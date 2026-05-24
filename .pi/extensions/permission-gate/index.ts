import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, normalize, relative, isAbsolute, join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { normalizeWritePath } from "../write-guard/index.ts";

const BUILTIN_SAFE_PREFIXES: readonly string[] = [
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "date",
  "which", "type", "env", "printenv", "uname", "whoami", "id",
  "git log", "git status", "git diff", "git show", "git branch",
  "git remote", "git stash list", "git tag", "git blame",
  "git reflog", "git shortlog", "git describe", "git ls-files",
  "git ls-tree", "git cat-file", "git rev-parse", "git config --get",
  "git config --list", "git for-each-ref", "git name-rev",
  "git cherry", "git bisect log", "git worktree list",
  "find ", "grep ", "rg ", "ag ", "fd ", "sed ",
  "python ", "python3 ", "node ", "ruby ", "perl ",
  "pip show", "pip list", "npm list", "cargo metadata",
  "df ", "du ", "free ", "top -bn", "ps ",
  "curl -I", "curl --head",
  "cp ", "mv ", "mkdir ", "touch ",
];

export type ExternalFilePolicy = "deny" | "ask" | "accept";

interface WorkspaceBoundaryConfig {
  externalFilePolicy: ExternalFilePolicy;
}

interface ExternalAccessRequest {
  summary: string;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "little-coder-workspace-boundary.json");
const DEFAULT_CONFIG: WorkspaceBoundaryConfig = { externalFilePolicy: "ask" };
const POLICY_OPTIONS: ExternalFilePolicy[] = ["deny", "ask", "accept"];

let saveConfigQueue: Promise<void> = Promise.resolve();

async function loadConfig(): Promise<WorkspaceBoundaryConfig> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return {
      externalFilePolicy: POLICY_OPTIONS.includes(raw.externalFilePolicy)
        ? raw.externalFilePolicy
        : DEFAULT_CONFIG.externalFilePolicy,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config: WorkspaceBoundaryConfig): Promise<void> {
  const snapshot = JSON.stringify(config, null, 2) + "\n";
  saveConfigQueue = saveConfigQueue.then(async () => {
    await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
    await writeFile(CONFIG_PATH, snapshot, "utf8");
  });
  return saveConfigQueue;
}

export function parseExtraPrefixes(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trimStart())
    .map((s) => (s.length > 0 && s !== " ".repeat(s.length) ? s : ""))
    .filter((s) => s.length > 0);
}

export function getSafePrefixes(): string[] {
  return [...BUILTIN_SAFE_PREFIXES, ...parseExtraPrefixes(process.env.LITTLE_CODER_BASH_ALLOW)];
}

function hasShellControlOperator(command: string): boolean {
  return /[;&|`$<>]/.test(command) || /\$\(|\n|\r/.test(command);
}

function isSafeDiagnosticCommand(command: string): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  if (hasShellControlOperator(c)) return false;

  return [
    /^npm\s+(?:run\s+)?typecheck(?:\s+--\s+(?:--?[\w:-]+(?:[= ][\w:./-]+)?\s*)*)?$/,
    /^npm\s+(?:run\s+)?lint(?:\s+--\s+(?:--?[\w:-]+(?:[= ][\w:./-]+)?\s*)*)?$/,
    /^npm\s+(?:list|ls)(?:\s+(?:--?[\w:-]+(?:[= ][\w:./@-]+)?|[\w@./-]+))*$/,
    /^npm\s+(?:view|info)\s+[\w@./-]+(?:\s+[\w.-]+)?(?:\s+--json)?$/,
    /^npx\s+(?:--yes\s+)?tsc\s+--noEmit(?:\s+--?[\w:-]+(?:[= ][\w:./-]+)?)*$/,
    /^npx\s+(?:--yes\s+)?skills\s+(?:find|list|show|info|search)(?:\s+[\w@./:,-]+)*$/,
  ].some((pattern) => pattern.test(c));
}

export function isSafeBash(command: string, prefixes: readonly string[] = getSafePrefixes()): boolean {
  const c = command.trim();
  if (isSafeDiagnosticCommand(c)) return true;
  return prefixes.some((p) => c.startsWith(p));
}

function getPermissionMode(): "auto" | "accept-all" | "manual" {
  const v = process.env.LITTLE_CODER_PERMISSION_MODE;
  if (v === "accept-all" || v === "manual") return v;
  return "auto";
}

export function isNoopCd(command: string, cwd: string): boolean {
  const trimmed = command.trim();
  const cdMatch = trimmed.match(/^cd\s+(.*)$/) ?? trimmed.match(/^cd$/);
  if (!cdMatch) return false;

  const rawArg = (cdMatch[1] ?? "").trim();
  const arg = rawArg.split(/\s*&&|;/)[0].trim();
  const target = expandCdPath(arg, cwd);
  const normalizedTarget = normalize(resolve(target));
  const normalizedCwd = normalize(resolve(cwd));
  return normalizedTarget === normalizedCwd || normalizedTarget.startsWith(normalizedCwd + "/");
}

function expandCdPath(arg: string, cwd: string): string {
  if (arg === "") return homedir();
  if (arg.startsWith("~")) {
    return resolve(homedir(), arg.slice(1).replace(/^\/?/, "./"));
  }
  return resolve(cwd, arg);
}

export function resolveWorkspacePath(inputPath: string, cwd: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return resolve(homedir(), "." + inputPath.slice(1));
  if (isAbsolute(inputPath)) return resolve(inputPath);
  return resolve(cwd, inputPath);
}

export function isWithinWorkspace(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/).includes("..");
}

function isWithinDefaultAllowedTmp(target: string): boolean {
  return isWithinWorkspace(normalize(resolve(tmpdir())), normalize(resolve(target)));
}

function isTrustedToolTempFilePath(target: string): boolean {
  const normalizedTarget = normalize(resolve(target));
  const normalizedTmpDir = normalize(resolve(tmpdir()));
  if (!isWithinWorkspace(normalizedTmpDir, normalizedTarget)) return false;
  const fileName = basename(normalizedTarget);
  return /^pi-bash-[^.]+\.log$/i.test(fileName);
}

function isTrustedToolTempGlob(base: string, pattern: string): boolean {
  const normalizedBase = normalize(resolve(base));
  const normalizedTmpDir = normalize(resolve(tmpdir()));
  if (normalizedBase !== normalizedTmpDir) return false;
  return /^pi-bash-.*\.log$/i.test(pattern) && !hasParentTraversal(pattern);
}

export function getExternalWorkspaceAccess(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string,
): ExternalAccessRequest | null {
  if (!input || typeof input !== "object") return null;

  if (toolName === "read") {
    const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
    if (!path) return null;
    const resolved = resolveWorkspacePath(path, cwd);
    if (isWithinDefaultAllowedTmp(resolved) || isTrustedToolTempFilePath(resolved)) return null;
    return isWithinWorkspace(cwd, resolved) ? null : { summary: resolved };
  }

  if (toolName === "edit") {
    const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
    if (!path) return null;
    const resolved = resolveWorkspacePath(path, cwd);
    if (isWithinDefaultAllowedTmp(resolved)) return null;
    return isWithinWorkspace(cwd, resolved) ? null : { summary: resolved };
  }

  if (toolName === "write") {
    const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
    if (!path) return null;
    const resolved = normalizeWritePath(path, cwd).path;
    if (isWithinDefaultAllowedTmp(resolved)) return null;
    return isWithinWorkspace(cwd, resolved) ? null : { summary: resolved };
  }

  if (toolName === "grep") {
    const baseInput = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : ".";
    const base = resolveWorkspacePath(baseInput, cwd);
    if (isWithinDefaultAllowedTmp(base)) return null;
    return isWithinWorkspace(cwd, base) ? null : { summary: base };
  }

  if (toolName === "findRead") {
    const baseInput = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : ".";
    const base = resolveWorkspacePath(baseInput, cwd);
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (isWithinDefaultAllowedTmp(base) || isTrustedToolTempGlob(base, pattern)) return null;
    if (!isWithinWorkspace(cwd, base)) return { summary: base };
    if (pattern && hasParentTraversal(pattern)) {
      return { summary: `${base} (pattern escapes base: ${pattern})` };
    }
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  let config: WorkspaceBoundaryConfig = { ...DEFAULT_CONFIG };
  let configLoadPromise: Promise<void> | null = null;

  const ensureConfigLoaded = async () => {
    if (!configLoadPromise) {
      configLoadPromise = (async () => {
        config = await loadConfig();
      })();
    }
    await configLoadPromise;
  };

  const setExternalFilePolicy = async (policy: ExternalFilePolicy) => {
    config.externalFilePolicy = policy;
    await saveConfig(config);
  };

  pi.registerCommand("workspace-permissions", {
    description: "Show or set external file access policy (deny, ask, accept)",
    handler: async (args, ctx) => {
      await ensureConfigLoaded();
      const arg = args[0]?.toLowerCase();
      if (arg === "deny" || arg === "ask" || arg === "accept") {
        await setExternalFilePolicy(arg);
        if (ctx.hasUI) ctx.ui.notify(`External file access policy set to '${arg}'.`, "info");
        return;
      }
      if (!ctx.hasUI) return;
      const choice = await ctx.ui.select(
        "External file access policy",
        POLICY_OPTIONS.map((p) => `${p}${p === config.externalFilePolicy ? " (current)" : ""}`),
      );
      if (!choice) return;
      const selected = choice.split(" ")[0] as ExternalFilePolicy;
      await setExternalFilePolicy(selected);
      ctx.ui.notify(`External file access policy set to '${selected}'.`, "info");
    },
  });

  pi.on("session_start", async () => {
    await ensureConfigLoaded();
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    await ensureConfigLoaded();

    const mode = getPermissionMode();
    if (mode !== "accept-all") {
      const toolName = (event as any).toolName;
      const input: any = (event as any).input ?? (event as any).args;

      if (toolName === "bash" || toolName === "Bash") {
        const cmd = input?.command;
        if (typeof cmd === "string") {
          if (/^cd(\s|$)/.test(cmd.trim()) && isNoopCd(cmd, ctx.cwd)) {
            return;
          }
          if (!isSafeBash(cmd)) {
            if (mode === "manual") {
              return { block: true, reason: "manual permission mode: bash command not pre-approved" };
            }
            return { block: true, reason: `bash whitelist: "${cmd.split(/\s+/)[0]}" is not in SAFE_PREFIXES` };
          }
        }
      }
    }

    const toolName = (event as any).toolName;
    const input: any = (event as any).input ?? (event as any).args;
    const external = getExternalWorkspaceAccess(toolName, input, ctx.cwd);
    if (!external || config.externalFilePolicy === "accept") return;

    const reasonBase = `external file access outside workspace: ${external.summary}`;
    if (config.externalFilePolicy === "deny") {
      return { block: true, reason: reasonBase };
    }
    if (!ctx.hasUI) {
      return { block: true, reason: `${reasonBase} (policy=ask but no UI available)` };
    }

    const allowed = await ctx.ui.confirm(
      "Allow external file access?",
      [
        `${toolName} wants to access a path outside the current workspace.`,
        "",
        `Target: ${external.summary}`,
        `Workspace: ${ctx.cwd}`,
        "",
        "Use /workspace-permissions deny|ask|accept to change this policy.",
      ].join("\n"),
    );
    if (!allowed) {
      return { block: true, reason: `external file access denied by user: ${external.summary}` };
    }
  });
}
