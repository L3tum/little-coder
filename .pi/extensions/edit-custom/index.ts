import {
  createEditToolDefinition,
  renderDiff,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

function normalizeEditArguments(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const input = args as {
    path?: unknown;
    file_path?: unknown;
    edits?: unknown;
    edit?: unknown;
    old_string?: unknown;
    new_string?: unknown;
    oldText?: unknown;
    newText?: unknown;
  };

  const normalizeOne = (edit: unknown) => {
    if (!edit || typeof edit !== "object") return null;
    const e = edit as { old_string?: unknown; new_string?: unknown; oldText?: unknown; newText?: unknown };
    const oldText = typeof e.oldText === "string"
      ? e.oldText
      : typeof e.old_string === "string"
        ? e.old_string
        : undefined;
    const newText = typeof e.newText === "string"
      ? e.newText
      : typeof e.new_string === "string"
        ? e.new_string
        : undefined;
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

function extractResultText(result: any): string {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text || "")
    .filter(Boolean)
    .join("\n");
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
      path: Type.String({ description: "Path of the file to edit" }),
      edits: Type.Array(
        Type.Object({
          old_string: Type.String({ description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].old_string in the same call." }),
          new_string: Type.String({ description: "Replacement text for this targeted edit." }),
        }),
        { description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead." },
      ),
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
      const normalizedContext = { ...context, args: normalizedArgs };
      const component = new Container();
      const text = extractResultText(result);
      const diff = !context.isError && typeof result?.details?.diff === "string" ? result.details.diff : undefined;

      const baseComponent = base.renderResult?.(result, options, theme, normalizedContext);
      if (context.isError) {
        if (baseComponent) return baseComponent;
        if (text) component.addChild(new Text(theme.fg("error", text), 0, 0));
        return component;
      }

      if (text) component.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
      if (diff) {
        if (text) component.addChild(new Spacer(1));
        const rawPath = typeof normalizedArgs?.path === "string" ? normalizedArgs.path : undefined;
        component.addChild(new Text(renderDiff(diff, { filePath: rawPath }), 1, 0));
      } else if (baseComponent) {
        return baseComponent;
      }
      return component;
    },
  } as any);
}
