"use client";

import { useMemo } from "react";
import {
  AlertCircle,
  CircleDollarSign,
  Cpu,
  Database,
  HardDrive,
  LineChart,
  Network,
  Shield,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";

import { cn } from "@/lib/cn";
import type {
  ConfidenceLevel,
  CostCategory,
  CostEstimateItem,
  EstimateResponse,
} from "@/types";

/* ===========================================================================
 * Props
 * ========================================================================= */
export interface CostDashboardProps {
  response: EstimateResponse;
}

/* ===========================================================================
 * Categorization — Strategy pattern
 *
 *   Each canonical service name (`item.service`, see backend parser.py) is
 *   mapped to a CostCategory. The lookup is O(1) via the hash table below.
 *   Anything we don't recognize falls through to "Other".
 *
 *   Adding a new category is a localized one-line change here — no other
 *   component needs to know. (Open/Closed.)
 * ========================================================================= */

const SERVICE_TO_CATEGORY: Record<string, CostCategory> = {
  // Compute
  beanstalk: "Compute",
  ec2: "Compute",
  "ec2-bastion": "Compute",
  jenkins: "Compute",
  "sophos-utm": "Compute",
  lambda: "Compute",

  // Database
  aurora: "Database",
  elasticache: "Database",
  rds: "Database",
  dynamodb: "Database",
  dms: "Database",

  // Storage
  s3: "Storage",
  efs: "Storage",
  ebs: "Storage",
  backup: "Storage",
  glacier: "Storage",

  // Networking
  elb: "Networking",
  "transit-gateway": "Networking",
  "nat-gateway": "Networking",
  "internet-gateway": "Networking",
  "privatelink": "Networking",
  cloudfront: "Networking",
  route53: "Networking",
  "api-gateway": "Networking",

  // Security
  waf: "Security",
  shield: "Security",
  kms: "Security",
  "secrets-manager": "Security",
  guardduty: "Security",
  inspector: "Security",
  "security-hub": "Security",
  cloudtrail: "Security",
  "certificate-manager": "Security",
  iam: "Security",
  "audit-manager": "Security",
  organizations: "Security",
  "control-tower": "Security",
  "iam-identity-center": "Security",

  // Analytics
  redshift: "Analytics",
  glue: "Analytics",
  athena: "Analytics",
  quicksight: "Analytics",
  firehose: "Analytics",
  kinesis: "Analytics",
  "step-functions": "Analytics",

  // Observability
  cloudwatch: "Observability",
  xray: "Observability",
  sns: "Observability",
  sqs: "Observability",
  datadog: "Observability",
  budgets: "Observability",
  "compute-optimizer": "Observability",
};

/**
 * O(1) — but with one fallback layer that fuzzy-matches the *prefix* so
 * unrecognized SKUs like `"aurora-postgres"` still land in the right bucket.
 */
function categoryFor(service: string): CostCategory {
  const lower = service.toLowerCase();
  if (SERVICE_TO_CATEGORY[lower]) return SERVICE_TO_CATEGORY[lower];
  for (const [key, cat] of Object.entries(SERVICE_TO_CATEGORY)) {
    if (lower.startsWith(key) || lower.includes(key)) return cat;
  }
  return "Other";
}

/* ===========================================================================
 * Visual config per category — single source of truth keeps the bars,
 * dots, and labels all using the same color.
 * ========================================================================= */

const CATEGORY_STYLE: Record<
  CostCategory,
  { icon: typeof Cpu; bar: string; dot: string; text: string; chip: string }
> = {
  Compute: {
    icon: Cpu,
    bar: "from-indigo-500 to-violet-500",
    dot: "bg-indigo-500",
    text: "text-indigo-700",
    chip: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  },
  Database: {
    icon: Database,
    bar: "from-fuchsia-500 to-pink-500",
    dot: "bg-fuchsia-500",
    text: "text-fuchsia-700",
    chip: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",
  },
  Storage: {
    icon: HardDrive,
    bar: "from-amber-400 to-orange-500",
    dot: "bg-amber-500",
    text: "text-amber-700",
    chip: "bg-amber-50 text-amber-800 ring-amber-200",
  },
  Networking: {
    icon: Network,
    bar: "from-sky-500 to-cyan-500",
    dot: "bg-sky-500",
    text: "text-sky-700",
    chip: "bg-sky-50 text-sky-700 ring-sky-200",
  },
  Security: {
    icon: Shield,
    bar: "from-rose-500 to-red-500",
    dot: "bg-rose-500",
    text: "text-rose-700",
    chip: "bg-rose-50 text-rose-700 ring-rose-200",
  },
  Analytics: {
    icon: LineChart,
    bar: "from-emerald-500 to-teal-500",
    dot: "bg-emerald-500",
    text: "text-emerald-700",
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  Observability: {
    icon: TrendingUp,
    bar: "from-slate-500 to-slate-700",
    dot: "bg-slate-500",
    text: "text-slate-700",
    chip: "bg-slate-100 text-slate-700 ring-slate-300",
  },
  Other: {
    icon: Sparkles,
    bar: "from-zinc-400 to-zinc-600",
    dot: "bg-zinc-400",
    text: "text-zinc-600",
    chip: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  },
};

const CATEGORY_ORDER: ReadonlyArray<CostCategory> = [
  "Compute",
  "Database",
  "Storage",
  "Networking",
  "Security",
  "Analytics",
  "Observability",
  "Other",
];

/* ===========================================================================
 * Aggregations — pure functions, easy to test in isolation.
 *
 * `aggregateByCategory` is a single O(N) pass that builds a hash-map; this
 * is the textbook "group-by" reduction. The output is sorted client-side by
 * descending total (an O(K log K) op where K ≤ 8 categories).
 * ========================================================================= */

interface CategoryRow {
  category: CostCategory;
  total: number;
  count: number;
}

function aggregateByCategory(
  items: ReadonlyArray<CostEstimateItem>,
): CategoryRow[] {
  const totals = new Map<CostCategory, CategoryRow>();
  for (const item of items) {
    const cat = categoryFor(item.service);
    const cost = Number.isFinite(item.monthly_cost_usd)
      ? item.monthly_cost_usd
      : 0;
    const existing = totals.get(cat);
    if (existing) {
      existing.total += cost;
      existing.count += 1;
    } else {
      totals.set(cat, { category: cat, total: cost, count: 1 });
    }
  }
  return Array.from(totals.values()).sort((a, b) => b.total - a.total);
}

interface ConfidenceCounts {
  high: number;
  medium: number;
  low: number;
  total: number;
  /** Cost-weighted percentage of "High (Infracost)" — the global score. */
  scorePercent: number;
}

/**
 * Why cost-weighted instead of count-weighted? A user with 1 huge expensive
 * EC2 instance ("High") and 30 tiny KMS keys ("Medium") should see a high
 * confidence score because the *dollars at stake* are well-estimated even
 * though the count is uneven. Weighting by cost matches user intuition.
 */
function confidenceStats(
  items: ReadonlyArray<CostEstimateItem>,
): ConfidenceCounts {
  let high = 0;
  let medium = 0;
  let low = 0;
  let weightedHigh = 0;
  let weightedTotal = 0;
  for (const item of items) {
    const cost = Math.max(0, item.monthly_cost_usd);
    weightedTotal += cost;
    switch (item.confidence) {
      case "High (Infracost)":
        high += 1;
        weightedHigh += cost;
        break;
      case "Medium":
        medium += 1;
        break;
      case "Low":
        low += 1;
        break;
    }
  }
  const scorePercent =
    weightedTotal > 0 ? (weightedHigh / weightedTotal) * 100 : 0;
  return { high, medium, low, total: items.length, scorePercent };
}

/* ===========================================================================
 * Currency formatter — locale-aware via ICU under the hood.
 * ========================================================================= */
const USD_BIG = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const USD_SMALL = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const fmtBig = (n: number): string => USD_BIG.format(Math.round(n));
const fmtSmall = (n: number): string => USD_SMALL.format(n);

/* ===========================================================================
 * Main component
 * ========================================================================= */

export function CostDashboard({ response }: CostDashboardProps): JSX.Element {
  const { final_costs, total_monthly_cost, errors } = response;

  const categoryRows = useMemo(() => aggregateByCategory(final_costs), [final_costs]);
  const confidence = useMemo(() => confidenceStats(final_costs), [final_costs]);
  const maxCategoryTotal = categoryRows[0]?.total ?? 0;
  const annualCost = total_monthly_cost * 12;

  const topThree = useMemo(
    () => [...final_costs].sort((a, b) => b.monthly_cost_usd - a.monthly_cost_usd).slice(0, 3),
    [final_costs],
  );

  return (
    <div className="flex flex-col gap-5">
      {/* ── Hero KPI card ─────────────────────────────────────────────── */}
      <section className="card relative overflow-hidden p-6 sm:p-8">
        {/* Decorative orbs */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-gradient-to-br from-brand-400/40 via-indigo-400/20 to-transparent blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-gradient-to-tr from-sky-400/30 via-cyan-300/10 to-transparent blur-3xl"
        />

        <div className="relative flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand-700">
              <CircleDollarSign className="h-3.5 w-3.5" />
              Total Estimated Monthly Cost
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="font-mono text-5xl font-bold tabular-nums text-ink-900 sm:text-6xl">
                {fmtBig(total_monthly_cost)}
              </span>
              <span className="text-sm font-medium text-ink-500">
                / month
              </span>
            </div>
            <div className="mt-1 text-sm text-ink-500">
              <span className="font-semibold text-ink-700">
                {fmtBig(annualCost)}
              </span>{" "}
              projected annually · {final_costs.length} resources priced
            </div>
          </div>

          <ConfidenceGauge stats={confidence} />
        </div>

        {/* Top spenders strip */}
        {topThree.length > 0 ? (
          <div className="relative mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {topThree.map((t, idx) => (
              <TopSpenderTile key={t.resource_id} rank={idx + 1} item={t} />
            ))}
          </div>
        ) : null}
      </section>

      {/* ── Category breakdown ───────────────────────────────────────── */}
      <section className="card p-6">
        <header className="mb-5 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">
              Cost Distribution by Category
            </h3>
            <p className="mt-0.5 text-xs text-ink-500">
              Where every dollar goes — grouped by operational concern.
            </p>
          </div>
          <span className="rounded-full bg-ink-100 px-2.5 py-1 text-[11px] font-medium text-ink-600">
            {categoryRows.length} categor{categoryRows.length === 1 ? "y" : "ies"}
          </span>
        </header>

        <div className="space-y-3.5">
          {CATEGORY_ORDER.filter((cat) =>
            categoryRows.some((r) => r.category === cat),
          ).map((cat) => {
            const row = categoryRows.find((r) => r.category === cat);
            if (!row) return null;
            const pctOfTotal =
              total_monthly_cost > 0
                ? (row.total / total_monthly_cost) * 100
                : 0;
            const widthPct =
              maxCategoryTotal > 0 ? (row.total / maxCategoryTotal) * 100 : 0;
            return (
              <CategoryBar
                key={cat}
                row={row}
                widthPercent={widthPct}
                shareOfTotal={pctOfTotal}
              />
            );
          })}
        </div>
      </section>

      {/* ── Non-fatal pipeline errors ────────────────────────────────── */}
      {errors.length > 0 ? (
        <section className="card border-amber-200 bg-amber-50/60 p-5">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
            <div>
              <h4 className="text-sm font-semibold text-amber-900">
                Pipeline produced {errors.length} non-fatal warning
                {errors.length === 1 ? "" : "s"}
              </h4>
              <ul className="mt-2 space-y-1 text-xs text-amber-900/80">
                {errors.slice(0, 5).map((e, i) => (
                  <li key={i} className="font-mono">
                    • {e}
                  </li>
                ))}
                {errors.length > 5 ? (
                  <li className="italic">
                    …and {errors.length - 5} more.
                  </li>
                ) : null}
              </ul>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ===========================================================================
 *  Sub-components
 * ========================================================================= */

function CategoryBar({
  row,
  widthPercent,
  shareOfTotal,
}: {
  row: CategoryRow;
  widthPercent: number;
  shareOfTotal: number;
}): JSX.Element {
  const style = CATEGORY_STYLE[row.category];
  const Icon = style.icon;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "grid h-7 w-7 place-items-center rounded-md ring-1 ring-inset",
              style.chip,
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-semibold text-ink-800">
            {row.category}
          </span>
          <span className="text-xs text-ink-400">
            {row.count} resource{row.count === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold tabular-nums text-ink-900">
            {fmtSmall(row.total)}
          </span>
          <span className={cn("text-xs font-medium", style.text)}>
            {shareOfTotal.toFixed(1)}%
          </span>
        </div>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink-100">
        <div
          role="progressbar"
          aria-valuenow={Math.round(widthPercent)}
          aria-valuemin={0}
          aria-valuemax={100}
          className={cn(
            "h-full rounded-full bg-gradient-to-r transition-all duration-700 ease-out",
            style.bar,
          )}
          style={{ width: `${Math.max(widthPercent, 1.5)}%` }}
        />
      </div>
    </div>
  );
}

function TopSpenderTile({
  rank,
  item,
}: {
  rank: number;
  item: CostEstimateItem;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-200 bg-white/80 p-3 shadow-sm">
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-brand-100 to-indigo-100 text-xs font-bold text-brand-700 ring-1 ring-brand-200">
        #{rank}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-ink-900">
          {item.title}
        </div>
        <div className="truncate text-xs text-ink-500">
          {item.service}
          {item.instance_type ? ` · ${item.instance_type}` : ""}
        </div>
      </div>
      <div className="text-right font-mono text-sm font-bold tabular-nums text-ink-900">
        {fmtSmall(item.monthly_cost_usd)}
      </div>
    </div>
  );
}

/* ===========================================================================
 *  Confidence Gauge — the global "Cost Confidence Score Indicator".
 *
 *  Renders a circular SVG ring whose filled arc is proportional to the
 *  cost-weighted percentage of "High" confidence line items. Pure SVG
 *  (no charting library) — < 1 KB after gzip and infinitely customizable.
 * ========================================================================= */

function ConfidenceGauge({
  stats,
}: {
  stats: ConfidenceCounts;
}): JSX.Element {
  const pct = Math.max(0, Math.min(100, stats.scorePercent));
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const dash = (pct / 100) * circumference;
  const tier: ConfidenceLevel =
    pct >= 70 ? "High (Infracost)" : pct >= 40 ? "Medium" : "Low";
  const ringColor =
    tier === "High (Infracost)"
      ? "stroke-emerald-500"
      : tier === "Medium"
        ? "stroke-amber-500"
        : "stroke-sky-500";
  const ringIcon =
    tier === "High (Infracost)" ? (
      <ShieldCheck className="h-4 w-4 text-emerald-600" />
    ) : tier === "Medium" ? (
      <Sparkles className="h-4 w-4 text-amber-600" />
    ) : (
      <AlertCircle className="h-4 w-4 text-sky-600" />
    );

  return (
    <div className="flex items-center gap-4 rounded-2xl border border-ink-200 bg-white/70 px-4 py-3 shadow-sm">
      <div className="relative h-24 w-24">
        <svg viewBox="0 0 100 100" className="-rotate-90">
          <circle
            cx="50"
            cy="50"
            r={radius}
            className="fill-none stroke-ink-100"
            strokeWidth="10"
          />
          <circle
            cx="50"
            cy="50"
            r={radius}
            className={cn("fill-none transition-all duration-700", ringColor)}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference - dash}`}
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center">
            <div className="font-mono text-xl font-bold tabular-nums text-ink-900">
              {pct.toFixed(0)}%
            </div>
            <div className="text-[10px] uppercase tracking-wider text-ink-400">
              grounded
            </div>
          </div>
        </div>
      </div>
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-1.5">
          {ringIcon}
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-600">
            Cost Confidence
          </span>
        </div>
        <div className="space-y-1 text-[11px] text-ink-600">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span className="font-medium">{stats.high}</span> high
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            <span className="font-medium">{stats.medium}</span> medium
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
            <span className="font-medium">{stats.low}</span> low
          </div>
        </div>
      </div>
    </div>
  );
}
