// Type declarations for cache-path.mjs (the shared XDG-aware cache-path
// resolver). Sibling `.d.mts` next to the `.mjs`: under the repo's
// `moduleResolution: "bundler"`, a `./cache-path.mjs` import from TS resolves
// to this declaration (TS maps `.mjs` → `.d.mts`).
//
// The module itself is plain dependency-light ESM so the plain-.mjs launcher
// (bin/update-check.mjs) can import it natively and the jiti-loaded TS
// extensions (llama-cpp-provider) can import it with these types.

/**
 * An ABSOLUTE home directory: `$HOME` when set (and absolute), else the
 * platform default. A relative `$HOME` falls back (loud) to the passwd entry
 * (os.userInfo), then os.homedir(), then "/". `env` defaults to process.env.
 */
export function absoluteHome(env?: Record<string, string | undefined>): string;

/**
 * The XDG-aware cache base directory: `$XDG_CACHE_HOME` when set and absolute,
 * else `~/.cache`. A relative/empty override falls back (loud) to `~/.cache`.
 * `env` defaults to process.env.
 */
export function cacheBaseDir(env?: Record<string, string | undefined>): string;

/**
 * little-coder's cache dir: `<base>/little-coder`. `env` defaults to
 * process.env.
 */
export function littleCoderCacheDir(
  env?: Record<string, string | undefined>,
): string;
