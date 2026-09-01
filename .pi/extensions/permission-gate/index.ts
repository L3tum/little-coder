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
  dirname,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { normalizeWritePath } from "../write-guard/index.ts";
import {
  getAgentDir,
  resolveLittleCoderSettings,
  updateGlobalSettings,
} from "../_shared/little-coder-settings.mjs";
// Shared pi-faithful trust matrix (no pi runtime import — see the module
// doc there). canonicalRepoKey is re-exported for existing importers/tests.
import {
  canonicalRepoKey,
  isProjectTrustedFailClosed,
} from "../_shared/project-trust.mjs";
// mtime-gated trust recheck: cheap lstat freshness keys (see freshness.mjs).
import { fileFreshnessKey } from "../_shared/freshness.mjs";
// Re-exported for existing importers/tests (permission.test.ts imports
// canonicalRepoKey from ./index.ts).
export { canonicalRepoKey, isProjectTrustedFailClosed };

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

// Lazy (computed per call): getAgentDir() reads $PI_CODING_AGENT_DIR at call
// time, so tests can point the config at a hermetic agent dir.
const configPath = () =>
  join(getAgentDir(), "little-coder-workspace-boundary.json");
const DEFAULT_CONFIG: WorkspaceBoundaryConfig = { externalFilePolicy: "ask" };
const POLICY_OPTIONS: ExternalFilePolicy[] = ["deny", "ask", "accept"];

let saveConfigQueue: Promise<void> = Promise.resolve();

async function loadConfig(): Promise<WorkspaceBoundaryConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(), "utf8"));
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
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), snapshot, "utf8");
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

/**
 * Sanitize a settings-file `little_coder.bash_allow` entry (array of raw
 * prefixes with the same semantics as LITTLE_CODER_BASH_ALLOW entries — a
 * trailing space is the word boundary, deliberately preserved).
 *
 * Keeps only string entries, trims LEADING whitespace (mirroring
 * parseExtraPrefixes' trimStart), drops empties. Never throws.
 */
export function sanitizeBashAllowEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const s = entry.trimStart();
    if (s.length > 0) out.push(s);
  }
  return out;
}

// Module state for the settings-file bash allowlist (lazy, per-session).
interface BashAllowState {
  prefixes: string[];
  projectPrefixes: number;
  /** Repo-scoped prefixes from the user's global file (via /allow). */
  repoPrefixes: number;
  /** builtin + env + settings union, rebuilt once per (re)load — not per
   *  tool_call. */
  safePrefixes: string[];
  /** The actual project-scoped prefixes (for the one-time notice). */
  projectPrefixList: string[];
  /** The actual repo-scoped prefixes (for the one-time notice). */
  repoPrefixList: string[];
  notified: boolean;
  repoNotified: boolean;
  // Freshness keys (mtimeMs:size) for the mtime-gated trust recheck. Captured
  // at load; the hot path lstats these three files and only re-runs the (still
  // one-way) trust resolution when trust.json or the agent-dir settings.json
  // (the defaultProjectTrust source) changes. A project-settings change is
  // deliberately NOT reloaded here — see ensureBashAllowLoaded.
  trustMtimeKey: string | null;
  globalSettingsMtimeKey: string | null;
  projectSettingsMtimeKey: string | null;
}
// Per-repo cache: each entry is keyed on the canonical (realpath) repo path,
// so switching repos no longer drops the other repo's state or its one-time
// notice flags (the old single-slot state reset them). The map is deliberately
// unbounded — it is cleared on every session_start, so its size is bounded by
// the distinct repos visited in the current session (a handful, a few hundred
// bytes each); a bounded LRU would only evict notice flags for no real win.
// `bashAllowLoadedKey` tracks the last-active repo so the tool_call fast
// path reads one entry via currentBashAllow().
const bashAllowCache = new Map<string, BashAllowState>();
let bashAllowLoadedKey: string | null = null;

/** The last-active repo's cached state (null key → undefined). */
function currentBashAllow(): BashAllowState | undefined {
  return bashAllowLoadedKey === null
    ? undefined
    : bashAllowCache.get(bashAllowLoadedKey);
}

// Test seams are kept in-module (consistent codebase pattern); see review descope note.
/** Cached repo keys in insertion order — for tests/inspection. */
export function _getBashAllowCacheKeysForTests(): string[] {
  return [...bashAllowCache.keys()];
}

/**
 * Render prefixes for a human-readable notice: quoted (so the word-boundary
 * trailing space is visible), first six, then a count of the rest.
 */
function formatPrefixList(list: string[]): string {
  const head = list
    .slice(0, 6)
    .map((p) => `"${p}"`)
    .join(", ");
  const extra = list.length - 6;
  return extra > 0 ? `${head}, and ${extra} more` : head;
}

/**
 * Freshness keys for the three files that feed a cached entry's trust
 * decision. lstat only (one syscall each, no open/read): µs-scale, so the
 * hot path can check them every tool_call. The paths match EXACTLY what
 * resolveLittleCoderSettings / ProjectTrustStore read (same join() shapes),
 * so a key change means the resolver would see different bytes.
 *   trust            — $PI_CODING_AGENT_DIR/trust.json (explicit decisions)
 *   globalSettings   — $PI_CODING_AGENT_DIR/settings.json (defaultProjectTrust)
 *   projectSettings  — <cwd>/.pi/settings.json (the project's own bash_allow)
 * Each is null when the file is missing.
 */
function allowCacheFileKeys(cwd: string): {
  trust: string | null;
  globalSettings: string | null;
  projectSettings: string | null;
} {
  const agent = getAgentDir();
  return {
    trust: fileFreshnessKey(join(agent, "trust.json")),
    globalSettings: fileFreshnessKey(join(agent, "settings.json")),
    projectSettings: fileFreshnessKey(join(cwd, ".pi", "settings.json")),
  };
}

/**
 * Read little_coder.bash_allow from the settings files (global scope always;
 * project scope only when the project is trusted) and cache the result.
 * The global file's bash_allow may be an array (global prefixes) or a
 * per-repo map — the entry for the current repo's canonical path is honored
 * without trust gating, because it was written by an explicit user action
 * (/allow) in the user's own file, never by the repo itself.
 * Idempotent within a session per repo key; reset via clearBashAllowCache()
 * on session_start. Synchronous — the files are tiny.
 *
 * The cache is keyed on the canonical (realpath) repo path, matching pi's
 * `normalizeCwd` — symlink / trailing-spelling cwd drift no longer forces a
 * reload + flag reset (interacts with the one-time notice). The fast path pays one
 * `realpathSync` per `tool_call` (previously only on load): µs-scale,
 * accepted.
 *
 * Fast-path trust recheck (mtime-gated): while a cached entry has
 * project prefixes active, a revoked project trust must NOT keep auto-
 * approving shell commands. The hot path lstats three files (trust.json,
 * agent-dir settings.json, project settings.json — see allowCacheFileKeys)
 * and re-runs the (still one-way) resolution ONLY when trust.json or the
 * agent-dir settings.json (the defaultProjectTrust source) freshness key
 * changed; the entry is then rebuilt WITHOUT project prefixes if the
 * decision flipped to untrusted (repo-scoped /allow prefixes survive;
 * `notified: true` so the one-time project notice doesn't re-fire).
 * A project-settings mtime change is deliberately NOT reloaded here — one-
 * time notice stability plus the documented "mid-session edits apply next
 * session/reload" contract.
 * One-way: re-trusting mid-session does not restore project prefixes —
 * the next session_start, /allow, /deny, or --reload applies them (same as
 * any mid-session settings edit).
 */
export function ensureBashAllowLoaded(cwd: string): void {
  const key = canonicalRepoKey(cwd);
  const cached = bashAllowCache.get(key);
  if (cached) {
    // Make this the last-active repo (currentBashAllow() fast path).
    // No re-insert: the map is unbounded, key order is plain insertion
    // order, and the entry (with its one-time notice flags) is stable.
    bashAllowLoadedKey = key;
    if (cached.projectPrefixes > 0) {
      // mtime-gated recheck (refined): 3 lstats (µs) per tool_call
      // instead of a trust.json read + parse + ancestor walk + settings
      // re-read. Trust can change via TWO sources — trust.json AND
      // defaultProjectTrust in the agent-dir settings.json — so gate on both.
      // A project-settings mtime change is deliberately NOT reloaded (one-time
      // notice stability + the documented "mid-session edits apply next
      // session/reload" contract).
      const keys = allowCacheFileKeys(cwd);
      if (
        keys.trust !== cached.trustMtimeKey ||
        keys.globalSettings !== cached.globalSettingsMtimeKey
      ) {
        // Trust-decision inputs changed: re-run resolution — still ONE-WAY
        // (re-trust does not restore project prefixes; revocation below).
        const r = resolveLittleCoderSettings(cwd);
        if (!isProjectTrustedFailClosed(cwd, r.defaultProjectTrust)) {
          // Trust was revoked since this entry loaded: rebuild WITHOUT
          // project prefixes. Repo-scoped /allow prefixes are the user's own
          // explicit grants and survive; the project notice already fired
          // (or would be wrong now), so notified: true.
          const globalParsed = parseBashAllow(r.global?.bash_allow);
          const repoPrefixes = globalParsed.repos.get(key) ?? [];
          const prefixes = [...globalParsed.global, ...repoPrefixes];
          bashAllowCache.set(key, {
            prefixes,
            projectPrefixes: 0,
            projectPrefixList: [],
            repoPrefixes: repoPrefixes.length,
            repoPrefixList: repoPrefixes,
            safePrefixes: getSafePrefixes(prefixes),
            notified: true,
            repoNotified: cached.repoNotified,
            trustMtimeKey: keys.trust,
            globalSettingsMtimeKey: keys.globalSettings,
            projectSettingsMtimeKey: keys.projectSettings,
          });
          return;
        }
      }
      // Store the refreshed keys so the next call compares against them.
      cached.trustMtimeKey = keys.trust;
      cached.globalSettingsMtimeKey = keys.globalSettings;
      cached.projectSettingsMtimeKey = keys.projectSettings;
    }
    return;
  }
  const r = resolveLittleCoderSettings(cwd);
  const globalParsed = parseBashAllow(r.global?.bash_allow);
  const repoPrefixes = globalParsed.repos.get(key) ?? [];
  let projectPrefixes: string[] = [];
  if (r.project?.bash_allow !== undefined) {
    if (isProjectTrustedFailClosed(cwd, r.defaultProjectTrust)) {
      // Project-scope entries come from a repo's own settings file (the only
      // untrusted-content path), so normalize a missing trailing space to
      // word-boundary form ("make" → "make ": allows `make …`, not
      // `makefoo`) — mirrors normalizeAllowPrefixDetail (/allow). Global-file
      // and env entries are the user's own values and keep their exact form
      // (documented caveat).
      projectPrefixes = sanitizeBashAllowEntries(r.project.bash_allow).map(
        (p) => (p.endsWith(" ") ? p : `${p} `),
      );
    }
  }
  const prefixes = [
    ...globalParsed.global,
    ...repoPrefixes,
    ...projectPrefixes,
  ];
  // Capture the freshness keys at load so the hot path's first recheck
  // compares against the state that produced this entry.
  const fileKeys = allowCacheFileKeys(cwd);
  const entry: BashAllowState = {
    prefixes,
    projectPrefixes: projectPrefixes.length,
    projectPrefixList: projectPrefixes,
    repoPrefixes: repoPrefixes.length,
    repoPrefixList: repoPrefixes,
    safePrefixes: getSafePrefixes(prefixes), // builtins + env + settings, once
    notified: false,
    repoNotified: false,
    trustMtimeKey: fileKeys.trust,
    globalSettingsMtimeKey: fileKeys.globalSettings,
    projectSettingsMtimeKey: fileKeys.projectSettings,
  };
  bashAllowCache.set(key, entry);
  bashAllowLoadedKey = key;
}

/** Reset the allowlist state (call on session_start). */
export function clearBashAllowCache(): void {
  bashAllowCache.clear();
  bashAllowLoadedKey = null;
}

/** Currently loaded settings-file prefixes (for tests / inspection). */
export function _getLoadedBashAllowPrefixesForTests(): string[] {
  return currentBashAllow()?.prefixes ?? [];
}

/** Count of repo-scoped prefixes (user file, via /allow) in the loaded state. */
export function _getLoadedBashAllowRepoPrefixCountForTests(): number {
  return currentBashAllow()?.repoPrefixes ?? 0;
}

/** The loaded safe-prefix union (builtins + env + settings) — rebuilt once
 *  per (re)load, not per tool_call (for tests / inspection). */
export function _getLoadedSafePrefixesForTests(): string[] {
  return currentBashAllow()?.safePrefixes ?? [];
}

/**
 * Builtin + env-var + settings-file prefixes (pure union — purely additive).
 * `settingsExtra` defaults to [] so exported signatures and existing tests
 * are untouched; the tool_call handler passes the loaded settings prefixes.
 */
export function getSafePrefixes(
  settingsExtra: readonly string[] = [],
): string[] {
  return [
    ...BUILTIN_SAFE_PREFIXES,
    ...parseExtraPrefixes(process.env.LITTLE_CODER_BASH_ALLOW),
    ...settingsExtra,
  ];
}

// ── per-repo bash allowlists (/allow and /deny) ─────────────────────────────
// The user's GLOBAL settings file may hold a per-repo allowlist so that
// "allow this command for THIS repo" is (a) an explicit user action and (b)
// stored outside the repo itself — a repo's own .pi/settings.json can never
// widen its own shell allowlist without project trust, and /allow must not
// depend on that (nor commit anything into the working tree).
//
// little_coder.bash_allow is polymorphic:
//   string[]                      → global prefixes (hand-written form —
//                                   the natural shape for editing the file
//                                   by hand)
//   Record<string, string[]>      → per-repo map; keys are absolute repo
//                                   paths, and the reserved key "global"
//                                   holds global prefixes.

/** Reserved map key for global (all-repo) prefixes in the object form. */
export const BASH_ALLOW_GLOBAL_KEY = "global";

export interface BashAllowParsed {
  /** Global prefixes (array form, or the "global" key of the object form). */
  global: string[];
  /** Per-repo prefixes keyed by absolute repo path. */
  repos: Map<string, string[]>;
}

/** Parse a polymorphic `little_coder.bash_allow` value. Never throws; any
 *  malformed part is simply dropped (same posture as sanitizeBashAllowEntries). */
export function parseBashAllow(value: unknown): BashAllowParsed {
  const repos = new Map<string, string[]>();
  let global: string[] = [];
  if (Array.isArray(value)) {
    global = sanitizeBashAllowEntries(value);
  } else if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const entries = sanitizeBashAllowEntries(val);
      if (entries.length === 0) continue;
      if (key === BASH_ALLOW_GLOBAL_KEY) {
        global = global.concat(entries);
      } else {
        repos.set(key, (repos.get(key) ?? []).concat(entries));
      }
    }
  }
  return { global, repos };
}

/**
 * Rebuild a `bash_allow` value from its parsed form. Stays an ARRAY when
 * there are no per-repo entries (keeps the file clean and backward
 * compatible); becomes an object (with a "global" key only when non-empty)
 * once any repo has entries.
 */
export function buildBashAllow(
  parsed: BashAllowParsed,
): string[] | Record<string, string[]> {
  if (parsed.repos.size === 0) return parsed.global;
  const obj: Record<string, string[]> = {};
  if (parsed.global.length > 0) obj[BASH_ALLOW_GLOBAL_KEY] = parsed.global;
  for (const [key, list] of parsed.repos) {
    if (list.length > 0) obj[key] = list;
  }
  return obj;
}

// Strip exactly ONE pair of matching surrounding quotes (after whitespace
// collapse): `/allow "make test"` stores `make test `, not `"make test" `
// (the latter would never match — quotes are consumed as quoting chars by
// the segment scanner). Mismatched quotes are never stripped. No
// recursion: `""x""` -> `"x"`.
function normalizeAllowPrefixDetail(raw: string): {
  prefix: string;
  quotesStripped: boolean;
} {
  let s = raw.trim().replace(/\s+/g, " ");
  let quotesStripped = false;
  if (
    s.length >= 2 &&
    (s[0] === `"` || s[0] === "'") &&
    s[s.length - 1] === s[0]
  ) {
    s = s.slice(1, -1).trim().replace(/\s+/g, " ");
    quotesStripped = true;
  }
  const prefix = s.endsWith(" ") ? s : `${s} `;
  return { prefix, quotesStripped };
}

/** Normalize user input from /allow into a stored prefix: trim, collapse
 *  internal whitespace, strip one pair of surrounding quotes, and force a
 *  trailing space so the word-boundary convention holds ("make" → "make ",
 *  which allows `make …` but not `makefoo`). */
export function normalizeAllowPrefix(raw: string): string {
  return normalizeAllowPrefixDetail(raw).prefix;
}

/** Split a /allow|/deny argument string into the raw command and the
 *  --global flag. A standalone `--global` token (anywhere in the args) selects
 *  the global scope (honored in every repo) instead of the current repo's key.
 *  Remaining tokens are re-joined with single spaces — internal whitespace is
 *  collapsed the same way normalizeAllowPrefixDetail does, so re-joining here is
 *  lossless for the downstream normalization. */
export function splitGlobalFlag(
  args: string | undefined,
): { command: string; global: boolean } {
  let global = false;
  const parts: string[] = [];
  for (const t of (args ?? "").trim().split(/\s+/)) {
    if (t === "") continue;
    if (t === "--global") global = true;
    else parts.push(t);
  }
  return { command: parts.join(" "), global };
}

/** After a /deny, explain why the prefix might STILL be allowed (a higher
 *  source keeps contributing it to the pure union): builtins, a trusted
 *  project's own settings, the env var, or the user's global allow list.
 *  Returns null when nothing else covers it. */
export function describeStillAllowed(
  prefix: string,
  cwd: string,
): string | null {
  // The built-in diagnostic whitelist (npm typecheck/lint/test, npx tsc
  // --noEmit, npx vitest, … — including `&&`-chained diagnostic commands)
  // keeps the command allowed no matter what settings say, so it is the
  // FIRST check: single diagnostics would be reported as "built-in safe
  // prefixes" via isSafePrefixCommand anyway, but only the chain-aware
  // isSafeDiagnosticCommand sees e.g. "git status && git diff".
  if (isSafeDiagnosticCommand(prefix))
    return "the built-in diagnostic whitelist";
  if (isSafePrefixCommand(prefix, BUILTIN_SAFE_PREFIXES))
    return "the built-in safe prefixes";
  const r = resolveLittleCoderSettings(cwd);
  if (
    isProjectTrustedFailClosed(cwd, r.defaultProjectTrust) &&
    isSafePrefixCommand(prefix, sanitizeBashAllowEntries(r.project?.bash_allow))
  )
    return "the project's .pi/settings.json (project is trusted)";
  if (
    isSafePrefixCommand(
      prefix,
      parseExtraPrefixes(process.env.LITTLE_CODER_BASH_ALLOW),
    )
  ) {
    return "LITTLE_CODER_BASH_ALLOW";
  }
  const globalParsed = parseBashAllow(r.global?.bash_allow);
  if (isSafePrefixCommand(prefix, globalParsed.global)) {
    return "your global bash_allow list";
  }
  return null;
}

export interface BashAllowOpResult {
  ok: boolean;
  error?: string;
  path?: string;
  /** The stored prefix (word-boundary normalized). */
  prefix: string;
  /** The repo key the change applied to. */
  repoKey: string;
  /** /allow: true when the prefix was actually added. */
  added: boolean;
  /** /deny: true when the prefix was actually removed. */
  removed: boolean;
  /** /deny only: why the command may still be allowed, if anything. */
  stillAllowedVia: string | null;
  /** /allow only: true when a pair of surrounding quotes was stripped from
   *  the user input (the stored value differs from what was typed). */
  quotesStripped: boolean;
}

async function applyBashAllowOp(
  rawCommand: string,
  cwd: string,
  mode: "allow" | "deny",
  global = false,
): Promise<BashAllowOpResult> {
  const base: BashAllowOpResult = {
    ok: false,
    prefix: "",
    repoKey: "",
    added: false,
    removed: false,
    stillAllowedVia: null,
    quotesStripped: false,
  };
  const raw = rawCommand.trim();
  if (!raw) return { ...base, error: "empty" };
  const { prefix, quotesStripped } = normalizeAllowPrefixDetail(raw);
  // `/allow ""` (or `''`): non-empty raw input that normalizes to nothing —
  // same "no command given" error as the raw-empty path, nothing written.
  if (prefix.trim() === "") return { ...base, error: "empty" };
  const repoKey = canonicalRepoKey(cwd);
  // The result's repoKey names the scope the change applied to: the canonical
  // repo path for repo-scoped ops, "global" for --global ops.
  base.repoKey = global ? BASH_ALLOW_GLOBAL_KEY : repoKey;
  // added/removed are reported ONLY on the success path: the mutate callback
  // below runs BEFORE the atomic write, so a write failure must not claim
  // the entry was added/removed.
  let added = false;
  let removed = false;
  const result = await updateGlobalSettings((doc) => {
    const nsRaw = doc.little_coder;
    const ns =
      nsRaw && typeof nsRaw === "object" && !Array.isArray(nsRaw)
        ? (nsRaw as Record<string, unknown>)
        : {};
    const parsed = parseBashAllow(ns.bash_allow);
    if (global) {
      // Global scope: the shared "global" key, honored in every repo and never
      // trust-gated (it lives in the user's own settings file). An emptied
      // global list collapses back to array form via buildBashAllow.
      if (mode === "allow") {
        if (!parsed.global.includes(prefix)) {
          parsed.global.push(prefix);
          added = true;
        }
      } else {
        const kept = parsed.global.filter((p) => p !== prefix);
        if (kept.length !== parsed.global.length) {
          parsed.global = kept;
          removed = true;
        }
      }
    } else {
      const list = parsed.repos.get(repoKey) ?? [];
      if (mode === "allow") {
        if (!list.includes(prefix)) {
          list.push(prefix);
          parsed.repos.set(repoKey, list);
          added = true;
        }
      } else {
        const kept = list.filter((p) => p !== prefix);
        if (kept.length !== list.length) {
          // Delete (rather than store an empty list) so an emptied repo falls
          // out of the map and buildBashAllow can collapse back to array form.
          if (kept.length === 0) parsed.repos.delete(repoKey);
          else parsed.repos.set(repoKey, kept);
          removed = true;
        }
      }
    }
    ns.bash_allow = buildBashAllow(parsed);
    doc.little_coder = ns;
  });
  if (!result.ok) return { ...base, error: result.error, prefix };
  base.added = added;
  base.removed = removed;
  // Refresh the in-session caches so the change takes effect immediately.
  // Capture the last-active repo's notice flags, drop every cached repo
  // (so the change becomes visible from EVERY repo key, lazily, on next
  // touch), reload the current repo, then restore the flags on the rebuilt
  // entry — a /allow must not re-fire the one-time notices.
  const prev = currentBashAllow();
  const notified = prev?.notified ?? false;
  const repoNotified = prev?.repoNotified ?? false;
  clearBashAllowCache();
  ensureBashAllowLoaded(cwd); // resolveLittleCoderSettings re-reads the file
  const rebuilt = currentBashAllow();
  if (rebuilt) {
    rebuilt.notified = notified; // freshly written by updateGlobalSettings
    rebuilt.repoNotified = repoNotified;
  }
  const stillAllowedVia =
    mode === "deny" ? describeStillAllowed(prefix, cwd) : null;
  return {
    ...base, // base.repoKey is the scope ("global" or the repo path)
    ok: true,
    path: result.path,
    prefix,
    stillAllowedVia,
    quotesStripped,
  };
}

/** `/allow <command>`: add a word-boundary prefix to the current repo's
 *  allowlist in the user's global settings file (effective immediately).
 *  With `global = true`, writes to the shared "global" key instead of the
 *  current repo's key — honored in every repo, never trust-gated (it lives
 *  in the user's own settings file). Async — the shared settings writer's
 *  lock is async. */
export function allowBashPrefix(
  rawCommand: string,
  cwd: string,
  global = false,
): Promise<BashAllowOpResult> {
  return applyBashAllowOp(rawCommand, cwd, "allow", global);
}

/** `/deny <command>`: remove a prefix from the current repo's allowlist
 *  (or, with `global = true`, from the shared "global" key). Built-ins /
 *  env / other-scope entries cannot be removed — `stillAllowedVia` reports
 *  what keeps the command allowed, if anything. Async. */
export function denyBashPrefix(
  rawCommand: string,
  cwd: string,
  global = false,
): Promise<BashAllowOpResult> {
  return applyBashAllowOp(rawCommand, cwd, "deny", global);
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
 * Detailed result of scanning a bash command for shell control operators.
 * - `segments`: the command split on top-level `&&`, `||`, and `|`
 * - `forbidden`: a disallowed shell operator appeared outside quotes
 * - `malformed`: a segment would be empty (e.g. `ls |`)
 */
export type BashSegmentScan =
  | { kind: "segments"; segments: string[] }
  | { kind: "forbidden"; operator: string }
  | { kind: "malformed" };

/**
 * Scan a command for top-level `&&`, `||`, and `|` separators that appear
 * OUTSIDE quoted strings, so `grep -E "a|b" file`, `grep 'a&&b' file`, and
 * `grep foo | head -20` are all understood correctly.
 *
 * `||` is treated like `&&`: it only runs the segments that are listed, and
 * each segment is still checked against the safe prefix list, so
 * `cargo clippy 2>&1 | grep -i supply || echo none` is as safe as the
 * equivalent `&&`/`|` chain.
 *
 * Forbidden outside quotes: `;`, bare `&` (backgrounding), backtick, `$`,
 * `<`, `>`, newline — and `$`/backtick inside double quotes (command
 * substitution). Characters inside single quotes are always literal.
 */
function scanBashSegmentsDetailed(command: string): BashSegmentScan {
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
  const operatorName = (ch: string) =>
    ch === "\n" || ch === "\r" ? "newline" : ch;

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
      if (next !== undefined && isOuterMeta(next))
        return { kind: "forbidden", operator: operatorName(next) };
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
      else if (isDoubleQuoteMeta(ch))
        return { kind: "forbidden", operator: operatorName(ch) };
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
      // Both `|` (pipeline) and `||` (short-circuit) split segments; every
      // resulting segment is still checked against the safe prefix list.
      if (command[i + 1] === "|") i += 1;
      flush();
      continue;
    }
    if (isOuterMeta(ch))
      return { kind: "forbidden", operator: operatorName(ch) };
    current += ch;
  }
  flush();

  const trimmed = segments.map((s) => s.trim());
  if (trimmed.some((s) => s.length === 0)) return { kind: "malformed" };
  return { kind: "segments", segments: trimmed };
}

/**
 * Split a command into top-level `&&`/`||`/`|` segments, or return null when
 * a forbidden shell control operator appears outside quotes or a segment
 * would be empty (e.g. `ls |`).
 */
export function scanBashSegments(command: string): string[] | null {
  const result = scanBashSegmentsDetailed(command);
  return result.kind === "segments" ? result.segments : null;
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

const ADVISORY_SUFFIX = "Ask the user to execute this command instead.";

interface BashGateResult {
  safe: boolean;
  reason: string | null;
}

function evaluateBash(
  command: string,
  prefixes: readonly string[],
  cwd?: string,
): BashGateResult {
  const c = command.trim();
  if (isSafeDiagnosticCommand(c)) return { safe: true, reason: null };

  // `cd <target> && …` / `cd <target> ; …` is allowed only when the cd target
  // itself contains no shell metacharacters, resolves inside the workspace,
  // and the chained command is itself safe. Without the chain check, any
  // `cd subdir && …` bypasses the whitelist entirely.
  if (cwd && /^cd(\s|$)/.test(c)) {
    const cdHead = c.split(/\s*(?:&&|;)/)[0];
    const cdSegments = scanBashSegments(cdHead);
    if (cdSegments !== null && cdSegments.length === 1 && isNoopCd(c, cwd)) {
      const remainder = stripLeadingCdChain(c);
      if (remainder.trim() === "") return { safe: true, reason: null };
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
  const scan = scanBashSegmentsDetailed(withoutStderrRedirect);
  if (scan.kind === "forbidden") {
    // Name the offending operator instead of blaming the first command
    // (e.g. "cargo clippy ... || echo none" must not report on "cargo").
    return {
      safe: false,
      reason: `bash whitelist: shell operator "${scan.operator}" is not allowed in pre-approved bash commands. ${ADVISORY_SUFFIX}`,
    };
  }
  if (scan.kind === "malformed" || scan.segments.length === 0) {
    return {
      safe: false,
      reason: `bash whitelist: command has an empty segment after a shell operator. ${ADVISORY_SUFFIX}`,
    };
  }
  for (const segment of scan.segments) {
    if (!isSafePrefixCommand(segment, prefixes)) {
      return {
        safe: false,
        reason: `bash whitelist: "${segment}" is not in SAFE_PREFIXES. ${ADVISORY_SUFFIX}`,
      };
    }
  }
  return { safe: true, reason: null };
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
  return result.safe ? null : result.reason;
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
      // pi passes the raw argument STRING (not an array) — take the first
      // whitespace-separated token.
      const arg = (typeof args === "string" ? args : String(args ?? ""))
        .trim()
        .split(/\s+/)[0]
        ?.toLowerCase();
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

  pi.registerCommand("allow", {
    description:
      "Allow a bash command prefix (saves to your user settings.json; takes effect immediately). Scoped to the current repo by default — add --global to allow it in every repo. /allow --reload discards the session-cached allowlist without writing anything",
    handler: async (args, ctx) => {
      // Pure cache invalidation: a hand edit to a settings file takes effect
      // on the next tool call without a session restart and without any
      // write (no-op when nothing is cached).
      if ((args ?? "").trim() === "--reload") {
        clearBashAllowCache();
        if (ctx.hasUI) ctx.ui.notify("bash allowlist reloaded", "info");
        return;
      }
      const { command, global } = splitGlobalFlag(args);
      const where = global ? "globally (all repos)" : "for this repo";
      const res = await allowBashPrefix(command, ctx.cwd, global);
      if (!ctx.hasUI) return;
      if (!res.ok) {
        ctx.ui.notify(
          res.error === "empty"
            ? "Usage: /allow <command> [--global]  — e.g. /allow make test"
            : `/allow failed: ${res.error}`,
          "error",
        );
        return;
      }
      ctx.ui.notify(
        res.added
          ? `Allowed "${res.prefix.trim()}" ${where} (saved to ${res.path}, active now).${res.quotesStripped ? " (surrounding quotes removed)" : ""}`
          : `"${res.prefix.trim()}" is already allowed ${where}.`,
        "info",
      );
    },
  });

  pi.registerCommand("deny", {
    description:
      "Remove a bash command prefix from your allow list (built-in safe prefixes can't be removed). Scoped to the current repo by default — add --global to remove it from every repo. /deny --reload discards the session-cached allowlist without writing anything",
    handler: async (args, ctx) => {
      // Pure cache invalidation (see /allow --reload): no settings write.
      if ((args ?? "").trim() === "--reload") {
        clearBashAllowCache();
        if (ctx.hasUI) ctx.ui.notify("bash allowlist reloaded", "info");
        return;
      }
      const { command, global } = splitGlobalFlag(args);
      const where = global ? "globally (all repos)" : "for this repo";
      const listNoun = global ? "the global list" : "this repo's allow list";
      const res = await denyBashPrefix(command, ctx.cwd, global);
      if (!ctx.hasUI) return;
      if (!res.ok) {
        ctx.ui.notify(
          res.error === "empty"
            ? "Usage: /deny <command> [--global]  — e.g. /deny make test"
            : `/deny failed: ${res.error}`,
          "error",
        );
        return;
      }
      if (!res.removed) {
        const suffix = res.stillAllowedVia
          ? ` It is still allowed via ${res.stillAllowedVia}.`
          : "";
        ctx.ui.notify(
          `"${res.prefix.trim()}" was not in ${listNoun} (nothing to remove).${suffix}`,
          "info",
        );
        return;
      }
      if (res.stillAllowedVia) {
        ctx.ui.notify(
          `Removed "${res.prefix.trim()}" from ${listNoun}, but it is still allowed via ${res.stillAllowedVia} — /deny only edits your settings-file entries.`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Denied "${res.prefix.trim()}" ${where} (saved to ${res.path}, active now).`,
          "info",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await ensureConfigLoaded();
    // The settings-file allowlist is CACHED per session (keyed on the
    // canonical repo path, unbounded — see the cache comment at the top);
    // it re-reads on session_start,
    // after /allow|/deny, and after /allow --reload — a mid-session
    // settings.json edit applies on the next /allow|/deny, --reload, or
    // the next session (deliberate: keeps the one-time notice flags
    // stable).
    clearBashAllowCache();
    const cwd = ctx?.sessionManager?.getCwd?.() ?? process.cwd();
    ensureBashAllowLoaded(cwd);
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    await ensureConfigLoaded();
    ensureBashAllowLoaded(ctx.cwd);
    const mode = getPermissionMode();
    // Single structural cast for the pi tool_call event (avoids repeated
    // `any` casts): toolName is always present on a tool_call; input/args
    // carry the tool's arguments (an object with command/path/file_path/…).
    const ev = event as {
      toolName: string;
      input?: Record<string, unknown>;
      args?: Record<string, unknown>;
    };
    const toolName = ev.toolName;
    const input: Record<string, unknown> | undefined = ev.input ?? ev.args;
    const isBashTool = toolName === "bash" || toolName === "Bash";

    if (mode !== "accept-all") {
      // One-time transparency notices: they concern auto-approving shell
      // commands, so they fire only on bash tool calls while the gate is
      // active (in accept-all mode nothing is gated, and non-bash tools
      // never touch the allowlist — a notice would be noise).
      const state = currentBashAllow();
      // Project-scoped prefixes are active (the repo's own settings file
      // is auto-approving shell commands).
      if (isBashTool && state && state.projectPrefixes > 0 && !state.notified) {
        state.notified = true;
        if (ctx.hasUI)
          ctx.ui.notify(
            `bash allowlist: ${state.projectPrefixes} project-scoped prefix(es) active from .pi/settings.json: ${formatPrefixList(state.projectPrefixList)}`,
            "info",
          );
      }
      // Same, for repo-scoped prefixes the user saved via /allow in their
      // user settings file (explicit user action, but still worth a one-time
      // "this is auto-approving shell commands here" note). Own flag so both
      // notices can fire in a session that has both kinds active.
      if (
        isBashTool &&
        state &&
        state.repoPrefixes > 0 &&
        !state.repoNotified
      ) {
        state.repoNotified = true;
        if (ctx.hasUI)
          ctx.ui.notify(
            `bash allowlist: ${state.repoPrefixes} repo-scoped prefix(es) active for this repo (via /allow in your settings): ${formatPrefixList(state.repoPrefixList)}`,
            "info",
          );
      }

      if (isBashTool) {
        const cmd = input?.command;
        if (typeof cmd === "string") {
          // A missing state here means ensureBashAllowLoaded produced no
          // entry; log it instead of failing silently.
          if (!state)
            console.error(
              "permission-gate: bash allowlist state missing (ensureBashAllowLoaded produced no entry) — falling back to builtins + env safe prefixes (repo-settings prefixes unavailable without state)",
            );
          // If state is unexpectedly missing, fall back to the builtins + env
          // safe-prefix union rather than an empty list — an empty list would
          // block even `git status`. Believed unreachable (ensureBashAllowLoaded
          // always installs an entry) but safe by construction.
          const safePrefixes = state?.safePrefixes ?? getSafePrefixes();
          if (mode === "manual") {
            if (!isSafeBash(cmd, safePrefixes, ctx.cwd)) {
              return {
                block: true,
                reason: "manual permission mode: bash command not pre-approved",
              };
            }
          } else {
            const reason = bashBlockReason(cmd, safePrefixes, ctx.cwd);
            if (reason !== null) {
              return { block: true, reason };
            }
          }
        }
      }
    }

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
