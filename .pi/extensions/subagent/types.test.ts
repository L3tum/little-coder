import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  emptyUsage,
  formatSubagentResult,
  formatSubagentResults,
  formatTokens,
  formatUsage,
  hasFinalAssistantOutput,
  hasSemanticCompletion,
  isResultError,
  isResultSuccess,
  normalizeCompletedResult,
  toPhaseOutcome,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers for building test results
// ---------------------------------------------------------------------------

function makeResult(overrides = {}) {
  return {
    agent: "TEST",
    agentSource: "user" as const,
    task: "test task",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
  it("formats small counts as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with one decimal and k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  it("formats large thousands as rounded k (10k+ use Math.round)", () => {
    expect(formatTokens(5000)).toBe("5.0k");
    expect(formatTokens(12000)).toBe("12k");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(1500000)).toBe("1.5M");
    expect(formatTokens(9000000)).toBe("9.0M");
  });
});

// ---------------------------------------------------------------------------
// formatUsage
// ---------------------------------------------------------------------------

describe("formatUsage", () => {
  it("formats empty usage as empty string", () => {
    expect(formatUsage(emptyUsage())).toBe("");
  });

  it("formats turns only", () => {
    expect(formatUsage({ ...emptyUsage(), turns: 1 })).toBe("1 turn");
    expect(formatUsage({ ...emptyUsage(), turns: 3 })).toBe("3 turns");
  });

  it("formats tokens only", () => {
    expect(formatUsage({ ...emptyUsage(), input: 500, output: 200 })).toBe(
      "↑500 ↓200",
    );
  });

  it("formats combined usage", () => {
    const usage = { ...emptyUsage(), turns: 2, input: 1200, output: 500 };
    expect(formatUsage(usage)).toBe("2 turns ↑1.2k ↓500");
  });

  it("includes cache stats when present", () => {
    const usage = {
      ...emptyUsage(),
      turns: 1,
      input: 100,
      output: 50,
      cacheRead: 40,
      cacheWrite: 20,
    };
    expect(formatUsage(usage)).toBe("1 turn ↑100 ↓50 R40 W20");
  });

  it("includes cost when present", () => {
    const usage = {
      ...emptyUsage(),
      turns: 1,
      input: 100,
      output: 50,
      cost: 0.0123,
    };
    expect(formatUsage(usage)).toContain("$0.0123");
  });

  it("includes model name when provided", () => {
    const usage = { ...emptyUsage(), turns: 1 };
    expect(formatUsage(usage, "claude-3.5")).toContain("claude-3.5");
  });
});

// ---------------------------------------------------------------------------
// formatSubagentResult
// ---------------------------------------------------------------------------

describe("formatSubagentResult", () => {
  it("formats a successful result with status icon and agent name", () => {
    const result = makeResult({
      agent: "RESEARCH",
      exitCode: 0,
      sawAgentEnd: true,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Output text" }] },
      ],
      usage: { ...emptyUsage(), turns: 2, input: 1000, output: 500 },
    });
    const output = formatSubagentResult(result);
    expect(output).toContain("✓ [RESEARCH] completed");
    expect(output).toContain("Output text");
    expect(output).toContain("2 turns");
  });

  it("formats a failed result with error icon", () => {
    const result = makeResult({
      agent: "COMPOSE",
      exitCode: 1,
      stopReason: "error",
    });
    const output = formatSubagentResult(result);
    expect(output).toContain("✗ [COMPOSE] failed");
  });

  it("includes optional label when provided", () => {
    const result = makeResult({
      agent: "RESEARCH",
      exitCode: 0,
      sawAgentEnd: true,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Findings" }] },
      ],
    });
    const output = formatSubagentResult(result, "Phase 2");
    expect(output).toContain("Phase 2 [RESEARCH]");
  });

  it("truncates long output to 300 chars", () => {
    const longText = "x".repeat(400);
    const result = makeResult({
      agent: "TEST",
      exitCode: 0,
      sawAgentEnd: true,
      messages: [
        { role: "assistant", content: [{ type: "text", text: longText }] },
      ],
    });
    const output = formatSubagentResult(result);
    expect(output).toContain("...");
    expect(output.length).toBeLessThan(400);
  });

  it("handles empty messages gracefully", () => {
    const result = makeResult({
      agent: "TEST",
      exitCode: 0,
      sawAgentEnd: true,
      messages: [],
    });
    const output = formatSubagentResult(result);
    expect(output).toContain("✓ [TEST] completed");
    // No output body shown when there's nothing to display
    expect(output).not.toContain("(no output)");
  });

  it("includes model name from result", () => {
    const result = makeResult({
      agent: "TEST",
      exitCode: 0,
      sawAgentEnd: true,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
      model: "gpt-4",
      usage: { ...emptyUsage(), turns: 1 },
    });
    const output = formatSubagentResult(result);
    expect(output).toContain("gpt-4");
  });
});

// ---------------------------------------------------------------------------
// formatSubagentResults (multi-phase)
// ---------------------------------------------------------------------------

describe("formatSubagentResults", () => {
  it("formats all phases as successful", () => {
    const phases = [
      {
        label: "Phase 1",
        result: makeResult({
          agent: "RESEARCH",
          exitCode: 0,
          sawAgentEnd: true,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Researched" }],
            },
          ],
          usage: { ...emptyUsage(), turns: 2, input: 1000, output: 500 },
        }),
      },
      {
        label: "Phase 2",
        result: makeResult({
          agent: "COMPOSE",
          exitCode: 0,
          sawAgentEnd: true,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Composed" }],
            },
          ],
          usage: { ...emptyUsage(), turns: 3, input: 2000, output: 800 },
        }),
      },
      {
        label: "Phase 3",
        result: makeResult({
          agent: "REVIEW-PLAN",
          exitCode: 0,
          sawAgentEnd: true,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Reviewed" }],
            },
          ],
          usage: { ...emptyUsage(), turns: 4, input: 3000, output: 1200 },
        }),
      },
    ];
    const output = formatSubagentResults(phases);
    expect(output).toContain("✓ parallel 3/3 completed");
    expect(output).toContain("Phase 1 [RESEARCH] completed");
    expect(output).toContain("Phase 2 [COMPOSE] completed");
    expect(output).toContain("Phase 3 [REVIEW-PLAN] completed");
    expect(output).toContain("Total:");
  });

  it("shows failure count when some phases fail", () => {
    const phases = [
      {
        label: "Phase 1",
        result: makeResult({
          agent: "RESEARCH",
          exitCode: 0,
          sawAgentEnd: true,
          messages: [
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
          ],
          usage: { ...emptyUsage(), turns: 1 },
        }),
      },
      {
        label: "Phase 2",
        result: makeResult({
          agent: "COMPOSE",
          exitCode: 1,
          stopReason: "error",
        }),
      },
    ];
    const output = formatSubagentResults(phases);
    expect(output).toContain("◐ parallel 1/2 completed (1 failed)");
    expect(output).toContain("Phase 1 [RESEARCH] completed");
    expect(output).toContain("Phase 2 [COMPOSE] failed");
  });

  it("aggregates total usage across phases", () => {
    const phases = [
      {
        label: "A",
        result: makeResult({
          agent: "A",
          exitCode: 0,
          sawAgentEnd: true,
          messages: [
            { role: "assistant", content: [{ type: "text", text: "a" }] },
          ],
          usage: { ...emptyUsage(), turns: 2, input: 1000, output: 500 },
        }),
      },
      {
        label: "B",
        result: makeResult({
          agent: "B",
          exitCode: 0,
          sawAgentEnd: true,
          messages: [
            { role: "assistant", content: [{ type: "text", text: "b" }] },
          ],
          usage: { ...emptyUsage(), turns: 3, input: 2000, output: 800 },
        }),
      },
    ];
    const output = formatSubagentResults(phases);
    expect(output).toContain("Total: 5 turns ↑3.0k ↓1.3k");
  });
});

// ---------------------------------------------------------------------------
// aggregateUsage
// ---------------------------------------------------------------------------

describe("aggregateUsage", () => {
  it("sums usage across multiple results", () => {
    const results = [
      makeResult({
        usage: {
          ...emptyUsage(),
          turns: 2,
          input: 1000,
          output: 500,
          cacheRead: 100,
        },
      }),
      makeResult({
        usage: {
          ...emptyUsage(),
          turns: 3,
          input: 2000,
          output: 800,
          cacheWrite: 50,
        },
      }),
    ];
    const total = aggregateUsage(results);
    expect(total.turns).toBe(5);
    expect(total.input).toBe(3000);
    expect(total.output).toBe(1300);
    expect(total.cacheRead).toBe(100);
    expect(total.cacheWrite).toBe(50);
    expect(total.cost).toBe(0);
  });

  it("returns empty for no results", () => {
    const total = aggregateUsage([]);
    expect(total).toEqual(emptyUsage());
  });
});

// ---------------------------------------------------------------------------
// isResultSuccess / isResultError
// ---------------------------------------------------------------------------

describe("isResultSuccess / isResultError", () => {
  it("treats completed result with sawAgentEnd as success", () => {
    const r = makeResult({
      exitCode: 0,
      sawAgentEnd: true,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    });
    expect(isResultSuccess(r)).toBe(true);
    expect(isResultError(r)).toBe(false);
  });

  it("treats non-zero exit code as error", () => {
    const r = makeResult({ exitCode: 1 });
    expect(isResultSuccess(r)).toBe(false);
    expect(isResultError(r)).toBe(true);
  });

  it("treats running result as neither", () => {
    const r = makeResult({ exitCode: -1 });
    expect(isResultSuccess(r)).toBe(false);
    expect(isResultError(r)).toBe(false);
  });

  it("treats error stopReason as error", () => {
    const r = makeResult({ exitCode: 0, stopReason: "error" });
    expect(isResultSuccess(r)).toBe(false);
    expect(isResultError(r)).toBe(true);
  });

  it("treats an error-ended run with prior assistant text as error (no stale-success)", () => {
    // Regression: a child whose FINAL LLM call failed (stopReason "error")
    // still emitted agent_end and has earlier assistant text — it must not
    // be classified as success just because stale partial output exists.
    // (This misclassification is what made remote errors invisible: the
    // parent saw "The bash tool isn't available..." instead of the 400/5xx.)
    const r = makeResult({
      exitCode: 0,
      sawAgentEnd: true,
      stopReason: "error",
      errorMessage: "503 service unavailable",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "partial work..." }],
        },
      ],
    });
    expect(isResultSuccess(r)).toBe(false);
    expect(isResultError(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasFinalAssistantOutput
// ---------------------------------------------------------------------------

describe("hasFinalAssistantOutput", () => {
  it("returns false for empty messages", () => {
    expect(hasFinalAssistantOutput({ messages: [] })).toBe(false);
  });

  it("returns true when last message has text content", () => {
    expect(
      hasFinalAssistantOutput({
        messages: [
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ],
      }),
    ).toBe(true);
  });

  it("returns false when last message is tool-call-only", () => {
    expect(
      hasFinalAssistantOutput({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool-call", callId: "1", name: "read", input: {} },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it("returns true when assistant text follows tool results", () => {
    expect(
      hasFinalAssistantOutput({
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", callId: "1", name: "read", input: {} },
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool-result", toolUseId: "1", content: "data" }],
          },
          { role: "assistant", content: [{ type: "text", text: "found it" }] },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for whitespace-only text", () => {
    expect(
      hasFinalAssistantOutput({
        messages: [
          { role: "assistant", content: [{ type: "text", text: "   " }] },
        ],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasSemanticCompletion
// ---------------------------------------------------------------------------

describe("hasSemanticCompletion", () => {
  it("returns false without sawAgentEnd", () => {
    expect(
      hasSemanticCompletion({
        sawAgentEnd: false,
        messages: [
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ],
      }),
    ).toBe(false);
  });

  it("returns false when the last assistant turn ended in an LLM error", () => {
    // The child may have finished a turn with text, then hit a remote error
    // on the next call: agent_end fires and stale text exists, but the run
    // did not complete.
    expect(
      hasSemanticCompletion({
        sawAgentEnd: true,
        stopReason: "error",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "partial" }] },
        ],
      }),
    ).toBe(false);
  });

  it("returns false with sawAgentEnd but no assistant output", () => {
    expect(
      hasSemanticCompletion({
        sawAgentEnd: true,
        messages: [],
      }),
    ).toBe(false);
  });

  it("returns true with sawAgentEnd and assistant text", () => {
    expect(
      hasSemanticCompletion({
        sawAgentEnd: true,
        messages: [
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      }),
    ).toBe(true);
  });

  it("returns false with sawAgentEnd but only tool calls", () => {
    expect(
      hasSemanticCompletion({
        sawAgentEnd: true,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool-call", callId: "1", name: "write", input: {} },
            ],
          },
        ],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeCompletedResult
// ---------------------------------------------------------------------------

describe("normalizeCompletedResult", () => {
  it("aborted + semantic success: exitCode → 0, stopReason cleared", () => {
    const r = makeResult({
      exitCode: 130,
      stopReason: "aborted" as const,
      errorMessage: "Subagent was aborted.",
      sawAgentEnd: true,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "completed before abort" }],
        },
      ],
    });
    normalizeCompletedResult(r, true);
    expect(r.exitCode).toBe(0);
    expect(r.stopReason).toBeUndefined();
    expect(r.errorMessage).toBeUndefined();
  });

  it("aborted + no semantic success: exitCode → 130, stopReason → aborted", () => {
    const r = makeResult({
      exitCode: 130,
      messages: [],
    });
    normalizeCompletedResult(r, true);
    expect(r.exitCode).toBe(130);
    expect(r.stopReason).toBe("aborted");
    expect(r.errorMessage).toBe("Subagent was aborted.");
    expect(r.stderr).toBe("Subagent was aborted.");
  });

  it("exitCode > 0 + clean semantic success: exitCode → 0, stopReason cleared", () => {
    // The child produced a real final answer (clean stop + text +
    // agent_end) but exited non-zero for an unrelated shutdown reason —
    // the semantic result wins.
    const r = makeResult({
      exitCode: 1,
      stopReason: "stop" as const,
      stderr: "graceful-exit warning",
      sawAgentEnd: true,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    });
    normalizeCompletedResult(r, false);
    expect(r.exitCode).toBe(0);
    // stopReason "stop" is the child's real final turn — it is kept.
    expect(r.stopReason).toBe("stop");
  });

  it("exitCode > 0 + error final turn: NOT downgraded (the error is real)", () => {
    // Regression: a child whose FINAL LLM call failed used to be downgraded
    // to success because stale assistant text + sawAgentEnd looked like
    // completion — that hid the remote error from the parent model.
    const r = makeResult({
      exitCode: 1,
      stopReason: "error" as const,
      errorMessage: "503 service unavailable",
      stderr: "503 service unavailable",
      sawAgentEnd: true,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "partial" }] },
      ],
    });
    normalizeCompletedResult(r, false);
    expect(r.exitCode).toBe(1);
    expect(r.stopReason).toBe("error");
    expect(r.errorMessage).toBe("503 service unavailable");
  });

  it("exitCode > 0 + no semantic success: stopReason → error", () => {
    const r = makeResult({
      exitCode: 1,
      stderr: "something went wrong",
      messages: [],
    });
    normalizeCompletedResult(r, false);
    expect(r.stopReason).toBe("error");
    expect(r.errorMessage).toBe("something went wrong");
  });

  it("exitCode === 0: no changes", () => {
    const r = makeResult({
      exitCode: 0,
      messages: [],
    });
    normalizeCompletedResult(r, false);
    expect(r.exitCode).toBe(0);
    expect(r.stopReason).toBeUndefined();
    expect(r.errorMessage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Snapshot tests for formatted output
// ---------------------------------------------------------------------------

describe("formatSubagentResult snapshots", () => {
  it("successful result", () => {
    const result = makeResult({
      agent: "RESEARCH",
      exitCode: 0,
      sawAgentEnd: true,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Research findings." }],
        },
      ],
      usage: { ...emptyUsage(), turns: 2, input: 1000, output: 500 },
    });
    expect(formatSubagentResult(result)).toMatchInlineSnapshot(`
      "✓ [RESEARCH] completed
      Research findings.
      2 turns ↑1.0k ↓500"
    `);
  });

  it("failed result", () => {
    const result = makeResult({
      agent: "COMPOSE",
      exitCode: 1,
      stopReason: "error",
    });
    expect(formatSubagentResult(result)).toMatchInlineSnapshot(
      `"✗ [COMPOSE] failed"`,
    );
  });

  it("multi-phase output", () => {
    const phases = [
      {
        label: "Phase 1",
        result: makeResult({
          agent: "RESEARCH",
          exitCode: 0,
          sawAgentEnd: true,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Researched" }],
            },
          ],
          usage: { ...emptyUsage(), turns: 2, input: 1000, output: 500 },
        }),
      },
      {
        label: "Phase 2",
        result: makeResult({
          agent: "COMPOSE",
          exitCode: 0,
          sawAgentEnd: true,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Composed" }],
            },
          ],
          usage: { ...emptyUsage(), turns: 3, input: 2000, output: 800 },
        }),
      },
    ];
    expect(formatSubagentResults(phases)).toMatchInlineSnapshot(`
      "✓ parallel 2/2 completed

      ✓ Phase 1 [RESEARCH] completed
      Researched
      2 turns ↑1.0k ↓500

      ✓ Phase 2 [COMPOSE] completed
      Composed
      3 turns ↑2.0k ↓800

      Total: 5 turns ↑3.0k ↓1.3k"
    `);
  });
});

// ---------------------------------------------------------------------------
// toPhaseOutcome
// ---------------------------------------------------------------------------

describe("toPhaseOutcome", () => {
  it("returns ok with text for a successful run with output", () => {
    const result = makeResult({
      exitCode: 0,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "phase done" }] },
      ],
    });
    const outcome = toPhaseOutcome(result);
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe("phase done");
    expect(outcome.error).toBeUndefined();
  });

  it("returns not ok with specific message for exit 0 + empty output", () => {
    const result = makeResult({
      exitCode: 0,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "   " }] },
      ],
    });
    const outcome = toPhaseOutcome(result);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toBe("   ");
    expect(outcome.error).toBe("TEST completed but produced no output");
  });

  it("returns not ok for an errored run (exit 1 + stderr)", () => {
    const result = makeResult({
      exitCode: 1,
      stopReason: "error",
      stderr: "something went wrong",
    });
    const outcome = toPhaseOutcome(result);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("something went wrong");
  });

  it("returns not ok for an errored run (fallback to exit code)", () => {
    const result = makeResult({
      exitCode: 1,
      stopReason: "error",
      stderr: "",
      errorMessage: "",
    });
    const outcome = toPhaseOutcome(result);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("TEST failed (exit 1)");
  });

  it("falls back to errorMessage when stderr is empty", () => {
    // The error-string chain is stderr || errorMessage || exit-code default;
    // without this test the errorMessage branch is dead-lettered.
    const result = makeResult({
      exitCode: 1,
      stopReason: "error",
      stderr: "",
      errorMessage: "EM-ONLY",
    });
    const outcome = toPhaseOutcome(result);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("EM-ONLY");
  });

  it("truncates a huge stderr so a failed phase cannot flood notifications", () => {
    const huge = "x".repeat(5_000);
    const result = makeResult({
      exitCode: 1,
      stopReason: "error",
      stderr: huge,
    });
    const outcome = toPhaseOutcome(result);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).not.toBe(huge);
    expect(outcome.error!.length).toBeLessThan(2_200);
    expect(outcome.error).toContain(huge.slice(0, 100));
    expect(outcome.error).toContain("truncated");
  });

  it("truncates a huge errorMessage as well", () => {
    const huge = "y".repeat(5_000);
    const result = makeResult({
      exitCode: 1,
      stopReason: "error",
      stderr: "",
      errorMessage: huge,
    });
    const outcome = toPhaseOutcome(result);
    expect(outcome.error!.length).toBeLessThan(2_200);
    expect(outcome.error).toContain("truncated");
  });

  it("returns not ok for an aborted run (exit 130)", () => {
    const result = makeResult({
      exitCode: 130,
      stopReason: "aborted",
      stderr: "Subagent was aborted.",
    });
    const outcome = toPhaseOutcome(result);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("Subagent was aborted.");
  });

  it("returns not ok for exitCode -1 (unreachable running state)", () => {
    const result = makeResult({ exitCode: -1 });
    const outcome = toPhaseOutcome(result);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("TEST failed (exit -1)");
  });
});
