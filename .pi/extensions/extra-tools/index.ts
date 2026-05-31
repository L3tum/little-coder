import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globFiles, renderGlobOutcome } from "./glob.ts";

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

  // Default vendor directory names to exclude from glob / findRead results.
  const DEFAULT_VENDOR_DIRS = ["node_modules", ".git", "vendor"];

  // ── glob ────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "glob",
    label: "Glob",
    description:
      "Find files matching a glob pattern. Returns a sorted list of matching paths (up to 500). " +
      "Common dependency/build/cache dirs (node_modules, .git, dist, …) are skipped, and the walk " +
      "is bounded — for a focused search, pass a `path` rather than globbing a whole home directory.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern e.g. **/*.py" }),
      path: Type.Optional(Type.String({ description: "Base directory (default: cwd)" })),
      ignoreDefaultExcludes: Type.Optional(Type.Boolean({
        description: `If true (default), skip common vendor directories (${DEFAULT_VENDOR_DIRS.join(", ")}). Set to false to include them.`,
      })),
    }),
    async execute(_id, { pattern, path, ignoreDefaultExcludes }) {
      try {
        const base = path || process.cwd();
        const outcome = await globFiles(pattern, {
          base,
          heavyDirs: ignoreDefaultExcludes === false ? new Set() : undefined,
        });
        return {
          content: [{ type: "text", text: renderGlobOutcome(outcome) }],
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
        const u = String(url ?? "").trim();
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
          return {
            content: [{ type: "text", text: "Error: url must start with http:// or https://" }],
            details: {},
            isError: true,
          };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const res = await fetch(u, {
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
      "Use maxCharacters to limit characters per file (default 4000, 0 = unlimited). " +
      "WARNING: this tool can easily overload the context window — always use the lowest maxFiles/maxCharacters that gets the job done."
    ,
    promptSnippet: "findRead(pattern, path?, maxFiles?, maxCharacters?, ignoreDefaultExcludes?): glob + read in one call.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern e.g. **/*.py" }),
      path: Type.Optional(Type.String({ description: "Base directory (default: cwd)" })),
      maxFiles: Type.Optional(Type.Number({ description: "Max files to read (default 10, max 50)" })),
      maxCharacters: Type.Optional(Type.Number({ description: "Max characters per file (default 4000, 0 = unlimited)" })),
      ignoreDefaultExcludes: Type.Optional(Type.Boolean({
        description: `If true (default), skip common vendor directories (${DEFAULT_VENDOR_DIRS.join(", ")}). Set to false to include them.`,
      })),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args as any;
      const input = args as Record<string, unknown>;
      const maxCharacters = typeof input.maxCharacters === "number"
        ? input.maxCharacters
        : typeof input.max_characters === "number"
          ? input.max_characters
          : undefined;
      return {
        pattern: input.pattern,
        path: typeof input.path === "string" ? input.path : input.file_path,
        maxFiles: typeof input.maxFiles === "number" ? input.maxFiles : input.max_files,
        maxCharacters,
        ignoreDefaultExcludes: typeof input.ignoreDefaultExcludes === "boolean"
          ? input.ignoreDefaultExcludes
          : typeof input.ignore_default_excludes === "boolean"
            ? input.ignore_default_excludes
            : undefined,
      } as any;
    },
    async execute(_id, { pattern, path, maxFiles, maxCharacters, ignoreDefaultExcludes }): Promise<any> {
      const base = path || process.cwd();
      const limit = Math.min(maxFiles ?? 5, 50);
      const charLimit = maxCharacters ?? 4000;
      const invocation = [
        "findRead invocation:",
        `pattern=${JSON.stringify(pattern)}`,
        `path=${JSON.stringify(base)}`,
        `maxFiles=${limit}`,
        `maxCharacters=${charLimit}`,
        `ignoreDefaultExcludes=${ignoreDefaultExcludes !== false}`,
        "",
      ].join("\n");
      try {
        const outcome = await globFiles(pattern, {
          base,
          maxMatches: limit,
          heavyDirs: ignoreDefaultExcludes === false ? new Set() : undefined,
        });
        const matches = outcome.matches;

        if (matches.length === 0) {
          return { content: [{ type: "text", text: invocation + renderGlobOutcome(outcome) }], details: { filesRead: 0, totalMatched: 0 } };
        }

        const capped = matches;
        const truncated: string[] = [];

        const parts: string[] = [];
        for (const abs of capped) {
          const rel = abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
          if (!existsSync(abs)) {
            parts.push(`--- ${abs} ---\n[File not found]`);
            continue;
          }
          try {
            const buf = readFileSync(abs);
            let text = buf.toString("utf-8");
            if (charLimit > 0 && text.length > charLimit) {
              text = text.slice(0, charLimit);
              truncated.push(rel);
            }
            parts.push(`--- ${abs} ---\n${text}`);
          } catch (e) {
            parts.push(`--- ${abs} ---\n[Error reading: ${(e as Error).message}]`);
          }
        }

        const suffix: string[] = [];
        if (outcome.matchTruncated) {
          suffix.push(`\n[Showing first ${limit} matched files. Increase maxFiles or narrow the pattern to see more.]`);
        }
        if (outcome.scanTruncated) {
          suffix.push(`[Search stopped after scanning many entries; results may be incomplete. Narrow the base path.]`);
        }
        if (truncated.length > 0) {
          suffix.push(`[Truncated to ${charLimit} characters: ${truncated.join(", ")}]`);
        }

        return {
          content: [{ type: "text", text: invocation + parts.join("\n\n") + suffix.join("\n") }],
          details: { filesRead: capped.length, totalMatched: matches.length },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: invocation + `Error: ${(e as Error).message}` }],
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
