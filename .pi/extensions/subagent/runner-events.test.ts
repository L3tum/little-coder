import { describe, expect, it } from "vitest";
import { getResultSummaryText, processPiEvent } from "./runner-events.js";
import { emptyUsage, type SingleResult } from "./types.ts";

function runningResult(): SingleResult {
  return {
    agent: "helper",
    agentSource: "user",
    task: "task",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
  };
}

describe("subagent runner events", () => {
  it("does NOT treat turn_end as a terminal child-run event", () => {
    // turn_end fires after each model turn, but the agent may still be
    // running (tool calls between turns). Only agent_end should signal
    // that the agent has fully finished.
    const result = runningResult() as SingleResult & { sawAgentEnd?: boolean };

    const changed = processPiEvent(
      {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      },
      result,
    );

    expect(changed).toBe(true);
    expect(result.sawAgentEnd).toBeUndefined(); // NOT set by turn_end
    expect(result.messages).toHaveLength(1);
  });

  it("treats agent_end as a terminal child-run event", () => {
    const result = runningResult() as SingleResult & { sawAgentEnd?: boolean };

    const changed = processPiEvent(
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "final output" }],
          },
        ],
      },
      result,
    );

    expect(changed).toBe(true);
    expect(result.sawAgentEnd).toBe(true); // set by agent_end
    expect(result.messages).toHaveLength(1);
  });
});

describe("getResultSummaryText", () => {
  it("returns the final assistant text for a successful result", () => {
    const r: SingleResult = {
      ...runningResult(),
      exitCode: 0,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "all good" }] },
      ],
    };
    expect(getResultSummaryText(r)).toBe("all good");
  });

  it("leads with the ACTUAL error for an error result, keeping stale partial output only as context", () => {
    // Regression: before the fix, a child that died on a remote error
    // after writing "The bash tool isn't available..." reported THAT text
    // as its summary, hiding the real error entirely.
    const r: SingleResult = {
      ...runningResult(),
      exitCode: 0,
      sawAgentEnd: true,
      stopReason: "error",
      errorMessage: "400 status code (no body)",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The bash tool isn't available in this environment",
            },
          ],
        },
      ],
    };
    const summary = getResultSummaryText(r);
    expect(summary).toContain("400 status code (no body)");
    expect(summary).toContain("Partial output before failure:");
    expect(summary).toContain("The bash tool isn't available");
    expect(summary.indexOf("400 status code (no body)" as string)).toBeLessThan(
      summary.indexOf("The bash tool isn't available" as string),
    );
  });

  it("uses stderr when an error result has no errorMessage", () => {
    const r: SingleResult = {
      ...runningResult(),
      exitCode: 1,
      stopReason: "error",
      stderr: "spawn pi ENOENT",
    };
    expect(getResultSummaryText(r)).toBe("spawn pi ENOENT");
  });

  it("returns '(no output)' for a clean result with no assistant text", () => {
    const r: SingleResult = { ...runningResult(), exitCode: 0 };
    expect(getResultSummaryText(r)).toBe("(no output)");
  });
});
