// Port of local/quality.py::assess_response + build_correction_message.

export interface ToolCall {
  name: string;
  input: unknown;
}

export type QualityResult =
  | { ok: true }
  | { ok: false; reason: string };

export function assessResponse(
  text: string,
  toolCalls: ToolCall[],
  recentToolCalls: ToolCall[],
  knownTools: Set<string>,
  recentToolCallsErrorTools: Set<string> = new Set(),
): QualityResult {
  // 1. Empty response with no tool calls
  if (!text.trim() && toolCalls.length === 0) {
    return { ok: false, reason: "empty_response" };
  }

  // 2. Hallucinated tool names (only checked when registry populated)
  for (const tc of toolCalls) {
    if (!tc.name) return { ok: false, reason: "empty_tool_name" };
    if (knownTools.size > 0 && !knownTools.has(tc.name)) {
      return { ok: false, reason: `unknown_tool:${tc.name}` };
    }
  }

  // 3. Repeated tool call loop (exact name+input match with previous turn).
  // Skip the check for tools that errored in the previous turn — retrying a
  // failed call is legitimate.  Only flag as a loop when the same tool+input
  // repeats after a *successful* execution of that call.
  if (toolCalls.length > 0 && recentToolCalls.length > 0) {
    for (const tc of toolCalls) {
      for (const prev of recentToolCalls) {
        if (tc.name === prev.name &&
            JSON.stringify(tc.input) === JSON.stringify(prev.input)) {
          // Only flag if this tool did NOT error in the previous turn
          if (!recentToolCallsErrorTools.has(tc.name)) {
            return { ok: false, reason: "repeated_tool_call" };
          }
        }
      }
    }
  }

  // 4. Malformed arguments sentinel from repairJson fallback
  for (const tc of toolCalls) {
    if (tc.input && typeof tc.input === "object" && "_raw" in tc.input) {
      return { ok: false, reason: `malformed_args:${tc.name || "?"}` };
    }
  }

  return { ok: true };
}

function formatToolList(knownTools: Set<string>): string {
  if (knownTools.size === 0) return "Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch";
  return [...knownTools].sort().join(", ");
}

// Simple Levenshtein distance for fuzzy matching tool names.
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findSimilarTools(toolName: string, knownTools: Set<string>, maxResults = 3): string[] {
  if (knownTools.size === 0) return [];
  const exactCaseInsensitive = [...knownTools].find((t) => t.toLowerCase() === toolName.toLowerCase());
  if (exactCaseInsensitive) return [exactCaseInsensitive];
  const scored = [...knownTools].map((t) => ({
    name: t,
    dist: editDistance(toolName.toLowerCase(), t.toLowerCase()),
  }));
  scored.sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name));
  const threshold = Math.min(3, Math.max(1, Math.floor(toolName.length / 2)));
  return scored.filter((s) => s.dist <= threshold).slice(0, maxResults).map((s) => s.name);
}

export function buildCorrectionMessage(reason: string, knownTools: Set<string> = new Set()): string {
  const tools = formatToolList(knownTools);
  const corrections: Record<string, string> = {
    empty_response:
      "STOP: Your previous response was empty. You MUST respond with either:\n" +
      "1. A text explanation of what you're doing, OR\n" +
      "2. A tool call to make progress.\n" +
      "Do not output nothing. Pick one action and execute it now.",
    empty_tool_name:
      "STOP: Your tool call had an empty tool name. You must specify WHICH tool.\n" +
      "Format: {\"name\": \"<tool_name>\", \"input\": {<args>}}\n" +
      `Available tools: ${tools}.\n` +
      "Pick the right tool for what you need to do and call it properly.",
    repeated_tool_call:
      "STOP: You just repeated the exact same tool call with the same arguments " +
      "as your previous turn. This means you're stuck in a loop.\n" +
      "Do NOT repeat the same call. Instead:\n" +
      "1. Read the file/content you need first (use Read or Bash)\n" +
      "2. Check if the file already exists before writing (use Glob)\n" +
      "3. If Edit failed, re-Read the file to get the exact current text\n" +
      "4. Try a completely different approach if the first one didn't work",
  };

  if (reason.startsWith("unknown_tool:")) {
    const toolName = reason.slice("unknown_tool:".length);
    const similar = findSimilarTools(toolName, knownTools);
    let msg =
      `STOP: Tool '${toolName}' does not exist. You tried to use a tool that isn't available.\n`;
    if (similar.length > 0) {
      msg += `Did you mean: ${similar.join(", ")}?\n`;
    }
    msg += `Available tools: ${tools}.\n` +
      "Pick one of these and call it with the correct name.";
    return msg;
  }
  if (reason.startsWith("malformed_args:")) {
    const toolName = reason.slice("malformed_args:".length);
    return (
      `STOP: The arguments for '${toolName}' were malformed / not valid JSON.\n` +
      "Tool arguments MUST be a valid JSON object, e.g.:\n" +
      `  {"name": "${toolName}", "input": {"key": "value"}}\n` +
      "Check: all quotes are closed, no trailing commas, keys are in double quotes."
    );
  }

  return corrections[reason] ?? `Issue detected: ${reason}. Please review your last action and try a different approach.`;
}

// Short, user-facing phrasing for the harness-intervention line (distinct from
// buildCorrectionMessage, which is the verbose text sent to the model).
export function phraseForUser(reason: string): string {
  if (reason.startsWith("unknown_tool:")) {
    return `the model called a tool that doesn't exist (${reason.slice("unknown_tool:".length)})`;
  }
  if (reason.startsWith("malformed_args:")) {
    return `the model's tool arguments were malformed (${reason.slice("malformed_args:".length)})`;
  }
  const phrases: Record<string, string> = {
    empty_response: "the model returned an empty response",
    empty_tool_name: "the model emitted a tool call with no name",
    repeated_tool_call: "the model repeated its previous tool call verbatim",
  };
  return phrases[reason] ?? `quality issue (${reason})`;
}
