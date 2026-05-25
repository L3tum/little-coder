import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTALL_URL = "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh";
const INSTALL_PS_URL = "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1";
const BINARY_ENV = "LITTLE_CODER_CODEBASE_BINARY";
const BINARY_NAME = process.platform === "win32" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp";
const MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const INDEX_TIMEOUT_MS = 15 * 60_000;

interface IndexedProject {
  name?: string;
  root_path?: string;
}

function isWithinDirectory(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function completeProjects(projects: IndexedProject[]): Array<Required<Pick<IndexedProject, "name" | "root_path">>> {
  return projects.filter((project): project is Required<Pick<IndexedProject, "name" | "root_path">> =>
    typeof project.name === "string"
    && project.name.length > 0
    && typeof project.root_path === "string"
    && project.root_path.length > 0,
  );
}

export function selectProjectForCwd(projects: IndexedProject[], cwd: string): string | undefined {
  return completeProjects(projects)
    .filter((project) => isWithinDirectory(project.root_path, cwd))
    .sort((left, right) => right.root_path.length - left.root_path.length)[0]?.name;
}

export function selectProjectForInput(projects: IndexedProject[], inputProject: string): string | undefined {
  const trimmed = inputProject.trim();
  if (!trimmed) return undefined;
  const normalizedPath = trimmed.replace(/\/+$/g, "");
  return completeProjects(projects).find((project) => project.root_path.replace(/\/+$/g, "") === normalizedPath)?.name;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function binaryCandidates(): string[] {
  const envPath = process.env[BINARY_ENV]?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const candidates = [
    envPath,
    join(homedir(), ".local", "bin", BINARY_NAME),
    localAppData ? join(localAppData, "Programs", "codebase-memory-mcp", BINARY_NAME) : undefined,
    BINARY_NAME,
  ].filter((value): value is string => !!value);
  return [...new Set(candidates)];
}

async function resolveBinary(): Promise<string> {
  const candidates = binaryCandidates();
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    try {
      await execFileAsync(candidate, ["--version"], {
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      return candidate;
    } catch (error: any) {
      if (error?.code !== "ENOENT") return candidate;
    }
  }
  throw new Error(
    `codebase-memory-mcp is not installed. Run /codebase install, or set ${BINARY_ENV} to the binary path.`,
  );
}

async function runBinary(binary: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: process.env,
    });
    const output = [stdout, stderr].filter(Boolean).join("").trim();
    return output;
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const message = stderr || stdout || error?.message || String(error);
    throw new Error(message);
  }
}

function parseCliOutput(output: string): unknown {
  if (!output) return "";
  try {
    return JSON.parse(output);
  } catch {
    const objectStart = output.indexOf("{");
    const objectEnd = output.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(output.slice(objectStart, objectEnd + 1));
      } catch {
        // fall through
      }
    }
    const arrayStart = output.indexOf("[");
    const arrayEnd = output.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try {
        return JSON.parse(output.slice(arrayStart, arrayEnd + 1));
      } catch {
        // fall through
      }
    }
    return output;
  }
}

async function runCli(tool: string, input: Record<string, unknown>, options: { cwd?: string; timeoutMs?: number } = {}): Promise<unknown> {
  const binary = await resolveBinary();
  const payload = pruneUndefined(input);
  const args = ["cli", tool];
  if (Object.keys(payload).length > 0) args.push(JSON.stringify(payload));
  return parseCliOutput(await runBinary(binary, args, options));
}

async function installOrUpdateBinary(mode: "install" | "update"): Promise<string> {
  if (mode === "update") {
    try {
      const binary = await resolveBinary();
      return await runBinary(binary, ["update"], { timeoutMs: INDEX_TIMEOUT_MS });
    } catch {
      // Fall through to install path when the binary is absent.
    }
  }

  if (process.platform === "win32") {
    return await runBinary(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `& ([ScriptBlock]::Create((Invoke-WebRequest -UseBasicParsing '${INSTALL_PS_URL}').Content)) --skip-config`,
      ],
      { timeoutMs: INDEX_TIMEOUT_MS },
    );
  }

  return await runBinary(
    "bash",
    ["-lc", `curl -fsSL '${INSTALL_URL}' | bash -s -- --skip-config`],
    { timeoutMs: INDEX_TIMEOUT_MS },
  );
}

async function listProjects(cwd?: string): Promise<IndexedProject[]> {
  const raw = await runCli("list_projects", {}, { cwd });
  const projects = (raw as any)?.projects;
  return Array.isArray(projects) ? projects as IndexedProject[] : [];
}

async function resolveProjectName(inputProject: unknown, cwd: string): Promise<string> {
  const projects = await listProjects(cwd);
  if (typeof inputProject === "string" && inputProject.trim().length > 0) {
    return selectProjectForInput(projects, inputProject) ?? inputProject.trim();
  }
  const matched = selectProjectForCwd(projects, cwd);
  if (matched) return matched;
  throw new Error(
    `No indexed codebase project matched ${cwd}. Run code_index first, or inspect known projects with code_projects.`,
  );
}

function textResult(value: unknown, details: Record<string, unknown> = {}, isError = false) {
  return {
    content: [{ type: "text" as const, text: pretty(value) }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

async function executeJsonTool(
  tool: string,
  input: Record<string, unknown>,
  options: { cwd?: string; timeoutMs?: number } = {},
) {
  try {
    const result = await runCli(tool, input, options);
    return textResult(result, { tool, input });
  } catch (error) {
    return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, { tool, input }, true);
  }
}

const codeSearchSchema = Type.Object({
  project: Type.Optional(Type.String({ description: "Indexed project name. Defaults to the current workspace when possible." })),
  query: Type.Optional(Type.String({ description: "BM25 full-text / natural-language structural search query." })),
  label: Type.Optional(Type.String()),
  name_pattern: Type.Optional(Type.String()),
  qn_pattern: Type.Optional(Type.String()),
  file_pattern: Type.Optional(Type.String()),
  relationship: Type.Optional(Type.String()),
  min_degree: Type.Optional(Type.Integer()),
  max_degree: Type.Optional(Type.Integer()),
  exclude_entry_points: Type.Optional(Type.Boolean()),
  include_connected: Type.Optional(Type.Boolean()),
  semantic_query: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Integer()),
  offset: Type.Optional(Type.Integer()),
});

const codeAdrSchema = Type.Object({
  project: Type.Optional(Type.String({ description: "Indexed project name. Defaults to the current workspace when possible." })),
  mode: Type.Optional(Type.Union([
    Type.Literal("get"),
    Type.Literal("update"),
    Type.Literal("sections"),
  ])),
  content: Type.Optional(Type.String()),
  sections: Type.Optional(Type.Array(Type.String())),
});

export default function codebaseMemoryDirect(pi: ExtensionAPI) {
  pi.registerCommand("codebase", {
    description: "Install, update, or inspect the bundled codebase-memory integration",
    handler: async (args, ctx) => {
      const subcommand = args?.trim() || "doctor";
      const workspaceCwd = ctx.cwd || process.cwd();

      try {
        if (subcommand === "install") {
          const output = await installOrUpdateBinary("install");
          if (ctx.hasUI) ctx.ui.notify(output || "Installed codebase-memory-mcp.", "info");
          return;
        }
        if (subcommand === "update") {
          const output = await installOrUpdateBinary("update");
          if (ctx.hasUI) ctx.ui.notify(output || "Updated codebase-memory-mcp.", "info");
          return;
        }

        const binary = await resolveBinary();
        const version = await runBinary(binary, ["--version"], { cwd: workspaceCwd });
        const projects = await listProjects(workspaceCwd);
        const matched = selectProjectForCwd(projects, workspaceCwd);
        const lines = [
          `Binary: ${binary}`,
          `Version: ${version || "unknown"}`,
          `Workspace: ${workspaceCwd}`,
          `Matched project: ${matched ?? "(none)"}`,
          `Indexed projects: ${projects.length}`,
          "",
          "Use /codebase install to bootstrap or /codebase update to pull upstream updates.",
        ];
        if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "code_projects",
    label: "CodeProjects",
    description: "List indexed codebase-memory projects.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _input: Record<string, never>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx?: ExtensionContext) {
      return executeJsonTool("list_projects", {}, { cwd: ctx?.cwd ?? process.cwd() });
    },
  });

  pi.registerTool({
    name: "code_index",
    label: "CodeIndex",
    description: "Index the current workspace or a specified repository into codebase-memory.",
    parameters: Type.Object({
      repo_path: Type.Optional(Type.String({ description: "Repository path to index. Defaults to the current workspace." })),
    }),
    async execute(_toolCallId: string, input: { repo_path?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx?: ExtensionContext) {
      const cwd = ctx?.cwd ?? process.cwd();
      return executeJsonTool(
        "index_repository",
        { repo_path: input.repo_path ?? cwd },
        { cwd, timeoutMs: INDEX_TIMEOUT_MS },
      );
    },
  });

  pi.registerTool({
    name: "code_status",
    label: "CodeStatus",
    description: "Show codebase-memory index status for the current workspace or a specified project.",
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Indexed project name. Defaults to the current workspace when possible." })),
    }),
    async execute(_toolCallId: string, input: { project?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx?: ExtensionContext) {
      const cwd = ctx?.cwd ?? process.cwd();
      try {
        const project = await resolveProjectName(input.project, cwd);
        return executeJsonTool("index_status", { project }, { cwd });
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, { tool: "index_status", input }, true);
      }
    },
  });

  pi.registerTool({
    name: "code_search",
    label: "CodeSearch",
    description: "Search the indexed code graph for functions, classes, routes, and relationships.",
    parameters: codeSearchSchema,
    async execute(_toolCallId: string, input: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx?: ExtensionContext) {
      const cwd = ctx?.cwd ?? process.cwd();
      try {
        const project = await resolveProjectName(input.project, cwd);
        return executeJsonTool("search_graph", { ...input, project }, { cwd });
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, { tool: "search_graph", input }, true);
      }
    },
  });

  pi.registerTool({
    name: "code_adr",
    label: "CodeAdr",
    description: "Create or update Architecture Decision Records for the indexed workspace.",
    parameters: codeAdrSchema,
    async execute(_toolCallId: string, input: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx?: ExtensionContext) {
      const cwd = ctx?.cwd ?? process.cwd();
      try {
        const project = await resolveProjectName(input.project, cwd);
        return executeJsonTool("manage_adr", { ...input, project }, { cwd });
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, { tool: "manage_adr", input }, true);
      }
    },
  });
}
