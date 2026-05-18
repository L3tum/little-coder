import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, normalize } from "node:path";
import { homedir } from "node:os";

// Port of tools.py::_SAFE_PREFIXES + agent.py::_check_permission. Bash
// commands not matching the whitelist are blocked in "auto" mode. In
// "accept-all" mode all commands pass (benchmark runs set this explicitly).
// Write/Edit confirmations are deferred to the TUI's own prompt; we simply
// add an extra guardrail on bash here to match little-coder's behavior.
//
// Per-deployment customization (issue #15):
//   LITTLE_CODER_PERMISSION_MODE=auto|accept-all|manual
//   LITTLE_CODER_BASH_ALLOW="cmd1,cmd2 sub,..."  extra allow-prefixes,
//                                                merged with the built-in list.

const BUILTIN_SAFE_PREFIXES: readonly string[] = [
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "date",
  "which", "type", "env", "printenv", "uname", "whoami", "id",
  // Read-only git commands (no writes to the repo)
  "git log", "git status", "git diff", "git show", "git branch",
  "git remote", "git stash list", "git tag", "git blame",
  "git reflog", "git shortlog", "git describe", "git ls-files",
  "git ls-tree", "git cat-file", "git rev-parse", "git config --get",
  "git config --list", "git for-each-ref", "git name-rev",
  "git cherry", "git bisect log", "git worktree list",
  "find ", "grep ", "rg ", "ag ", "fd ",
  "python ", "python3 ", "node ", "ruby ", "perl ",
  "pip show", "pip list", "npm list", "cargo metadata",
  "df ", "du ", "free ", "top -bn", "ps ",
  "curl -I", "curl --head",
  // Routine filesystem scaffolding. Trailing space = word boundary, so
  // "cp " matches "cp a b" but not "cpufetch". rm stays off the list by
  // design; use LITTLE_CODER_BASH_ALLOW=rm if a deployment needs it.
  "cp ", "mv ", "mkdir ", "touch ",
];

// Trailing whitespace is meaningful — it acts as a word boundary in startsWith
// matching ("find " refuses "findbug"). We only strip leading whitespace so
// callers retain control over that boundary.
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

export function isSafeBash(command: string, prefixes: readonly string[] = getSafePrefixes()): boolean {
  const c = command.trim();
  return prefixes.some((p) => c.startsWith(p));
}

function getPermissionMode(): "auto" | "accept-all" | "manual" {
  const v = process.env.LITTLE_CODER_PERMISSION_MODE;
  if (v === "accept-all" || v === "manual") return v;
  return "auto";
}

/**
 * Resolve a `cd` command's target and check whether it lands within the
 * current working directory tree.  AIs frequently emit `cd <subdir> && …`
 * to navigate into a subdirectory before running further commands.  Rather
 * than blocking every `cd`, we allow it when the resolved target is equal
 * to cwd or a strict descendant of cwd (a harmless tree-downward move) and
 * block genuine escapes that would confuse the single-directory harness
 * (e.g. `cd /tmp`, `cd ~`, `cd ..` from the repo root).
 *
 * Handles:
 *   cd                 → $HOME
 *   cd ~               → $HOME
 *   cd ~/foo           → $HOME/foo
 *   cd foo             → cwd/foo
 *   cd /abs/path       → /abs/path
 *   cd ./foo           → cwd/foo
 *   cd ..              → cwd/..
 *   cd foo && rest     → resolved from the cd segment only
 */
export function isNoopCd(command: string, cwd: string): boolean {
  // Strip common leading noise the model may prepend.
  const trimmed = command.trim();

  // Only intercept bare `cd …` — not `scd`, `cdcd`, etc.
  const cdMatch = trimmed.match(/^cd\s+(.*)$/) ?? trimmed.match(/^cd$/);
  if (!cdMatch) return false; // not a cd command; let normal whitelist handle it

  // Extract the argument.  `cd` with no args → $HOME.
  const rawArg = (cdMatch[1] ?? "").trim();
  // If the cd is chained (e.g. "cd foo && ls"), only look at the segment
  // before the first `&&` or `;`.
  const arg = rawArg.split(/\s*&&|;/)[0].trim();
  const target = expandCdPath(arg, cwd);
  const normalizedTarget = normalize(resolve(target));
  const normalizedCwd = normalize(resolve(cwd));
  // Allow if target is cwd itself or a strict descendant of cwd.
  return normalizedTarget === normalizedCwd || normalizedTarget.startsWith(normalizedCwd + "/");
}

function expandCdPath(arg: string, cwd: string): string {
  if (arg === "") return homedir();
  if (arg.startsWith("~")) {
    // ~ → $HOME, ~/foo → $HOME/foo
    return resolve(homedir(), arg.slice(1).replace(/^\/?/, "./"));
  }
  return resolve(cwd, arg);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    const mode = getPermissionMode();
    if (mode === "accept-all") return;

    const toolName = (event as any).toolName;
    const input: any = (event as any).input ?? (event as any).args;

    // Only gate bash-family tools for now; pi has its own confirmation flow
    // for destructive edits via the TUI.
    if (toolName === "bash" || toolName === "Bash") {
      const cmd = input?.command;
      if (typeof cmd === "string") {
        // Allow `cd` when it resolves to cwd (no-op).  AIs frequently emit
        // `cd <project> && …` even when already in the right directory.
        if (/^cd(\s|$)/.test(cmd.trim()) && isNoopCd(cmd, process.cwd())) {
          return;
        }
        if (!isSafeBash(cmd)) {
          if (mode === "manual") {
            return { block: true, reason: "manual permission mode: bash command not pre-approved" };
          }
          // auto: block when not whitelisted
          return { block: true, reason: `bash whitelist: "${cmd.split(/\s+/)[0]}" is not in SAFE_PREFIXES` };
        }
      }
    }
  });
}
