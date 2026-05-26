"""FastAPI application entry point.

Routes
------
* ``GET  /api/health``    Liveness probe.
* ``POST /api/estimate``  Run the full LangGraph pipeline on a diagram.
* ``GET  /api/history``   List recent estimate runs (newest first; MongoDB).

Adapter at the API boundary
---------------------------
The diagram payload is accepted in two shapes for client flexibility:

* Wrapped:  ``{"diagram": {"id": ..., "nodes": [...], "edges": [...]}}``
* Raw:      ``{"id": ..., "nodes": [...], "edges": [...]}``

One canonical internal shape, multiple acceptable wire shapes -- classic
Adapter pattern.

Lifecycle
---------
Startup / shutdown are handled by FastAPI's ``lifespan`` async context
manager (replaces the deprecated ``@app.on_event`` hooks). On startup we
attempt to connect to MongoDB; on shutdown we close the connection pool.
When ``MONGODB_URI`` is unset, the database layer gracefully no-ops and
the rest of the API keeps working.

Persistence is durable + inline
-------------------------------
Successful estimate runs are persisted via an **inline ``await``** to the
repository layer *before* the HTTP response is sent. We previously used
``BackgroundTasks`` (fire-and-forget) for lower tail latency, but that
pattern silently drops writes whenever the worker is killed (SIGTERM
during a rolling deploy, OOM, container eviction) between the response
and the eventual ``insert_one``. Inline ``await`` trades a few hundred
milliseconds of latency for a durability guarantee: if the client got
``200 OK``, the row is in MongoDB. The repository layer wraps the write
in a bounded exponential-backoff retry, so transient socket blips never
surface to the user, and a fully-degraded DB still returns an empty
string instead of crashing the request.

History pagination
------------------
``GET /api/history`` uses **keyset (cursor) pagination** rather than
``skip``/``offset``. Clients pass back the opaque ``next_cursor`` from
the previous page; the repository translates that to a ``_id < cursor``
range query against the implicit ``_id`` B-tree index, giving us
``O(log N + K)`` per page regardless of depth.
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from dotenv import load_dotenv

# Load .env before importing modules that read os.environ at import time.
load_dotenv()

from fastapi import (  # noqa: E402
    FastAPI,
    HTTPException,
    Query,
    Request,
)
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field  # noqa: E402

from .database import close_db, get_estimate_history, init_db, save_estimate  # noqa: E402
from .graph import compiled_graph  # noqa: E402
from .state import CostEstimateItem, ExtractedResource, OverallState  # noqa: E402

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("aws-cost-estimator.main")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class EstimateRequest(BaseModel):
    """Wrapped form: ``{"diagram": {...}}``."""

    model_config = ConfigDict(extra="allow")

    diagram: dict[str, Any] | None = Field(default=None)


class EstimateResponse(BaseModel):
    """Final shape returned to the client. Mirrors the populated state."""

    model_config = ConfigDict(populate_by_name=True)

    parsed_resources: list[ExtractedResource] = Field(default_factory=list)
    infracost_results: dict[str, Any] = Field(default_factory=dict)
    final_costs: list[CostEstimateItem] = Field(default_factory=list)
    total_monthly_cost: float = 0.0
    architectural_explanation: str = ""
    errors: list[str] = Field(default_factory=list)


class HistoryResponse(BaseModel):
    """Envelope for ``GET /api/history`` with cursor-pagination metadata.

    ``next_cursor`` is the opaque token clients must echo back as the
    ``cursor`` query parameter to fetch the following page. It is the
    string form of the MongoDB ``ObjectId`` of the last row on this page.
    A ``null`` value means the client has reached the end of the
    collection -- no further pages exist.
    """

    model_config = ConfigDict(populate_by_name=True)

    items: list[dict[str, Any]] = Field(default_factory=list)
    count: int = 0
    next_cursor: str | None = Field(
        default=None,
        description=(
            "Opaque pagination token. Pass back as ``?cursor=...`` to get "
            "the next page. ``null`` when there are no more pages."
        ),
    )


# ---------------------------------------------------------------------------
# App + middleware + lifecycle
# ---------------------------------------------------------------------------


_DEV_ORIGINS: tuple[str, ...] = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3005",
    "http://127.0.0.1:3005",
)


def _parse_origins(raw: str | None) -> list[str]:
    """Build the CORS allowlist by merging dev defaults with the env value.

    The env value is expected as a comma-separated string, e.g.
    ``"http://localhost:3000,http://127.0.0.1:3005"``. Whitespace around
    each entry is tolerated. Dev defaults (ports 3000 and 3005 on both
    ``localhost`` and ``127.0.0.1``) are always included first so a missing
    or malformed ``.env`` cannot lock the frontend out during local dev.

    Deduplication uses ``dict.fromkeys``, which exploits CPython's
    insertion-ordered ``dict`` (PEP 468 / 3.7+) to act as an "ordered set"
    in O(n) time and space.
    """
    extras = [o.strip() for o in (raw or "").split(",") if o.strip()]
    return list(dict.fromkeys((*_DEV_ORIGINS, *extras)))


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Async context manager that bookends the server's lifetime.

    Startup:
        * Attempt to initialize the MongoDB client. Returns ``False`` and
          logs a warning when ``MONGODB_URI`` is empty or the server is
          unreachable -- the API stays up regardless.

    Shutdown:
        * Close the Motor client (releases TCP connection pool).

    This is the modern replacement for ``@app.on_event("startup")`` /
    ``@app.on_event("shutdown")`` and is the recommended pattern from
    FastAPI 0.93 onward.
    """
    enabled = await init_db()
    if enabled:
        logger.info("lifespan: persistence layer is ONLINE.")
    else:
        logger.info("lifespan: persistence layer is OFFLINE (no MONGODB_URI / unreachable).")
    try:
        yield
    finally:
        await close_db()


app = FastAPI(
    title="AWS Cost Estimator",
    description=(
        "LangGraph-powered cost estimator for proprietary AWS infrastructure diagrams. "
        "Pipeline: parse -> enrich -> estimate -> explain."
    ),
    version="1.0.0",
    lifespan=_lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_origins(os.getenv("CORS_ALLOW_ORIGINS")),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_diagram(request_body: dict[str, Any]) -> dict[str, Any]:
    """Accept both wrapped and raw diagram payloads."""
    if not isinstance(request_body, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    diagram = request_body.get("diagram")
    if isinstance(diagram, dict):
        return diagram
    if "nodes" in request_body or "edges" in request_body:
        return request_body
    raise HTTPException(
        status_code=400,
        detail="Missing diagram. Send either {'diagram': {...}} or the diagram object directly.",
    )


def _diagram_identifier(diagram: dict[str, Any]) -> str:
    """Return a stable, human-readable ID for the diagram (for logs + persistence).

    Falls back through ``id`` -> ``name`` -> the literal ``"unknown"`` so we
    always have *something* to key the history record on.
    """
    candidate = diagram.get("id") or diagram.get("name") or "unknown"
    return str(candidate)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "aws-cost-estimator",
        "version": app.version,
    }


@app.post("/api/estimate", response_model=EstimateResponse)
async def estimate(raw_request: Request) -> EstimateResponse:
    """Run the full LangGraph pipeline on the supplied diagram.

    On success, persist the result via an **inline ``await``** to
    ``save_estimate`` *before* returning the response. This gives us a
    real durability guarantee (``200 OK`` <=> the row is in MongoDB) and
    eliminates the silent-drop window that ``BackgroundTasks`` had during
    deploys / restarts. The repository layer handles transient socket
    errors with bounded exponential-backoff retries; a fully-broken DB is
    still swallowed (logged + ``""`` returned) so the user never sees a
    500 just because history is unavailable.
    """
    try:
        body = await raw_request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid JSON body: {exc}") from exc

    diagram = _extract_diagram(body)
    if not (diagram.get("nodes") or diagram.get("edges")):
        raise HTTPException(
            status_code=422,
            detail="diagram must contain a 'nodes' and/or 'edges' array",
        )

    diagram_id = _diagram_identifier(diagram)
    initial_state: OverallState = {"raw_diagram": diagram}
    logger.info(
        "estimate: running pipeline on diagram %r (%d nodes, %d edges)",
        diagram_id,
        len(diagram.get("nodes") or []),
        len(diagram.get("edges") or []),
    )

    try:
        result_state: OverallState = await compiled_graph.ainvoke(initial_state)
    except Exception as exc:  # noqa: BLE001
        logger.exception("pipeline failure")
        raise HTTPException(
            status_code=500,
            detail=f"pipeline execution failed: {exc}",
        ) from exc

    response = EstimateResponse(
        parsed_resources=list(result_state.get("parsed_resources") or []),
        infracost_results=dict(result_state.get("infracost_results") or {}),
        final_costs=list(result_state.get("final_costs") or []),
        total_monthly_cost=float(result_state.get("total_monthly_cost") or 0.0),
        architectural_explanation=str(result_state.get("architectural_explanation") or ""),
        errors=list(result_state.get("errors") or []),
    )

    # Durable inline persistence. ``model_dump(mode="json")`` converts every
    # Pydantic sub-model to a BSON-friendly dict (datetimes -> ISO strings,
    # enums -> raw values, etc.) so Mongo can store it directly.
    # ``save_estimate`` is internally bounded by tenacity retries and is
    # contractually swallow-only; it cannot raise into this handler.
    inserted_id = await save_estimate(diagram_id, response.model_dump(mode="json"))
    if inserted_id:
        logger.debug("estimate: persisted run as %s", inserted_id)
    else:
        logger.debug("estimate: persistence skipped or degraded for diagram %r", diagram_id)

    return response


@app.get("/api/history", response_model=HistoryResponse)
async def history(
    limit: int = Query(
        20,
        ge=1,
        le=200,
        description="Page size (1-200). Defaults to 20.",
    ),
    cursor: str | None = Query(
        default=None,
        description=(
            "Opaque pagination token from a previous response's "
            "``next_cursor``. Omit to fetch the first page."
        ),
    ),
) -> HistoryResponse:
    """Return one page of saved estimate runs, newest first.

    Uses **keyset (cursor) pagination** on ``_id``: pages run at
    ``O(log N + K)`` regardless of how deep into the history the client
    is paging. The opaque ``next_cursor`` in the response should be sent
    back as ``?cursor=...`` to fetch the next page; a ``null`` value
    indicates the end of the collection.

    When MongoDB is not configured the layer returns an empty page --
    this endpoint will still respond ``200 OK`` with
    ``{"items": [], "count": 0, "next_cursor": null}`` so clients can
    detect "no history yet" without a special case.
    """
    page = await get_estimate_history(limit=limit, cursor=cursor)
    return HistoryResponse(
        items=page["items"],
        count=len(page["items"]),
        next_cursor=page["next_cursor"],
    )


# ---------------------------------------------------------------------------
# uvicorn entrypoint (so `python -m app.main` also works for local dev)
# ---------------------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("RELOAD", "false").lower() == "true",
    )
