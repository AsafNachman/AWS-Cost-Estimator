"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock,
  History,
  Inbox,
  Layers,
  Loader2,
  RefreshCw,
  ServerCrash,
  Sparkles,
  Table2,
  Trash2,
  X,
} from "lucide-react";

import { ArchitectureExplainer } from "@/components/ArchitectureExplainer";
import { CostDashboard } from "@/components/CostDashboard";
import { CostTable } from "@/components/CostTable";
import { JSONEditor } from "@/components/JSONEditor";
import {
  ApiError,
  apiBaseUrl,
  fetchCostEstimate,
  fetchEstimateHistory,
  fetchHealth,
} from "@/services/api";
import { cn } from "@/lib/cn";
import type { EstimateResponse, HistoryItem } from "@/types";

/* ===========================================================================
 *  localStorage persistence layer
 *
 *  Design notes
 *  ------------
 *  1. **Versioned envelope.** We wrap the payload in `{ version, response,
 *     savedAt }` rather than storing the bare `EstimateResponse`. When the
 *     shape ever drifts we bump `version` and the shape guard below rejects
 *     stale entries cleanly instead of crashing the page on hydration.
 *
 *  2. **SSR-safe.** Next.js renders the first pass on the server, where
 *     `window` (and therefore `localStorage`) does not exist. Every helper
 *     short-circuits on `typeof window === "undefined"`, so importing this
 *     module on the server is harmless.
 *
 *  3. **Defensive try/catch.** `localStorage` can throw in three real-world
 *     scenarios: (a) the user is in Safari Private Browsing where quota is
 *     0, (b) the quota is exhausted by some other tab, (c) the browser
 *     blocks third-party storage. Persistence is a *best-effort* nicety —
 *     never the primary path — so any failure degrades silently to in-
 *     memory-only state.
 *
 *  4. **Runtime shape guard.** TypeScript types vanish at runtime, so a
 *     `JSON.parse` result is `unknown`. The `isPersistedResponse` predicate
 *     narrows that to our envelope type with minimal structural checks — a
 *     poor man's Zod sufficient for a one-field schema.
 *
 *  Complexity
 *  ----------
 *  * `readPersistedResponse`  — O(P) where P is the serialized payload size
 *                               (one `JSON.parse` over the stored string).
 *  * `writePersistedResponse` — O(P) (one `JSON.stringify` over the response).
 *  Both operations are synchronous; localStorage is a synchronous browser
 *  API backed by SQLite on most engines. For payloads in the few-hundred-KB
 *  range that we produce here the latency is sub-millisecond.
 * ========================================================================= */

const STORAGE_KEY_RESPONSE = "aws-cost-estimator:response:v1";
const STORAGE_KEY_INPUT = "aws-cost-estimator:input:v1";
const PERSIST_SCHEMA_VERSION = 1 as const;

interface PersistedResponse {
  readonly version: typeof PERSIST_SCHEMA_VERSION;
  readonly savedAt: string; // ISO-8601, for debugging / future TTL logic
  readonly response: EstimateResponse;
}

/**
 * Runtime type guard — narrows `unknown` (the only honest type for a
 * `JSON.parse` result) into `PersistedResponse`. We check just enough of
 * the structure to avoid false positives without descending into every
 * leaf: the price of a wrong narrowing here is a hydration that surfaces
 * `undefined` fields downstream, which would break tables/charts.
 */
function isPersistedResponse(value: unknown): value is PersistedResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== PERSIST_SCHEMA_VERSION) return false;
  const r = v.response as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return false;
  return (
    Array.isArray(r.parsed_resources) &&
    Array.isArray(r.final_costs) &&
    typeof r.total_monthly_cost === "number" &&
    typeof r.architectural_explanation === "string"
  );
}

function readPersistedResponse(): EstimateResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_RESPONSE);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedResponse(parsed) ? parsed.response : null;
  } catch {
    // Malformed JSON, quota error during read (rare), or storage disabled.
    return null;
  }
}

function writePersistedResponse(response: EstimateResponse): void {
  if (typeof window === "undefined") return;
  try {
    const envelope: PersistedResponse = {
      version: PERSIST_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      response,
    };
    window.localStorage.setItem(STORAGE_KEY_RESPONSE, JSON.stringify(envelope));
  } catch {
    // Quota exceeded or storage disabled — non-fatal. The in-memory result
    // still renders; it just won't survive a refresh.
  }
}

/* ---------------------------------------------------------------------------
 *  Raw-input persistence (a.k.a. `raw_json_input`)
 *
 *  Why a *second*, simpler channel instead of folding the text into the
 *  response envelope?
 *    1. **Decoupled lifecycles.** The user can edit the JSON for minutes
 *       between estimates; the response is updated only when the pipeline
 *       finishes. Coupling them would force a JSON.stringify of a
 *       potentially-large `EstimateResponse` on every keystroke.
 *    2. **No schema version needed.** The payload is a `string`, not a
 *       structured object, so there is no shape to drift. We skip the
 *       envelope to keep the read path branchless.
 *    3. **Independent failure modes.** If the response cache becomes
 *       corrupted (e.g. an old version is left behind), the input
 *       textarea still rehydrates — the two channels degrade
 *       independently, which is exactly the resilience guarantee the
 *       hardening pass is aiming for.
 *
 *  All three helpers are SSR-safe (`typeof window === "undefined"`
 *  guard) and defensive against the same three real-world failure
 *  scenarios as the response helpers: Safari Private Browsing quota=0,
 *  cross-tab quota exhaustion, and third-party-storage blocks.
 *
 *  Complexity: O(L) where L = length of the stored string. localStorage
 *  is a synchronous browser API backed by SQLite on most engines, so
 *  for typical diagram payloads (a few KB to a few hundred KB) the read
 *  and write latencies are sub-millisecond.
 * ------------------------------------------------------------------------- */

function readPersistedInput(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY_INPUT);
  } catch {
    // localStorage threw — see writePersistedInput for the enumerated cases.
    return null;
  }
}

function writePersistedInput(text: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_INPUT, text);
  } catch {
    // Quota exceeded, storage disabled, or private-browsing mode. Drop the
    // write silently — the textarea still works in-memory; it just won't
    // survive a refresh on this particular browser profile.
  }
}

/* ===========================================================================
 *  Tabs — declarative registry. Lets us iterate over `TABS` to render the
 *  toolbar AND the body without duplicating their order.
 * ========================================================================= */

type TabKey = "dashboard" | "table" | "explainer";

interface TabDef {
  key: TabKey;
  label: string;
  icon: typeof BarChart3;
  description: string;
}

const TABS: ReadonlyArray<TabDef> = [
  {
    key: "dashboard",
    label: "Cost Dashboard",
    icon: BarChart3,
    description: "Overview & KPIs",
  },
  {
    key: "table",
    label: "Detailed Breakdown",
    icon: Table2,
    description: "Per-resource line items",
  },
  {
    key: "explainer",
    label: "Architecture Review",
    icon: Layers,
    description: "Plain-language explanation",
  },
];

/* ===========================================================================
 *  Page component (the container)
 * ========================================================================= */

const HISTORY_PAGE_SIZE = 20;

export default function HomePage(): JSX.Element {
  /* ----- Editor state — lifted up so history rows can rehydrate it. ------- */
  const [diagramText, setDiagramText] = useState<string>("");

  /* ----- Request lifecycle ----------------------------------------------- */
  const [isLoading, setLoading] = useState<boolean>(false);
  const [response, setResponse] = useState<EstimateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* ----- Tabs ------------------------------------------------------------ */
  const [activeTab, setActiveTab] = useState<TabKey>("dashboard");

  /* ----- History drawer -------------------------------------------------- */
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const [historyItems, setHistoryItems] = useState<HistoryItem[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState<boolean>(false);
  const [historyNextCursor, setHistoryNextCursor] = useState<string | null>(
    null,
  );
  const [historyError, setHistoryError] = useState<string | null>(null);

  /* ----- Backend health -------------------------------------------------- */
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);

  /* ----- Hydration tracking ---------------------------------------------- *
   *  `useRef` gives us a *mutable* container whose `.current` value survives
   *  re-renders without triggering one. We use it as a "is this the very
   *  first render?" flag to suppress the redundant persist that would
   *  otherwise fire immediately after hydration sets `response`.            */
  const hasHydratedRef = useRef<boolean>(false);

  /* ----- Mount-time hydration from localStorage --------------------------
   *  Dual-channel hydration. We read both the raw editor text AND the
   *  resolved backend response from localStorage in a single commit so
   *  that all four user-facing surfaces — the textarea workspace, the
   *  dashboard KPIs, the breakdown table, and the architectural
   *  explainer — light up simultaneously after a hard refresh. Otherwise
   *  the page would flash through a blank state and then "snap" content
   *  in piecemeal, which reads as a bug.
   *
   *  We deliberately do *not* read localStorage inside `useState`'s
   *  initializer: Next.js renders the first pass on the server, and
   *  `localStorage` is browser-only — touching it during SSR would throw.
   *  Reading inside a `useEffect` defers the access to the client-only
   *  commit phase, eliminating any SSR/CSR markup mismatch.
   *
   *  The two reads are independent: a corrupt response cache cannot stop
   *  the input text from rehydrating, and vice versa. We only flip
   *  `hasHydratedRef` to `true` *after* both setters have been issued so
   *  the persistence effects below don't fire mid-hydration and clobber
   *  the just-read values with the empty initial state.                       */
  useEffect(() => {
    const persistedResponse = readPersistedResponse();
    if (persistedResponse) {
      setResponse(persistedResponse);
    }

    const persistedInput = readPersistedInput();
    if (persistedInput !== null && persistedInput.length > 0) {
      setDiagramText(persistedInput);
    }

    hasHydratedRef.current = true;
  }, []);

  /* ----- Persistence: backup `response` on every successful estimate -----
   *  This runs whenever `response` changes. We skip the very first run
   *  (the one driven by hydration) so we don't immediately round-trip the
   *  same data back into localStorage. We also skip on `null` so that
   *  transient loading states (`setResponse(null)` inside `handleSubmit`)
   *  don't clobber a previously persisted result — the user can still
   *  refresh mid-request and see the old result rather than a blank page.  */
  useEffect(() => {
    if (!hasHydratedRef.current) return;
    if (response) writePersistedResponse(response);
  }, [response]);

  /* ----- Persistence: mirror `diagramText` into localStorage on edit -----
   *  Symmetric with the response effect above. Two design choices:
   *
   *    1. We persist *every* change — including empty strings — so the
   *       "user explicitly cleared the editor" intent survives a refresh.
   *       Skipping empty writes would mean a refresh resurrects a stale
   *       diagram the user thought they had wiped, which is a worse
   *       UX failure than the occasional redundant write.
   *
   *    2. We do not debounce. localStorage writes are sub-millisecond
   *       SQLite inserts on the main thread; for the keystroke cadence a
   *       human can produce (≤30 Hz peak) the throughput cost is in the
   *       noise. Debouncing would introduce a window during which a
   *       hard refresh resurrects a *stale* edit — a worse failure than
   *       a few microseconds of synchronous I/O per keystroke.
   *
   *  Same `hasHydratedRef` guard as the response effect, so the initial
   *  hydration pass doesn't immediately write the empty-string default
   *  back over what we just read from disk.                                 */
  useEffect(() => {
    if (!hasHydratedRef.current) return;
    writePersistedInput(diagramText);
  }, [diagramText]);

  /* ----- One-shot health check on mount.
     `null` = "unknown", `true` = reachable, `false` = unreachable.
     We use this only to surface a hint banner; the user can still try to
     submit if they want. */
  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then(() => !cancelled && setBackendOnline(true))
      .catch(() => !cancelled && setBackendOnline(false));
    return () => {
      cancelled = true;
    };
  }, []);

  /* ----- Handlers -------------------------------------------------------- */

  const handleSubmit = useCallback(async (diagram: unknown) => {
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const result = await fetchCostEstimate(diagram);
      setResponse(result);
      setActiveTab("dashboard"); // jump back to the overview on every fresh run
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown error";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Fetch the first page of history. Memoized so the `<JSONEditor>` and the
   * header button don't re-mount their handlers gratuitously across renders.
   *
   * We pass `cursor: null` explicitly to reset pagination state every time
   * the drawer is re-opened — otherwise a stale `historyNextCursor` from a
   * previous session would silently skip the newest rows.
   */
  const handleOpenHistory = useCallback(async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await fetchEstimateHistory({
        limit: HISTORY_PAGE_SIZE,
        cursor: null,
      });
      setHistoryItems(data.items);
      setHistoryNextCursor(data.next_cursor);
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : "Failed to load history",
      );
      setHistoryItems([]);
      setHistoryNextCursor(null);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  /**
   * Fetch the *next* keyset page and **append** it to the existing list.
   *
   * Why append instead of replace? UX: the drawer is a continuous scrollable
   * timeline. Replacing the list on every "Load more" click would yank the
   * user's scroll position back to the top of the new page, breaking the
   * mental model of an infinite list.
   *
   * The functional setter `setHistoryItems((prev) => ...)` reads the latest
   * value of `prev` at commit time rather than the value captured by this
   * closure when the callback was created — that protects us against a
   * "stale closure" bug if the user clicks "Load more" twice in quick
   * succession before React has had a chance to re-render.
   *
   * Complexity: O(K) where K is the page size — a single array spread, no
   * dedup pass needed because the keyset cursor guarantees `_id < cursor`
   * (i.e. the new page is strictly disjoint from the previous one).
   */
  const handleLoadMoreHistory = useCallback(async () => {
    if (!historyNextCursor || historyLoadingMore) return;
    setHistoryLoadingMore(true);
    setHistoryError(null);
    try {
      const data = await fetchEstimateHistory({
        limit: HISTORY_PAGE_SIZE,
        cursor: historyNextCursor,
      });
      setHistoryItems((prev) => [...(prev ?? []), ...data.items]);
      setHistoryNextCursor(data.next_cursor);
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : "Failed to load more history",
      );
    } finally {
      setHistoryLoadingMore(false);
    }
  }, [historyNextCursor, historyLoadingMore]);

  const handleCloseHistory = useCallback(() => setHistoryOpen(false), []);

  const handleSelectHistory = useCallback((item: HistoryItem) => {
    // Hydrate the right pane with the historical estimate AND rewind the
    // editor to a placeholder so the user can see what diagram produced it.
    setResponse(item.payload);
    setError(null);
    setActiveTab("dashboard");
    setHistoryOpen(false);
    setDiagramText(
      `// Historical run — diagram_id: ${item.diagram_id}\n` +
        `// captured ${item.created_at}\n` +
        `// (Paste the original diagram JSON here to re-run.)\n`,
    );
  }, []);

  /* ----- Memos ----------------------------------------------------------- */

  const hasResults = response !== null;

  const headerTotal = useMemo(() => {
    if (!response) return null;
    const n = Math.round(response.total_monthly_cost);
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n);
  }, [response]);

  /* ----- Render ---------------------------------------------------------- */

  return (
    <main className="flex min-h-screen flex-col">
      {/* ── Top app bar ──────────────────────────────────────────────── */}
      <AppHeader
        backendOnline={backendOnline}
        onOpenHistory={handleOpenHistory}
        currentTotal={headerTotal}
      />

      {/* ── Split layout — 40% editor / 60% results ─────────────────── */}
      <div className="flex flex-1 flex-col gap-4 px-4 pb-8 pt-4 lg:px-6 xl:flex-row xl:gap-6 xl:px-8">
        {/* Left pane */}
        <section className="xl:w-2/5 xl:max-w-[640px] xl:min-w-[420px]">
          <div className="h-full xl:sticky xl:top-4 xl:h-[calc(100vh-6.5rem)]">
            <JSONEditor
              value={diagramText}
              onChange={setDiagramText}
              onSubmit={handleSubmit}
              isLoading={isLoading}
              error={error}
            />
          </div>
        </section>

        {/* Right pane */}
        <section className="flex-1 xl:w-3/5 min-w-0">
          {isLoading ? (
            <LoadingSkeleton />
          ) : error && !hasResults ? (
            <ErrorPanel
              message={error}
              onRetry={() => setError(null)}
              backendOnline={backendOnline}
            />
          ) : hasResults && response ? (
            <div className="flex flex-col gap-4">
              <TabBar
                activeTab={activeTab}
                onChange={setActiveTab}
                response={response}
              />

              {/* Body — Conditionally render each tab's content. We use a
                 conditional rather than React Suspense lazy chunks because
                 these components are small (<10 KB gzipped each) and
                 always-needed; lazy loading would add latency without
                 saving meaningful bandwidth. */}
              <div className="animate-fade-in">
                {activeTab === "dashboard" ? (
                  <CostDashboard response={response} />
                ) : null}
                {activeTab === "table" ? (
                  <CostTable items={response.final_costs} />
                ) : null}
                {activeTab === "explainer" ? (
                  <ArchitectureExplainer
                    markdown={response.architectural_explanation}
                  />
                ) : null}
              </div>
            </div>
          ) : (
            <EmptyState />
          )}
        </section>
      </div>

      {/* ── History drawer ───────────────────────────────────────────── */}
      <HistoryDrawer
        open={historyOpen}
        items={historyItems}
        loading={historyLoading}
        loadingMore={historyLoadingMore}
        nextCursor={historyNextCursor}
        error={historyError}
        onClose={handleCloseHistory}
        onRefresh={handleOpenHistory}
        onLoadMore={handleLoadMoreHistory}
        onSelect={handleSelectHistory}
      />
    </main>
  );
}

/* ===========================================================================
 *  Top bar
 * ========================================================================= */

function AppHeader({
  backendOnline,
  onOpenHistory,
  currentTotal,
}: {
  backendOnline: boolean | null;
  onOpenHistory: () => void;
  currentTotal: string | null;
}): JSX.Element {
  return (
    <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1800px] items-center justify-between gap-3 px-4 py-3 lg:px-6 xl:px-8">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-indigo-500 text-white shadow-sm">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-none text-ink-900">
              AWS Cost Estimator
            </h1>
            <p className="mt-0.5 text-[11px] text-ink-500">
              LangGraph pipeline · parse → enrich → estimate → explain
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {currentTotal ? (
            <div className="hidden items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200 sm:inline-flex">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {currentTotal} / mo (current)
            </div>
          ) : null}

          <BackendStatusChip online={backendOnline} />

          <button
            type="button"
            onClick={onOpenHistory}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
          >
            <History className="h-3.5 w-3.5" />
            History
          </button>
        </div>
      </div>
    </header>
  );
}

function BackendStatusChip({
  online,
}: {
  online: boolean | null;
}): JSX.Element {
  if (online === null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-ink-100 px-2.5 py-1 text-[11px] font-medium text-ink-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        connecting
      </span>
    );
  }
  if (online) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200"
        title={`API base: ${apiBaseUrl}`}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
        API online
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-lg bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200"
      title={`Unable to reach ${apiBaseUrl}`}
    >
      <ServerCrash className="h-3 w-3" />
      API offline
    </span>
  );
}

/* ===========================================================================
 *  Tab bar (above the results)
 * ========================================================================= */

function TabBar({
  activeTab,
  onChange,
  response,
}: {
  activeTab: TabKey;
  onChange: (tab: TabKey) => void;
  response: EstimateResponse;
}): JSX.Element {
  const itemCount = response.final_costs.length;
  return (
    <nav className="card flex flex-wrap items-center justify-between gap-3 px-2 py-2">
      <div role="tablist" className="flex flex-wrap gap-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              role="tab"
              type="button"
              aria-selected={isActive}
              onClick={() => onChange(tab.key)}
              className={cn(
                "group inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition",
                isActive
                  ? "bg-gradient-to-r from-brand-600 to-indigo-500 text-white shadow-sm"
                  : "text-ink-600 hover:bg-ink-50 hover:text-ink-900",
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4 transition",
                  isActive ? "text-white" : "text-ink-400 group-hover:text-ink-700",
                )}
              />
              <span>{tab.label}</span>
              <span
                className={cn(
                  "hidden text-[10.5px] font-normal opacity-80 sm:inline",
                  isActive ? "text-white/80" : "text-ink-400",
                )}
              >
                · {tab.description}
              </span>
            </button>
          );
        })}
      </div>
      <div className="hidden items-center gap-2 px-2 text-[11px] text-ink-500 sm:flex">
        <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono font-semibold text-ink-700">
          {itemCount}
        </span>
        line items priced
      </div>
    </nav>
  );
}

/* ===========================================================================
 *  Skeleton loader — appears while the estimate is in-flight.
 *
 *  Why a hand-rolled skeleton instead of a generic spinner?
 *    - Layout stability: the user sees the *shape* of the final result
 *      before the data arrives → no jarring jump when content lands.
 *    - Perceived performance: animated shimmer feels faster than a
 *      static spinner even when wall-clock latency is identical.
 *    - Accessibility: `aria-busy="true"` on the wrapper tells screen
 *      readers that this region is loading.
 * ========================================================================= */

function LoadingSkeleton(): JSX.Element {
  return (
    <div aria-busy="true" aria-live="polite" className="flex flex-col gap-4">
      <div className="card flex items-center gap-2 px-3 py-2">
        <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
        <span className="text-xs font-medium text-ink-600">
          Running pipeline…{" "}
          <span className="text-ink-400">
            (parse → enrich → estimate → explain)
          </span>
        </span>
      </div>

      {/* Hero KPI shimmer */}
      <SkeletonCard className="h-44">
        <div className="space-y-3 p-6">
          <SkeletonLine width="35%" />
          <SkeletonLine width="55%" height="40px" />
          <SkeletonLine width="25%" />
        </div>
      </SkeletonCard>

      {/* Category bars shimmer */}
      <SkeletonCard className="h-72">
        <div className="space-y-3 p-6">
          <SkeletonLine width="40%" />
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex justify-between">
                <SkeletonLine width="120px" />
                <SkeletonLine width="70px" />
              </div>
              <SkeletonLine width={`${90 - i * 12}%`} height="10px" rounded />
            </div>
          ))}
        </div>
      </SkeletonCard>
    </div>
  );
}

function SkeletonCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={cn("card relative overflow-hidden", className)}>
      {/* Sliding shimmer overlay */}
      <span aria-hidden="true" className="shimmer-overlay animate-shimmer" />
      {children}
    </div>
  );
}

function SkeletonLine({
  width = "100%",
  height = "14px",
  rounded = true,
}: {
  width?: string;
  height?: string;
  rounded?: boolean;
}): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn("bg-ink-100", rounded ? "rounded-full" : "rounded-md")}
      style={{ width, height }}
    />
  );
}

/* ===========================================================================
 *  Empty + error states
 * ========================================================================= */

function EmptyState(): JSX.Element {
  return (
    <div className="card grid min-h-[60vh] place-items-center p-8 text-center">
      <div className="max-w-md">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-brand-100 to-indigo-100 text-brand-700 shadow-inner">
          <Inbox className="h-6 w-6" />
        </div>
        <h3 className="mt-5 text-xl font-semibold tracking-tight text-ink-900">
          {"Awaiting an architecture diagram"}
        </h3>
        {/*
         * Each conversational segment is wrapped in `{"…"}` rather than
         * placed as bare JSX text. This defends against three real things:
         *   1. **`react/no-unescaped-entities`** — apostrophes, curly
         *      quotes, ampersands, and `>` can trip this rule in different
         *      ESLint preset configurations. A JS string literal sidesteps
         *      the parser entirely so the rule has nothing to flag.
         *   2. **Trailing-whitespace collapse.** JSX merges adjacent
         *      whitespace and strips trailing spaces between tags;
         *      explicit `{"…"}` expressions preserve every byte so the
         *      copy reads exactly as written.
         *   3. **Stable diffs under Prettier.** Bare prose wraps
         *      unpredictably across line widths; string-literal segments
         *      stay on a single token so cosmetic re-indents don't leak
         *      into git history.
         */}
        <p className="mt-2 text-sm text-ink-500">
          {"Paste your proprietary diagram JSON in the editor, drag and drop a file, or click "}
          <span className="font-semibold">{"Load Example"}</span>
          {" for a one-click demo. Once you click "}
          <span className="font-semibold text-brand-700">
            {"Analyze & Estimate Cost"}
          </span>
          {", the LangGraph pipeline will run end-to-end and the dashboard, table, and architectural review will appear here."}
        </p>

        <div className="mt-6 grid grid-cols-3 gap-3 text-xs">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <div
                key={t.key}
                className="rounded-xl border border-ink-200 bg-white/60 p-3 text-left shadow-sm"
              >
                <Icon className="mb-1.5 h-4 w-4 text-brand-600" />
                <div className="font-semibold text-ink-800">{t.label}</div>
                <div className="text-[11px] text-ink-500">{t.description}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ErrorPanel({
  message,
  onRetry,
  backendOnline,
}: {
  message: string;
  onRetry: () => void;
  backendOnline: boolean | null;
}): JSX.Element {
  return (
    <div className="card border-rose-200 bg-rose-50/60 p-8 text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-100 text-rose-600">
        <ServerCrash className="h-6 w-6" />
      </div>
      <h3 className="mt-4 text-lg font-semibold text-rose-900">
        Estimate request failed
      </h3>
      <p className="mt-2 break-words font-mono text-xs text-rose-800/90">
        {message}
      </p>
      {backendOnline === false ? (
        /*
         * Every conversational segment is wrapped in `{"…"}` rather than
         * placed as bare JSX text. Three things this defends against:
         *
         *   1. **react/no-unescaped-entities lint rule.** Apostrophes
         *      (e.g. "isn't"), curly quotes, and a handful of other
         *      glyphs trip this rule when they appear directly inside
         *      JSX text. Wrapping the segment as a JS string literal
         *      sidesteps the parser entirely.
         *   2. **Trailing-whitespace collapse.** JSX collapses adjacent
         *      whitespace and strips trailing spaces between tags;
         *      explicit string expressions preserve every byte so the
         *      copy reads exactly as written.
         *   3. **Stable diffs under Prettier.** Bare text wraps
         *      unpredictably across line widths; string-literal
         *      segments never get re-flowed, so cosmetic re-indents
         *      don't ripple into git history.
         */
        <p className="mt-3 text-xs text-rose-800/80">
          {"The backend at "}
          <span className="font-mono font-semibold">{apiBaseUrl}</span>
          {" is not reachable. Make sure "}
          <code className="rounded bg-rose-100 px-1">uvicorn</code>
          {" is running on port 8000."}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-500"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {" Dismiss & try again"}
      </button>
    </div>
  );
}

/* ===========================================================================
 *  History drawer (slides in from the right)
 *
 *  Why a drawer rather than a separate page?
 *    The user's primary task is *running* estimates; history is a
 *    side-conversation. A peel-out drawer lets them peek at a past run
 *    without losing their current editor state — classic UX for
 *    secondary, browse-only data.
 * ========================================================================= */

function HistoryDrawer({
  open,
  items,
  loading,
  loadingMore,
  nextCursor,
  error,
  onClose,
  onRefresh,
  onLoadMore,
  onSelect,
}: {
  open: boolean;
  items: HistoryItem[] | null;
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onSelect: (item: HistoryItem) => void;
}): JSX.Element {
  // Esc-to-close. Native pattern; we attach to `document` because the focus
  // ring may be inside a child input.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // The "Load more" affordance only makes sense when (a) we already have a
  // first page rendered and (b) the server told us there's another page.
  // `nextCursor === null` from the API is the explicit "end of list"
  // signal under keyset pagination.
  const hasItems = !!items && items.length > 0;
  const canLoadMore = hasItems && nextCursor !== null;

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden={!open}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-ink-950/40 backdrop-blur-sm transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Estimate history"
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-md transform flex-col bg-white shadow-2xl transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-center justify-between border-b border-ink-200 bg-gradient-to-r from-white to-ink-50/60 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-200">
              <Clock className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold leading-none text-ink-900">
                Run History
              </h2>
              <p className="mt-0.5 text-[11px] text-ink-500">
                MongoDB-backed log of previous estimates.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-md p-1.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-800"
              title="Refresh"
              aria-label="Refresh history"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-800"
              title="Close"
              aria-label="Close history drawer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="scrollbar-thin flex-1 overflow-y-auto">
          {loading ? (
            <DrawerLoading />
          ) : error && !hasItems ? (
            <DrawerError message={error} onRetry={onRefresh} />
          ) : !hasItems ? (
            <DrawerEmpty />
          ) : (
            <>
              <ul className="divide-y divide-ink-100">
                {items!.map((item) => (
                  <HistoryRow key={item.id} item={item} onSelect={onSelect} />
                ))}
              </ul>

              {/* Pagination footer — visible whenever the keyset cursor
                  signals another page exists, OR an in-flight "Load more"
                  failed (we surface the error inline rather than blowing
                  away the current list). */}
              {(canLoadMore || error) && (
                <div className="border-t border-ink-100 bg-white px-5 py-3">
                  {error && hasItems ? (
                    <p
                      className="mb-2 break-words font-mono text-[10.5px] text-rose-700"
                      role="alert"
                    >
                      {error}
                    </p>
                  ) : null}
                  {canLoadMore ? (
                    <button
                      type="button"
                      onClick={onLoadMore}
                      disabled={loadingMore}
                      className={cn(
                        "inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-2 text-xs font-semibold text-ink-700 shadow-sm transition",
                        loadingMore
                          ? "cursor-not-allowed opacity-70"
                          : "hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700",
                      )}
                    >
                      {loadingMore ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Loading next page…
                        </>
                      ) : (
                        <>
                          <ChevronDown className="h-3.5 w-3.5" />
                          Load more
                        </>
                      )}
                    </button>
                  ) : null}
                </div>
              )}

              {/* End-of-list sentinel: shown when we've reached the last
                  page (next_cursor === null) so the user knows the list
                  isn't broken — it's just complete. */}
              {hasItems && nextCursor === null ? (
                <p className="px-5 py-3 text-center text-[10.5px] text-ink-400">
                  · End of history ·
                </p>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function HistoryRow({
  item,
  onSelect,
}: {
  item: HistoryItem;
  onSelect: (item: HistoryItem) => void;
}): JSX.Element {
  const total = item.payload?.total_monthly_cost ?? 0;
  const resourceCount = item.payload?.final_costs?.length ?? 0;
  const when = useMemo(() => formatTimestamp(item.created_at), [item.created_at]);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item)}
        className="group flex w-full items-center gap-3 px-5 py-3.5 text-left transition hover:bg-brand-50/60"
      >
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-100 text-ink-500 ring-1 ring-ink-200 group-hover:bg-brand-100 group-hover:text-brand-700 group-hover:ring-brand-200">
          <Clock className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink-900">
            {item.diagram_id}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-ink-500">
            <span>{when}</span>
            <span>·</span>
            <span>
              <span className="font-semibold text-ink-700">
                {resourceCount}
              </span>{" "}
              resources
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-bold tabular-nums text-ink-900">
            ${Math.round(total).toLocaleString("en-US")}
          </div>
          <div className="text-[10px] text-ink-400">/ month</div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-300 group-hover:text-brand-500" />
      </button>
    </li>
  );
}

function DrawerLoading(): JSX.Element {
  return (
    <ul className="divide-y divide-ink-100">
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="flex items-center gap-3 px-5 py-3.5">
          <div className="h-9 w-9 shrink-0 rounded-lg bg-ink-100" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-2/3 rounded bg-ink-100" />
            <div className="h-2 w-1/3 rounded bg-ink-100" />
          </div>
          <div className="h-3 w-12 rounded bg-ink-100" />
        </li>
      ))}
    </ul>
  );
}

function DrawerEmpty(): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div className="max-w-xs">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-ink-100 text-ink-400">
          <Trash2 className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-ink-900">
          No saved runs yet
        </h3>
        {/*
         * Copy reflects the new inline-await persistence model. Each
         * conversational segment is a `{"…"}` string expression so the
         * lint pipeline (`react/no-unescaped-entities`) cannot reject the
         * apostrophe-light prose, and the punctuation can never collapse
         * into the surrounding whitespace.
         */}
        <p className="mt-1 text-[11.5px] text-ink-500">
          {"Once MongoDB is configured ("}
          <span className="font-mono">MONGODB_URI</span>
          {"), every successful estimate is durably persisted "}
          {"(inline await with bounded retries) and will appear here."}
        </p>
      </div>
    </div>
  );
}

function DrawerError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div className="max-w-xs">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-rose-100 text-rose-600">
          <ServerCrash className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-rose-900">
          {"Couldn't load history"}
        </h3>
        <p className="mt-1 break-words font-mono text-[11px] text-rose-800">
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition hover:bg-rose-500"
        >
          <RefreshCw className="h-3 w-3" />
          {" Try again"}
        </button>
      </div>
    </div>
  );
}

/* ===========================================================================
 *  Misc utilities
 * ========================================================================= */

/**
 * Human-friendly timestamp ("3 minutes ago", "yesterday at 14:30", …).
 *
 * Uses the built-in `Intl.RelativeTimeFormat` when the delta is small, and
 * `Intl.DateTimeFormat` for older entries. Falls back to the raw ISO string
 * if either of those fail (e.g. very old Safari).
 */
function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    const now = Date.now();
    const diffMs = now - date.getTime();
    const seconds = Math.round(diffMs / 1000);
    const minutes = Math.round(seconds / 60);
    const hours = Math.round(minutes / 60);
    const days = Math.round(hours / 24);

    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    if (seconds < 60) return rtf.format(-seconds, "second");
    if (minutes < 60) return rtf.format(-minutes, "minute");
    if (hours < 24) return rtf.format(-hours, "hour");
    if (days < 7) return rtf.format(-days, "day");

    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return iso;
  }
}
