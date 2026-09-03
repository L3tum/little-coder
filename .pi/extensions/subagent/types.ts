/**
 * Shared type definitions for the subagent extension.
 */

import type { Message } from "@earendil-works/pi-ai";
import { getFinalAssistantText, capErrorText } from "./runner-events.js";

/** Context mode for delegated runs. */
export type DelegationMode = "spawn" | "fork";

/** Default context mode for delegated runs. */
export const DEFAULT_DELEGATION_MODE: DelegationMode = "spawn";

/** Aggregated token usage from a subagent run. */
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Result of a single subagent invocation. */
export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  sawAgentEnd?: boolean;
}

/** Metadata attached to every tool result for rendering. */
export interface SubagentDetails {
  mode: "single" | "parallel";
  delegationMode: DelegationMode;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

/** A display-friendly representation of a message part. */
export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

/** Create an empty UsageStats object. */
export function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

/** Sum usage across multiple results. */
export function aggregateUsage(results: SingleResult[]): UsageStats {
  const total = emptyUsage();
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.turns += r.usage.turns;
  }
  return total;
}

/** Whether the child emitted a final assistant text response. */
export function hasFinalAssistantOutput(
  r: Pick<SingleResult, "messages">,
): boolean {
  return getFinalAssistantText(r.messages).trim().length > 0;
}

/** Whether the child semantically completed the run. */
export function hasSemanticCompletion(
  r: Pick<SingleResult, "messages" | "sawAgentEnd" | "stopReason">,
): boolean {
  // A run whose LAST assistant turn ended in an LLM error (stopReason
  // "error") did not complete, even though it emitted agent_end and has
  // earlier assistant text — treating it as success would hide the real
  // error behind stale partial output.
  return (
    Boolean(r.sawAgentEnd) &&
    r.stopReason !== "error" &&
    hasFinalAssistantOutput(r)
  );
}

/** Whether a result should be treated as successful by the wrapper/UI. */
export function isResultSuccess(r: SingleResult): boolean {
  if (r.exitCode === -1) return false;
  if (hasSemanticCompletion(r)) return true;
  return (
    r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted"
  );
}

/** Whether a result represents an error. */
export function isResultError(r: SingleResult): boolean {
  if (r.exitCode === -1) return false;
  return !isResultSuccess(r);
}

/** Reconcile process exit status with semantic completion observed from Pi's event stream. */
export function normalizeCompletedResult(
  result: SingleResult,
  wasAborted: boolean,
): SingleResult {
  const hasSemanticSuccess = hasSemanticCompletion(result);

  if (wasAborted) {
    if (hasSemanticSuccess) {
      result.exitCode = 0;
      if (result.stopReason === "aborted") result.stopReason = undefined;
      if (result.errorMessage === "Subagent was aborted.") {
        result.errorMessage = undefined;
      }
    } else {
      result.exitCode = 130;
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted.";
      if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
    }
    return result;
  }

  if (result.exitCode > 0) {
    if (hasSemanticSuccess) {
      result.exitCode = 0;
      if (result.stopReason === "error") result.stopReason = undefined;
      if (result.errorMessage === result.stderr.trim()) {
        result.errorMessage = undefined;
      }
    } else {
      if (!result.stopReason) result.stopReason = "error";
      if (!result.errorMessage && result.stderr.trim()) {
        result.errorMessage = result.stderr.trim();
      }
    }
  }

  return result;
}

/** Extract the last assistant text from a message history. */
export function getFinalOutput(messages: Message[]): string {
  return getFinalAssistantText(messages);
}

/**
 * The normalized outcome of one pipeline phase. `ok` is true only when the
 * child exited successfully AND produced non-empty output — a completed run
 * that ends with no text is a failed phase, not a silent success (its
 * downstream phase would otherwise be handed an empty input).
 */
export interface PhaseOutcome {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Classify a finished `SingleResult` into a `PhaseOutcome`. Single source of
 * truth for the "did this phase succeed?" question so the pipeline (and any
 * future pipeline consumer) shares one definition of success. A successful
 * exit with empty final output is treated as a failure; an errored run is one
 * with stderr/errorMessage/`stopReason: "error"`; the unreachable
 * `exitCode === -1` (spawn error) is a failure via the fallback branch.
 * Error strings are bounded (capErrorText) so a chatty stderr cannot
 * turn one failed phase into a wall of notification text.
 */
export function toPhaseOutcome(result: SingleResult): PhaseOutcome {
  const text = getFinalOutput(result.messages);
  const success = isResultSuccess(result);
  const ok = success && text.trim().length > 0;
  let error: string | undefined;
  if (!ok) {
    if (success) {
      error = `${result.agent} completed but produced no output`;
    } else if (isResultError(result)) {
      error =
        capErrorText(result.errorMessage ?? "") ||
        capErrorText(result.stderr) ||
        `${result.agent} failed (exit ${result.exitCode})`;
    } else {
      error = `${result.agent} failed (exit ${result.exitCode})`;
    }
  }
  return { ok, text, error };
}

/** Extract all display-worthy items from a message history. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") {
          items.push({ type: "text", text: part.text });
        } else if (part.type === "toolCall") {
          items.push({
            type: "toolCall",
            name: part.name,
            args: part.arguments,
          });
        }
      }
    }
  }
  return items;
}

/**
 * Return only the LAST display-worthy item (the current tool call if the
 * history ends mid-tool, else the newest text). Backward scan that stops at
 * the first hit — O(1) in history length where getDisplayItems is O(N) in
 * messages AND parts (it allocates a DisplayItem per part). For a live
 * progress panel that re-derives the activity line on every child event,
 * this turns per-event work from unbounded-history into constant. Same
 * filter as getDisplayItems (assistant text/toolCall parts only).
 */
export function getLastDisplayItem(
  messages: Message[],
): DisplayItem | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j];
      if (part.type === "text") {
        return { type: "text", text: part.text };
      } else if (part.type === "toolCall") {
        return { type: "toolCall", name: part.name, args: part.arguments };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Text formatting — for programmatic callers (e.g., deep-plan) that need
// nicely-formatted output without going through the TUI render pipeline.
// ---------------------------------------------------------------------------

/** Format a token count into a human-readable string (e.g., "1.2k", "3M"). */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/** Format usage stats into a compact summary string. */
export function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

/**
 * Format a single subagent result as a text block.
 *
 * Produces output that mimics the collapsed subagent tool-call rendering:
 * status icon, agent name, delegation mode, output preview, and usage stats.
 *
 * @param label  Optional label (e.g. "Phase 1") prepended to the agent name.
 */
export function formatSubagentResult(r: SingleResult, label?: string): string {
  const icon = isResultError(r) ? "✗" : "✓";
  const status = isResultError(r) ? "failed" : "completed";
  const labelPart = label ? `${label} ` : "";
  const header = `${icon} ${labelPart}[${r.agent}] ${status}`;

  const body = getFinalOutput(r.messages) || "(no output)";
  const usage = formatUsage(r.usage, r.model);

  const lines = [header];
  if (body && body !== "(no output)") {
    const preview = body.length > 300 ? body.slice(0, 300) + "..." : body;
    lines.push(preview);
  }
  if (usage) {
    lines.push(usage);
  }
  return lines.join("\n");
}

/**
 * Format multiple subagent results as a combined "parallel" summary block.
 *
 * Each phase is separated by a divider line. Total usage is appended at the end.
 *
 * @param phases  Array of { label, result } pairs.
 */
export function formatSubagentResults(
  phases: { label: string; result: SingleResult }[],
): string {
  const successCount = phases.filter((p) => isResultSuccess(p.result)).length;
  const failCount = phases.filter((p) => isResultError(p.result)).length;

  const lines: string[] = [];

  let icon: string;
  if (failCount > 0) {
    icon = "◐";
    lines.push(
      `${icon} parallel ${successCount}/${phases.length} completed (${failCount} failed)`,
    );
  } else {
    icon = "✓";
    lines.push(`${icon} parallel ${successCount}/${phases.length} completed`);
  }

  for (let i = 0; i < phases.length; i++) {
    lines.push("");
    lines.push(formatSubagentResult(phases[i].result, phases[i].label));
  }

  const totalUsage = formatUsage(aggregateUsage(phases.map((p) => p.result)));
  if (totalUsage) {
    lines.push("");
    lines.push(`Total: ${totalUsage}`);
  }

  return lines.join("\n");
}

// (rendering moved to render.ts — types must be a dependency-free leaf)
