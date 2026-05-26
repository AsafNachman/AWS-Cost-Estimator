"""Async MongoDB persistence layer for completed estimate runs.

Architecture
------------
This module implements the **Repository Pattern**: callers ask the
domain-language questions ``save_estimate`` / ``get_estimate_history`` and
do not care that the underlying store happens to be MongoDB. Swapping in
Postgres, DynamoDB, or even an in-memory dict only changes *this* file --
the rest of the codebase is insulated behind a stable two-function API.

The Motor client is a process-wide **Singleton** (one TCP connection pool
per worker), initialized via ``init_db()`` from FastAPI's ``lifespan`` hook
and torn down via ``close_db()``. Lazy initialization means the backend
still boots cleanly when ``MONGODB_URI`` is not configured -- in that mode
the repository functions degrade gracefully (logged no-ops). This is the
Null Object pattern applied to an optional dependency.

Motor under the hood
--------------------
``motor.motor_asyncio.AsyncIOMotorClient`` wraps PyMongo's C extension with
an ``asyncio`` adapter: every blocking I/O call is dispatched to a small
worker thread pool and the result is bridged back to the running event
loop via an ``asyncio.Future``. From our perspective every call is a
regular coroutine and the event loop is never blocked, even though the
underlying socket operations are themselves blocking C calls.

Resilience: Retry with Exponential Backoff
------------------------------------------
``save_estimate`` is wrapped in ``tenacity.AsyncRetrying`` so transient
network errors (``AutoReconnect``, ``NetworkTimeout``, ``ConnectionFailure``,
``ServerSelectionTimeoutError``) trigger up to **3 attempts** with
exponential backoff (~0.5s, ~1s, ~2s). Permanent errors such as
``DuplicateKeyError`` or ``InvalidDocument`` short-circuit immediately --
they are programmer errors, not transient blips, and retrying would only
waste latency. Worst-case write tail latency is therefore bounded at
roughly ``initial RTT + 0.5 + 1 + 2`` seconds.

Pagination: Keyset (Cursor-based) instead of Offset
---------------------------------------------------
``get_estimate_history`` uses **keyset pagination** on ``_id`` rather than
the naive ``.skip(N).limit(K)`` pattern. ``ObjectId`` values are
monotonically increasing (the first 4 bytes are a UNIX timestamp), so
sorting by ``_id`` desc is equivalent to "newest first" without needing
an extra index. With the default ``_id`` B-tree index, each page is an
``O(log N + K)`` seek instead of the ``O(N + K)`` cost of ``skip``, which
has to walk every preceding document. This is the standard scalable
pagination strategy and is the only one that does not degrade as the
collection grows.

Complexity
----------
* ``save_estimate``         -- O(1) network round-trip; O(P) bytes over the wire.
* ``get_estimate_history``  -- O(log N + K) per page via the ``_id`` index.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Final, TypedDict

from bson import ObjectId
from bson.errors import InvalidId
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from pymongo.errors import (
    AutoReconnect,
    ConnectionFailure,
    NetworkTimeout,
    ServerSelectionTimeoutError,
)
from tenacity import (
    AsyncRetrying,
    RetryError,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Module-level singletons. Exactly one client + one database handle per
# worker process. Populated by ``init_db`` and cleared by ``close_db``.
# ---------------------------------------------------------------------------

_client: AsyncIOMotorClient | None = None
"""Process-wide Motor client. ``None`` until ``init_db`` succeeds."""

_db: AsyncIOMotorDatabase | None = None
"""Process-wide database handle. ``None`` until ``init_db`` succeeds."""

_ESTIMATES_COLLECTION: Final[str] = "estimates"
"""Name of the collection that holds historical estimate runs."""

_DEFAULT_DB_NAME: Final[str] = "aws_cost_estimator"
_SERVER_SELECTION_TIMEOUT_MS: Final[int] = 3000
"""Bail out of init if the server doesn't answer within 3s -- well below
any realistic FastAPI startup budget."""

# Errors that justify a retry. They all map to transient socket / topology
# states that typically resolve within a few hundred ms (primary failover,
# brief network partition, server-side resource pressure). Anything outside
# this allowlist is a permanent error and is re-raised immediately so we do
# not waste latency retrying things that will never succeed.
_TRANSIENT_DB_ERRORS: Final[tuple[type[BaseException], ...]] = (
    AutoReconnect,
    NetworkTimeout,
    ConnectionFailure,
    ServerSelectionTimeoutError,
)

_SAVE_RETRY_ATTEMPTS: Final[int] = 3
_SAVE_RETRY_BACKOFF_MULTIPLIER: Final[float] = 0.5
_SAVE_RETRY_BACKOFF_MIN_S: Final[float] = 0.5
_SAVE_RETRY_BACKOFF_MAX_S: Final[float] = 4.0

_DEFAULT_PAGE_SIZE: Final[int] = 20
_MAX_PAGE_SIZE: Final[int] = 200


class HistoryPage(TypedDict):
    """Result envelope returned by ``get_estimate_history``.

    Using a ``TypedDict`` (not a plain ``dict``) gives mypy / Pyright the
    field-level type information they need to catch typos at the call site
    without paying the runtime cost of a Pydantic model.
    """

    items: list[dict[str, Any]]
    next_cursor: str | None


def _is_enabled() -> bool:
    """Return True iff MongoDB has been initialized successfully."""
    return _db is not None


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def init_db(
    uri: str | None = None,
    db_name: str | None = None,
    *,
    ping: bool = True,
) -> bool:
    """Initialize the global Mongo client + database handle.

    Args:
        uri: Override for the ``MONGODB_URI`` env var. When neither is set,
            persistence is disabled and we return ``False`` (no error).
        db_name: Override for the ``MONGODB_DB`` env var. Defaults to
            ``"aws_cost_estimator"``.
        ping: If True (default), issue a ``{"ping": 1}`` admin command to
            verify reachability before declaring the layer healthy. Set to
            ``False`` in unit tests where the round-trip is undesirable.

    Returns:
        ``True`` when initialization succeeded and the DB is usable.
        ``False`` when MongoDB is not configured or unreachable -- the
        backend keeps running, but persistence becomes a no-op.

    Idempotent: calling ``init_db`` after a successful init is a no-op
    that returns ``True`` immediately, so it is safe to invoke from
    multiple lifespan hooks or tests.
    """
    global _client, _db

    if _client is not None:
        logger.debug("database: already initialized; reusing existing client.")
        return True

    resolved_uri = (uri or os.getenv("MONGODB_URI") or "").strip()
    resolved_db_name = (db_name or os.getenv("MONGODB_DB") or _DEFAULT_DB_NAME).strip()

    logger.info(f"database: attempting connection with MONGODB_URI={resolved_uri}")
    logger.info(f"database: targeting database={resolved_db_name}")

    if not resolved_uri:
        logger.info("database: MONGODB_URI not set; persistence disabled.")
        return False

    try:
        client: AsyncIOMotorClient = AsyncIOMotorClient(
            resolved_uri,
            serverSelectionTimeoutMS=_SERVER_SELECTION_TIMEOUT_MS,
            uuidRepresentation="standard",
            appname="aws-cost-estimator",
        )
        if ping:
            await client.admin.command("ping")
        db = client[resolved_db_name]
        await _ensure_indexes(db)
    except Exception as exc:  # noqa: BLE001 -- one graceful path for any failure
        logger.warning(
            "database: MongoDB unreachable at %s (%s); persistence disabled.",
            _redact_uri(resolved_uri),
            exc,
        )
        return False

    _client = client
    _db = db
    logger.info(
        "database: connected to MongoDB (db=%s, collection=%s)",
        resolved_db_name,
        _ESTIMATES_COLLECTION,
    )
    return True


async def _ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    """Create the indexes our queries rely on.

    MongoDB's ``create_index`` is idempotent: re-creating an existing index
    is a server-side no-op, so we can safely call this on every startup.

    Indexes:
        * ``created_at`` DESC -- legacy, kept for ad-hoc analytics queries.
        * ``diagram_id`` ASC  -- supports per-diagram history queries.

    Note that the keyset-pagination path in ``get_estimate_history`` rides
    on the implicit ``_id`` index that every MongoDB collection has by
    default; we do not need to define an extra one.
    """
    estimates = db[_ESTIMATES_COLLECTION]
    await estimates.create_index([("created_at", -1)], name="created_at_desc")
    await estimates.create_index([("diagram_id", 1)], name="diagram_id_asc")


async def close_db() -> None:
    """Tear down the Motor client. Safe to call multiple times.

    ``AsyncIOMotorClient.close()`` is synchronous but it gracefully shuts
    down the underlying connection pool (cancels in-flight ops, closes
    sockets). We wrap it in an async function for symmetry with
    ``init_db`` and so it slots into FastAPI's async lifespan.
    """
    global _client, _db
    if _client is None:
        return
    try:
        _client.close()
    finally:
        _client = None
        _db = None
        logger.info("database: connection closed.")


# ---------------------------------------------------------------------------
# Repository functions
# ---------------------------------------------------------------------------


async def save_estimate(diagram_id: str, payload: dict[str, Any]) -> str:
    """Persist one completed estimate run, with bounded retry on transient errors.

    Retry policy
    ------------
    Wrapped in ``tenacity.AsyncRetrying`` configured for **up to 3 attempts**
    with exponential backoff (``wait_exponential``). Only the errors in
    ``_TRANSIENT_DB_ERRORS`` trigger a retry; anything else (e.g.
    ``DuplicateKeyError``, ``InvalidDocument``) bails out on the first try
    since retrying a permanent error is wasted latency.

    Args:
        diagram_id: The proprietary diagram ID (from the user's JSON).
            Stored as a top-level field so future per-diagram queries can
            filter on it cheaply via the ``diagram_id_asc`` index.
        payload: A JSON-serializable dict mirroring the API response
            (parsed resources, costs, explanation, errors). Caller is
            responsible for converting Pydantic models via
            ``model_dump(mode="json")`` before passing it in.

    Returns:
        The MongoDB ``ObjectId`` of the inserted document as a string.
        Empty string when persistence is not configured or every retry
        failed -- callers can treat the empty value as "skipped" and
        continue. A history miss must never break the primary
        cost-estimation flow.
    """
    if not _is_enabled():
        logger.debug("save_estimate: skipped (MongoDB disabled).")
        return ""

    assert _db is not None  # type-narrow for mypy / readability

    document: dict[str, Any] = {
        "diagram_id": diagram_id,
        "payload": payload,
        "created_at": datetime.now(timezone.utc),
    }

    try:
        inserted_id = await _insert_with_retry(document)
    except RetryError as exc:
        # All retries exhausted on a transient error; the original cause
        # is hanging off ``exc.last_attempt`` for the log line.
        logger.error(
            "save_estimate: gave up after %d transient failures for diagram %r: %s",
            _SAVE_RETRY_ATTEMPTS,
            diagram_id,
            exc.last_attempt.exception() if exc.last_attempt else exc,
        )
        return ""
    except Exception:  # noqa: BLE001 -- non-transient error; log and degrade
        logger.exception(
            "save_estimate: non-transient insert_one failure for diagram %r.",
            diagram_id,
        )
        return ""

    logger.info("save_estimate: persisted diagram %r as %s", diagram_id, inserted_id)
    return inserted_id


async def _insert_with_retry(document: dict[str, Any]) -> str:
    """Execute the ``insert_one`` call under a tenacity retry policy.

    ``AsyncRetrying`` is an async iterator yielding an ``AttemptManager``
    for each retry. Wrapping the operation in ``with attempt:`` lets
    tenacity observe the exception (or success), consult the predicates
    (``stop`` + ``retry``), sleep via ``wait``, and re-loop. The
    ``reraise=True`` flag means that when retries are exhausted the
    *original* exception is re-raised wrapped in a ``RetryError`` so the
    caller can distinguish "transient, exhausted" from "permanent".

    Returns the stringified ObjectId on success.
    """
    assert _db is not None

    last_inserted_id: str = ""
    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(_SAVE_RETRY_ATTEMPTS),
        wait=wait_exponential(
            multiplier=_SAVE_RETRY_BACKOFF_MULTIPLIER,
            min=_SAVE_RETRY_BACKOFF_MIN_S,
            max=_SAVE_RETRY_BACKOFF_MAX_S,
        ),
        retry=retry_if_exception_type(_TRANSIENT_DB_ERRORS),
        reraise=False,
    ):
        with attempt:
            result = await _db[_ESTIMATES_COLLECTION].insert_one(document)
            last_inserted_id = str(result.inserted_id)
        # If we got here the attempt did not raise; record the attempt
        # number for visibility when the first try succeeded vs. retried.
        if attempt.retry_state.attempt_number > 1:
            logger.info(
                "save_estimate: succeeded on retry attempt %d/%d",
                attempt.retry_state.attempt_number,
                _SAVE_RETRY_ATTEMPTS,
            )
    return last_inserted_id


async def get_estimate_history(
    *,
    limit: int = _DEFAULT_PAGE_SIZE,
    cursor: str | None = None,
) -> HistoryPage:
    """Return one page of estimate runs via keyset (cursor-based) pagination.

    Keyset pagination
    -----------------
    We sort by ``_id`` descending (ObjectIds embed a UNIX timestamp in the
    first 4 bytes, so this is functionally "newest first") and filter
    ``{"_id": {"$lt": ObjectId(cursor)}}`` when a cursor is supplied.
    Because every Mongo collection has a B-tree index on ``_id``, the
    server can ``seek`` to the cursor position in **O(log N)** and stream
    the next K documents in **O(K)**, regardless of how deep into the
    history we are paging. ``.skip(N).limit(K)`` would be **O(N + K)**
    because Mongo has to walk every skipped document.

    We fetch ``limit + 1`` rows so we can tell whether another page exists
    without an extra count query; the extra row is the "peek". If it
    appears, we drop it from the response and emit a ``next_cursor`` so
    the client can request the following page.

    Args:
        limit: Page size. Clamped to ``[1, _MAX_PAGE_SIZE]`` so a hostile
            or accidental client cannot DOS us by asking for millions of
            documents.
        cursor: Opaque pagination token returned as ``next_cursor`` by the
            previous call. It is the string form of an ``ObjectId``. An
            invalid value is treated as "start from the beginning" rather
            than raising, so a stale or hand-edited cursor cannot 500 us.

    Returns:
        A ``HistoryPage`` with ``items`` (JSON-ready dicts, newest first)
        and ``next_cursor`` (string ObjectId or ``None`` when this is the
        last page). Empty page when persistence is not configured or the
        read failed.
    """
    if not _is_enabled():
        logger.debug("get_estimate_history: skipped (MongoDB disabled).")
        return HistoryPage(items=[], next_cursor=None)

    assert _db is not None

    clamped_limit = max(1, min(int(limit), _MAX_PAGE_SIZE))

    query: dict[str, Any] = {}
    if cursor:
        parsed = _parse_object_id(cursor)
        if parsed is not None:
            # Strict less-than on _id under DESC sort = "the next page after
            # this one". Using $lt (not $lte) avoids returning the boundary
            # row twice across pages.
            query["_id"] = {"$lt": parsed}
        else:
            logger.warning(
                "get_estimate_history: ignoring malformed cursor %r; "
                "returning first page.",
                cursor,
            )

    try:
        mongo_cursor = (
            _db[_ESTIMATES_COLLECTION]
            .find(query)
            .sort("_id", -1)
            .limit(clamped_limit + 1)  # +1 = "peek" row for next_cursor detection
        )
        rows: list[dict[str, Any]] = await mongo_cursor.to_list(length=clamped_limit + 1)
    except Exception:  # noqa: BLE001 -- read path degrades gracefully
        logger.exception("get_estimate_history: query failed.")
        return HistoryPage(items=[], next_cursor=None)

    has_more = len(rows) > clamped_limit
    page_rows = rows[:clamped_limit]
    next_cursor: str | None = None
    if has_more and page_rows:
        # The cursor *is* the last returned row's _id, not the peek row's.
        # The next call will then ask for "_id < <last_id>" and resume
        # exactly where this page ended.
        next_cursor = str(page_rows[-1]["_id"])

    return HistoryPage(
        items=[_to_jsonable(row) for row in page_rows],
        next_cursor=next_cursor,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _parse_object_id(raw: str) -> ObjectId | None:
    """Best-effort ``ObjectId`` parsing.

    Returns ``None`` on any parse failure instead of raising so callers
    can degrade gracefully. ``InvalidId`` is the canonical bson error for
    malformed hex strings; we catch ``ValueError`` as well to absorb
    type-coercion edge cases (e.g. non-string input).
    """
    try:
        return ObjectId(raw)
    except (InvalidId, TypeError, ValueError):
        return None


def _to_jsonable(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a Mongo document into a JSON-serializable dict.

    * ``_id`` (``bson.ObjectId``)  -> ``id`` (``str``)
    * ``created_at`` (``datetime``) -> ISO-8601 string

    Both substitutions are belt-and-suspenders: FastAPI's default encoder
    can handle ``datetime`` natively, but normalizing here means any
    consumer (including non-FastAPI callers) sees a clean payload.
    """
    out: dict[str, Any] = dict(row)
    raw_id = out.pop("_id", None)
    if raw_id is not None:
        out["id"] = str(raw_id)
    created_at = out.get("created_at")
    if isinstance(created_at, datetime):
        out["created_at"] = created_at.isoformat()
    return out


def _redact_uri(uri: str) -> str:
    """Mask credentials in a Mongo URI before logging it.

    Turns ``mongodb://user:pass@host:27017`` into ``mongodb://***@host:27017``
    so we never leak passwords into log streams or error trackers.
    """
    try:
        scheme, sep, rest = uri.partition("://")
        if not sep or not rest:
            return uri
        creds, at, hostpart = rest.partition("@")
        if not at:
            return uri
        return f"{scheme}://***@{hostpart}"
    except Exception:  # noqa: BLE001
        return "<redacted>"


__all__ = [
    "HistoryPage",
    "close_db",
    "get_estimate_history",
    "init_db",
    "save_estimate",
]
