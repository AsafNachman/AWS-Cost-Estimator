"use client";

import {
  ChangeEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FileJson,
  Loader2,
  RotateCcw,
  Sparkles,
  Upload,
  Wand2,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { EXAMPLE_DIAGRAMS } from "@/data/examples";

/* ---------------------------------------------------------------------------
 * Component props (Controlled component — value lives in the parent).
 *
 * Controlled vs. uncontrolled trade-off
 * -------------------------------------
 * A controlled <textarea> requires `value` + `onChange` from the parent and
 * lets us mutate the editor contents from elsewhere (e.g. when the user
 * clicks a history row in the side drawer). Uncontrolled would be slightly
 * cheaper render-wise but would prevent that programmatic mutation — a
 * worse UX trade.
 * ------------------------------------------------------------------------- */
export interface JSONEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (parsedDiagram: unknown) => void;
  isLoading?: boolean;
  /** Surfaced from the parent so we can tag the submit button if the
   *  most-recent request failed. */
  error?: string | null;
}

/**
 * Validation result returned by `validateJson`. A small ADT (algebraic data
 * type) so consumers can pattern-match on `.kind`.
 */
type ValidationResult =
  | { kind: "empty" }
  | { kind: "valid"; data: unknown; nodeCount: number; edgeCount: number }
  | { kind: "invalid"; message: string };

/**
 * Pure function — given a raw text blob, return a tagged status describing
 * what kind of JSON it is (if any). Pure functions are trivially testable
 * and never trigger re-renders by themselves.
 *
 * Complexity: O(N) where N = number of characters (the underlying
 * `JSON.parse` uses a single-pass recursive-descent parser implemented in
 * C++/V8 — roughly 250 MB/s on modern hardware).
 */
function validateJson(text: string): ValidationResult {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };

  try {
    const data = JSON.parse(trimmed) as unknown;
    if (!data || typeof data !== "object") {
      return { kind: "invalid", message: "Top-level JSON must be an object." };
    }
    const root = data as Record<string, unknown>;
    const inner = (root["diagram"] as Record<string, unknown> | undefined) ?? root;
    const nodes = Array.isArray(inner["nodes"])
      ? (inner["nodes"] as unknown[])
      : [];
    const edges = Array.isArray(inner["edges"])
      ? (inner["edges"] as unknown[])
      : [];
    if (nodes.length === 0 && edges.length === 0) {
      return {
        kind: "invalid",
        message: "Diagram must include a 'nodes' or 'edges' array.",
      };
    }
    return {
      kind: "valid",
      data,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    };
  } catch (err) {
    return {
      kind: "invalid",
      message: `Invalid JSON: ${(err as Error).message}`,
    };
  }
}

/**
 * Pretty-print whatever's in the textarea. Idempotent — running it twice
 * yields the same result, so we don't have to debounce.
 */
function prettyPrint(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

/**
 * Cheap line-counter that avoids allocating a full split-array for huge
 * payloads. We only need the *count*, not the lines themselves.
 *
 * Complexity: O(N) characters, O(1) extra memory.
 */
function countLines(text: string): number {
  if (!text) return 1;
  let n = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) n += 1;
  }
  return n;
}

export function JSONEditor({
  value,
  onChange,
  onSubmit,
  isLoading = false,
  error = null,
}: JSONEditorProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  /* ----- Derived state — memoized so we don't re-validate per keystroke
     when the parent re-renders for an unrelated reason. */
  const validation = useMemo<ValidationResult>(() => validateJson(value), [value]);
  const lineCount = useMemo(() => countLines(value), [value]);

  /* ----- Sync the gutter scroll position with the textarea's scroll.
     We attach via `useEffect` rather than inline `onScroll` so React doesn't
     re-create the listener on every render. */
  useEffect(() => {
    const ta = textareaRef.current;
    const gutter = gutterRef.current;
    if (!ta || !gutter) return;
    const handler = (): void => {
      gutter.scrollTop = ta.scrollTop;
    };
    ta.addEventListener("scroll", handler, { passive: true });
    return () => ta.removeEventListener("scroll", handler);
  }, []);

  /* ----- Close the example-picker dropdown on outside click. Standard
     pattern: listen on `document.mousedown` and check if the click target is
     inside our ref'd subtree. */
  useEffect(() => {
    if (!pickerOpen) return;
    const handleOutside = (e: MouseEvent): void => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [pickerOpen]);

  /* ----- Handlers ---------------------------------------------------------- */

  const handleTextChange: ChangeEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      onChange(e.target.value);
    },
    [onChange],
  );

  const handleLoadExample = useCallback(
    (slug: string) => {
      const ex = EXAMPLE_DIAGRAMS.find((d) => d.slug === slug);
      if (!ex) return;
      onChange(JSON.stringify(ex.diagram, null, 2));
      setPickerOpen(false);
    },
    [onChange],
  );

  /**
   * `FileReader.readAsText` runs on the platform thread (browser-side),
   * dispatches the work to a worker pool, and fires `onload` with the UTF-8
   * decoded string. For ~MB-scale JSON the read is essentially free.
   */
  const handleFile = useCallback(
    (file: File | null) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") onChange(result);
      };
      reader.onerror = () => {
        onChange(
          `// Failed to read ${file.name}: ${reader.error?.message ?? "unknown error"}`,
        );
      };
      reader.readAsText(file);
    },
    [onChange],
  );

  const handleFilePick: ChangeEventHandler<HTMLInputElement> = useCallback(
    (e) => {
      handleFile(e.target.files?.[0] ?? null);
      if (e.target) e.target.value = ""; // allow re-selecting the same file
    },
    [handleFile],
  );

  const handleDragOver: React.DragEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      e.preventDefault();
      setDragActive(true);
    },
    [],
  );

  const handleDragLeave: React.DragEventHandler<HTMLDivElement> = useCallback(
    () => setDragActive(false),
    [],
  );

  const handleDrop: React.DragEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleFormat = useCallback(() => {
    onChange(prettyPrint(value));
  }, [value, onChange]);

  const handleClear = useCallback(() => {
    onChange("");
  }, [onChange]);

  const handleSubmit = useCallback(() => {
    if (validation.kind !== "valid" || isLoading) return;
    onSubmit(validation.data);
  }, [validation, isLoading, onSubmit]);

  const canSubmit = validation.kind === "valid" && !isLoading;

  /* ----- Render -----------------------------------------------------------
   *  Container note: the outer `<section>` deliberately does **not** use
   *  `overflow-hidden`. Earlier revisions clipped at the card's rounded
   *  edge, which also clipped the "Load Example" dropdown that sits inside
   *  the toolbar. Visual integrity of the rounded corners is preserved by
   *  giving the header and footer their own `rounded-t-2xl` / `rounded-b-2xl`
   *  so each gradient terminates inside the card's curve instead of leaking
   *  past it. The dropdown is therefore free to escape the section
   *  vertically with `position: absolute`.                                  */
  return (
    <section className="card flex h-full flex-col">
      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-t-2xl border-b border-ink-200 bg-gradient-to-r from-white to-ink-50/60 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600/10 text-brand-600 ring-1 ring-brand-200">
            <FileJson className="h-4 w-4" strokeWidth={2.2} />
          </span>
          <div>
            <h2 className="text-sm font-semibold leading-none text-ink-900">
              Diagram Input
            </h2>
            <p className="mt-0.5 text-xs text-ink-500">
              Paste your proprietary diagram JSON or load an example.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Quick-load dropdown ───────────────────────────────── */}
          <div ref={dropdownRef} className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Load Example
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition",
                  pickerOpen && "rotate-180",
                )}
              />
            </button>

            {pickerOpen ? (
              /*
               * Dropdown positioning — Tailwind-UI–style floating menu.
               *
               * Why these specific utilities?
               *  - `absolute` + `left-0` + (no `top`) → the dropdown uses its
               *    *static* vertical position (i.e. immediately below the
               *    button in DOM flow) and pins to the left edge of the
               *    `relative` wrapper, so it can't drift sideways when the
               *    toolbar wraps on narrow viewports. `mt-2` then injects an
               *    8 px breathing gap below the button.
               *  - `z-50` sits **above** the page header (`z-30`) and the
               *    history drawer backdrop (`z-40`), so the menu never gets
               *    obscured by a sibling stacking context. Stacking contexts
               *    are the React/CSS analogue of paint-order layers — any
               *    ancestor with a `transform`, `filter`, or non-`static`
               *    `position` creates one, which is why we keep the
               *    `relative` wrapper deliberately bare.
               *  - `w-72` (= 18rem ≈ 288 px) keeps the menu wide enough to
               *    show the two-line "label + description" entry without
               *    truncation, but narrow enough not to drown the toolbar.
               *  - `origin-top-left` anchors any future scale/fade animation
               *    to the upper-left corner so it visually "drops out" of
               *    the button, matching the Headless-UI / Radix idiom.
               *  - `shadow-xl` (vs. the old `shadow-lg`) bumps the elevation
               *    one tier so the panel reads as floating above even the
               *    `shadow-elev` card surface. This is the standard
               *    elevation step Tailwind UI uses for popovers.
               *  - `ring-1 ring-black/5` uses the modern Tailwind v3
               *    slash-opacity syntax (replaces the deprecated
               *    `ring-opacity-5`). A 5 % black ring is barely visible on
               *    white but holds the panel's edge against any background.
               *  - `focus:outline-none` removes the user-agent's default
               *    focus ring on the menu *container* — focus lives on the
               *    inner `<button role="menuitem">` items, which carry their
               *    own hover/focus styling.
               *
               * Container contract (no clipping mask): the parent `<section>`
               * deliberately omits `overflow-hidden` so this `absolute`
               * element can escape downward past the toolbar without being
               * clipped at the rounded card edge. The `card` utility in
               * `globals.css` only sets `border + bg + shadow-elev` — never
               * `overflow-hidden` — so the dropdown is free to overflow.
               */
              <div
                role="menu"
                aria-orientation="vertical"
                className="absolute z-50 left-0 mt-2 w-72 origin-top-left rounded-md bg-white shadow-xl ring-1 ring-black/5 focus:outline-none"
              >
                {/*
                 * `py-1` wraps the items so their hover backgrounds don't
                 * touch the rounded-md container edge — the standard
                 * Tailwind UI menu shape. `role="none"` strips the inner div
                 * from the accessibility tree so screen readers walk
                 * `menu → menuitem` directly.
                 */}
                <div className="py-1" role="none">
                  {EXAMPLE_DIAGRAMS.map((ex) => (
                    <button
                      key={ex.slug}
                      type="button"
                      onClick={() => handleLoadExample(ex.slug)}
                      className="block w-full px-4 py-2 text-left transition hover:bg-brand-50 focus:bg-brand-50 focus:outline-none"
                      role="menuitem"
                    >
                      <div className="text-sm font-semibold text-ink-900">
                        {ex.label}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-500">
                        {ex.description}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* Upload JSON ─────────────────────────────────────────── */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
          >
            <Upload className="h-3.5 w-3.5" />
            Upload JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleFilePick}
            className="hidden"
          />

          {/* Format ─────────────────────────────────────────────── */}
          <button
            type="button"
            onClick={handleFormat}
            disabled={validation.kind !== "valid"}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            title="Pretty-print JSON"
          >
            <Wand2 className="h-3.5 w-3.5" />
            Format
          </button>

          {/* Clear ──────────────────────────────────────────────── */}
          <button
            type="button"
            onClick={handleClear}
            disabled={!value}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-medium text-ink-500 shadow-sm transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            title="Clear editor"
            aria-label="Clear editor"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* ── Editor surface ──────────────────────────────────────────────── */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative flex-1 min-h-0 bg-[#fbfbfd]",
          dragActive && "ring-2 ring-inset ring-brand-400",
        )}
      >
        {/* Line-number gutter — its own scroll-overflow-hidden container
            keeps the digits aligned with the textarea content.  We sync
            scroll positions in the `useEffect` above. */}
        <div className="absolute inset-y-0 left-0 flex w-12 select-none flex-col overflow-hidden border-r border-ink-200 bg-ink-50/60">
          <div
            ref={gutterRef}
            className="code-font pt-3.5 pb-3.5 pr-2 text-right text-ink-400 overflow-hidden"
            style={{ scrollbarWidth: "none" }}
            aria-hidden="true"
          >
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
        </div>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleTextChange}
          spellCheck={false}
          wrap="off"
          placeholder={'{\n  "id": "...",\n  "nodes": [...],\n  "edges": [...]\n}'}
          className="code-font scrollbar-thin h-full w-full resize-none bg-transparent py-3.5 pl-14 pr-4 text-ink-900 outline-none placeholder:text-ink-300"
        />

        {dragActive ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-brand-500/5">
            <div className="rounded-xl border-2 border-dashed border-brand-400 bg-white/90 px-4 py-3 text-sm font-medium text-brand-700 shadow-lg">
              Drop JSON file to load…
            </div>
          </div>
        ) : null}
      </div>

      {/* ── Footer — validation status + animated submit ────────────────── */}
      <footer className="flex flex-wrap items-center justify-between gap-3 rounded-b-2xl border-t border-ink-200 bg-gradient-to-r from-ink-50/40 to-white px-5 py-3.5">
        <ValidationStatus result={validation} error={error} />
        <SubmitButton
          disabled={!canSubmit}
          isLoading={isLoading}
          onClick={handleSubmit}
        />
      </footer>
    </section>
  );
}

/* ===========================================================================
 *  Sub-components — kept in the same file because they are tightly coupled
 *  to JSONEditor and would never be reused elsewhere. Co-location wins.
 *  ========================================================================= */

function ValidationStatus({
  result,
  error,
}: {
  result: ValidationResult;
  error: string | null;
}): JSX.Element {
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-800">
        <AlertTriangle className="h-3.5 w-3.5" />
        {error}
      </div>
    );
  }

  switch (result.kind) {
    case "empty":
      return (
        <p className="text-xs text-ink-400">
          Editor is empty — paste a diagram or load an example.
        </p>
      );
    case "invalid":
      return (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-900">
          <AlertTriangle className="h-3.5 w-3.5" />
          {result.message}
        </div>
      );
    case "valid":
      return (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-800">
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span>
            Valid diagram —{" "}
            <span className="font-semibold">{result.nodeCount}</span> nodes,{" "}
            <span className="font-semibold">{result.edgeCount}</span> edges
          </span>
        </div>
      );
  }
}

function SubmitButton({
  disabled,
  isLoading,
  onClick,
}: {
  disabled: boolean;
  isLoading: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "group relative inline-flex items-center gap-2 overflow-hidden rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-all duration-200",
        "bg-gradient-to-r from-brand-600 to-indigo-500 shadow-glow",
        "hover:scale-[1.02] hover:from-brand-500 hover:to-indigo-400 active:scale-[0.99]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:hover:scale-100",
        !disabled && !isLoading && "animate-pulse-glow",
      )}
    >
      {/* Sliding sheen overlay — purely cosmetic; hides itself when disabled */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700",
          !disabled && "group-hover:translate-x-full",
        )}
      />
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4 transition-transform group-hover:rotate-12" />
      )}
      <span>{isLoading ? "Analyzing…" : "Analyze & Estimate Cost"}</span>
    </button>
  );
}
