import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].old_string must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    promptSnippet: "edit(path, edits): patch an existing file using exact old_string → new_string replacements.",
    parameters: Type.Object({
      path: Type.String({ description: "Path of the file to edit" }),
      edits: Type.Array(
        Type.Object({
          old_string: Type.String({ description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].old_string in the same call." }),
          new_string: Type.String({ description: "Replacement text for this targeted edit." }),
        }),
        { description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead." },
      ),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args as any;
      const input = args as {
        path?: unknown;
        file_path?: unknown;
        edits?: Array<{ old_string?: unknown; new_string?: unknown; oldText?: unknown; newText?: unknown }>;
        edit?: { old_string?: unknown; new_string?: unknown; oldText?: unknown; newText?: unknown };
        old_string?: unknown;
        new_string?: unknown;
        oldText?: unknown;
        newText?: unknown;
      };
      const path = typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : input.path;
      const normalizedEdits = [
        ...(Array.isArray(input.edits) ? input.edits : []),
        ...(input.edit && typeof input.edit === "object" ? [input.edit] : []),
      ].flatMap((e) => {
            const old_string = typeof e?.old_string === "string"
              ? e.old_string
              : typeof e?.oldText === "string"
                ? e.oldText
                : undefined;
            const new_string = typeof e?.new_string === "string"
              ? e.new_string
              : typeof e?.newText === "string"
                ? e.newText
                : undefined;
            return typeof old_string === "string" && typeof new_string === "string"
              ? [{ old_string, new_string }]
              : [];
          });
      const topLevelOld = typeof input.old_string === "string"
        ? input.old_string
        : typeof input.oldText === "string"
          ? input.oldText
          : undefined;
      const topLevelNew = typeof input.new_string === "string"
        ? input.new_string
        : typeof input.newText === "string"
          ? input.newText
          : undefined;
      if (typeof topLevelOld === "string" && typeof topLevelNew === "string") {
        normalizedEdits.push({ old_string: topLevelOld, new_string: topLevelNew });
      }
      return { path, edits: normalizedEdits } as any;
    },
    async execute(_id, { path, edits }) {
      try {
        const abs = isAbsolute(path) ? path : join(process.cwd(), path);
        const original = readFileSync(abs, "utf-8");
        let content = original;
        for (let i = 0; i < edits.length; i++) {
          const { old_string, new_string } = edits[i];
          if (!old_string) {
            return {
              content: [{ type: "text", text: `Error: edits[${i}].old_string must not be empty in ${abs}.` }],
              details: {},
              isError: true,
            };
          }
          const first = content.indexOf(old_string);
          if (first === -1) {
            return {
              content: [{ type: "text", text: `Error: Could not find edits[${i}] in ${abs}. The old_string must match exactly including all whitespace and newlines.` }],
              details: {},
              isError: true,
            };
          }
          const second = content.indexOf(old_string, first + old_string.length);
          if (second !== -1) {
            return {
              content: [{ type: "text", text: `Error: Found multiple occurrences of edits[${i}] in ${abs}. Each old_string must be unique. Please provide more context to make it unique.` }],
              details: {},
              isError: true,
            };
          }
          content = content.replace(old_string, new_string);
        }
        writeFileSync(abs, content, "utf-8");
        return {
          content: [{ type: "text", text: `Edited ${abs} (${edits.length} edit block${edits.length === 1 ? "" : "s"})` }],
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
