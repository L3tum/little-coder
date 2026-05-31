import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { findCompatibleToolName, rewriteValueToSchema, type CompatRewriteStats } from "./heuristics.ts";

interface CompatStats {
  toolCallsSeen: number;
  mutatedCalls: number;
  renamedKeys: number;
  arrayWraps: number;
  unknownToolCorrections: number;
  rewrittenByTool: Record<string, number>;
  recentNotes: string[];
}

function emptyStats(): CompatStats {
  return {
    toolCallsSeen: 0,
    mutatedCalls: 0,
    renamedKeys: 0,
    arrayWraps: 0,
    unknownToolCorrections: 0,
    rewrittenByTool: {},
    recentNotes: [],
  };
}

function addNote(stats: CompatStats, note: string): void {
  stats.recentNotes.unshift(note);
  if (stats.recentNotes.length > 12) stats.recentNotes.length = 12;
}

function replaceObjectContents(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of Object.entries(next)) target[key] = value;
}

function renderStats(stats: CompatStats): string {
  const lines = [
    "Compatibility stats:",
    `  toolCallsSeen: ${stats.toolCallsSeen}`,
    `  mutatedCalls: ${stats.mutatedCalls}`,
    `  renamedKeys: ${stats.renamedKeys}`,
    `  arrayWraps: ${stats.arrayWraps}`,
    `  unknownToolCorrections: ${stats.unknownToolCorrections}`,
  ];
  const tools = Object.entries(stats.rewrittenByTool).sort((a, b) => b[1] - a[1]);
  if (tools.length > 0) {
    lines.push("", "Rewrites by tool:");
    for (const [tool, count] of tools) lines.push(`  ${tool}: ${count}`);
  }
  if (stats.recentNotes.length > 0) {
    lines.push("", "Recent rewrites:");
    for (const note of stats.recentNotes) lines.push(`  ${note}`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let stats = emptyStats();

  pi.on("session_start", async () => {
    stats = emptyStats();
    // Tools with required `path` parameters (read, write) fail TypeBox
    // validation when the model sends `file_path` instead.  Validation
    // happens *before* the tool_call extension event, so the heuristic
    // rewrite in on("tool_call") never runs.  Workaround: wrap these tools
    // with a prepareArguments shim that applies the rewrite before validation.
    const wrapPrepare = (def: any) => {
      def.prepareArguments = (args: unknown) => {
        if (!args || typeof args !== "object" || Array.isArray(args)) return args;
        const out = rewriteValueToSchema(
          args as Record<string, unknown>,
          def.parameters as any,
        ) as {
          value: unknown;
          changed: boolean;
          stats: CompatRewriteStats;
        };
        if (!out.changed || !out.value || typeof out.value !== "object" || Array.isArray(out.value))
          return args;
        return out.value;
      };
      return def;
    };
    pi.registerTool(wrapPrepare(createReadToolDefinition(process.cwd())) as any);
    pi.registerTool(wrapPrepare(createWriteToolDefinition(process.cwd())) as any);
  });

  pi.registerCommand("compat-stats", {
    description: "Show compatibility rewrite statistics for this session",
    handler: async (_args, ctx) => {
      const text = renderStats(stats);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });

  pi.on("tool_call", async (event) => {
    stats.toolCallsSeen++;
    if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) return;
    const tool = (pi.getAllTools() as Array<{ name: string; parameters?: unknown }>).find((t) => t.name === event.toolName);
    const schema = tool?.parameters as any;
    if (!schema) return;

    const out = rewriteValueToSchema(event.input, schema) as {
      value: unknown;
      changed: boolean;
      stats: CompatRewriteStats;
    };
    if (!out.changed || !out.value || typeof out.value !== "object" || Array.isArray(out.value)) return;

    replaceObjectContents(event.input as Record<string, unknown>, out.value as Record<string, unknown>);
    stats.mutatedCalls++;
    stats.renamedKeys += out.stats.renamedKeys.length;
    stats.arrayWraps += out.stats.arrayWrappedKeys.length;
    stats.rewrittenByTool[event.toolName] = (stats.rewrittenByTool[event.toolName] ?? 0) + 1;
    const detailParts: string[] = [];
    if (out.stats.renamedKeys.length > 0) {
      detailParts.push(out.stats.renamedKeys.map((p) => `${p.from}→${p.to}`).join(", "));
    }
    if (out.stats.arrayWrappedKeys.length > 0) {
      detailParts.push(`wrapped arrays: ${out.stats.arrayWrappedKeys.join(", ")}`);
    }
    addNote(stats, `${event.toolName}: ${detailParts.join("; ")}`);
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = (event as any).message;
    if (!message || (message as any).stopReason !== "error") return;
    const knownTools = new Set((pi.getAllTools() as Array<{ name: string }>).map((t) => t.name));
    const content = Array.isArray(message.content) ? message.content : [];
    const calls = content
      .filter((block: any) => block?.type === "toolCall")
      .map((block: any) => ({
        name: String(block.name ?? ""),
        input: block.arguments ?? block.input ?? {},
      }));

    for (const call of calls) {
      if (!call.name || knownTools.has(call.name)) continue;
      const corrected = findCompatibleToolName(call.name, knownTools);
      if (!corrected || corrected === call.name) continue;
      stats.unknownToolCorrections++;
      addNote(stats, `tool name: ${call.name}→${corrected}`);
      const fixedCall = JSON.stringify({ name: corrected, input: call.input });
      const text = [
        `Compatibility correction: tool '${call.name}' should be '${corrected}'.`,
        "Retry immediately with this corrected tool call:",
        "```tool",
        fixedCall,
        "```",
      ].join("\n");
      ctx.ui.notify(`compatibility: corrected tool '${call.name}' → '${corrected}'`, "warning");
      pi.sendUserMessage(text, { deliverAs: "steer" });
      return;
    }

    const rawText = content
      .filter((block: any) => block?.type === "text")
      .map((block: any) => String(block.text ?? ""))
      .join("\n");
    const m = rawText.match(/Unknown tool:?\s*([^\s.,;!?)\]}]+)/i);
    const bad = m?.[1]?.trim();
    if (!bad) return;
    const corrected = findCompatibleToolName(bad, knownTools);
    if (!corrected || corrected === bad) return;
    stats.unknownToolCorrections++;
    addNote(stats, `tool name: ${bad}→${corrected}`);
    const text = `Compatibility correction: tool '${bad}' should be '${corrected}'. Retry the same call with the corrected tool name.`;
    ctx.ui.notify(`compatibility: corrected tool '${bad}' → '${corrected}'`, "warning");
    pi.sendUserMessage(text, { deliverAs: "steer" });
  });
}
