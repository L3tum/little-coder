import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { glob } from "glob";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Ports of tools.py::_glob, _webfetch, _websearch. Pi ships its own grep/find,
// so those are not re-registered here.
export default function (pi: ExtensionAPI) {
  // ── /tools command ────────────────────────────────────────────────────
  pi.registerCommand("tools", {
    description: "List all loaded tools",
    handler: async (_args, ctx) => {
      const allTools: ToolInfo[] = pi.getAllTools();
      const lines: string[] = ["Loaded Tools:", ""];
      const sorted = [...allTools].sort((a, b) => a.name.localeCompare(b.name));
      for (const tool of sorted) {
        const desc = (tool.description ?? "").split("\n")[0].slice(0, 80);
        lines.push(`  ${tool.name} — ${desc}`);
      }
      lines.push("");
      lines.push(`Total: ${sorted.length} tools`);
      const text = lines.join("\n");
      if (ctx.hasUI) {
        ctx.ui.notify(text, "info");
      }
      return { content: [{ type: "text" as const, text }] };
    },
  });

  // ── glob ────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "glob",
    label: "Glob",
    description:
      "Find files matching a glob pattern. Returns a sorted list of matching paths (up to 500).",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern e.g. **/*.py" }),
      path: Type.Optional(Type.String({ description: "Base directory (default: cwd)" })),
    }),
    async execute(_id, { pattern, path }) {
      try {
        const base = path || process.cwd();
        let matches: string[] = await glob(pattern, { cwd: base });
        if (matches.length > 500) matches = matches.slice(0, 500);
        matches.sort();
        const text = matches.length === 0 ? "No files matched" : matches.join("\n");
        return {
          content: [{ type: "text", text }],
          details: {},
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── webfetch ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "webfetch",
    label: "WebFetch",
    description: "Fetch a URL and return its text content (HTML stripped). Capped at 25K chars.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      prompt: Type.Optional(Type.String({ description: "Hint for what to extract (informational)" })),
    }),
    async execute(_id, { url }) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const res = await fetch(url, {
          headers: { "User-Agent": "little-coder/0.1" },
          redirect: "follow",
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Error: HTTP ${res.status} ${res.statusText}` }],
            details: {},
            isError: true,
          };
        }
        const ct = res.headers.get("content-type") || "";
        let text = await res.text();
        if (ct.includes("html")) {
          text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
          text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
          text = text.replace(/<[^>]+>/g, " ");
          text = text.replace(/\s+/g, " ").trim();
        }
        if (text.length > 25_000) text = text.slice(0, 25_000);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── findRead ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "findRead",
    label: "FindRead",
    description:
      "Find files matching a glob pattern and read their contents in one call. " +
      "Combines glob + read so you don't need two separate tool calls. " +
      "Returns each file's path followed by its content, separated by headers. " +
      "Use maxFiles to limit how many files are read (default 10). " +
      "Use maxLines to limit lines per file (default 200, 0 = unlimited).",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern e.g. **/*.py" }),
      path: Type.Optional(Type.String({ description: "Base directory (default: cwd)" })),
      maxFiles: Type.Optional(Type.Number({ description: "Max files to read (default 10, max 50)" })),
      maxLines: Type.Optional(Type.Number({ description: "Max lines per file (default 200, 0 = unlimited)" })),
    }),
    async execute(_id, { pattern, path, maxFiles, maxLines }) {
      try {
        const base = path || process.cwd();
        let matches: string[] = await glob(pattern, { cwd: base });
        matches.sort();

        if (matches.length === 0) {
          return { content: [{ type: "text", text: "No files matched" }], details: {} };
        }

        const limit = Math.min(maxFiles ?? 10, 50);
        const capped = matches.slice(0, limit);
        const lineLimit = maxLines ?? 200;
        const truncated: string[] = [];

        const parts: string[] = [];
        for (const rel of capped) {
          const abs = isAbsolute(rel) ? rel : join(base, rel);
          if (!existsSync(abs)) {
            parts.push(`--- ${abs} ---\n[File not found]`);
            continue;
          }
          try {
            const buf = readFileSync(abs);
            let text = buf.toString("utf-8");
            if (lineLimit > 0) {
              const lines = text.split("\n");
              if (lines.length > lineLimit) {
                text = lines.slice(0, lineLimit).join("\n");
                truncated.push(rel);
              }
            }
            parts.push(`--- ${abs} ---\n${text}`);
          } catch (e) {
            parts.push(`--- ${abs} ---\n[Error reading: ${(e as Error).message}]`);
          }
        }

        const suffix: string[] = [];
        if (matches.length > limit) {
          suffix.push(`\n[Showing ${limit} of ${matches.length} matched files. Increase maxFiles to see more.]`);
        }
        if (truncated.length > 0) {
          suffix.push(`[Truncated to ${lineLimit} lines: ${truncated.join(", ")}]`);
        }

        return {
          content: [{ type: "text", text: parts.join("\n\n") + suffix.join("\n") }],
          details: { filesRead: capped.length, totalMatched: matches.length },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── readEditVerify ────────────────────────────────────────────────────
  pi.registerTool({
    name: "readEditVerify",
    label: "ReadEditVerify",
    description:
      "Read a file, apply text replacements in place, write back, and verify — all in one call. " +
      "Combines read + edit + verify so you don't need multiple tool calls. " +
      "Each replacement is an oldText → newText pair applied sequentially. " +
      "After writing, the tool reads back the file and confirms the content matches.",
    parameters: Type.Object({
      path: Type.String({ description: "Path of the file to edit" }),
      replacements: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text to find" }),
          newText: Type.String({ description: "Replacement text" }),
        }),
        { description: "Sequential text replacements to apply" },
      ),
    }),
    async execute(_id, { path, replacements }) {
      try {
        const abs = isAbsolute(path) ? path : join(process.cwd(), path);
        if (!existsSync(abs)) {
          return {
            content: [{ type: "text", text: `Error: File not found: ${abs}` }],
            details: {},
            isError: true,
          };
        }

        // Read
        let content: string;
        try {
          content = readFileSync(abs, "utf-8");
        } catch (e) {
          return {
            content: [{ type: "text", text: `Error reading file: ${(e as Error).message}` }],
            details: {},
            isError: true,
          };
        }

        // Apply replacements sequentially
        const applied: number[] = [];
        const skipped: number[] = [];
        for (let i = 0; i < replacements.length; i++) {
          const { oldText, newText } = replacements[i];
          if (content.includes(oldText)) {
            content = content.split(oldText).join(newText);
            applied.push(i);
          } else {
            skipped.push(i);
          }
        }

        // Write back
        try {
          writeFileSync(abs, content, "utf-8");
        } catch (e) {
          return {
            content: [{ type: "text", text: `Error writing file: ${(e as Error).message}` }],
            details: {},
            isError: true,
          };
        }

        // Verify: read back and compare
        let verified = false;
        let lineCount = 0;
        try {
          const written = readFileSync(abs, "utf-8");
          verified = written === content;
          lineCount = written.split("\n").length - (written.endsWith("\n") ? 1 : 0) +
            (written.length > 0 && !written.endsWith("\n") ? 1 : 0);
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Written but verification read failed: ${(e as Error).message}` },
            ],
            details: { verified: false },
            isError: true,
          };
        }

        const lines: string[] = [
          `Edited ${abs} (${lineCount} lines)`,
          `Replacements: ${applied.length} applied, ${skipped.length} skipped`,
          `Verification: ${verified ? "OK — content matches" : "MISMATCH — written content differs from expected"}`,
        ];
        if (applied.length > 0) {
          lines.push(`Applied indices: ${applied.join(", ")}`);
        }
        if (skipped.length > 0) {
          lines.push(`Skipped (text not found): ${skipped.join(", ")}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { verified, applied: applied.length, skipped: skipped.length, lines: lineCount },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── websearch ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "websearch",
    label: "WebSearch",
    description: "Search the web via DuckDuckGo and return the top ~8 results as Markdown.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id, { query }) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible)" },
          redirect: "follow",
          signal: controller.signal,
        });
        clearTimeout(timer);
        const body = await res.text();
        const titleRe = /class="result__title"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/div>/g;
        const titles: Array<{ link: string; title: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = titleRe.exec(body)) && titles.length < 8) {
          titles.push({ link: m[1], title: m[2].replace(/<[^>]+>/g, "").trim() });
        }
        const snippets: string[] = [];
        while ((m = snippetRe.exec(body)) && snippets.length < 8) {
          snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
        }
        if (titles.length === 0) {
          return {
            content: [{ type: "text", text: "No results found" }],
            details: {},
          };
        }
        const out = titles
          .map((t, i) => `**${t.title}**\n${t.link}\n${snippets[i] ?? ""}`)
          .join("\n\n");
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
