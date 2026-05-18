import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { glob } from "glob";

// Ports of tools.py::_glob, _webfetch, _websearch. Pi ships its own grep/find,
// so those are not re-registered here.
export default function (pi: ExtensionAPI) {
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
