import {
  createEditToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export function normalizeEditArguments(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const input = args as {
    path?: unknown;
    file_path?: unknown;
    edits?: unknown;
    edit?: unknown;
    old_string?: unknown;
    new_string?: unknown;
    oldString?: unknown;
    newString?: unknown;
    old_text?: unknown;
    new_text?: unknown;
    oldText?: unknown;
    newText?: unknown;
  };

  const pickString = (value: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const key of keys) {
      if (typeof value[key] === "string") return value[key];
    }
    return undefined;
  };

  const normalizeOne = (edit: unknown) => {
    if (!edit || typeof edit !== "object") return null;
    const e = edit as Record<string, unknown>;
    const oldText = pickString(e, ["oldText", "old_string", "oldString", "old_text"]);
    const newText = pickString(e, ["newText", "new_string", "newString", "new_text"]);
    return typeof oldText === "string" && typeof newText === "string" ? { oldText, newText } : null;
  };

  let rawEdits: unknown[] = [];
  if (Array.isArray(input.edits)) rawEdits = input.edits;
  else if (typeof input.edits === "string") {
    try {
      const parsed = JSON.parse(input.edits);
      if (Array.isArray(parsed)) rawEdits = parsed;
    } catch {}
  }
  if (input.edit) rawEdits = [...rawEdits, input.edit];

  const edits = rawEdits.flatMap((edit) => {
    const normalized = normalizeOne(edit);
    return normalized ? [normalized] : [];
  });
  const topLevel = normalizeOne(input);
  if (topLevel) edits.push(topLevel);

  return {
    path: typeof input.path === "string" ? input.path : input.file_path,
    edits,
  };
}

export default function (pi: ExtensionAPI) {
  const base = createEditToolDefinition(process.cwd());

  pi.registerTool({
    ...base,
    name: "edit",
    label: "Edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].old_string must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    promptSnippet: "edit(path, edits): patch an existing file using exact old_string → new_string replacements.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path of the file to edit" })),
      file_path: Type.Optional(Type.String({ description: "Alias for path." })),
      edits: Type.Optional(Type.Array(
        Type.Object({
          old_string: Type.Optional(Type.String({ description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].old_string in the same call." })),
          new_string: Type.Optional(Type.String({ description: "Replacement text for this targeted edit." })),
          oldString: Type.Optional(Type.String()),
          newString: Type.Optional(Type.String()),
          old_text: Type.Optional(Type.String()),
          new_text: Type.Optional(Type.String()),
          oldText: Type.Optional(Type.String()),
          newText: Type.Optional(Type.String()),
        }),
        { description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Alias keys oldString/old_text/oldText and newString/new_text/newText are accepted and normalized internally." },
      )),
      edit: Type.Optional(Type.Object({
        old_string: Type.Optional(Type.String()),
        new_string: Type.Optional(Type.String()),
        oldString: Type.Optional(Type.String()),
        newString: Type.Optional(Type.String()),
        old_text: Type.Optional(Type.String()),
        new_text: Type.Optional(Type.String()),
        oldText: Type.Optional(Type.String()),
        newText: Type.Optional(Type.String()),
      })),
      old_string: Type.Optional(Type.String()),
      new_string: Type.Optional(Type.String()),
      oldString: Type.Optional(Type.String()),
      newString: Type.Optional(Type.String()),
      old_text: Type.Optional(Type.String()),
      new_text: Type.Optional(Type.String()),
      oldText: Type.Optional(Type.String()),
      newText: Type.Optional(Type.String()),
    }),
    prepareArguments(args: unknown) {
      return normalizeEditArguments(args) as any;
    },
    execute: base.execute as any,
    renderCall(args: any, theme: any, context: any) {
      const normalizedArgs = normalizeEditArguments(args) as any;
      return base.renderCall?.(normalizedArgs, theme, { ...context, args: normalizedArgs });
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      const normalizedArgs = normalizeEditArguments(context.args) as any;
      return base.renderResult?.(result, options, theme, { ...context, args: normalizedArgs });
    },
  } as any);
}
