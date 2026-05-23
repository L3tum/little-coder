import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assessResponse, buildCorrectionMessage, phraseForUser, type ToolCall } from "./quality.ts";
import { harnessIntervention } from "../_shared/intervention.ts";

// Port of local/quality.py. Hooks turn_end, inspects the assistant message
// + previous turn's tool calls, and — if we detect a failure mode — sends
// a correction user message with deliverAs:"steer" so the model gets it
// immediately on its next turn rather than waiting for the next user input.

// Session-scoped state. Pi reuses extensions across turns within a session;
// a fresh extension instance is loaded per session via the session lifecycle.
let previousToolCalls: ToolCall[] = [];
// Track which specific tools had errors in the previous turn.
// Only those tools are exempt from the repeated_tool_call check on the next turn.
let previousTurnErrorTools = new Set<string>();
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
    const activeTools = typeof (pi as any).getActiveTools === "function"
      ? (pi as any).getActiveTools()
      : [];
    if (Array.isArray(activeTools)) {
      activeTools.forEach((name: unknown) => {
        if (typeof name === "string") knownTools.add(name);
      });
    }
    previousToolCalls = [];
    previousTurnErrorTools = new Set();
    consecutiveFailures = 0;
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = (event as any).message;
    if (!message) return;

    // Skip turns that were interrupted/aborted — by the user pressing ESC OR by
    // a harness abort (thinking-budget, turn-cap). Their content is
    // legitimately partial/empty, so assessing them spuriously fires
    // `empty_response`. Also clear the rolling state so the next completed turn
    // doesn't inherit stale repeat-loop context from an interrupted one.
    const stopReason = (message as any).stopReason;
    if (stopReason === "aborted") {
      previousToolCalls = [];
      previousTurnErrorTools = new Set();
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

    // Turns that fail before completion should not seed repeat-loop detection.
    if (stopReason === "error") {
      previousToolCalls = [];
      previousTurnErrorTools = new Set();
      consecutiveFailures = 0;
      return;
    }

    const toolResults = Array.isArray((event as any).toolResults) ? (event as any).toolResults : [];

    // Build the set of tool names that errored this turn.
    const currentErrorTools = new Set<string>();
    for (const result of toolResults) {
      if (result?.isError && result?.toolName) {
        currentErrorTools.add(result.toolName);
      }
    }

    const verdict = assessResponse(
      text,
      currentCalls,
      previousToolCalls,
      knownTools,
      previousTurnErrorTools,
      currentErrorTools,
    );

    // Update rolling state for next turn regardless of verdict
    previousToolCalls = currentCalls;
    previousTurnErrorTools = currentErrorTools;

    if (verdict.ok) {
      consecutiveFailures = 0;
      return;
    }

    // Cap corrections so we don't burn turns in a correction loop
    consecutiveFailures++;
    if (consecutiveFailures > MAX_CONSECUTIVE_CORRECTIONS) {
      harnessIntervention(
        ctx,
        `${phraseForUser(verdict.reason)} — backing off after ${consecutiveFailures} in a row.`,
      );
      return;
    }

    const correction = buildCorrectionMessage(verdict.reason, knownTools);
    harnessIntervention(ctx, `${phraseForUser(verdict.reason)} — redirecting the model.`);
    // "steer" delivers the correction promptly to the in-flight loop. The
    // prior "followUp" mode parked the message until the *next* user input,
    // by which point it was no longer relevant (issue #16).
    pi.sendUserMessage(correction, { deliverAs: "steer" });
  });
}
