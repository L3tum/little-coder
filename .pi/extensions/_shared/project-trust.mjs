// Shared, pi-faithful project-trust resolution for little-coder extensions
// that need a non-interactive, fail-closed decision (permission-gate's
// project-scope bash_allow gate, benchmark-profiles' project-scope model
// profiles).
//
// Mirrors pi's `resolveProjectTrusted` / `findNearestTrustEntry`
// (dist/core/trust-manager.js) WITHOUT importing the pi runtime:
//   - pi's ProjectTrustStore is only reachable through the package root
//     barrel (the exports map has no subpath), which drags the entire
//     runtime into each extension's jiti instance;
//   - every ProjectTrustStore.get() takes a synchronous file lock, which a
//     read-only lookup does not need.
//
// PI-VERSION PIN: this reads/writes `~/.pi/agent/trust.json` and honors
// `defaultProjectTrust` per the pi ~0.80.x trust model (boolean-or-null map
// keyed by canonical absolute path, nearest-ancestor decision). If pi changes
// the trust store's on-disk format (e.g. a new field, a different key
// scheme, or a versioned file), re-verify this module against the new
// dist/core/trust-manager.js — a format drift here silently fails closed
// (wrong trust decision), which is safe but surprising.
//
// Deliberate divergence (do not "simplify" to ctx.isProjectTrusted()):
//   - little-coder has no prompt here. pi's "ask" default would prompt in
//     its own flow; for us "ask" / "never" / unknown => not trusted.
//   - Session-level trust granted via pi's interactive prompt is NOT honored
//     by this gate (it only reads trust.json + defaultProjectTrust).
//
// No read lock: pi writes trust.json with a plain (non-atomic) writeFileSync,
// so a torn read during a concurrent /trust decision is possible; the parse
// error is caught and the decision fails closed to defaultProjectTrust.
//
// Unit-testable and cheap under jiti; no pi runtime imports.
//
// Shipped as plain `.mjs` (types in the sibling `.d.mts`) so the plain-.mjs
// launcher can import it natively, exactly like settings-write.mjs.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "./little-coder-settings.mjs";

/**
 * Canonical key for "the current repo": the real, absolute launch
 * directory (realpath, matching how pi's trust.json canonicalizes cwd
 * paths; falls back to resolve() if realpath fails).
 * @param {string} cwd
 * @returns {string}
 */
export function canonicalRepoKey(cwd) {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

/**
 * Read the nearest stored trust decision for `cwd` from
 * `<agentDir>/trust.json` (pi's trust store: a flat map of canonical
 * directory path -> true | false | null).
 *
 * pi-exact semantics (trust-manager.js `findNearestTrustEntry` +
 * `readTrustFile`):
 *   - walk from the canonicalized cwd up through ancestors;
 *   - the nearest entry that is strictly `true` or `false` wins;
 *   - `null` entries (a "trust parent" decision clears the child) are
 *     skipped and the walk CONTINUES upward;
 *   - any value that is not true/false/null is an invalid store (pi's
 *     readTrustFile throws) -> returned as null here (fail closed);
 *   - missing file, malformed JSON, non-object root -> null (no decision).
 *
 * Never throws.
 *
 * @param {string} agentDir
 * @param {string} cwd
 * @returns {boolean | null}
 */
// (P2) Module-level memo for the parsed + validated trust map. readTrustDecision
// otherwise re-reads, re-parses, and re-validates the ENTIRE map (O(N) in trust
// entries) on every call — which is on the per-token-limit-turn path. Invalidate
// by file path + mtimeMs + size (the same freshness inputs the rest of the repo
// uses). Accepted limitation: a content-only rewrite with an identical mtimeMs
// AND size (e.g. 1 s-granularity filesystems) is undetectable — the same trade
// every other freshness key in this repo makes.
let trustMapMemo = { path: null, mtimeMs: null, size: null, map: null };

/** Drop the trust-map memo (test isolation; the _ForTests seam pattern). */
export function _clearTrustCacheForTests() {
  trustMapMemo = { path: null, mtimeMs: null, size: null, map: null };
}

/** Read + parse + validate the trust map. null on any failure: missing file,
 * malformed JSON, non-object root, or an invalid value anywhere (pi's
 * readTrustFile treats a corrupt store as "no decision", fail closed). */
function readAndValidateTrustMap(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return null; // missing or unreadable
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // Validate the whole map up front, like pi's readTrustFile.
  for (const value of Object.values(parsed)) {
    if (value !== true && value !== false && value !== null) return null;
  }
  return parsed;
}

export function readTrustDecision(agentDir, cwd) {
  const file = join(agentDir, "trust.json");
  let mtimeMs;
  let size;
  try {
    const st = statSync(file);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    mtimeMs = null; // file absent (or unreadable)
    size = null;
  }
  // Memo hit (same file, same mtime + size) → reuse the validated map without
  // re-reading/re-parsing/re-validating. Miss → re-read and refresh the memo.
  if (
    trustMapMemo.path === file &&
    trustMapMemo.mtimeMs === mtimeMs &&
    trustMapMemo.size === size
  ) {
    return trustDecisionFromMap(trustMapMemo.map, cwd);
  }
  const map = readAndValidateTrustMap(file);
  trustMapMemo = { path: file, mtimeMs, size, map };
  return trustDecisionFromMap(map, cwd);
}

/** Nearest-ancestor boolean walk over a validated map (null map → null). */
function trustDecisionFromMap(map, cwd) {
  if (!map) return null;
  let currentDir = canonicalRepoKey(cwd);
  for (;;) {
    const value = map[currentDir];
    if (value === true || value === false) return value;
    // `null` (and absent) entries: keep walking upward.
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * Trust matrix for honoring project-scope (untrusted repo) little-coder
 * settings.
 * (1) The stored trust.json decision for this cwd comes FIRST (pi-exact
 *     precedence): `true` -> trusted, `false` -> not trusted (an explicit
 *     distrust beats "always"), `null`/absent -> fall through to (2).
 * (2) defaultProjectTrust "always" -> trusted; "never" / "ask" / any
 *     unknown string -> not trusted (fail-closed; little-coder has no
 *     prompt here — pi would prompt on "ask").
 * (3) Ancestor walk (see readTrustDecision): a trusted PARENT directory
 *     grants project trust to every repo under it.
 * (4) Any read/parse failure fails closed (the matrix falls to (2)).
 *
 * @param {string} cwd
 * @param {string | null | undefined} defaultProjectTrust
 * @returns {boolean}
 */
export function isProjectTrustedFailClosed(cwd, defaultProjectTrust) {
  try {
    const stored = readTrustDecision(getAgentDir(), cwd);
    if (stored === true) return true;
    if (stored === false) return false;
    return defaultProjectTrust === "always";
  } catch {
    return false;
  }
}
