// Port of local/output_parser.py. Pure-function JSON repair + text-based
// tool-call extraction. Used by the output-parser extension to DETECT
// malformed tool calls (fenced, <tool_call> tags, raw JSON) in assistant
// text. Active repair (executing the extracted calls) is handled by the
// extension via session.followUp() to nudge the model back onto native
// tool-calling for subsequent turns.

export function escapeNewlinesInJsonStrings(text: string): string {
  const out: string[] = [];
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && inString && i + 1 < text.length) {
      out.push(ch, text[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out.push(ch);
    } else if (inString && ch === "\n") {
      out.push("\\n");
    } else if (inString && ch === "\t") {
      out.push("\\t");
    } else if (inString && ch === "\r") {
      out.push("\\r");
    } else {
      out.push(ch);
    }
    i++;
  }
  return out.join("");
}

export function repairJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  // 0. direct parse
  try {
    return JSON.parse(trimmed);
  } catch {}
  // 1. re-escape literal newlines/tabs in strings
  let fixed = escapeNewlinesInJsonStrings(trimmed);
  try {
    return JSON.parse(fixed);
  } catch {}
  // 2. trailing commas
  fixed = fixed.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
  // 3. single quotes → double, only if no doubles present
  if (!fixed.includes('"') && fixed.includes("'"))
    fixed = fixed.replace(/'/g, '"');
  // 4. unquoted keys — skip if content already has quoted string keys
  if (!fixed.includes('": ') && !fixed.includes('":"')) {
    fixed = fixed.replace(/(?<=[{,\s])(\w+)\s*:/g, '"$1":');
  }
  // 5. missing closing braces / brackets
  const openB =
    (fixed.match(/\{/g) || []).length - (fixed.match(/\}/g) || []).length;
  if (openB > 0) fixed += "}".repeat(openB);
  const openS =
    (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
  if (openS > 0) fixed += "]".repeat(openS);
  try {
    return JSON.parse(fixed);
  } catch {}
  // 6. extract first JSON object
  const m = fixed.match(/\{[^{}]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return { _raw: raw };
}

export interface ExtractedCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export function parseTextToolCalls(text: string): ExtractedCall[] {
  const calls: ExtractedCall[] = [];

  // Pattern 1: ```tool ... ``` or ```json ... ```
  const fenceRe = /```(?:tool|json)\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) {
    const data = repairJson(m[1]);
    if (typeof data.name === "string" && data.name) {
      calls.push({
        id: `call_text_${calls.length}`,
        name: data.name,
        input: (data.input ?? data.parameters ?? data.args ?? {}) as Record<
          string,
          unknown
        >,
      });
    }
  }

  // Pattern 2: <tool_call> ... </tool_call>
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((m = tagRe.exec(text))) {
    const data = repairJson(m[1]);
    if (typeof data.name === "string" && data.name) {
      calls.push({
        id: `call_text_${calls.length}`,
        name: data.name,
        input: (data.input ?? data.parameters ?? data.args ?? {}) as Record<
          string,
          unknown
        >,
      });
    }
  }

  // Pattern 3: bare JSON object with "name"+"input"
  if (calls.length === 0) {
    const bareRe = /\{[^{}]*"name"\s*:\s*"(\w+)"[^{}]*\}/g;
    while ((m = bareRe.exec(text))) {
      const data = repairJson(m[0]);
      if (typeof data.name === "string" && data.name) {
        calls.push({
          id: `call_text_${calls.length}`,
          name: data.name,
          input: (data.input ?? data.parameters ?? {}) as Record<
            string,
            unknown
          >,
        });
      }
    }
  }

  return calls;
}
