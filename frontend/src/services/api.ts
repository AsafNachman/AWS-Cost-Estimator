/**
 * Typed API client for the FastAPI backend.
 *
 * Architectural notes
 * -------------------
 * 1. **Adapter pattern at the API boundary.** The backend accepts the diagram
 *    in two shapes (wrapped `{diagram: {...}}` or raw `{...}`). The client
 *    normalizes any caller input — diagram-shaped or already-wrapped — into
 *    the wrapped form. Symmetric with `_extract_diagram` on the server.
 *
 * 2. **Singleton via ESM module cache.** ES module specifiers are *globally
 *    keyed* by URL inside the Node/browser module registry, so importing
 *    this file from multiple components returns the same module instance.
 *    The exported functions act as static methods on a hidden Singleton.
 *
 * 3. **Resilient JSON parsing.** A 5xx response with an empty body would
 *    crash `response.json()` — we read the body as text first and only
 *    attempt to parse if it looks like JSON. Errors surface as typed
 *    `ApiError` instances, so callers can branch on `status` rather than
 *    sniffing strings.
 *
 * 4. **Optional `AbortSignal`.** The caller can cancel an in-flight request
 *    (e.g. when the user clicks "Cancel" or the component unmounts). This
 *    forwards to `fetch`'s native `AbortController` plumbing — the under-
 *    lying TCP socket is closed when the signal aborts.
 *
 * Big-O
 * -----
 * * `fetchCostEstimate`  — O(R) network bytes (payload size dominates).
 * * `fetchEstimateHistory` — O(L) for the bounded `limit` parameter.
 *
 * Both functions are O(1) in CPU on the client; latency is bounded entirely
 * by the round-trip to the backend.
 */
import type {
  Diagram,
  EstimateResponse,
  HistoryResponse,
} from "@/types";

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */

/**
 * Base URL of the FastAPI server.
 *
 * Resolved in this order:
 *   1. `NEXT_PUBLIC_API_BASE_URL` (build-time injected by Next.js — the
 *      `NEXT_PUBLIC_` prefix is what makes a variable browser-visible;
 *      anything else stays server-only).
 *   2. Hard-coded `http://localhost:8000` for local dev parity with the
 *      backend's default `uvicorn --port 8000` configuration.
 */
const API_BASE_URL: string =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ||
  "http://localhost:8000";

/** Reasonable wall-clock ceiling for an LLM-powered estimate. */
const DEFAULT_TIMEOUT_MS = 120_000;

/* ---------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------- */

/**
 * Typed error so consumers can `instanceof ApiError` and branch on `status`
 * without parsing free-form error messages.
 *
 * Extending the built-in `Error` requires re-setting the prototype because
 * TypeScript's down-leveling of `class` to ES5 breaks the prototype chain
 * — a well-known footgun documented in the TS handbook.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/* ---------------------------------------------------------------------------
 * Internal helpers
 * ------------------------------------------------------------------------- */

/**
 * Wrap `fetch` with: JSON content-type, optional timeout via AbortController,
 * and typed JSON parsing of the body.
 *
 * `AbortController` under the hood
 * --------------------------------
 * Calling `controller.abort()` sets the signal's `aborted` flag and dispatches
 * an `"abort"` event. The fetch implementation listens for that event and
 * tears down the underlying socket via the platform's HTTP stack (libuv on
 * Node, the browser's network service on web). The promise then rejects with
 * a `DOMException` of name `"AbortError"` — we re-wrap that into an
 * `ApiError` so callers see a single error type.
 */
async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  // Compose caller's signal with our timeout signal so either can cancel.
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", () => controller.abort());
  }

  const url = `${API_BASE_URL}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new ApiError(`Request to ${path} aborted/timed out`, 0);
    }
    throw new ApiError(
      `Network error contacting ${url}: ${(err as Error).message}`,
      0,
    );
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }

  // Read the body once, as text — `response.json()` would throw on an empty
  // body, which is common for some 5xx responses. Parsing manually gives us
  // a single, well-defined failure mode.
  const rawText = await response.text();
  let parsed: unknown = undefined;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      // Non-JSON bodies are unusual but legitimate (e.g. HTML 502 from a
      // reverse proxy). Fall through; `parsed` stays undefined.
    }
  }

  if (!response.ok) {
    const detail =
      (parsed as { detail?: string } | undefined)?.detail ??
      response.statusText ??
      "Unknown error";
    throw new ApiError(
      `HTTP ${response.status} from ${path}: ${detail}`,
      response.status,
      parsed,
    );
  }

  return parsed as T;
}

/**
 * Adapter — accept *any* of:
 *   1. A bare diagram object (`{nodes, edges, ...}`)
 *   2. A wrapped object (`{diagram: {nodes, edges, ...}}`)
 *   3. A JSON string of either of the above
 * and return the canonical wrapped form that the backend expects.
 *
 * Why accept #3? `JSONEditor` works with strings; this lets callers skip
 * the manual `JSON.parse` step and centralizes the error surface.
 *
 * Throws `ApiError(400, ...)` for anything that obviously isn't a diagram.
 */
function toWrappedDiagram(input: unknown): { diagram: Diagram } {
  let candidate: unknown = input;

  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch (err) {
      throw new ApiError(
        `Diagram payload is not valid JSON: ${(err as Error).message}`,
        400,
      );
    }
  }

  if (!candidate || typeof candidate !== "object") {
    throw new ApiError("Diagram payload must be a JSON object.", 400);
  }

  const obj = candidate as Record<string, unknown>;

  // Already wrapped? Pass through (after a minimal shape check).
  const inner = obj["diagram"];
  if (inner && typeof inner === "object") {
    return { diagram: inner as Diagram };
  }

  // Raw form — verify it at least looks like a diagram.
  if (!("nodes" in obj) && !("edges" in obj)) {
    throw new ApiError(
      "Diagram must contain a 'nodes' and/or 'edges' array.",
      400,
    );
  }

  return { diagram: obj as Diagram };
}

/* ---------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

export interface FetchEstimateOptions {
  /** Forwarded to `fetch` so callers can cancel. */
  signal?: AbortSignal;
  /** Per-request timeout override (ms). Default: 120 s. */
  timeoutMs?: number;
}

/**
 * `POST /api/estimate` — run the LangGraph pipeline on a diagram.
 *
 * @param diagram Either the raw diagram or `{diagram: ...}`, optionally
 *   stringified. Normalized via `toWrappedDiagram` before being sent.
 * @returns The full {@link EstimateResponse} as defined by `state.py`.
 *
 * @throws {ApiError} On non-2xx responses, network errors, timeouts, or
 *   payload-shape errors. The `.status` field tells you which.
 */
export async function fetchCostEstimate(
  diagram: unknown,
  options: FetchEstimateOptions = {},
): Promise<EstimateResponse> {
  const payload = toWrappedDiagram(diagram);

  return request<EstimateResponse>(
    "/api/estimate",
    {
      method: "POST",
      body: JSON.stringify(payload),
      signal: options.signal,
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

export interface FetchHistoryOptions {
  /** Page size. Clamped client-side to `[1, 200]` to match the server's
   *  `Query(..., ge=1, le=200)` bounds in `main.py`. Default: 20 — the
   *  same default the server uses, so omitting `limit` produces an
   *  identical URL on both sides. */
  limit?: number;
  /** Opaque pagination token returned as `next_cursor` by the previous
   *  call. Omit (or pass `null`) to fetch the first page.
   *
   *  Treated as a black box on the client: we never inspect or mutate
   *  the cursor — it is the server's job to decode it back into an
   *  `ObjectId` and translate it to a `_id < cursor` range query
   *  against the implicit `_id` B-tree index. Keeping it opaque means
   *  the server can swap the encoding (e.g. signed JWT-style tokens)
   *  without a client change. */
  cursor?: string | null;
  signal?: AbortSignal;
}

/**
 * `GET /api/history` — fetch one page of estimate runs, newest first.
 *
 * Keyset (cursor) pagination
 * --------------------------
 * The server uses the `_id` B-tree index to seek to the cursor position
 * in **O(log N)** and stream the next K rows in **O(K)**, regardless of
 * how deep we page. This is asymptotically faster than `.skip(N)`,
 * which forces Mongo to walk every preceding document and degrades to
 * **O(N + K)**.
 *
 * Calling convention
 * ------------------
 * * First page:  `fetchEstimateHistory({ limit: 20 })`
 * * Next page:   `fetchEstimateHistory({ limit: 20, cursor: prev.next_cursor })`
 * * End of list: `prev.next_cursor === null` — the server has signaled
 *                no further pages exist.
 *
 * When MongoDB is not configured the endpoint returns
 * `{items: [], count: 0, next_cursor: null}` — *not* an error — so
 * callers can treat "no history yet" without a special case.
 */
export async function fetchEstimateHistory(
  options: FetchHistoryOptions = {},
): Promise<HistoryResponse> {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 20)));
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.cursor) {
    // Only attach the param when we actually have one; an empty string
    // would still be transmitted and the server would (rightly) treat
    // it as a malformed cursor.
    params.set("cursor", options.cursor);
  }

  return request<HistoryResponse>(
    `/api/history?${params.toString()}`,
    { method: "GET", signal: options.signal },
    30_000, // history queries are quick — no need for the full 120 s budget.
  );
}

/**
 * `GET /api/health` — cheap liveness check used by the UI to surface
 * "backend offline" hints when the user lands on the page.
 */
export async function fetchHealth(): Promise<{
  status: string;
  service: string;
  version: string;
}> {
  return request("/api/health", { method: "GET" }, 5_000);
}

/** The resolved base URL — useful for displaying "API: <url>" in the UI. */
export const apiBaseUrl: string = API_BASE_URL;
