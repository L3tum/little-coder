// Shared reader for the `little_coder` namespace in pi's settings files, with
// correct per-repo / per-user / package-default precedence.
//
// Background: benchmark-profiles' original `loadSettings()` read the
// package-root `.pi/settings.json` first, then `~/.pi/agent/settings.json`,
// first whole-file match wins. Because the shipped package file always
// contains a `little_coder` block, that meant:
//   1. the user's actual repo (<cwd>/.pi/settings.json) was never read —
//      "per-repo profiles" did not exist;
//   2. the global file's little_coder block was never read either —
//      per-user profiles were silently dead.
//
// This module fixes both: it reads all three scopes and merges per top-level
// key, project → global → pkg-shipped, first scope that HAS the key wins
// (no deep merge — matching the repo's "deliberately avoid deep merging"
// stance in llama-cpp-provider's mergeProviders).
//
// Malformed/missing files never throw — that scope simply contributes
// nothing (mirrors loadConfig in permission-gate and pi-vcc's readJson).
//
// The resolver is unmemoized: every call re-reads the three small files, so
// settings edits apply mid-session on the next turn/operation (behavior
// improvement — this also dissolves the per-extension stale-memo trap:
// each importer's jiti instance no longer caches).
//
// This dir intentionally has no `index.ts`, so the launcher's extension
// auto-discovery skips it — it is a library imported by the real extensions.
// No pi runtime imports here: unit-testable and cheap under jiti.
//
// Shipped as plain `.mjs` (types in the sibling `.d.mts`) so the plain-.mjs
// launcher can import it natively, exactly like settings-write.mjs.
//
// NOTE: this module is read-only in its reader functions, but it ALSO exports
// one writer — `updateGlobalSettings` (see the "writing the GLOBAL settings
// file" section below) — which persists per-repo bash allowlists into the
// user's global settings.json via the shared settings-write.mjs protocol.
//
// LOCATION WARNING: _shared/ must stay under .pi/extensions/ so jiti-loaded
// TS extensions can import it. Relocating it (e.g. to a top-level shared/)
// would first require making pkgSettingsRoot() (below, the "three levels up"
// hop) env/manifest-driven and updating every bin/ import edge.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { updateSettingsFile } from "./settings-write.mjs";

/**
 * pi's agent dir: $PI_CODING_AGENT_DIR (with `~` / `~/x` expansion, same
 * convention as bin/little-coder.mjs step 8) or ~/.pi/agent.
 * @returns {string}
 */
export function getAgentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env && env.trim().length > 0) {
    if (env === "~") return homedir();
    if (env.startsWith("~/")) return homedir() + env.slice(1);
    return resolve(env);
  }
  return join(homedir(), ".pi", "agent");
}

/**
 * The little-coder package root (shipped .pi/settings.json lives here).
 * _shared/ is <pkgRoot>/.pi/extensions/_shared, so three levels up.
 * LITTLE_CODER_PKG_ROOT overrides for tests.
 * @returns {string}
 */
export function pkgSettingsRoot() {
  const override = process.env.LITTLE_CODER_PKG_ROOT;
  if (override && override.trim().length > 0) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..");
}

/**
 * Read one settings file. Returns null when the file is missing, malformed,
 * or has no usable `little_coder` object — never throws.
 * @param {string} path
 * @returns {{namespace: unknown, defaultProjectTrust: string | null} | null}
 */
export function readLittleCoderScope(path) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ns = raw.little_coder;
  const namespace =
    ns && typeof ns === "object" && !Array.isArray(ns) ? ns : null;
  const dpt = raw.defaultProjectTrust;
  return {
    namespace,
    defaultProjectTrust: typeof dpt === "string" && dpt.length > 0 ? dpt : null,
  };
}

/**
 * Per-key merge: for each top-level key of `little_coder`, the first scope
 * (project → global → pkg) that HAS the key wins. No deep merge.
 * @param {unknown} project
 * @param {unknown} global
 * @param {unknown} pkg
 * @returns {Record<string, unknown>}
 */
export function mergeNamespaces(project, global, pkg) {
  const scopes = [project, global, pkg].filter((s) => s !== null);
  const merged = {};
  const keys = new Set();
  for (const scope of scopes) for (const k of Object.keys(scope)) keys.add(k);
  for (const key of keys) {
    for (const scope of scopes) {
      if (key in scope) {
        merged[key] = scope[key];
        break;
      }
    }
  }
  return merged;
}

/**
 * Resolve the `little_coder` namespace with project → global → pkg precedence.
 * `cwd` defaults to process.cwd(). Unmemoized — every call re-reads the three
 * files, so settings edits apply mid-session on the next turn/operation.
 * @param {string} [cwd]
 * @returns {{merged: Record<string, unknown>, project: Record<string, unknown> | null, global: Record<string, unknown> | null, pkg: Record<string, unknown> | null, defaultProjectTrust: string | null}}
 */
export function resolveLittleCoderSettings(cwd) {
  const effectiveCwd = cwd ?? process.cwd();
  const project =
    readLittleCoderScope(join(effectiveCwd, ".pi", "settings.json"))
      ?.namespace ?? null;
  const globalRead = readLittleCoderScope(join(getAgentDir(), "settings.json"));
  const pkg =
    readLittleCoderScope(join(pkgSettingsRoot(), ".pi", "settings.json"))
      ?.namespace ?? null;

  return {
    merged: mergeNamespaces(project, globalRead?.namespace ?? null, pkg),
    project,
    global: globalRead?.namespace ?? null,
    pkg,
    defaultProjectTrust: globalRead?.defaultProjectTrust ?? null,
  };
}

/**
 * Resolve a single `little_coder` key with trust-gated precedence.
 *
 * `trusted` (project trust): when true, the project (per-repo) scope wins if
 * it HAS the key; when false, the project scope is ignored entirely and the
 * global → pkg-shipped fallback applies (an untrusted repo can never supply
 * its own value for a security-relevant key). This is the single
 * implementation of the trust-gated per-key precedence that the consumers
 * (token-limit-guard, benchmark-profiles) previously re-derived by hand.
 *
 * For `trusted === true` this is exactly `resolved.merged[key]`; for
 * `trusted === false` it is `mergeNamespaces(null, global, pkg)[key]`.
 *
 * @param {{project: Record<string, unknown> | null, global: Record<string, unknown> | null, pkg: Record<string, unknown> | null}} resolved
 *   The object returned by resolveLittleCoderSettings (or any object with
 *   project/global/pkg scopes).
 * @param {string} key
 * @param {boolean} trusted
 * @returns {unknown} undefined when no in-scope scope has the key.
 */export function resolveKey(resolved, key, trusted) {
  if (trusted) {
    const v = resolved.project ? resolved.project[key] : undefined;
    if (v !== undefined) return v;
  }
  const g = resolved.global ? resolved.global[key] : undefined;
  if (g !== undefined) return g;
  return resolved.pkg ? resolved.pkg[key] : undefined;
}

// ── writing the GLOBAL settings file ────────────────────────────────────────
// The read path above is deliberately side-effect free. This is the one place
// that writes, used by permission-gate's /allow and /deny commands to persist
// per-repo bash allowlists into the user's own settings file.
//
// The actual lock + atomic-write protocol lives in the shared writer
// (settings-write.mjs — the ONE implementation, also delegated to by the
// plain-.mjs launcher's writeGlobalSettingsJson). This module is a thin
// ASYNC delegate: it resolves the agent dir and keeps the {ok, path,
// error?} shape.

/** @param {unknown} err @returns {string} */
function settingsErrMsg(err) {
  return err instanceof Error ? err.message : String(err);
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
 * settings-write.mjs for the protocol: async 10 × ~20 ms ELOCKED retry,
 * O_EXCL 0o600 temp, rename), so two little-coder processes writing at
 * once cannot clobber each other.
 *
 * Fail-safe: if the file exists but is malformed JSON (or not a plain
 * object) the write is REFUSED and an error is returned — a corrupt settings
 * file is never clobbered.
 *
 * Async (the ELOCKED retry loop must not busy-wait the event loop).
 * Never throws: every failure (lock exhaustion, read/parse refusal, write
 * error) is returned as `{ ok: false, error }`.
 *
 * @param {(doc: Record<string, unknown>) => void} mutate
 * @returns {Promise<{ok: boolean, path: string, error?: string}>}
 */
export async function updateGlobalSettings(mutate) {
  const path = join(getAgentDir(), "settings.json");
  try {
    const result = await updateSettingsFile(path, mutate);
    if (result.ok) return { ok: true, path };
    return { ok: false, path, error: result.error };
  } catch (err) {
    return { ok: false, path, error: settingsErrMsg(err) };
  }
}
