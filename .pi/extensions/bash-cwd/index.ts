import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isAbsolute, relative, resolve } from "node:path";

export function isWithinDirectory(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveWorkspaceCwd(requested: string, cwd: string): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = requested.trim();
  if (!trimmed) return { ok: true, path: cwd };
  const resolved = resolve(cwd, trimmed);
  if (!isWithinDirectory(cwd, resolved)) {
    return {
      ok: false,
      reason: `Error: bash.cwd must be the current working directory or one of its subdirectories. Rejected: ${resolved}`,
    };
  }
  return { ok: true, path: resolved };
}

export default function (pi: any) {
  const base = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...base,
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr. " +
      "Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. " +
      "Optionally provide a timeout in seconds. Optionally provide cwd to run from the current working directory or one of its subdirectories.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory. Must be current working directory or its subdirectory." })),
    }),
    prepareArguments(args: any) {
      if (!args || typeof args !== "object") return args;
      return {
        command: typeof args.command === "string" ? args.command : "",
        timeout: typeof args.timeout === "number" ? args.timeout : undefined,
        cwd: typeof args.cwd === "string"
          ? args.cwd
          : typeof args.workingDirectory === "string"
            ? args.workingDirectory
            : typeof args.working_directory === "string"
              ? args.working_directory
              : undefined,
      };
    },
    async execute(toolCallId: string, input: any, signal: AbortSignal, onUpdate: any, ctx: any) {
      const chosenCwd = typeof input?.cwd === "string" ? input.cwd : "";
      const resolved = resolveWorkspaceCwd(chosenCwd, ctx.cwd);
      if (!resolved.ok) {
        return {
          content: [{ type: "text", text: resolved.reason }],
          details: {},
          isError: true,
        };
      }
      const dynamic = createBashToolDefinition(resolved.path);
      return dynamic.execute(
        toolCallId,
        { command: input.command, timeout: input.timeout },
        signal,
        onUpdate,
        ctx,
      );
    },
  });
}
