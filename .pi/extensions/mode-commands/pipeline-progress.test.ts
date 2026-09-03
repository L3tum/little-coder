// Unit tests for the pipeline live-progress panel (pipeline-progress.ts).
// The pure functions (activityLine / buildProgressSpec / renderProgressWidget)
// are tested directly; the controller (createPipelineProgress) is tested
// against a recording fake setWidget, with fake timers for the throttle and
// heartbeat behavior. No subprocesses, no real TUI.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityLine,
  buildProgressSpec,
  createPipelineProgress,
  renderProgressWidget,
  type PipelinePhaseState,
  type ProgressTheme,
} from "./pipeline-progress.ts";
import type { SingleResult } from "../subagent/api.ts";

const FAKE_THEME: ProgressTheme = { fg: (_c, t) => t, bold: (t) => t };

function makeResult(messages: unknown[]): SingleResult {
  return {
    agent: "TEST",
    agentSource: "user",
    task: "t",
    exitCode: 0,
    messages: messages as SingleResult["messages"],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}

function textMsg(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function toolMsg(name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", name, arguments: args }],
  };
}

describe("activityLine", () => {
  it("reports (starting…) for an empty history", () => {
    expect(activityLine(makeResult([]))).toBe("(starting…)");
  });

  it("reports the current tool call as '→ name arg'", () => {
    expect(
      activityLine(makeResult([toolMsg("bash", { command: "git diff" })])),
    ).toBe("→ bash git diff");
  });

  it("shows read offset/limit as a line range", () => {
    expect(
      activityLine(
        makeResult([
          toolMsg("read", { file_path: "src/a.ts", offset: 10, limit: 20 }),
        ]),
      ),
    ).toBe("→ read src/a.ts:10-29");
  });

  it("truncates long args to one line's worth", () => {
    const long = "x".repeat(100);
    const line = activityLine(makeResult([toolMsg("bash", { command: long })]));
    expect(line).toBe(`→ bash ${"x".repeat(47)}…`);
    expect(line.length).toBeLessThan(60);
  });

  it("falls back to 'writing… (N chars)' when the newest item is text", () => {
    expect(
      activityLine(
        makeResult([toolMsg("bash", { command: "ls" }), textMsg("abc")]),
      ),
    ).toBe("writing… (3 chars)");
  });

  it("only shows assistant display items (tool results and other roles are skipped)", () => {
    const result = makeResult([
      {
        role: "toolResult",
        toolCallId: "1",
        name: "bash",
        content: [{ type: "text", text: "output" }],
        isError: false,
      },
      toolMsg("websearch", { query: "pi tui" }),
    ]);
    expect(activityLine(result)).toBe("→ websearch pi tui");
  });

  it("pins the canonical tool-name → arg-field mapping (drift degrades the activity line)", () => {
    // summarizeArgs re-encodes the tool-name → argument-field mapping that
    // subagent/render.ts owns; a renamed arg or new pi tool would silently
    // fall through to the default case (first string value) or "". Pinning
    // each dedicated case keeps that drift visible.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["bash", { command: "git diff" }, "→ bash git diff"],
      ["read", { file_path: "src/a.ts" }, "→ read src/a.ts"],
      ["write", { path: "src/b.ts" }, "→ write src/b.ts"],
      ["edit", { file_path: "src/c.ts" }, "→ edit src/c.ts"],
      ["grep", { pattern: "foo" }, "→ grep foo"],
      ["glob", { pattern: "*.ts" }, "→ glob *.ts"],
      ["find", { query: "bar" }, "→ find bar"],
      ["webfetch", { url: "http://x" }, "→ webfetch http://x"],
      ["websearch", { query: "pi" }, "→ websearch pi"],
    ];
    for (const [name, args, want] of cases) {
      expect(activityLine(makeResult([toolMsg(name, args)])), name).toBe(want);
    }
    // Unknown tools: the first non-empty string arg is the fallback.
    expect(
      activityLine(makeResult([toolMsg("mystery", { z: 1, label: "hello" })])),
    ).toBe("→ mystery hello");
  });

  it("does not split a surrogate pair when truncating", () => {
    // The bash command is truncated to 48 code units by summarizeArgs. Build
    // a command where that cut lands exactly on a surrogate PAIR boundary:
    // 46 filler chars, then 😀 (a 2-code-unit pair) at indices 46..47, then
    // more filler so the total (50) exceeds 48. Naive truncation to 48 would
    // keep the HIGH surrogate at index 46 without its low half — a lone
    // (unpaired) surrogate. The backoff must drop the whole pair instead.
    const s = "x".repeat(46) + "\u{1F600}" + "xy"; // length 50
    const line = activityLine(makeResult([toolMsg("bash", { command: s })]));
    // Kept prefix is the 46 filler chars + ellipsis — the pair at 46..47 is
    // dropped whole, not split.
    expect(line).toBe("→ bash " + "x".repeat(46) + "…");
    const kept = line.slice("→ bash ".length, -1);
    for (let i = 0; i < kept.length; i++) {
      const c = kept.charCodeAt(i);
      const paired =
        (c >= 0xd800 &&
          c <= 0xdbff &&
          i + 1 < kept.length &&
          kept.charCodeAt(i + 1) >= 0xdc00 &&
          kept.charCodeAt(i + 1) <= 0xdfff) ||
        (c >= 0xdc00 &&
          c <= 0xdfff &&
          i > 0 &&
          kept.charCodeAt(i - 1) >= 0xd800 &&
          kept.charCodeAt(i - 1) <= 0xdbff);
      const lone = c >= 0xd800 && c <= 0xdfff && !paired;
      expect(lone, `lone surrogate at ${i}`).toBe(false);
    }
  });
});

function phase(
  name: string,
  status: PipelinePhaseState["status"],
  over: Partial<PipelinePhaseState> = {},
): PipelinePhaseState {
  return {
    name,
    status,
    startedAt: null,
    finishedAt: null,
    activity: null,
    error: null,
    ...over,
  };
}

describe("buildProgressSpec", () => {
  const t0 = 1_000_000;

  it("all pending: ○ header 'waiting to start', rows show queued", () => {
    const spec = buildProgressSpec(
      "/review",
      [phase("A", "pending"), phase("B", "pending")],
      t0,
    );
    expect(spec.headerIcon).toBe("○");
    expect(spec.headerIconColor).toBe("muted");
    expect(spec.headerText).toBe("/review — waiting to start");
    expect(spec.rows.every((r) => r.tail === "queued" && r.meta === "")).toBe(
      true,
    );
  });

  it("running: ⏳ header counts done/running; running row shows elapsed + activity", () => {
    const spec = buildProgressSpec(
      "/review",
      [
        phase("A", "ok", { startedAt: t0, finishedAt: t0 + 60_000 }),
        phase("B", "running", {
          startedAt: t0 + 30_000,
          activity: "→ bash git diff",
        }),
        phase("C", "pending"),
      ],
      t0 + 30_000 + 42_000,
    );
    expect(spec.headerIcon).toBe("⏳");
    expect(spec.headerIconColor).toBe("warning");
    expect(spec.headerText).toBe("/review — 1/3 done, 1 running");
    const [a, b, c] = spec.rows;
    expect(a.icon).toBe("✓");
    expect(a.meta).toBe(" 01:00");
    expect(a.tail).toBe("");
    expect(b.icon).toBe("⏳");
    expect(b.meta).toBe(" 00:42");
    expect(b.tail).toBe("→ bash git diff");
    expect(c.icon).toBe("○");
    expect(c.tail).toBe("queued");
  });

  it("a failed phase shows its error; ◐ header once nothing is running", () => {
    const spec = buildProgressSpec(
      "deep plan",
      [
        phase("A", "ok", { startedAt: t0, finishedAt: t0 + 1000 }),
        phase("B", "failed", {
          startedAt: t0,
          finishedAt: t0 + 5000,
          error: "boom",
        }),
      ],
      t0 + 10_000,
    );
    expect(spec.headerIcon).toBe("◐");
    expect(spec.headerText).toBe("deep plan — 2/2 done, 1 failed");
    expect(spec.rows[1].icon).toBe("✗");
    expect(spec.rows[1].tail).toBe("boom");
    expect(spec.rows[1].tailColor).toBe("error");
  });

  it("all ok: ✓ success header", () => {
    const spec = buildProgressSpec(
      "x",
      [phase("A", "ok", { startedAt: t0, finishedAt: t0 + 1000 })],
      t0,
    );
    expect(spec.headerIcon).toBe("✓");
    expect(spec.headerIconColor).toBe("success");
    expect(spec.headerText).toBe("x — all 1 phases done");
  });

  it("a settled partial run (some done, none running/failed) shows the count, not 'waiting to start'", () => {
    const spec = buildProgressSpec(
      "/review",
      [
        phase("A", "ok", { startedAt: t0, finishedAt: t0 + 1000 }),
        phase("B", "pending"),
      ],
      t0,
    );
    expect(spec.headerIcon).toBe("○");
    expect(spec.headerText).toBe("/review — 1/2 done");
  });

  it("pads names to a shared column width", () => {
    const long = "A-MUCH-LONGER-NAME";
    const spec = buildProgressSpec(
      "x",
      [phase("SHORT", "pending"), phase(long, "pending")],
      t0,
    );
    expect(spec.nameWidth).toBe(long.length);
    expect(spec.rows[0].name).toBe("SHORT".padEnd(long.length));
  });
});

describe("renderProgressWidget", () => {
  it("renders a header plus one line per phase (Container.render)", () => {
    const now = Date.now();
    const c = renderProgressWidget(
      "/review",
      [
        phase("REVIEW-A", "running", {
          startedAt: now - 42_000,
          activity: "→ bash git diff",
        }),
        phase("REVIEW-B", "pending"),
      ],
      FAKE_THEME,
    );
    const lines = c.render(120);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("/review — 0/2 done, 1 running");
    expect(lines[1]).toContain("REVIEW-A");
    expect(lines[1]).toContain("00:42");
    expect(lines[1]).toContain("→ bash git diff");
    expect(lines[2]).toContain("REVIEW-B");
    expect(lines[2]).toContain("queued");
  });
});

describe("createPipelineProgress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFake() {
    const calls: { key: string; content: unknown }[] = [];
    const ctx = {
      ui: {
        setWidget: (key: string, content: unknown) =>
          calls.push({ key, content }),
      },
    };
    return { calls, ctx };
  }

  it("renders immediately on creation and clears the widget on dispose", () => {
    vi.useFakeTimers();
    const { calls, ctx } = makeFake();
    const p = createPipelineProgress(ctx, "/review", ["A", "B"]);
    expect(calls).toHaveLength(1);
    expect(typeof calls[0].content).toBe("function");
    p.dispose();
    expect(calls[calls.length - 1].content).toBeUndefined();
    p.dispose(); // idempotent
    expect(calls).toHaveLength(2);
  });

  it("lifecycle: start → activity → finish(ok) updates phase state", () => {
    vi.useFakeTimers();
    const { ctx } = makeFake();
    const p = createPipelineProgress(ctx, "/review", ["A"]);
    p.start("A");
    expect(p.state[0]).toMatchObject({
      status: "running",
      startedAt: expect.any(Number),
    });
    p.finish("A", true);
    expect(p.state[0]).toMatchObject({
      status: "ok",
      finishedAt: expect.any(Number),
      error: null,
      activity: null,
    });
    p.dispose();
  });

  it("finish(ok=false) records the error (default 'unknown error' when absent)", () => {
    vi.useFakeTimers();
    const { ctx } = makeFake();
    const p = createPipelineProgress(ctx, "/review", ["A", "B"]);
    p.start("A");
    p.start("B");
    p.finish("A", false, "phase timeout");
    p.finish("B", false);
    expect(p.state[0]).toMatchObject({
      status: "failed",
      error: "phase timeout",
    });
    expect(p.state[1]).toMatchObject({
      status: "failed",
      error: "unknown error",
    });
    p.dispose();
  });

  it("ignores start/activity/finish for unknown or already-settled phases", () => {
    vi.useFakeTimers();
    const { calls, ctx } = makeFake();
    const p = createPipelineProgress(ctx, "/review", ["A"]);
    const before = calls.length;
    p.start("NOPE");
    p.activity("NOPE", "x");
    p.finish("NOPE", true);
    expect(calls).toHaveLength(before); // no state change → no re-render
    p.start("A");
    p.start("A"); // already running: no-op
    expect(calls).toHaveLength(before + 1);
    p.finish("A", true);
    const settled = calls.length;
    p.start("A"); // settled: no-op
    p.activity("A", "y");
    expect(calls).toHaveLength(settled);
    p.dispose();
  });

  it("throttles rapid activity updates to a single trailing render", () => {
    vi.useFakeTimers();
    const { calls, ctx } = makeFake();
    const p = createPipelineProgress(ctx, "/review", ["A"]);
    p.start("A");
    p.activity("A", "line 1"); // t=0: throttle window empty but since=0 → queued
    p.activity("A", "line 2"); // inside window → still not rendered
    p.activity("A", "line 3"); // same window → still not rendered
    expect(p.state[0].activity).toBe("line 3");
    const rendersSoFar = calls.length;
    vi.advanceTimersByTime(400);
    expect(calls).toHaveLength(rendersSoFar + 1);
    p.dispose();
  });

  it("heartbeat re-renders running phases once per second, not settled ones", () => {
    vi.useFakeTimers();
    const { calls, ctx } = makeFake();
    const p = createPipelineProgress(ctx, "/review", ["A"]);
    p.start("A");
    const running = calls.length;
    vi.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(running + 1); // elapsed-time tick
    p.finish("A", true);
    const settled = calls.length;
    vi.advanceTimersByTime(3_000);
    expect(calls).toHaveLength(settled); // settled panel: no ticks
    p.dispose();
  });

  it("is a no-op without ui (headless/test context)", () => {
    vi.useFakeTimers();
    const p = createPipelineProgress({}, "/review", ["A"]);
    p.start("A");
    p.activity("A", "x");
    p.finish("A", false, "e");
    p.dispose();
    p.dispose();
  });

  it("two panels get distinct widget keys (a retry cannot clobber a live panel)", () => {
    vi.useFakeTimers();
    const { calls, ctx } = makeFake();
    const p1 = createPipelineProgress(ctx, "/review", ["A"]);
    const p2 = createPipelineProgress(ctx, "/review", ["A"]);
    expect(new Set(calls.map((c) => c.key))).toHaveLength(2);
    p1.dispose();
    p2.dispose();
  });
});
