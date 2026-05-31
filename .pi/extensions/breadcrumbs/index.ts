import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverSessions, parseSessionFile, searchSessions } from "../_shared/session-history.ts";

function renderSearch(query: string, limit: number, mode = "lexical"): string {
  const rows = searchSessions(query, discoverSessions(), process.cwd(), limit);
  const modeNote = mode === "semantic" ? "Semantic session search is not initialized; using lexical fallback.\n\n" : "";
  if (rows.length === 0) return `${modeNote}No session breadcrumbs found for ${JSON.stringify(query)}.`;
  return modeNote + rows.map((s, i) => [
    `${i + 1}. ${s.id} score=${s.score} mode=${s.mode}`,
    `project=${s.project ?? "?"} cwd=${s.cwd ?? "?"}`,
    s.snippet,
  ].join("\n")).join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("breadcrumbs", {
    description: "Search prior session outlines: /breadcrumbs <query>",
    handler: async (args, ctx) => ctx.ui?.notify?.(renderSearch(String(args ?? ""), 5), "info"),
  });

  pi.registerTool({
    name: "breadcrumbs_search",
    label: "BreadcrumbsSearch",
    description: "Search prior Pi session outlines and snippets. Returns outlines only, not full transcripts.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
      mode: Type.Optional(Type.String({ description: "Search mode: lexical or semantic. Semantic falls back clearly when unavailable." })),
    }),
    async execute(_id, { query, limit, mode }) {
      return { content: [{ type: "text", text: renderSearch(query, Math.min(limit ?? 5, 20), mode) }], details: { mode: mode === "semantic" ? "lexical-fallback" : "lexical" } };
    },
  });

  pi.registerTool({
    name: "breadcrumbs_read",
    label: "BreadcrumbsRead",
    description: "Read a bounded chunk from a prior session id/path returned by breadcrumbs_search.",
    parameters: Type.Object({
      session: Type.String({ description: "Session id or JSONL path from search" }),
      cursor: Type.Optional(Type.Number({ description: "Turn offset (default 0)" })),
      maxTurns: Type.Optional(Type.Number({ description: "Turns to read (default 8, max 20)" })),
      maxCharacters: Type.Optional(Type.Number({ description: "Character cap (default 8000, hard cap 16000)" })),
      includeToolOutput: Type.Optional(Type.Boolean({ description: "Include tool output bodies (default false)" })),
    }),
    async execute(_id, { session, cursor, maxTurns, maxCharacters, includeToolOutput }): Promise<any> {
      const sessions = discoverSessions();
      const found = sessions.find((s) => s.id === session || s.path === session || s.id.endsWith(session));
      if (!found) return { content: [{ type: "text", text: `Error: unknown session ${session}` }], details: {}, isError: true };
      const parsed = parseSessionFile(found.path) ?? found;
      const start = Math.max(0, cursor ?? 0);
      const count = Math.min(maxTurns ?? 8, 20);
      const cap = Math.min(maxCharacters ?? 8000, 16000);
      const visibleTurns = parsed.turns.filter((t) => includeToolOutput || (!t.toolName && t.role !== "tool" && t.role !== "tool_result"));
      const turns = visibleTurns.slice(start, start + count);
      const text = turns.map((t, i) => `${start + i}: ${t.role}${t.toolName ? `:${t.toolName}` : ""}\n${t.text}`).join("\n\n").slice(0, cap);
      const next = start + count < visibleTurns.length ? start + count : null;
      return { content: [{ type: "text", text: `${text}\n\n[cursor=${start} next=${next} maxTurns=${count} maxCharacters=${cap}]` }], details: { next } };
    },
  });
}
