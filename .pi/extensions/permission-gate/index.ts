import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  resolve,
  normalize,
  relative,
  isAbsolute,
  join,
  basename,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { normalizeWritePath } from "../write-guard/index.ts";

const BUILTIN_SAFE_PREFIXES: readonly string[] = [
  // Read-only commands
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "printf",
  "date",
  "which",
  "type",
  "env",
  "printenv",
  "uname",
  "whoami",
  "id",
  // Git read-only
  "git log",
  "git status",
  "git diff",
  "git show",
  "git branch",
  "git remote",
  "git stash list",
  "git tag",
  "git blame",
  "git reflog",
  "git shortlog",
  "git describe",
  "git ls-files",
  "git ls-tree",
  "git cat-file",
  "git rev-parse",
  "git config --get",
  "git config --list",
  "git for-each-ref",
  "git name-rev",
  "git cherry",
  "git bisect log",
  "git worktree list",
  // Search / find
  "find ",
  "grep ",
  "rg ",
  "ag ",
  "fd ",
  "sed ",
  // Interpreters
  "python ",
  "python3 ",
  "node ",
  "ruby ",
  "perl ",
  // Test runners (diagnostic only)
  "pytest",
  "pytest ",
  "jest",
  "jest ",
  // Package managers
  "pip show",
  "pip list",
  "npm list",
  "npx skills",
  // Compilers
  "tsc",
  "tsc ",
  // Cargo
  "cargo metadata",
  "cargo build",
  "cargo build ",
  "cargo check",
  "cargo check ",
  "cargo test",
  "cargo test ",
  "cargo clippy",
  "cargo clippy ",
  "cargo fmt --check",
  "cargo fmt --check ",
  "cargo miri test",
  "cargo miri test ",
  // System info
  "df ",
  "du ",
  "free ",
  "top -bn",
  "ps ",
  "curl -I",
  "curl --head",
  // File inspection (read-only)
  "file ",
  "stat ",
  "sha256sum ",
  "md5sum ",
  "diff ",
  // Filesystem scaffolding
  "cp ",
  "mv ",
  "mkdir ",
  "touch ",
  // rmdir (removes only empty directories)
  "rmdir ",
  // Path utilities (read-only resolution)
  "basename ",
  "dirname ",
  "realpath ",
  "readlink ",
  // Text utilities (transform-only)
  "cut ",
  "sort ",
  "uniq ",
  "tr ",
  "comm ",
];

export type ExternalFilePolicy = "deny" | "ask" | "accept";

interface WorkspaceBoundaryConfig {
  externalFilePolicy: ExternalFilePolicy;
}

interface ExternalAccessRequest {
  summary: string;
}

const CONFIG_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "little-coder-workspace-boundary.json",
);
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
  return [
    ...BUILTIN_SAFE_PREFIXES,
    ...parseExtraPrefixes(process.env.LITTLE_CODER_BASH_ALLOW),
  ];
}

export function hasShellControlOperator(command: string): boolean {
  return /[;&|`$<>]/.test(command) || /\$\(|\n|\r/.test(command);
}

function isSafeSingleDiagnosticCommand(command: string): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  if (hasShellControlOperator(c)) return false;

  return [
    /^npm\s+(?:run\s+)?typecheck(?:\s+--\s+(?:--?[\w:-]+(?:[= ][\w:./-]+)?\s*)*)?$/,
    /^npm\s+(?:run\s+)?lint(?:\s+--\s+(?:--?[\w:-]+(?:[= ][\w:./-]+)?\s*)*)?$/,
    /^npm\s+(?:run\s+)?test(?:\s+(?:--|run|--?[\w:-]+(?:[= ][\w:./@-]+)?|[\w@./:-]+))*$/,
    /^npm\s+(?:list|ls)(?:\s+(?:--?[\w:-]+(?:[= ][\w:./@-]+)?|[\w@./-]+))*$/,
    /^npm\s+(?:view|info)\s+[\w@./-]+(?:\s+[\w.-]+)?(?:\s+--json)?$/,
    /^npx\s+(?:--yes\s+)?tsc\s+--noEmit(?:\s+--?[\w:-]+(?:[= ][\w:./-]+)?)*$/,
    /^npx\s+(?:--yes\s+)?vitest(?:\s+(?:run|--?[\w:-]+(?:[= ][\w:./@-]+)?|[\w@./:-]+))*$/,
    /^npx\s+(?:--yes\s+)?skills(?:\s+(?:--help|-h|find|list|show|info|search)(?:\s+[\w@./:,-]+)*)?$/,
  ].some((pattern) => pattern.test(c));
}

function isSafeDiagnosticCommand(command: string): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  if (isSafeSingleDiagnosticCommand(c)) return true;
  // Allow && chaining only; reject all other shell operators.
  // Strip && before checking for other operators (&& contains &).
  const withoutAndAnd = c.replace(/\s*&&\s*/g, " ");
  if (hasShellControlOperator(withoutAndAnd)) return false;
  const parts = c.split(/\s+&&\s+/);
  return parts.length > 1 && parts.every(isSafeSingleDiagnosticCommand);
}

function normalizeCargoCommand(c: string): string {
  // Strip `+nightly` or other toolchain overrides from cargo commands before matching.
  // e.g. "cargo +nightly check " -> "cargo check "
  return c.replace(/\bcargo\s+\+\w+\s+/g, "cargo ");
}

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] || command.trim();
}

function isSafePrefixCommand(
  segment: string,
  prefixes: readonly string[],
): boolean {
  if (isSafeSingleDiagnosticCommand(segment)) return true;
  const normalized = normalizeCargoCommand(segment);
  if (
    prefixes.some((p) => segment.startsWith(p)) ||
    prefixes.some((p) => normalized.startsWith(p))
  )
    return true;
  // Space-terminated prefixes (e.g. "sort ") also allow the bare command name
  // (e.g. "sort") — the idiomatic pipeline tail — without matching longer
  // words like "sortsomething", preserving the word-boundary convention.
  return prefixes.some((p) => p.endsWith(" ") && segment === p.trim());
}

/**
 * Split a command into top-level segments joined by `&&` or `|` that appear
 * OUTSIDE quoted strings, so `grep -E "a|b" file`, `grep 'a&&b' file`, and
 * `grep foo | head -20` are all understood correctly.
 *
 * Returns null when a shell control operator appears outside quotes
 * (`;`, bare `&`, `||`, backtick, `$`, `<`, `>`, newline), when `$`/backtick
 * appears inside double quotes (command substitution), or when a segment would
 * be empty (e.g. `ls |`). Characters inside single quotes are always literal.
 */
export function scanBashSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const n = command.length;

  const isOuterMeta = (ch: string) =>
    ch === ";" ||
    ch === "&" ||
    ch === "`" ||
    ch === "$" ||
    ch === "<" ||
    ch === ">" ||
    ch === "\n" ||
    ch === "\r";
  const isDoubleQuoteMeta = (ch: string) =>
    ch === "`" || ch === "$" || ch === "\n" || ch === "\r";

  const flush = () => {
    segments.push(current);
    current = "";
  };

  for (let i = 0; i < n; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (quote === "'") {
        // Backslash is literal inside single quotes.
        current += ch;
        continue;
      }
      // Escaped metacharacters outside quotes are still treated as dangerous
      // (e.g. `find . -exec rm {} \;` must not pass via a literal `;`).
      const next = command[i + 1];
      if (next !== undefined && isOuterMeta(next)) return null;
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (isDoubleQuoteMeta(ch)) return null;
      else current += ch;
      continue;
    }
    // Outside quotes.
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      flush();
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") return null; // `||` short-circuit is not allowed
      flush();
      continue;
    }
    if (isOuterMeta(ch)) return null;
    current += ch;
  }
  flush();

  const trimmed = segments.map((s) => s.trim());
  if (trimmed.some((s) => s.length === 0)) return null;
  return trimmed;
}

/**
 * For a command that starts with `cd`, return the command chained after the
 * leading cd target and its `&&`/`;` separator ("" for a bare `cd`), or ""
 * when the cd line cannot be parsed as a plain path chain.
 */
function stripLeadingCdChain(command: string): string {
  const m = command
    .trim()
    .match(/^cd(?:\s+([^;&|`$<>]+))?(?:\s*(?:&&|;)\s*(.*))?$/);
  return m?.[2] ?? "";
}

interface BashGateResult {
  safe: boolean;
  segment: string;
}

function evaluateBash(
  command: string,
  prefixes: readonly string[],
  cwd?: string,
): BashGateResult {
  const c = command.trim();
  if (isSafeDiagnosticCommand(c)) return { safe: true, segment: "" };

  // `cd <target> && …` / `cd <target> ; …` is allowed only when the cd target
  // itself contains no shell metacharacters, resolves inside the workspace,
  // and the chained command is itself safe. Without the chain check, any
  // `cd subdir && …` bypasses the whitelist entirely.
  if (cwd && /^cd(\s|$)/.test(c)) {
    const cdHead = c.split(/\s*(?:&&|;)/)[0];
    const cdSegments = scanBashSegments(cdHead);
    if (cdSegments !== null && cdSegments.length === 1 && isNoopCd(c, cwd)) {
      const remainder = stripLeadingCdChain(c);
      if (remainder.trim() === "") return { safe: true, segment: "" };
      return evaluateBash(remainder, prefixes, cwd);
    }
  }

  // Strip safe stderr redirections before scanning for control operators.
  // "2>/dev/null" and "2>&1" are standard patterns to suppress/merge stderr.
  // They are safe because: 2>/dev/null discards stderr to a fixed safe path,
  // and 2>&1 merges stderr into stdout (no new file creation or data loss).
  const withoutStderrRedirect = c
    .replace(/\s*2>\s*\/dev\/null/g, "")
    .replace(/\s*2>&1/g, "");
  const segments = scanBashSegments(withoutStderrRedirect);
  if (segments === null || segments.length === 0) {
    // A shell control operator appeared outside quotes (for example
    // "ls -la; rm -rf /"), or the command is empty.
    return { safe: false, segment: firstToken(c) };
  }
  for (const segment of segments) {
    if (!isSafePrefixCommand(segment, prefixes)) {
      return { safe: false, segment };
    }
  }
  return { safe: true, segment: "" };
}

export function isSafeBash(
  command: string,
  prefixes: readonly string[] = getSafePrefixes(),
  cwd?: string,
): boolean {
  return evaluateBash(command, prefixes, cwd).safe;
}

export function bashBlockReason(
  command: string,
  prefixes: readonly string[] = getSafePrefixes(),
  cwd?: string,
): string | null {
  const result = evaluateBash(command, prefixes, cwd);
  if (result.safe) return null;
  return `bash whitelist: "${result.segment}" is not in SAFE_PREFIXES. Ask the user to execute this command instead.`;
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
  return (
    normalizedTarget === normalizedCwd ||
    normalizedTarget.startsWith(normalizedCwd + "/")
  );
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
  if (inputPath.startsWith("~/"))
    return resolve(homedir(), "." + inputPath.slice(1));
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
  return isWithinWorkspace(
    normalize(resolve(tmpdir())),
    normalize(resolve(target)),
  );
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

function isWithinUserSkillsRoot(target: string): boolean {
  const root =
    process.env.LITTLE_CODER_USER_SKILLS_DIR ||
    join(homedir(), ".pi", "skills");
  return isWithinWorkspace(
    normalize(resolve(root)),
    normalize(resolve(target)),
  );
}

export function getExternalWorkspaceAccess(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string,
): ExternalAccessRequest | null {
  if (!input || typeof input !== "object") return null;

  if (toolName === "read") {
    const path =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : undefined;
    if (!path) return null;
    const resolved = resolveWorkspacePath(path, cwd);
    if (
      isWithinDefaultAllowedTmp(resolved) ||
      isTrustedToolTempFilePath(resolved) ||
      isWithinUserSkillsRoot(resolved)
    )
      return null;
    return isWithinWorkspace(cwd, resolved) ? null : { summary: resolved };
  }

  if (toolName === "edit") {
    const path =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : undefined;
    if (!path) return null;
    const resolved = resolveWorkspacePath(path, cwd);
    if (isWithinDefaultAllowedTmp(resolved) || isWithinUserSkillsRoot(resolved))
      return null;
    return isWithinWorkspace(cwd, resolved) ? null : { summary: resolved };
  }

  if (toolName === "write") {
    const path =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : undefined;
    if (!path) return null;
    const resolved = normalizeWritePath(path, cwd).path;
    if (isWithinDefaultAllowedTmp(resolved) || isWithinUserSkillsRoot(resolved))
      return null;
    return isWithinWorkspace(cwd, resolved) ? null : { summary: resolved };
  }

  if (toolName === "grep") {
    const baseInput =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : ".";
    const base = resolveWorkspacePath(baseInput, cwd);
    if (isWithinDefaultAllowedTmp(base) || isWithinUserSkillsRoot(base))
      return null;
    return isWithinWorkspace(cwd, base) ? null : { summary: base };
  }

  if (toolName === "findRead") {
    const baseInput =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : ".";
    const base = resolveWorkspacePath(baseInput, cwd);
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (
      isWithinDefaultAllowedTmp(base) ||
      isTrustedToolTempGlob(base, pattern) ||
      isWithinUserSkillsRoot(base)
    )
      return null;
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
        if (ctx.hasUI)
          ctx.ui.notify(`External file access policy set to '${arg}'.`, "info");
        return;
      }
      if (!ctx.hasUI) return;
      const choice = await ctx.ui.select(
        "External file access policy",
        POLICY_OPTIONS.map(
          (p) => `${p}${p === config.externalFilePolicy ? " (current)" : ""}`,
        ),
      );
      if (!choice) return;
      const selected = choice.split(" ")[0] as ExternalFilePolicy;
      await setExternalFilePolicy(selected);
      ctx.ui.notify(
        `External file access policy set to '${selected}'.`,
        "info",
      );
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
          if (mode === "manual") {
            if (!isSafeBash(cmd, getSafePrefixes(), ctx.cwd)) {
              return {
                block: true,
                reason: "manual permission mode: bash command not pre-approved",
              };
            }
          } else {
            const reason = bashBlockReason(cmd, getSafePrefixes(), ctx.cwd);
            if (reason !== null) {
              return { block: true, reason };
            }
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
      return {
        block: true,
        reason: `${reasonBase} (policy=ask but no UI available)`,
      };
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
      return {
        block: true,
        reason: `external file access denied by user: ${external.summary}`,
      };
    }
  });
}
