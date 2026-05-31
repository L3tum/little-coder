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
  it("treats turn_end as a terminal child-run event", () => {
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
    expect(result.sawAgentEnd).toBe(true);
    expect(result.messages).toHaveLength(1);
  });
});
