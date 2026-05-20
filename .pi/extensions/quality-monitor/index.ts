import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assessResponse, buildCorrectionMessage, type ToolCall } from "./quality.ts";

// Port of local/quality.py. Hooks turn_end, inspects the assistant message
// + previous turn's tool calls, and — if we detect a failure mode — sends
// a correction user message with deliverAs:"steer" so the model gets it
// immediately on its next turn rather than waiting for the next user input.

// Session-scoped state. Pi reuses extensions across turns within a session;
// a fresh extension instance is loaded per session via the session lifecycle.
let previousToolCalls: ToolCall[] = [];
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_CORRECTIONS = 2; // stop nudging after 2 failed corrections

export default function (pi: ExtensionAPI) {
  // Seed known tools from the active tool registry (same source as /tools).
  // This ensures hallucination detection works from the very first turn,
  // before any tool has been executed. Also listen for tool_execution_start
  // to catch dynamically added tools (e.g. MCP) mid-session.
  const knownTools = new Set<string>();
  pi.on("tool_execution_start", async (event) => {
    const name = (event as any).toolName;
    if (typeof name === "string") knownTools.add(name);
  });

  pi.on("session_start", async () => {
    knownTools.clear();
    pi.getActiveTools().forEach(knownTools.add, knownTools);
    previousToolCalls = [];
    consecutiveFailures = 0;
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = (event as any).message;
    const fs = require('node:fs');
    fs.appendFileSync('/tmp/quality-monitor.log', `[${new Date().toISOString()}] turn_end: stopReason=${(message as any)?.stopReason}, contentLen=${message?.content?.length}, knownToolsSize=${knownTools.size}\n`);
    if (!message) return;

    // Skip quality checks on aborted turns — the user intentionally stopped
    // the agent; injecting a correction is confusing and unwanted.
    const stopReason = (message as any).stopReason;
    if (stopReason === "aborted") {
      previousToolCalls = [];
      consecutiveFailures = 0;
      return;
    }

    // Extract assistant text + tool calls from pi's content-block format
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text ?? "")
      .join("\n");
    const currentCalls: ToolCall[] = content
      .filter((c: any) => c?.type === "toolCall")
      .map((c: any) => ({ name: c.name, input: c.arguments ?? c.input ?? {} }));

    // On error turns (e.g. unknown tool name), still check for hallucinated
    // tools so we can inject a correction — but skip other checks that
    // don't make sense when the turn failed before completion.
    if (stopReason === "error") {
      previousToolCalls = [];
      consecutiveFailures = 0;
      return;
    }

    const verdict = assessResponse(text, currentCalls, previousToolCalls, knownTools);

    // Update rolling state for next turn regardless of verdict
    previousToolCalls = currentCalls;

    if (verdict.ok) {
      consecutiveFailures = 0;
      return;
    }

    // Cap corrections so we don't burn turns in a correction loop
    consecutiveFailures++;
    if (consecutiveFailures > MAX_CONSECUTIVE_CORRECTIONS) {
      ctx.ui.notify(
        `quality-monitor: ${verdict.reason} (suppressed after ${consecutiveFailures} in a row)`,
        "warning",
      );
      return;
    }

    const correction = buildCorrectionMessage(verdict.reason, knownTools);
    ctx.ui.notify(
      `quality-monitor: ${verdict.reason} → injecting correction`,
      "warning",
    );
    // "steer" delivers the correction promptly to the in-flight loop. The
    // prior "followUp" mode parked the message until the *next* user input,
    // by which point it was no longer relevant (issue #16).
    pi.sendUserMessage(correction, { deliverAs: "steer" });
  });
}
