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

  // 3. Repeated tool call loop (exact name+input match with previous turn)
  if (toolCalls.length > 0 && recentToolCalls.length > 0) {
    for (const tc of toolCalls) {
      for (const prev of recentToolCalls) {
        if (tc.name === prev.name &&
            JSON.stringify(tc.input) === JSON.stringify(prev.input)) {
          return { ok: false, reason: "repeated_tool_call" };
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
    return (
      `STOP: Tool '${toolName}' does not exist. You tried to use a tool that isn't available.\n` +
      `Available tools: ${tools}.\n` +
      "Pick one of these and call it with the correct name."
    );
  }
  if (reason.startsWith("malformed_args:")) {
    const toolName = reason.slice("malformed_args:".length);
    return (
      `STOP: The arguments for '${toolName}' were not valid JSON.\n` +
      "Tool arguments MUST be a valid JSON object, e.g.:\n" +
      `  {"name": "${toolName}", "input": {"key": "value"}}\n` +
      "Check: all quotes are closed, no trailing commas, keys are in double quotes."
    );
  }

  return corrections[reason] ?? `Issue detected: ${reason}. Please review your last action and try a different approach.`;
}
