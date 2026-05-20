import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { glob } from "glob";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ports of tools.py::_glob, _webfetch, _websearch. Pi ships its own grep/find,
// so those are not re-registered here.

const BROWSER_TOOL_NAMES = [
  "BrowserNavigate",
  "BrowserClick",
  "BrowserType",
  "BrowserScroll",
  "BrowserExtract",
  "BrowserBack",
  "BrowserHistory",
];

function browserToolDescriptions(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "..", "..", "skills", "tools");
  const out: string[] = [];
  const mapping: Record<string, string> = {
    BrowserNavigate: "browser_navigate.md",
    BrowserClick: "browser_click.md",
    BrowserType: "browser_type.md",
    BrowserExtract: "browser_extract.md",
  };
  for (const name of BROWSER_TOOL_NAMES) {
    const file = mapping[name];
    if (!file) {
      out.push(`  ${name} — available on demand; see /enable-browser-tools`);
      continue;
    }
    try {
      const text = readFileSync(join(dir, file), "utf-8");
      const body = text.split("---").slice(2).join("---").trim();
      const first = body.split("\n").find((line) => line.trim().length > 0) ?? "available on demand";
      out.push(`  ${name} — ${first.replace(/^##\s+/, "").slice(0, 90)}`);
    } catch {
      out.push(`  ${name} — available on demand; see /enable-browser-tools`);
    }
  }
  return out;
}

function renderToolsListing(pi: ExtensionAPI): string {
  const allTools = pi.getAllTools() as Array<{ name: string; description?: string }>;
  const lines: string[] = ["Loaded Tools:", ""];
  const sorted = [...allTools].sort((a, b) => a.name.localeCompare(b.name));
  const loadedNames = new Set(sorted.map((t) => t.name));
  for (const tool of sorted) {
    const desc = (tool.description ?? "").split("\n")[0].slice(0, 80);
    lines.push(`  ${tool.name} — ${desc}`);
  }
  const hiddenBrowser = BROWSER_TOOL_NAMES.filter((name) => !loadedNames.has(name));
  if (hiddenBrowser.length > 0) {
    lines.push("");
    lines.push("Browser tools available on demand:");
    lines.push(...browserToolDescriptions());
    lines.push("  Use enableBrowserTools (tool) or /enable-browser-tools (command) to load them.");
  }
  lines.push("");
  lines.push(`Total: ${sorted.length} tools`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  // ── /tools command ────────────────────────────────────────────────────
  pi.registerCommand("tools", {
    description: "List all loaded tools",
    handler: async (_args, ctx) => {
      const text = renderToolsListing(pi);
      if (ctx.hasUI) {
        ctx.ui.notify(text, "info");
      }
    },
  });

  pi.registerTool({
    name: "tools",
    label: "Tools",
    description: "List the current tool registry, including Browser* tools that are discoverable on demand.",
    promptSnippet: "tools(): list currently loaded tools and on-demand Browser* tools.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: renderToolsListing(pi) }], details: {} };
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
      "Use maxFiles to limit how many files are read (default 5). " +
      "Use maxLines to limit lines per file (default 100, 0 = unlimited). " +
      "WARNING: this tool can easily overload the context window — always use the lowest maxFiles/maxLines that gets the job done."
    ,
    promptSnippet: "findRead(pattern, path?, maxFiles?, maxLines?): glob + read in one call.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern e.g. **/*.py" }),
      path: Type.Optional(Type.String({ description: "Base directory (default: cwd)" })),
      maxFiles: Type.Optional(Type.Number({ description: "Max files to read (default 10, max 50)" })),
      maxLines: Type.Optional(Type.Number({ description: "Max lines per file (default 200, 0 = unlimited)" })),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args as any;
      const input = args as Record<string, unknown>;
      return {
        pattern: input.pattern,
        path: typeof input.path === "string" ? input.path : input.file_path,
        maxFiles: typeof input.maxFiles === "number" ? input.maxFiles : input.max_files,
        maxLines: typeof input.maxLines === "number" ? input.maxLines : input.max_lines,
      } as any;
    },
    async execute(_id, { pattern, path, maxFiles, maxLines }): Promise<any> {
      try {
        const base = path || process.cwd();
        let matches: string[] = await glob(pattern, { cwd: base });
        matches.sort();

        if (matches.length === 0) {
          return { content: [{ type: "text", text: "No files matched" }], details: { filesRead: 0, totalMatched: 0 } };
        }

        const limit = Math.min(maxFiles ?? 5, 50);
        const capped = matches.slice(0, limit);
        const lineLimit = maxLines ?? 100;
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
          details: { verified: false, applied: 0, skipped: 0, lines: 0 },
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
      "Each replacement is an old_string → new_string pair applied sequentially. " +
      "After writing, the tool reads back the file and confirms the content matches.",
    promptSnippet: "readEditVerify(path, replacements): read, patch, write, and verify in one call.",
    parameters: Type.Object({
      path: Type.String({ description: "Path of the file to edit" }),
      replacements: Type.Array(
        Type.Object({
          old_string: Type.String({ description: "Exact text to find" }),
          new_string: Type.String({ description: "Replacement text" }),
        }),
        { description: "Sequential text replacements to apply" },
      ),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args as any;
      const input = args as Record<string, unknown> & {
        replacements?: Array<Record<string, unknown>>;
        replacement?: Record<string, unknown>;
      };
      const replacements = Array.isArray(input.replacements)
        ? input.replacements
        : input.replacement && typeof input.replacement === "object"
          ? [input.replacement]
          : [];
      const topLevelOld = typeof input.old_string === "string"
        ? input.old_string
        : input.oldText;
      const topLevelNew = typeof input.new_string === "string"
        ? input.new_string
        : input.newText;
      const normalized = replacements.map((r) => ({
        old_string: typeof r.old_string === "string" ? r.old_string : r.oldText,
        new_string: typeof r.new_string === "string" ? r.new_string : r.newText,
      }));
      if (typeof topLevelOld === "string" && typeof topLevelNew === "string") {
        normalized.push({ old_string: topLevelOld, new_string: topLevelNew });
      }
      return {
        path: typeof input.path === "string" ? input.path : input.file_path,
        replacements: normalized,
      } as any;
    },
    async execute(_id, { path, replacements }): Promise<any> {
      try {
        const abs = isAbsolute(path) ? path : join(process.cwd(), path);
        if (!existsSync(abs)) {
          return {
            content: [{ type: "text", text: `Error: File not found: ${abs}` }],
            details: { verified: false, applied: 0, skipped: 0, lines: 0 },
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
            details: { verified: false, applied: 0, skipped: 0, lines: 0 },
            isError: true,
          };
        }

        // Apply replacements sequentially
        const applied: number[] = [];
        const skipped: number[] = [];
        for (let i = 0; i < replacements.length; i++) {
          const { old_string, new_string } = replacements[i] as { old_string: string; new_string: string };
          if (content.includes(old_string)) {
            content = content.split(old_string).join(new_string);
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
            details: { verified: false, applied: applied.length, skipped: skipped.length, lines: 0 },
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
            details: { verified: false, applied: applied.length, skipped: skipped.length, lines: 0 },
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
          details: { verified: false, applied: 0, skipped: 0, lines: 0 },
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
