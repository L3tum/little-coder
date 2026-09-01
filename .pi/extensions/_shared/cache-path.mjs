// Shared XDG-aware cache-path resolution. Uses ONLY env vars + os — never
// fileURLToPath or relative ".." hops, so it is safe from the M-arch-1
// "three levels up" relocation trap that affects little-coder-settings.mjs's
// pkgSettingsRoot().
//
// This is the single implementation of the "absolute home + XDG cache base"
// ladder that was copy-pasted (with the same comment) in bin/update-check.mjs
// and llama-cpp-provider/config.ts. Both now import it. The plain-.mjs
// launcher reads process.env by default; the jiti-loaded TS extensions pass
// an explicit env object for testability.
//
// Shipped as plain `.mjs` (types in the sibling `.d.mts`) so the plain-.mjs
// launcher can import it natively and the jiti-loaded TS extensions can
// import it with these types.

import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * An ABSOLUTE home directory: `$HOME` when set (and absolute), else the
 * platform default. NOTE: os.homedir() ECHOES $HOME when it is set, so a
 * broken (relative) $HOME makes homedir() relative too — in that case the
 * passwd entry (os.userInfo) is the last absolute fallback.
 *
 * `env` defaults to process.env; pass an explicit object to test without
 * mutating the real environment.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function absoluteHome(env = process.env) {
  const envHome = env.HOME && env.HOME.trim();
  if (envHome) {
    if (isAbsolute(envHome)) return envHome;
    console.error(
      `cache-path: HOME is relative ("${envHome}") — falling back to the platform home directory`,
    );
  }
  try {
    const h = userInfo().homedir;
    if (h && isAbsolute(h)) return h;
  } catch {
    /* no passwd entry — fall through to homedir() */
  }
  const platform = homedir();
  if (isAbsolute(platform)) return platform;
  return "/";
}

/**
 * The XDG-aware cache base directory: `$XDG_CACHE_HOME` when set and
 * absolute, else `~/.cache`. An empty/whitespace-only override falls back to
 * the platform default (plain `??` does not catch ""), and a non-empty
 * RELATIVE override falls back (loud) to `~/.cache` — the exact guard against
 * the historical repo-root ./cache dir bug.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function cacheBaseDir(env = process.env) {
  const xdgRaw = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim();
  if (xdgRaw) {
    if (isAbsolute(xdgRaw)) return xdgRaw;
    console.error(
      `cache-path: XDG_CACHE_HOME is relative ("${xdgRaw}") — falling back to ~/.cache`,
    );
  }
  return join(absoluteHome(env), ".cache");
}

/**
 * little-coder's cache dir: `<base>/little-coder` (created lazily by writers
 * via the atomic-write helpers). Both the version-check cache and the
 * llama-cpp ctx-window cache live here.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function littleCoderCacheDir(env = process.env) {
  return join(cacheBaseDir(env), "little-coder");
}
