import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, openSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { harnessIntervention } from "../_shared/intervention.ts";

/**
 * Resolve a write `path` argument to a concrete on-disk path.
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

function pathKey(input: Record<string, unknown>): "path" | "file_path" | undefined {
  if (typeof input.path === "string") return "path";
  if (typeof input.file_path === "string") return "file_path";
  return undefined;
}

function reserveNewWritePath(resolved: string): boolean {
  try {
    closeSync(openSync(resolved, "wx"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    return true;
  }
}

function editRecipe(resolved: string): string {
  return (
    `Write refused — ${resolved} already exists.\n` +
    `\n` +
    `Write is for creating NEW files only. To change an existing file, use edit:\n` +
    `  {"name": "edit", "input": {"path": "${resolved}", ` +
    `"edits": [{"oldText": "<exact text currently in the file>", ` +
    `"newText": "<replacement text>"}]}}\n` +
    `\n` +
    `If you do not already know the file's current content, read it first to get the ` +
    `exact text for oldText. Include enough surrounding context (2-3 lines) to ` +
    `make oldText unique in the file.\n` +
    `\n` +
    `For multiple changes, pass multiple entries in edits[] — one per location. Do NOT ` +
    `retry Write; it will be refused again.`
  );
}

// Port of tools.py::_write's guard. The whitepaper's benchmark result depends
// on Write refusing whole-file rewrites of existing files (fires on ~57% of
// Polyglot exercises). The earlier implementation registered a custom `write`
// tool, but pi's built-in write shadows it; enforce the guard on `tool_call`
// instead so it applies regardless of which write implementation executes.
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (String((event as any).toolName ?? "").toLowerCase() !== "write") return;
    const input = ((event as any).input ?? {}) as Record<string, unknown>;
    const key = pathKey(input);
    if (!key) return;

    const { path: resolved } = normalizeWritePath(String(input[key]), ctx.cwd);
    input[key] = resolved;

    if (!existsSync(resolved) && reserveNewWritePath(resolved)) return;

    harnessIntervention(
      ctx,
      "small models can't rewrite whole files — redirected the model to edit.",
    );
    return { block: true, reason: editRecipe(resolved) };
  });
}
