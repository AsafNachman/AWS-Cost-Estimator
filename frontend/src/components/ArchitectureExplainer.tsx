"use client";

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  Cpu,
  Database,
  FileText,
  Layers,
  LineChart,
  Network,
  Shield,
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/cn";

/* ===========================================================================
 *  Props
 * ========================================================================= */

export interface ArchitectureExplainerProps {
  markdown: string;
}

/* ===========================================================================
 *  Section taxonomy — Strategy registry.
 *
 *  Each row is `(category-label, heading-regex, icon, accent)`. The first
 *  row whose regex matches the H2 heading wins. This is the canonical
 *  "ordered first-match" routing strategy — same idea as middleware chains
 *  or Express route tables.
 *
 *  Adding a new section concern is a one-row edit; the parser and renderer
 *  loop over this array without further branching. (Open/Closed.)
 * ========================================================================= */

interface CategoryDef {
  key: string;
  label: string;
  icon: typeof Cpu;
  /** Tailwind classes for the icon pill + accent stripe. */
  accent: {
    pill: string;
    stripe: string;
    ring: string;
  };
  matcher: RegExp;
}

const CATEGORY_DEFS: ReadonlyArray<CategoryDef> = [
  {
    key: "overview",
    label: "Overview",
    icon: FileText,
    accent: {
      pill: "bg-brand-50 text-brand-700",
      stripe: "from-brand-500 to-indigo-500",
      ring: "ring-brand-200",
    },
    matcher: /^\s*(architecture\s+overview|tl;?dr|tldr|overview|summary|executive\s+summary)/i,
  },
  {
    key: "compute",
    label: "Compute",
    icon: Cpu,
    accent: {
      pill: "bg-indigo-50 text-indigo-700",
      stripe: "from-indigo-500 to-violet-500",
      ring: "ring-indigo-200",
    },
    matcher: /^\s*compute/i,
  },
  {
    key: "storage",
    label: "Storage & Databases",
    icon: Database,
    accent: {
      pill: "bg-amber-50 text-amber-800",
      stripe: "from-amber-500 to-orange-500",
      ring: "ring-amber-200",
    },
    matcher: /^\s*(storage|database|data\s+layer)/i,
  },
  {
    key: "networking",
    label: "Networking",
    icon: Network,
    accent: {
      pill: "bg-sky-50 text-sky-700",
      stripe: "from-sky-500 to-cyan-500",
      ring: "ring-sky-200",
    },
    matcher: /^\s*(networking|network|connectivity|traffic)/i,
  },
  {
    key: "security",
    label: "Security & Compliance",
    icon: Shield,
    accent: {
      pill: "bg-rose-50 text-rose-700",
      stripe: "from-rose-500 to-red-500",
      ring: "ring-rose-200",
    },
    matcher: /^\s*(security|compliance|identity|access)/i,
  },
  {
    key: "analytics",
    label: "Analytics",
    icon: LineChart,
    accent: {
      pill: "bg-emerald-50 text-emerald-700",
      stripe: "from-emerald-500 to-teal-500",
      ring: "ring-emerald-200",
    },
    matcher: /^\s*(analytics|data\s+warehouse|reporting|bi)/i,
  },
  {
    key: "observability",
    label: "Observability",
    icon: Activity,
    accent: {
      pill: "bg-slate-100 text-slate-700",
      stripe: "from-slate-500 to-slate-700",
      ring: "ring-slate-300",
    },
    matcher: /^\s*(observability|monitoring|telemetry|logging)/i,
  },
  {
    key: "patterns",
    label: "Architectural Patterns",
    icon: Layers,
    accent: {
      pill: "bg-fuchsia-50 text-fuchsia-700",
      stripe: "from-fuchsia-500 to-pink-500",
      ring: "ring-fuchsia-200",
    },
    matcher: /^\s*(architectural\s+patterns?|patterns?\s+observed|design\s+patterns?)/i,
  },
  {
    key: "risks",
    label: "Risks & Recommendations",
    icon: AlertTriangle,
    accent: {
      pill: "bg-orange-50 text-orange-700",
      stripe: "from-orange-500 to-rose-500",
      ring: "ring-orange-200",
    },
    matcher: /^\s*(notable\s+risks?|risks?\s+(and|&)\s+recommendations?|recommendations?|risks?)/i,
  },
];

const FALLBACK_CATEGORY: CategoryDef = {
  key: "other",
  label: "Other",
  icon: Sparkles,
  accent: {
    pill: "bg-zinc-100 text-zinc-700",
    stripe: "from-zinc-400 to-zinc-600",
    ring: "ring-zinc-200",
  },
  matcher: /.*/,
};

/* ===========================================================================
 *  Markdown sectionizer — one pass over the line stream.
 *
 *  Why parse the markdown ourselves instead of letting `react-markdown` do
 *  it? We need *structural* access to the H2-bounded sections so we can put
 *  each one inside its own collapsible panel. `react-markdown` is great at
 *  rendering, but it gives us a flat HAST tree at the React level. A
 *  pre-pass is simpler and runs in **O(N)** over the line count — well
 *  within budget for any reasonable explanation length.
 *
 *  We deliberately retain the H2 itself in the section body so users can
 *  still see it (styled by `prose`) — but we move it into the accordion
 *  trigger when collapsed.
 * ========================================================================= */

interface ParsedSection {
  /** Original H2 text from the markdown (or "Introduction" if pre-H2). */
  heading: string;
  /** Markdown body *without* its leading H2 line (we render that ourselves). */
  body: string;
  category: CategoryDef;
}

/**
 * Heading regex — anchored to start-of-line and tolerant of trailing
 * whitespace. `m` flag means `^/$` match per-line, not just per-string.
 * `multiline: true` would be required on Node < 14 but is unnecessary in
 * modern JS engines as long as the `m` flag is present.
 */
const H2_REGEX = /^##\s+(.+?)\s*$/m;

function classifyHeading(heading: string): CategoryDef {
  for (const cat of CATEGORY_DEFS) {
    if (cat.matcher.test(heading)) return cat;
  }
  return FALLBACK_CATEGORY;
}

/**
 * Split a Markdown string into `ParsedSection` objects bounded by `## `
 * level-2 headings.
 *
 * Algorithm: a single linear scan over the lines, accumulating into a
 * mutable buffer. We emit the buffered chunk whenever we cross an H2
 * boundary (or hit EOF). **O(N)** in the line count, **O(N)** in memory.
 */
function sectionize(markdown: string): ParsedSection[] {
  if (!markdown.trim()) return [];

  const lines = markdown.split(/\r?\n/);
  const sections: ParsedSection[] = [];

  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  const flush = (): void => {
    if (currentHeading === null && currentBody.every((l) => !l.trim())) return;
    const heading = currentHeading ?? "Introduction";
    const body = currentBody.join("\n").trim();
    if (!body && !currentHeading) return; // skip empty preamble
    sections.push({
      heading,
      body,
      category: classifyHeading(heading),
    });
  };

  for (const line of lines) {
    const match = H2_REGEX.exec(line);
    if (match) {
      // The match is anchored — `match[1]` is guaranteed to be a string.
      const heading = match[1] ?? "";
      flush();
      currentHeading = heading;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return sections;
}

/* ===========================================================================
 *  Main component
 * ========================================================================= */

type ViewMode = "accordion" | "tabs";

export function ArchitectureExplainer({
  markdown,
}: ArchitectureExplainerProps): JSX.Element {
  const sections = useMemo(() => sectionize(markdown), [markdown]);

  // Default to "all open" so the user sees everything at first glance.
  // `Set<string>` gives O(1) add/has/delete; using a `Record<string, boolean>`
  // would force us to deep-clone for every toggle, which is needlessly
  // expensive at scale.
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    sections.forEach((_, idx) => initial.add(String(idx)));
    return initial;
  });

  const [mode, setMode] = useState<ViewMode>("accordion");
  const [activeTab, setActiveTab] = useState<number>(0);

  const toggle = (key: string): void => {
    setOpenKeys((prev) => {
      // Immutable update — React's `useState` does a referential equality
      // check, so returning the *same* Set would skip the re-render.
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandAll = (): void =>
    setOpenKeys(new Set(sections.map((_, i) => String(i))));
  const collapseAll = (): void => setOpenKeys(new Set());

  if (sections.length === 0) {
    return (
      <div className="card p-10 text-center text-ink-500">
        <p className="text-sm">No architectural explanation was generated.</p>
      </div>
    );
  }

  return (
    <section className="card overflow-hidden">
      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 bg-gradient-to-r from-white to-ink-50/60 px-5 py-3.5">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">
            Architectural Review
          </h3>
          <p className="mt-0.5 text-xs text-ink-500">
            Plain-language explanation grouped by operational concern.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-lg border border-ink-200 bg-white p-0.5 shadow-sm">
            <ViewToggle
              active={mode === "accordion"}
              onClick={() => setMode("accordion")}
              label="Accordion"
            />
            <ViewToggle
              active={mode === "tabs"}
              onClick={() => setMode("tabs")}
              label="Tabs"
            />
          </div>

          {mode === "accordion" ? (
            <>
              <button
                type="button"
                onClick={expandAll}
                className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-ink-600 shadow-sm hover:bg-brand-50 hover:text-brand-700"
              >
                Expand all
              </button>
              <button
                type="button"
                onClick={collapseAll}
                className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-ink-600 shadow-sm hover:bg-brand-50 hover:text-brand-700"
              >
                Collapse all
              </button>
            </>
          ) : null}
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────── */}
      {mode === "accordion" ? (
        <div className="divide-y divide-ink-100">
          {sections.map((section, idx) => {
            const isOpen = openKeys.has(String(idx));
            return (
              <AccordionPanel
                key={`${section.category.key}-${idx}`}
                section={section}
                isOpen={isOpen}
                onToggle={() => toggle(String(idx))}
              />
            );
          })}
        </div>
      ) : (
        <TabsView
          sections={sections}
          activeIndex={activeTab}
          onChange={setActiveTab}
        />
      )}
    </section>
  );
}

/* ===========================================================================
 *  Sub-components
 * ========================================================================= */

function ViewToggle({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md px-2.5 py-1 text-[11px] font-semibold transition",
        active
          ? "bg-brand-600 text-white shadow-sm"
          : "text-ink-600 hover:text-ink-800",
      )}
    >
      {label}
    </button>
  );
}

function AccordionPanel({
  section,
  isOpen,
  onToggle,
}: {
  section: ParsedSection;
  isOpen: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { category, heading, body } = section;
  const Icon = category.icon;

  return (
    <div className="group">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className={cn(
          "relative flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors",
          isOpen ? "bg-white" : "hover:bg-ink-50/60",
        )}
      >
        {/* Left accent stripe */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-1 left-0 w-1 rounded-r-full bg-gradient-to-b",
            category.accent.stripe,
            isOpen ? "opacity-100" : "opacity-40 group-hover:opacity-80",
          )}
        />

        <span
          className={cn(
            "grid h-9 w-9 place-items-center rounded-lg ring-1 ring-inset",
            category.accent.pill,
            category.accent.ring,
          )}
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-400">
            {category.label}
          </div>
          <div className="truncate text-sm font-semibold text-ink-900">
            {heading}
          </div>
        </div>

        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-ink-400 transition-transform",
            isOpen && "rotate-180 text-brand-600",
          )}
        />
      </button>

      {isOpen ? (
        <div className="animate-fade-in border-t border-ink-100 bg-white px-5 pb-6 pt-4">
          <MarkdownBody markdown={body} />
        </div>
      ) : null}
    </div>
  );
}

function TabsView({
  sections,
  activeIndex,
  onChange,
}: {
  sections: ReadonlyArray<ParsedSection>;
  activeIndex: number;
  onChange: (idx: number) => void;
}): JSX.Element {
  const safeIndex = Math.min(activeIndex, sections.length - 1);
  const active = sections[safeIndex];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Architecture sections"
        className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-ink-100 bg-ink-50/60 px-3 py-2"
      >
        {sections.map((s, idx) => {
          const Icon = s.category.icon;
          const isActive = idx === safeIndex;
          return (
            <button
              key={`${s.category.key}-${idx}`}
              role="tab"
              type="button"
              aria-selected={isActive}
              onClick={() => onChange(idx)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                isActive
                  ? "bg-white text-ink-900 shadow-sm ring-1 ring-ink-200"
                  : "text-ink-500 hover:text-ink-800",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {s.category.label}
            </button>
          );
        })}
      </div>
      <div className="px-5 py-5">
        {active ? (
          <>
            <div className="mb-3 text-[10.5px] font-semibold uppercase tracking-wider text-ink-400">
              {active.category.label}
            </div>
            <MarkdownBody markdown={active.body} headingTitle={active.heading} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Wrapper around `<ReactMarkdown>` configured for our `prose` styling.
 *
 * `react-markdown` pipeline (Visitor pattern across two ASTs)
 * -----------------------------------------------------------
 * 1. **`micromark`** tokenizes the Markdown string with a state-machine
 *    that handles CommonMark + GFM tokens (one byte at a time, no
 *    backtracking — runs at ~250 MB/s).
 * 2. **`mdast-util-from-markdown`** turns the token stream into an `mdast`
 *    AST (Markdown AST — `root`, `paragraph`, `heading`, …).
 * 3. **`remark-rehype`** transforms the `mdast` into a `hast` AST (HTML
 *    AST — `element`, `text`, …) — this is where Markdown's structural
 *    nodes become HTML element nodes.
 * 4. **`react-markdown` visitor** walks the `hast` and emits a React
 *    element per node, allowing us to override individual element types
 *    via the `components` prop.
 *
 * The whole pipeline is O(N) over the source text and bounded in memory
 * by the tree depth.
 */
function MarkdownBody({
  markdown,
  headingTitle,
}: {
  markdown: string;
  headingTitle?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none",
        "prose-headings:font-semibold prose-headings:text-ink-900",
        "prose-h1:text-xl prose-h2:text-base prose-h3:text-sm",
        "prose-p:text-ink-700 prose-li:text-ink-700",
        "prose-strong:text-ink-900",
        "prose-code:rounded prose-code:bg-ink-100 prose-code:px-1 prose-code:py-px prose-code:text-[12.5px] prose-code:font-mono prose-code:text-brand-700 prose-code:before:hidden prose-code:after:hidden",
        "prose-blockquote:not-italic prose-blockquote:border-l-brand-300 prose-blockquote:bg-brand-50/40 prose-blockquote:py-1 prose-blockquote:pr-2 prose-blockquote:rounded-r-md prose-blockquote:text-ink-700",
        "prose-a:text-brand-700 hover:prose-a:text-brand-600",
        "prose-hr:border-ink-200",
      )}
    >
      {headingTitle ? (
        <h2 className="!mt-0 !mb-3 text-base font-semibold text-ink-900">
          {headingTitle}
        </h2>
      ) : null}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}
