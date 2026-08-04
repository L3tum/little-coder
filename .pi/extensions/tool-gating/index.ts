import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Port of agent.py's _allowed_tools gate. When LITTLE_CODER_ALLOWED_TOOLS
// is set (comma-separated), any tool_call not in the list is blocked with
// a structured error. The benchmark harness sets this via the RPC env.
// skill-inject also reads the list to filter skills to the allowed subset.

interface ToolCallEvent {
  toolName?: string;
}

interface ToolCallResult {
  block: boolean;
  reason: string;
}

let cachedAllowed: Set<string> | null | undefined = undefined;

function getAllowedTools(): Set<string> | null {
  if (cachedAllowed !== undefined) return cachedAllowed;
  const env = process.env.LITTLE_CODER_ALLOWED_TOOLS;
  if (!env) {
    cachedAllowed = null;
    return null;
  }
  const names = env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  cachedAllowed = names.length === 0 ? null : new Set(names);
  return cachedAllowed;
}

export default function (pi: ExtensionAPI) {
  // Publish the allowed-tools list on systemPromptOptions so skill-inject can
  // filter its budget to allowed tools only (matches _filtered_schemas()
  // behavior in the patched agent.py).
  pi.on("before_agent_start", async (event) => {
    cachedAllowed = undefined; // Invalidate cache for new run
    const allowed = getAllowedTools();
    const eventAny = event as unknown as {
      systemPromptOptions?: Record<string, any>;
    };
    if (!allowed) return;
    const opts = eventAny.systemPromptOptions ?? {};
    if (
      !opts.littleCoder ||
      typeof opts.littleCoder !== "object" ||
      Array.isArray(opts.littleCoder)
    ) {
      opts.littleCoder = {};
    }
    opts.littleCoder.allowedTools = Array.from(allowed);
  });

  pi.on("tool_call", async (event): Promise<ToolCallResult | undefined> => {
    const allowed = getAllowedTools();
    if (!allowed) return;
    const name = (event as ToolCallEvent).toolName;
    if (typeof name === "string" && !allowed.has(name)) {
      return {
        block: true,
        reason: `tool '${name}' is not in _allowed_tools [${Array.from(allowed).join(", ")}]`,
      };
    }
  });
}

// Exported for test isolation — module-level cache persists across test runs
export function resetToolGatingCache() {
  cachedAllowed = undefined;
}
