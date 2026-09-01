// Type declarations for little-coder-settings.mjs (the shared `little_coder`
// settings resolver/writer). Sibling `.d.mts` next to the `.mjs`: under the
// repo's `moduleResolution: "bundler"`, a `./little-coder-settings.mjs` import
// from TS resolves to this declaration (TS maps `.mjs` → `.d.mts`). Same
// caveat as settings-write.d.mts: no `.d.ts` fallback for a `.mjs` source —
// if this declaration is wrong the fix is a declaration fix.
//
// The module itself is plain dependency-light ESM so the plain-.mjs launcher
// (bin/) can import it natively and the jiti-loaded TS extensions can import
// it with these types.

/**
 * The `little_coder` namespace in a pi settings file. Values are `unknown`
 * (user-provided data) — consumers cast to their own structural types.
 * Declared keys are documented here; the open index signature keeps
 * forward-compat for keys added later.
 */
export interface LittleCoderNamespace {
  /** Fallback model profile (see benchmark-profiles). */
  default_model_profile?: unknown;
  /** Per-model profiles keyed by `provider/model` prefix. */
  model_profiles?: unknown;
  /**
   * Extra bash SAFE_PREFIXES entries (see permission-gate). Polymorphic:
   *  - `string[]`  → global prefixes (applied to every repo).
   *  - `Record<string, string[]>` → per-repo map: each key is an absolute
   *    repo path whose value is that repo's extra prefixes; the reserved
   *    key `"global"` holds global prefixes. Written by the `/allow` and
   *    `/deny` commands (see permission-gate).
   */
  bash_allow?: unknown;
  /** false disables token-limit auto-continue (see token-limit-guard). */
  token_limit_auto_continue?: unknown;
  [key: string]: unknown;
}

export interface SettingsResolution {
  /** Per-key merge result: project → global → pkg-shipped. */
  merged: LittleCoderNamespace;
  /** Raw <cwd>/.pi/settings.json `little_coder` block (or null). */
  project: LittleCoderNamespace | null;
  /** Raw <agentDir>/settings.json `little_coder` block (or null). */
  global: LittleCoderNamespace | null;
  /** Raw shipped .pi/settings.json `little_coder` block (or null). */
  pkg: LittleCoderNamespace | null;
  /**
   * Top-level `defaultProjectTrust` from the GLOBAL settings file
   * ("ask" | "always" | "never", per pi's DefaultProjectTrust; unknown strings
   * pass through as-is and fail closed at the consumer), or null when
   * unset/invalid. Consumed by permission-gate's project-scope bash_allow
   * trust matrix.
   */
  defaultProjectTrust: string | null;
}

/** Read of one settings file (namespace block + defaultProjectTrust). */
export interface ScopeRead {
  namespace: LittleCoderNamespace | null;
  defaultProjectTrust: string | null;
}

/**
 * pi's agent dir: $PI_CODING_AGENT_DIR (with `~` / `~/x` expansion, same
 * convention as bin/little-coder.mjs step 8) or ~/.pi/agent.
 */
export function getAgentDir(): string;

/**
 * The little-coder package root (shipped .pi/settings.json lives here).
 * _shared/ is <pkgRoot>/.pi/extensions/_shared, so three levels up.
 * LITTLE_CODER_PKG_ROOT overrides for tests.
 */
export function pkgSettingsRoot(): string;

/**
 * Read one settings file. Returns null when the file is missing, malformed,
 * or has no usable `little_coder` object — never throws.
 */
export function readLittleCoderScope(path: string): ScopeRead | null;

/**
 * Per-key merge: for each top-level key of `little_coder`, the first scope
 * (project → global → pkg) that HAS the key wins. No deep merge.
 */
export function mergeNamespaces(
  project: LittleCoderNamespace | null,
  global: LittleCoderNamespace | null,
  pkg: LittleCoderNamespace | null,
): LittleCoderNamespace;

/**
 * Resolve the `little_coder` namespace with project → global → pkg precedence.
 * `cwd` defaults to process.cwd(). Unmemoized — every call re-reads the three
 * files, so settings edits apply mid-session on the next turn/operation.
 */
export function resolveLittleCoderSettings(cwd?: string): SettingsResolution;

/**
 * Resolve a single `little_coder` key with trust-gated precedence. `trusted`
 * true → project → global → pkg (exactly `resolved.merged[key]`); `trusted`
 * false → global → pkg (the project scope is ignored, so an untrusted repo
 * can never supply its own value for a security-relevant key). Returns
 * `undefined` when no in-scope scope has the key.
 */
export function resolveKey(
  resolved: Pick<SettingsResolution, "project" | "global" | "pkg">,
  key: string,
  trusted: boolean,
): unknown;

export interface SettingsUpdateResult {
  ok: boolean;
  /** Absolute path of the settings file that was (or would be) written. */
  path: string;
  error?: string;
}

/**
 * Read-modify-write the GLOBAL (per-user) settings file —
 * `$PI_CODING_AGENT_DIR/settings.json` or `~/.pi/agent/settings.json`.
 *
 * `mutate` receives the parsed top-level JSON document (a plain object) and
 * may modify it in place. Every other top-level key (and every other
 * `little_coder` key) is preserved. The write is atomic (temp file +
 * rename), creates the agent dir if missing, and the entire
 * read-modify-write runs under the shared proper-lockfile lock (see
 * settings-write.mjs for the protocol).
 *
 * Fail-safe: if the file exists but is malformed JSON (or not a plain
 * object) the write is REFUSED and an error is returned — a corrupt settings
 * file is never clobbered.
 *
 * Async; never throws: every failure is returned as `{ ok: false, error }`.
 */
export function updateGlobalSettings(
  mutate: (doc: Record<string, unknown>) => void,
): Promise<SettingsUpdateResult>;
