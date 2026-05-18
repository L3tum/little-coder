import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Resolve the Write tool's `path` argument to a concrete on-disk path.
 *
 * Two deterministic rewrites:
 *
 * 1. `"/<single-segment>"` (e.g. `/foo.md`) → `<cwd>/<single-segment>`.
 *    Background: the model has been seen to anchor at filesystem root when
 *    given an "Absolute file path" schema and no obvious directory context.
 *    Genuine system-path writes always include at least one intermediate
 *    directory (`/etc/X`, `/tmp/Y/Z`), so a root + bare filename is almost
 *    always a mistake. Rewriting to cwd matches user intent and avoids
 *    accidentally writing to `/`.
 *
 * 2. Bare filename / relative path (no leading slash) → resolved against cwd.
 *    Node's `fs` APIs already do this implicitly, but resolving here makes
 *    the success message report the real absolute path that was written.
 *
 * Anything else (absolute path with at least one intermediate directory) is
 * left untouched.
 */
export function normalizeWritePath(
  inputPath: string,
  cwd: string = process.cwd(),
): { path: string; rewrittenFrom?: string } {
  if (/^\/[^/]+$/.test(inputPath)) {
    return { path: join(cwd, inputPath.slice(1)), rewrittenFrom: inputPath };
  }
  if (!isAbsolute(inputPath)) {
    return { path: join(cwd, inputPath) };
  }
  return { path: inputPath };
}

// Port of tools.py::_write. Preserves the exact Edit-recipe error string so
// the model recovers to Edit on its next turn. The whitepaper's benchmark
// result depends on Write refusing whole-file rewrites of existing files
// (fires on ~57% of Polyglot exercises).
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "write",
    label: "Write",
    description:
      "Create a NEW file with the given content. Refuses if the file already exists — use edit to modify existing files. " +
      "Parent directories are created automatically. " +
      "Pass either a path relative to the working directory (e.g. `notes/plan.md`) or a full absolute path. " +
      "A bare filename like `foo.md` resolves to <cwd>/foo.md. " +
      "A path of the form `/<filename>` with no intermediate directories is treated as cwd-relative " +
      "(use `/etc/hosts` etc. if you really mean the filesystem root).",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to cwd, or absolute)" }),
      content: Type.String({ description: "Full file content" }),
    }),
    async execute(_id, { path, content }) {
      const { path: resolved, rewrittenFrom } = normalizeWritePath(path);
      if (existsSync(resolved)) {
        const recipe =
          `Error: Write refused — ${resolved} already exists.\n` +
          `\n` +
          `Write is only for creating NEW files. To change an existing file, use Edit:\n` +
          `  {"name": "Edit", "input": {"path": "${resolved}", ` +
          `"old_string": "<exact text currently in the file>", ` +
          `"new_string": "<replacement text>"}}\n` +
          `\n` +
          `If you do not already know the file's current content, Read it first to ` +
          `get the exact text for old_string. Include enough surrounding context ` +
          `(2-3 lines) to make old_string unique in the file.\n` +
          `\n` +
          `For multiple changes, emit multiple Edit calls — one per location. Do NOT ` +
          `retry Write; it will be refused again.`;
        return {
          content: [{ type: "text", text: recipe }],
          details: {},
          isError: true,
        };
      }

      try {
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, content, { encoding: "utf-8" });
        const lc = content.split("\n").length - (content.endsWith("\n") ? 1 : 0) +
          (content.length > 0 && !content.endsWith("\n") ? 1 : 0);
        const suffix = rewrittenFrom
          ? ` (note: rewrote "${rewrittenFrom}" to "${resolved}" — single-segment root paths are treated as cwd-relative)`
          : "";
        return {
          content: [{ type: "text", text: `Created ${resolved} (${lc} lines)${suffix}` }],
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
}
