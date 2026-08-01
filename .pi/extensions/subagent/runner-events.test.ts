import { describe, expect, it } from "vitest";
import { processPiEvent } from "./runner-events.js";
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
