"use client";

import { useMemo, useState } from "react";
import {
  ArrowDownAZ,
  ArrowDownUp,
  ArrowUpAZ,
  ChevronRight,
  Search,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/cn";
import type {
  ConfidenceLevel,
  CostEstimateItem,
  EnvironmentTier,
} from "@/types";

/* ===========================================================================
 * Public props
 * ========================================================================= */
export interface CostTableProps {
  items: ReadonlyArray<CostEstimateItem>;
}

/* ===========================================================================
 * Sorting — Strategy pattern
 *
 *  A `SortKey` is the *strategy identifier*; `COMPARATORS` is the registry
 *  that maps a key to a comparison function. The table is sort-agnostic — to
 *  add a new sortable column you register one entry; nothing in the render
 *  function changes. (Open/Closed Principle.)
 *
 *  Big-O: `Array.prototype.sort` uses V8's TimSort, a hybrid merge/insertion
 *  sort that detects already-sorted runs in O(N) and degrades gracefully to
 *  O(N log N) worst case.
 * ========================================================================= */

type SortKey =
  | "title"
  | "service"
  | "account"
  | "monthly_cost_usd"
  | "confidence";

type SortDirection = "asc" | "desc";

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  "High (Infracost)": 0,
  Medium: 1,
  Low: 2,
};

const COMPARATORS: Record<
  SortKey,
  (a: CostEstimateItem, b: CostEstimateItem) => number
> = {
  title: (a, b) => a.title.localeCompare(b.title),
  service: (a, b) => a.service.localeCompare(b.service),
  account: (a, b) => a.account.localeCompare(b.account),
  monthly_cost_usd: (a, b) => a.monthly_cost_usd - b.monthly_cost_usd,
  confidence: (a, b) =>
    CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
};

/* ===========================================================================
 * Formatting helpers — pure, side-effect-free.
 * ========================================================================= */

/**
 * `Intl.NumberFormat` is a Singleton wrapper around the platform's ICU
 * implementation — building a new instance is cheap-ish but not free, so we
 * cache one per locale + style combination at module scope. This is the
 * standard idiom from the V8 perf docs.
 */
const USD_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUsd(value: number): string {
  return USD_FMT.format(value);
}

/* ===========================================================================
 * Confidence + tier badges — Factory functions
 *
 * Each call returns a fully-styled JSX badge from a single enum value. By
 * concentrating the mapping into a single source of truth we ensure the
 * dashboard's KPI cards and the table's badges always show the *same*
 * colors for the same confidence value.
 * ========================================================================= */

const CONFIDENCE_BADGE: Record<
  ConfidenceLevel,
  { label: string; classes: string; icon: typeof ShieldCheck }
> = {
  "High (Infracost)": {
    label: "High",
    classes: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    icon: ShieldCheck,
  },
  Medium: {
    label: "Medium",
    classes: "bg-amber-50 text-amber-800 ring-amber-200",
    icon: Sparkles,
  },
  Low: {
    label: "Low",
    classes: "bg-sky-50 text-sky-700 ring-sky-200",
    icon: ShieldQuestion,
  },
};

function ConfidenceBadge({ level }: { level: ConfidenceLevel }): JSX.Element {
  const cfg = CONFIDENCE_BADGE[level];
  const Icon = cfg.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1",
        cfg.classes,
      )}
      title={level}
    >
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

const TIER_CLASSES: Record<EnvironmentTier, string> = {
  Production: "bg-rose-50 text-rose-700 ring-rose-200",
  Management: "bg-violet-50 text-violet-700 ring-violet-200",
  Deployment: "bg-cyan-50 text-cyan-700 ring-cyan-200",
  "Dev/QA": "bg-teal-50 text-teal-700 ring-teal-200",
  Global: "bg-slate-100 text-slate-700 ring-slate-200",
  Unknown: "bg-slate-50 text-slate-500 ring-slate-200",
};

function TierBadge({ tier }: { tier: EnvironmentTier }): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        TIER_CLASSES[tier],
      )}
    >
      {tier}
    </span>
  );
}

/* ===========================================================================
 * Main component
 * ========================================================================= */

export function CostTable({ items }: CostTableProps): JSX.Element {
  const [sort, setSort] = useState<SortState>({
    key: "monthly_cost_usd",
    direction: "desc",
  });
  const [query, setQuery] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  /* ----- Derived state — memoized -----------------------------------------
   *
   * Sorting + filtering combined runs in O(N + N log N) = O(N log N). With
   * `useMemo`, the result is cached against the (items, query, sort) tuple,
   * so unrelated parent re-renders cost O(1).
   * ------------------------------------------------------------------------- */
  const visibleItems = useMemo<CostEstimateItem[]>(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter((item) => {
          return (
            item.title.toLowerCase().includes(q) ||
            item.service.toLowerCase().includes(q) ||
            (item.region ?? "").toLowerCase().includes(q) ||
            (item.instance_type ?? "").toLowerCase().includes(q) ||
            item.account.toLowerCase().includes(q)
          );
        })
      : [...items];
    const cmp = COMPARATORS[sort.key];
    filtered.sort((a, b) => (sort.direction === "asc" ? cmp(a, b) : -cmp(a, b)));
    return filtered;
  }, [items, query, sort]);

  const grandTotal = useMemo<number>(
    () =>
      visibleItems.reduce(
        (acc, item) => acc + (Number.isFinite(item.monthly_cost_usd) ? item.monthly_cost_usd : 0),
        0,
      ),
    [visibleItems],
  );

  const setSortKey = (key: SortKey): void => {
    setSort((prev) => {
      // Same column clicked twice — flip direction. New column — default to desc
      // for numeric columns (cost), asc for alphabetic ones.
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return {
        key,
        direction: key === "monthly_cost_usd" ? "desc" : "asc",
      };
    });
  };

  const toggleRow = (id: string): void => {
    setExpandedRow((cur) => (cur === id ? null : id));
  };

  /* ----- Render ----------------------------------------------------------- */
  if (items.length === 0) {
    return (
      <div className="card p-10 text-center text-ink-500">
        <p className="text-sm">No cost line items were returned.</p>
      </div>
    );
  }

  return (
    <section className="card overflow-hidden">
      {/* ── Header bar — title + search ─────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 bg-gradient-to-r from-white to-ink-50/60 px-5 py-3.5">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">
            Per-resource cost breakdown
          </h3>
          <p className="mt-0.5 text-xs text-ink-500">
            Showing {visibleItems.length} of {items.length} resources · Sub-total{" "}
            <span className="font-mono font-semibold text-ink-700">
              {formatUsd(grandTotal)}
            </span>
            /mo
          </p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name, service, region…"
            className="form-input w-64 rounded-lg border border-ink-200 bg-white py-1.5 pl-8 pr-3 text-xs text-ink-700 shadow-sm placeholder:text-ink-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          />
        </div>
      </header>

      {/* ── Table itself.  Sticky header + overflow-x-auto handles narrow
            viewports gracefully. ───────────────────────────────────────── */}
      <div className="scrollbar-thin max-h-[640px] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-ink-50/95 backdrop-blur">
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink-500">
              <th className="w-8 px-2 py-2.5" aria-label="Expand row" />
              <SortableHeader
                label="Resource"
                column="title"
                sort={sort}
                onClick={setSortKey}
                className="px-3"
              />
              <SortableHeader
                label="Service"
                column="service"
                sort={sort}
                onClick={setSortKey}
              />
              <SortableHeader
                label="Tier"
                column="account"
                sort={sort}
                onClick={setSortKey}
              />
              <SortableHeader
                label="Confidence"
                column="confidence"
                sort={sort}
                onClick={setSortKey}
              />
              <SortableHeader
                label="USD / month"
                column="monthly_cost_usd"
                sort={sort}
                onClick={setSortKey}
                align="right"
                className="pr-5"
              />
            </tr>
          </thead>

          <tbody className="divide-y divide-ink-100">
            {visibleItems.map((item) => {
              const isOpen = expandedRow === item.resource_id;
              const hasDetail =
                Boolean(item.breakdown) ||
                (Array.isArray(item.assumptions) && item.assumptions.length > 0);

              return (
                <FragmentRow
                  key={item.resource_id}
                  item={item}
                  isOpen={isOpen}
                  hasDetail={hasDetail}
                  onToggle={() => toggleRow(item.resource_id)}
                />
              );
            })}

            {visibleItems.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-10 text-center text-sm text-ink-500"
                >
                  No resources match{" "}
                  <span className="font-mono text-ink-700">&ldquo;{query}&rdquo;</span>
                  .
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ===========================================================================
 * Row component — extracted so the React reconciler can `memo` it later if
 * we ever virtualize the table.
 * ========================================================================= */

interface FragmentRowProps {
  item: CostEstimateItem;
  isOpen: boolean;
  hasDetail: boolean;
  onToggle: () => void;
}

function FragmentRow({
  item,
  isOpen,
  hasDetail,
  onToggle,
}: FragmentRowProps): JSX.Element {
  return (
    <>
      <tr
        onClick={hasDetail ? onToggle : undefined}
        className={cn(
          "group transition-colors",
          hasDetail && "cursor-pointer hover:bg-brand-50/40",
          isOpen && "bg-brand-50/60",
        )}
        title={
          item.breakdown ??
          (hasDetail ? "Click to see assumptions" : undefined)
        }
      >
        <td className="px-2 py-3 align-top">
          {hasDetail ? (
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 text-ink-400 transition-transform",
                isOpen && "rotate-90 text-brand-600",
              )}
            />
          ) : null}
        </td>
        <td className="px-3 py-3 align-top">
          <div className="font-medium text-ink-900">{item.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
            {item.instance_type ? (
              <span className="rounded bg-ink-100 px-1.5 py-px font-mono text-[10.5px] text-ink-700">
                {item.instance_type}
              </span>
            ) : null}
            {item.region ? <span>· {item.region}</span> : null}
            {item.quantity > 1 ? (
              <span className="text-ink-400">× {item.quantity}</span>
            ) : null}
          </div>
        </td>
        <td className="py-3 align-top">
          <span className="rounded-md bg-ink-100/70 px-1.5 py-0.5 font-mono text-[11px] text-ink-700">
            {item.service}
          </span>
        </td>
        <td className="py-3 align-top">
          <TierBadge tier={item.account} />
        </td>
        <td className="py-3 align-top">
          <ConfidenceBadge level={item.confidence} />
        </td>
        <td className="pr-5 py-3 align-top text-right font-mono font-semibold tabular-nums text-ink-900">
          {formatUsd(item.monthly_cost_usd)}
        </td>
      </tr>

      {isOpen && hasDetail ? (
        <tr className="bg-brand-50/30">
          <td />
          <td colSpan={5} className="px-3 pb-4 pt-1">
            <div className="rounded-xl border border-brand-100 bg-white/70 p-4 shadow-inner animate-fade-in">
              {item.breakdown ? (
                <div className="mb-3">
                  <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-brand-700">
                    Breakdown
                  </div>
                  <p className="font-mono text-xs leading-relaxed text-ink-700">
                    {item.breakdown}
                  </p>
                </div>
              ) : null}
              {item.assumptions.length > 0 ? (
                <div>
                  <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-brand-700">
                    Assumptions
                  </div>
                  <ul className="ml-4 list-disc space-y-1 text-xs text-ink-700">
                    {item.assumptions.map((a, idx) => (
                      <li key={idx}>{a}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* ===========================================================================
 *  Sortable column header.
 * ========================================================================= */

interface SortableHeaderProps {
  label: string;
  column: SortKey;
  sort: SortState;
  onClick: (key: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}

function SortableHeader({
  label,
  column,
  sort,
  onClick,
  align = "left",
  className,
}: SortableHeaderProps): JSX.Element {
  const active = sort.key === column;
  const Icon = !active ? ArrowDownUp : sort.direction === "asc" ? ArrowUpAZ : ArrowDownAZ;
  return (
    <th
      scope="col"
      className={cn(
        "py-2.5 font-semibold",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onClick(column)}
        className={cn(
          "inline-flex items-center gap-1 rounded transition hover:text-ink-800",
          active && "text-brand-600",
        )}
      >
        {align === "right" && <Icon className="h-3 w-3" />}
        <span>{label}</span>
        {align === "left" && <Icon className="h-3 w-3" />}
      </button>
    </th>
  );
}
