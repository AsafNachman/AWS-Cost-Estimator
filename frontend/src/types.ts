/**
 * Shared TypeScript types — a one-to-one mirror of the backend's Pydantic models
 * (`backend/app/state.py`) and FastAPI response envelopes (`backend/app/main.py`).
 *
 * Keeping the contract in a single source-of-truth file means every component
 * imports the same `EstimateResponse`/`CostEstimateItem` — if the backend
 * schema drifts, TypeScript will surface the breakage at compile time
 * everywhere it matters (DRY + Single Source of Truth).
 *
 * The string-literal unions below match the `Literal[...]` types in
 * `state.py` exactly. Using literals (instead of plain `string`) gives the
 * compiler the information it needs to do *exhaustiveness checking* on
 * `switch`/`match` statements — adding a new tier on the backend will then
 * fail the build until every frontend match handles it.
 */

/** Mirrors `ConfidenceLevel` in backend/app/state.py. */
export type ConfidenceLevel = "High (Infracost)" | "Medium" | "Low";

/** Mirrors `EnvironmentTier` in backend/app/state.py. */
export type EnvironmentTier =
  | "Production"
  | "Management"
  | "Deployment"
  | "Dev/QA"
  | "Global"
  | "Unknown";

/** Mirrors `ExtractedResource` in backend/app/state.py. */
export interface ExtractedResource {
  id: string;
  title: string;
  node_type: string;
  canonical_service: string;

  role?: string | null;
  raw_config?: string | null;
  reason?: string | null;
  addresses?: string[];

  instance_type?: string | null;
  db_instance_class?: string | null;
  cache_node_type?: string | null;
  warehouse_node_type?: string | null;

  storage_gb?: number | null;
  storage_type?: string | null;

  count?: number;
  max_count?: number | null;

  multi_az?: boolean | null;
  engine?: string | null;

  account?: EnvironmentTier;
  region?: string | null;
  availability_zone?: string | null;
  parent_chain?: string[];

  connected_to?: string[];
  connected_from?: string[];
}

/** Mirrors `CostEstimateItem` in backend/app/state.py. */
export interface CostEstimateItem {
  resource_id: string;
  title: string;
  service: string;
  account: EnvironmentTier;
  region?: string | null;

  instance_type?: string | null;
  quantity: number;

  monthly_cost_usd: number;
  unit_cost_usd?: number | null;
  breakdown?: string | null;
  confidence: ConfidenceLevel;
  assumptions: string[];
}

/** Mirrors `EstimateResponse` in backend/app/main.py — the canonical
 *  body returned by `POST /api/estimate`. */
export interface EstimateResponse {
  parsed_resources: ExtractedResource[];
  infracost_results: Record<string, unknown>;
  final_costs: CostEstimateItem[];
  total_monthly_cost: number;
  architectural_explanation: string;
  errors: string[];
}

/** One row in `GET /api/history`. */
export interface HistoryItem {
  id: string;
  diagram_id: string;
  created_at: string; // ISO-8601
  payload: EstimateResponse;
}

/** Mirrors `HistoryResponse` in backend/app/main.py.
 *
 *  `next_cursor` is the opaque keyset token: pass it back as
 *  `?cursor=...` on the next call to fetch the page that comes
 *  *after* this one. `null` means the client has reached the end of
 *  the collection.
 *
 *  Modeling it as `string | null` (rather than `string | undefined`)
 *  mirrors the JSON shape exactly — `null` is what `JSON.stringify`
 *  emits for a `None` field — so we can `=== null` without first
 *  worrying about missing keys.
 */
export interface HistoryResponse {
  items: HistoryItem[];
  count: number;
  next_cursor: string | null;
}

/* ---------------------------------------------------------------------------
 * Diagram input — kept intentionally loose because the proprietary schema
 * has many optional fields and the backend re-validates anyway. Strict
 * typing buys us nothing on the *input* side; flexibility is more valuable.
 * ------------------------------------------------------------------------- */

export interface DiagramNode {
  id: string;
  type: string;
  title?: string;
  description?: string;
  parentId?: string;
  position?: { x: number; y: number };
  width?: number;
  height?: number;
  [extra: string]: unknown;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  animated?: boolean;
  style?: { strokeDasharray?: string };
  [extra: string]: unknown;
}

export interface Diagram {
  id?: string;
  name?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  [extra: string]: unknown;
}

/** Cost categories used by the dashboard's split bars.
 *  Modeled as a closed union so adding a new category requires a single
 *  edit + a TS error wherever the union is matched. */
export type CostCategory =
  | "Compute"
  | "Storage"
  | "Database"
  | "Networking"
  | "Security"
  | "Analytics"
  | "Observability"
  | "Other";
