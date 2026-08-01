import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Port of agent.py's _allowed_tools gate. When LITTLE_CODER_ALLOWED_TOOLS
// is set (comma-separated), any tool_call not in the list is blocked with
// a structured error. The benchmark harness sets this via the RPC env.
// skill-inject also reads the list to filter skills to the allowed subset.

function getAllowedTools(): Set<string> | null {
  const env = process.env.LITTLE_CODER_ALLOWED_TOOLS;
  if (!env) return null;
  const names = env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length === 0 ? null : new Set(names);
}

export default function (pi: ExtensionAPI) {
  // Publish the allowed-tools list on systemPromptOptions so skill-inject can
  // filter its budget to allowed tools only (matches _filtered_schemas()
  // behavior in the patched agent.py).
  pi.on("before_agent_start", async (event) => {
    const allowed = getAllowedTools();
    if (!allowed) return;
    const opts: any = (event as any).systemPromptOptions ?? {};
    if (!opts.littleCoder) opts.littleCoder = {};
    opts.littleCoder.allowedTools = Array.from(allowed);
  });

  pi.on("tool_call", async (event) => {
    const allowed = getAllowedTools();
    if (!allowed) return;
    const name = (event as any).toolName;
    if (typeof name === "string" && !allowed.has(name)) {
      return {
        block: true,
        reason: `tool '${name}' is not in _allowed_tools [${Array.from(allowed).join(", ")}]`,
      };
    }
  });
}
