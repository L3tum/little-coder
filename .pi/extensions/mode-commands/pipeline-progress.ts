/**
 * Live progress panel for the programmatic pipelines (/review,
 * /review-project, /deep-plan).
 *
 * The subagent TOOL streams live output because pi re-renders an in-flight
 * tool call on every onUpdate. The pipelines run from COMMAND handlers, which
 * have no in-flight tool rendering — without this panel a 7-phase run is
 * silent apart from a footer status line. This module closes that gap with a
 * live widget above the editor (ctx.ui.setWidget, keyed so it updates in
 * place): one row per phase with a status icon, elapsed time, and a one-line
 * "currently doing" tail derived from the phase's streaming output — the
 * same per-phase signal the subagent tool renders, without the session
 * pollution that streaming user messages would cause.
 *
 * Headless/test contexts without a ui.setWidget are no-ops (every UI call is
 * guarded), so the pipelines behave exactly as before there.
 */

import { randomBytes } from "node:crypto";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import {
  getDisplayItems,
  getFinalOutput,
  type SingleResult,
} from "../subagent/api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal theme surface the widget needs (pi's interactive Theme satisfies
 *  this; tests can pass a no-op substitute). */
export type ProgressTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

/** Widget factory shape pi's setWidget expects for component content. */
export type ProgressWidgetFactory = (tui: TUI, theme: ProgressTheme) => Container;

/** Structural slice of the command context this module touches. `setWidget`
 *  is declared with METHOD syntax (not a function-typed property) so its
 *  parameters check bivariantly — the host's real (overloaded) setWidget is
 *  then assignable here, and our factory is accepted by its factory overload.
 */
export type ProgressCtx = {
  ui?: {
    setWidget?(
      key: string,
      content: string[] | undefined | ProgressWidgetFactory,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
  };
};

export type PipelinePhaseStatus = "pending" | "running" | "ok" | "failed";

export interface PipelinePhaseState {
  name: string;
  status: PipelinePhaseStatus;
  startedAt: number | null;
  finishedAt: number | null;
  /** One-line "currently doing" tail from the phase's streaming output. */
  activity: string | null;
  /** Populated when status === "failed". */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Activity line — the per-phase "currently doing" signal
// ---------------------------------------------------------------------------

function truncateLine(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Compact one-arg summary for the common tool shapes (plain text — the
 *  richer per-tool formatting stays in subagent/render.ts). */
function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "bash":
      return truncateLine(str(args.command), 48);
    case "read":
    case "write":
    case "edit": {
      const p = str(args.file_path) || str(args.path);
      const off = args.offset;
      const lim = args.limit;
      return truncateLine(
        typeof off === "number"
          ? `${p}:${off}${typeof lim === "number" ? `-${off + lim - 1}` : ""}`
          : p,
        48,
      );
    }
    case "grep":
    case "glob":
    case "find":
      return truncateLine(str(args.pattern) || str(args.query), 48);
    case "webfetch":
      return truncateLine(str(args.url), 48);
    case "websearch":
      return truncateLine(str(args.query), 48);
    default: {
      const v = Object.values(args).find(
        (x) => typeof x === "string" && (x as string).length > 0,
      );
      return v ? truncateLine(String(v), 48) : "";
    }
  }
}

/**
 * Derive the one-line activity for a (possibly partial) phase result: the
 * LAST display item of the streamed messages — the current tool call if the
 * phase is mid-tool, else "writing… (N chars)" while the final text is the
 * newest item. Empty history → "(starting…)".
 */
export function activityLine(result: SingleResult): string {
  const items = getDisplayItems(result.messages);
  const last = items[items.length - 1];
  if (last && last.type === "toolCall") {
    const arg = summarizeArgs(last.name, last.args);
    return arg ? `→ ${last.name} ${arg}` : `→ ${last.name}`;
  }
  const text = getFinalOutput(result.messages);
  return text ? `writing… (${text.length} chars)` : "(starting…)";
}

// ---------------------------------------------------------------------------
// Row spec — pure, theme-free (unit-testable)
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ICONS = {
  pending: { glyph: "○", color: "muted" },
  running: { glyph: "⏳", color: "warning" },
  ok: { glyph: "✓", color: "success" },
  failed: { glyph: "✗", color: "error" },
} as const;

export interface ProgressRowSpec {
  icon: string;
  iconColor: string;
  /** Phase name, space-padded to the shared column width. */
  name: string;
  /** Elapsed time (running or finished phases), or "". */
  meta: string;
  metaColor: string;
  /** Trailing detail: activity / error / "queued". */
  tail: string;
  tailColor: string;
}

export interface ProgressSpec {
  headerIcon: string;
  headerIconColor: string;
  headerText: string;
  nameWidth: number;
  rows: ProgressRowSpec[];
}

/**
 * Pure layout of the panel: header + one row per phase. `now` is injectable
 * so tests don't depend on the wall clock.
 */
export function buildProgressSpec(
  label: string,
  phases: PipelinePhaseState[],
  now: number,
): ProgressSpec {
  const running = phases.filter((p) => p.status === "running").length;
  const failed = phases.filter((p) => p.status === "failed").length;
  // "done" = settled phases (ok OR failed) — pending does not count as done.
  const done = phases.filter(
    (p) => p.status === "ok" || p.status === "failed",
  ).length;
  const allDone = phases.length > 0 && done === phases.length;
  const headerIcon = running > 0 ? "⏳" : failed > 0 ? "◐" : allDone ? "✓" : "○";
  const headerIconColor =
    running > 0 || failed > 0 ? "warning" : allDone ? "success" : "muted";
  const headerText =
    running > 0
      ? `${label} — ${done}/${phases.length} done, ${running} running`
      : failed > 0
        ? `${label} — ${done}/${phases.length} done, ${failed} failed`
        : allDone
          ? `${label} — all ${phases.length} phases done`
          : done > 0
            ? `${label} — ${done}/${phases.length} done`
            : `${label} — waiting to start`;

  const nameWidth = Math.min(
    24,
    Math.max(...phases.map((p) => p.name.length), 8),
  );

  const rows: ProgressRowSpec[] = phases.map((p) => {
    const icon = ICONS[p.status];
    let meta = "";
    let tail = "";
    let tailColor: string = "muted";
    if (p.status === "pending") {
      tail = "queued";
    } else if (p.status === "running") {
      meta = formatElapsed(now - (p.startedAt ?? now));
      tail = p.activity ?? "(starting…)";
      tailColor = "toolOutput";
    } else {
      meta = formatElapsed((p.finishedAt ?? now) - (p.startedAt ?? now));
      if (p.status === "failed") {
        tail = truncateLine(p.error ?? "unknown error", 48);
        tailColor = "error";
      }
    }
    return {
      icon: icon.glyph,
      iconColor: icon.color,
      name: p.name.padEnd(nameWidth),
      meta: meta ? ` ${meta}` : "",
      metaColor: "dim",
      tail,
      tailColor,
    };
  });

  return { headerIcon, headerIconColor, headerText, nameWidth, rows };
}
// ---------------------------------------------------------------------------
// TUI rendering
// ---------------------------------------------------------------------------

/** Build the widget component for the current phase state (called once per
 *  setWidget by pi's interactive mode). */
export function renderProgressWidget(
  label: string,
  phases: PipelinePhaseState[],
  theme: ProgressTheme,
): Container {
  const spec = buildProgressSpec(label, phases, Date.now());
  const container = new Container();
  container.addChild(
    new Text(
      `${theme.fg(spec.headerIconColor, spec.headerIcon)} ${theme.fg(
        "toolTitle",
        theme.bold(spec.headerText),
      )}`,
      0,
      0,
    ),
  );
  for (const row of spec.rows) {
    let line = `${theme.fg(row.iconColor, row.icon)} ${theme.fg("accent", row.name)}`;
    if (row.meta) line += `${theme.fg(row.metaColor, row.meta)}`;
    if (row.tail) line += ` ${theme.fg(row.tailColor, row.tail)}`;
    container.addChild(new Text(line.trimEnd(), 0, 0));
  }
  return container;
}

/** The factory passed to ctx.ui.setWidget; reads live state at set time. */
export function makeProgressWidgetFactory(
  label: string,
  getState: () => PipelinePhaseState[],
): ProgressWidgetFactory {
  return (_tui, theme) => renderProgressWidget(label, getState(), theme);
}

// ---------------------------------------------------------------------------
// Progress controller — per-run lifecycle
// ---------------------------------------------------------------------------

/** Activity updates re-render at most this often (the streaming cadence is
 *  per child event; re-creating the widget component per event would thrash
 *  the TUI diff). */
const ACTIVITY_RENDER_INTERVAL_MS = 400;
/** Heartbeat that advances the elapsed-time display while any phase runs. */
const ELAPSED_TICK_MS = 1_000;
const WIDGET_KEY_PREFIX = "lc-pipeline-progress";

export interface PipelineProgress {
  /** Mark a phase started (pending → running). No-op for unknown/settled names. */
  start(name: string): void;
  /** Update a running phase's activity line (throttled re-render). */
  activity(name: string, line: string): void;
  /** Settle a running phase (running → ok|failed). */
  finish(name: string, ok: boolean, error?: string): void;
  /** Clear the widget and stop all timers. Idempotent; no-ops after. */
  dispose(): void;
  /** Live phase states (read-only view, for tests and debugging). */
  readonly state: readonly PipelinePhaseState[];
}

/**
 * Create the live progress panel for one pipeline run. Renders immediately
 * (all phases queued), then updates in place as phases start/stream/finish;
 * `dispose()` clears the widget — call it on EVERY exit path (the pipelines
 * wrap their run bodies in try/finally for exactly this).
 */
export function createPipelineProgress(
  ctx: ProgressCtx,
  label: string,
  phaseNames: string[],
): PipelineProgress {
  const phases: PipelinePhaseState[] = phaseNames.map((name) => ({
    name,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    activity: null,
    error: null,
  }));
  const setWidget = ctx.ui?.setWidget;
  // Per-run key: two runs in one session (a retried /review after a failed
  // one) must not clobber a still-live panel from the previous run.
  const widgetKey = `${WIDGET_KEY_PREFIX}-${randomBytes(3).toString("hex")}`;
  let disposed = false;
  let lastRenderAt = 0;
  let renderQueued: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const renderNow = () => {
    if (disposed) return;
    lastRenderAt = Date.now();
    setWidget?.(widgetKey, makeProgressWidgetFactory(label, () => phases));
  };

  renderNow();

  // Elapsed-time heartbeat: re-render once per second while any phase is
  // running (a fully settled panel shows final durations and doesn't need
  // ticks). unref so the timer can never hold a headless process open.
  tickTimer = setInterval(() => {
    if (disposed) return;
    if (phases.some((p) => p.status === "running")) renderNow();
  }, ELAPSED_TICK_MS);
  tickTimer.unref?.();

  const find = (name: string) => phases.find((p) => p.name === name);

  return {
    state: phases,
    start(name: string): void {
      if (disposed) return;
      const p = find(name);
      if (!p || p.status !== "pending") return;
      p.status = "running";
      p.startedAt = Date.now();
      renderNow();
    },
    activity(name: string, line: string): void {
      if (disposed) return;
      const p = find(name);
      if (!p || p.status !== "running") return;
      if (p.activity === line) return;
      p.activity = line;
      const since = Date.now() - lastRenderAt;
      if (since >= ACTIVITY_RENDER_INTERVAL_MS) {
        renderNow();
        return;
      }
      if (!renderQueued) {
        renderQueued = setTimeout(() => {
          renderQueued = null;
          renderNow();
        }, ACTIVITY_RENDER_INTERVAL_MS - since);
        renderQueued.unref?.();
      }
    },
    finish(name: string, ok: boolean, error?: string): void {
      if (disposed) return;
      const p = find(name);
      if (!p || p.status !== "running") return;
      p.status = ok ? "ok" : "failed";
      p.finishedAt = Date.now();
      p.activity = null;
      p.error = ok ? null : (error ?? "unknown error");
      renderNow();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (tickTimer) clearInterval(tickTimer);
      if (renderQueued) clearTimeout(renderQueued);
      setWidget?.(widgetKey, undefined);
    },
  };
}
