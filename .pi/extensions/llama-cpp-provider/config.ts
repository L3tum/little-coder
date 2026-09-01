// Pure config-loading logic for the providers extension. Kept separate from
// the pi wiring in index.ts so it can be unit-tested without a pi runtime.
//
// Schema (all required unless noted):
//   {
//     "providers": {
//       "<name>": {
//         "api": "openai-completions",
//         "baseUrl": "http://...",
//         "apiKey": "ENV_VAR_NAME",
//         "models": [ { id, name, reasoning, input, contextWindow, maxTokens, cost }, ... ]
//       }, ...
//     }
//   }

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../_shared/settings-write.mjs";
import { littleCoderCacheDir } from "../_shared/cache-path.mjs";

export interface ProviderModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface ProviderEntry {
  api: string;
  baseUrl: string;
  apiKey: string;
  models: ProviderModelEntry[];
}

export interface ModelsFile {
  providers: Record<string, ProviderEntry>;
}

export interface LoadResult {
  providers: Record<string, ProviderEntry>;
  /** Files that were attempted, in resolution order. Useful for diagnostics. */
  sources: {
    path: string;
    status: "ok" | "missing" | "invalid";
    error?: string;
  }[];
}

/** Provider env knob: if set, overrides the provider's baseUrl. Originally a
 *  back-compat shim for the two providers we shipped before the data-driven
 *  refactor; kept as the per-provider env-override pattern for any provider
 *  whose baseUrl changes between deployments. */
const LEGACY_BASE_URL_ENV: Record<string, string> = {
  llamacpp: "LLAMACPP_BASE_URL",
  ollama: "OLLAMA_BASE_URL",
  lmstudio: "LMSTUDIO_BASE_URL",
};

/** Resolution order for the user-override file. First existing path wins. */
export function resolveOverridePath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.LITTLE_CODER_MODELS_FILE) return env.LITTLE_CODER_MODELS_FILE;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "little-coder", "models.json");
  if (env.HOME) return join(env.HOME, ".config", "little-coder", "models.json");
  return undefined;
}

function parseModelsFile(raw: string): ModelsFile {
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.providers ||
    typeof parsed.providers !== "object"
  ) {
    throw new Error("expected top-level { providers: { ... } }");
  }
  return parsed as ModelsFile;
}

function readIfPresent(
  path: string,
):
  | { kind: "ok"; data: ModelsFile }
  | { kind: "missing" }
  | { kind: "invalid"; error: string } {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    const raw = readFileSync(path, "utf-8");
    return { kind: "ok", data: parseModelsFile(raw) };
  } catch (err) {
    return {
      kind: "invalid",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function applyEnvOverrides(
  providers: Record<string, ProviderEntry>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ProviderEntry> {
  const out: Record<string, ProviderEntry> = {};
  for (const [name, entry] of Object.entries(providers)) {
    const envVar = LEGACY_BASE_URL_ENV[name];
    if (envVar && env[envVar]) {
      out[name] = { ...entry, baseUrl: env[envVar]! };
    } else {
      out[name] = entry;
    }
  }
  return out;
}

/**
 * Merge: user file's providers fully replace package providers with the same
 * key. Providers only in the user file are added. Providers only in the
 * package default are kept. (We deliberately avoid deep per-model merging —
 * the user redeclares the whole provider entry if they want to change it,
 * which is far less surprising than "your override silently inherited fields
 * from a future package release.")
 */
export function mergeProviders(
  pkgDefault: Record<string, ProviderEntry>,
  userOverride: Record<string, ProviderEntry> | undefined,
): Record<string, ProviderEntry> {
  if (!userOverride) return { ...pkgDefault };
  return { ...pkgDefault, ...userOverride };
}

/**
 * Load the package default models.json + (optionally) the user override file,
 * apply env-var baseUrl overrides for the legacy providers, and return the
 * merged provider map plus diagnostics for each source.
 */
export function loadProviders(
  pkgRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadResult {
  const sources: LoadResult["sources"] = [];
  const defaultPath = join(pkgRoot, "models.json");
  const defaultRead = readIfPresent(defaultPath);
  let pkgDefault: Record<string, ProviderEntry> = {};
  if (defaultRead.kind === "ok") {
    pkgDefault = defaultRead.data.providers;
    sources.push({ path: defaultPath, status: "ok" });
  } else if (defaultRead.kind === "missing") {
    sources.push({ path: defaultPath, status: "missing" });
  } else {
    sources.push({
      path: defaultPath,
      status: "invalid",
      error: defaultRead.error,
    });
  }

  const overridePath = resolveOverridePath(env);
  let userOverride: Record<string, ProviderEntry> | undefined;
  if (overridePath) {
    const userRead = readIfPresent(overridePath);
    if (userRead.kind === "ok") {
      userOverride = userRead.data.providers;
      sources.push({ path: overridePath, status: "ok" });
    } else if (userRead.kind === "missing") {
      sources.push({ path: overridePath, status: "missing" });
    } else {
      sources.push({
        path: overridePath,
        status: "invalid",
        error: userRead.error,
      });
    }
  }

  const merged = mergeProviders(pkgDefault, userOverride);
  const withEnv = applyEnvOverrides(merged, env);
  return { providers: withEnv, sources };
}

// ── live context-window detection (llama.cpp /props) ────────────────────────
// little-coder budgets against the model's registered contextWindow. Rather than
// trust the static value in models.json, we ask a running llama.cpp server for
// its actual n_ctx at startup, so a `-c 131072` server shows 128k instead of the
// declared default. Best-effort: any failure falls back to the declared window.

/** Derive the llama.cpp `/props` URL from an OpenAI-style baseUrl. llama-server
 *  serves /props at the server ROOT, not under /v1 (which 404s), so strip a
 *  trailing /v1 (and any trailing slash) before appending /props. */
export function propsUrlFor(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/props`;
}

/** Pull the context window (n_ctx) out of a llama.cpp /props response. It lives
 *  at default_generation_settings.n_ctx (the per-slot window — exactly what one
 *  conversation can use); some builds also expose a top-level n_ctx. Returns
 *  undefined when absent or not a positive number. */
export function contextWindowFromProps(json: unknown): number | undefined {
  const j = json as {
    default_generation_settings?: { n_ctx?: unknown };
    n_ctx?: unknown;
  } | null;
  const n = Number(j?.default_generation_settings?.n_ctx ?? j?.n_ctx);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

/** Ask a llama.cpp server for its live context window via /props. Returns
 *  undefined on ANY failure (server down, no /props, non-JSON, timeout) so the
 *  caller falls back to the declared window — never throws, never blocks beyond
 *  timeoutMs. */
export async function probeContextWindow(
  baseUrl: string,
  deps: ProbeDeps = {},
): Promise<number | undefined> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = deps.url ?? propsUrlFor(baseUrl);
  // 500 ms default (was 1500): a local/LAN llama.cpp server answers in tens
  // of ms; the remaining budget only serves to stall startup when the server
  // is down. LITTLE_CODER_CTX_PROBE_TIMEOUT_MS still overrides via ProbeDeps.
  const timeoutMs = deps.timeoutMs ?? 500;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    return contextWindowFromProps(await res.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ── /props cache: keep the probed window across launches ─────────────────────
// A live server's n_ctx is stable across launches (it changes only when the
// user restarts the server with a different -c). Caching the probe result
// removes the fetch from the launch critical path on warm launches; a
// background re-probe refreshes the cache for the NEXT launch (a stale
// cache value only affects the displayed/budgeted window, never correctness).
//
// There is NO TTL/expiry: a warm launch uses whatever is cached (fresh or
// stale) immediately and the never-awaited background re-probe refreshes it
// for the next launch. Expiry would only re-introduce a blocking probe on
// the launch path, which the cache exists to remove.

// Bounded staleness: a cached window older than this triggers a
// re-probe ATTEMPT before use on the warm path (the stale value is kept only
// if the re-probe fails). Consecutive re-probe failures are counted in the
// cache; at this threshold we warn loudly (the registered window is very
// stale and cannot be refreshed — the server is likely unreachable).
export const CTX_PROBE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const CTX_PROBE_FAIL_WARN_AT = 3;

interface CtxProbeCacheFile {
  contextWindow: number;
  probedAt: number;
  baseUrl: string;
  /** consecutive re-probe failures for a stale cache (0/absent = none). */
  probeFailCount?: number;
}

/** Sanitize a URL host (e.g. "localhost:8080") into a safe file-name key. */
export function ctxProbeHostKey(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host.replace(/[^a-z0-9.:-]/gi, "_");
  } catch {
    return null;
  }
}

/** XDG-aware cache path: $XDG_CACHE_HOME/little-coder/ctx-window-<host>.json,
 *  else ~/.cache/little-coder/... (same convention as the version-check
 *  cache). null when the baseUrl has no parseable host (callers no-op). */
export function ctxProbeCachePath(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const host = ctxProbeHostKey(baseUrl);
  if (!host) return null;
  // The absolute-home + XDG-cache-base ladder lives in the shared
  // cache-path.mjs (previously duplicated verbatim in bin/update-check.mjs).
  // A relative/empty HOME or XDG_CACHE_HOME override falls back (loud) to the
  // platform defaults instead of writing ./cache under the process cwd.
  return join(littleCoderCacheDir(env), `ctx-window-${host}.json`);
}

/** Read the disk-cached context window (NO TTL gate — a warm launch uses any
 *  cached value immediately; a background re-probe on each launch refreshes
 *  the cache for the next launch). Parse + validate the cache file for a
 *  baseUrl; null on any failure: missing file, malformed JSON, non-positive
 *  number, missing probedAt, bad path, or a stored baseUrl that does not
 *  match (the host key alone can collide between different paths on the same
 *  host). */
export function readCtxProbeCache(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): {
    contextWindow: number;
    probedAt: number;
    probeFailCount: number;
  } | null {
  const path = ctxProbeCachePath(baseUrl, env);
  if (!path || !existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as CtxProbeCacheFile;
    if (
      typeof data?.contextWindow !== "number" ||
      !Number.isFinite(data.contextWindow) ||
      data.contextWindow <= 0 ||
      typeof data?.probedAt !== "number" ||
      typeof data?.baseUrl !== "string" ||
      data.baseUrl !== baseUrl
    ) {
      return null;
    }
    return {
      contextWindow: data.contextWindow,
      probedAt: data.probedAt,
      probeFailCount:
        typeof data?.probeFailCount === "number" &&
        Number.isFinite(data.probeFailCount) &&
        data.probeFailCount >= 0
          ? Math.floor(data.probeFailCount)
          : 0,
    };
  } catch {
    return null;
  }
}

/** Decision for the warm (cached) ctx-probe path. Pure + injectable so
 *  it is unit-testable without a live server:
 *  - fresh (age <= maxAgeMs): return the cached window as-is, mode "fresh"
 *    (the caller fires a background re-probe to self-correct next launch);
 *  - stale (age > maxAgeMs): await the injected re-probe; on success return
 *    the fresh window (failCount reset, mode "reprobed"), on failure return
 *    the stale window with failCount+1 (original probedAt preserved so the
 *    cache stays stale) and a loud warning once failCount reaches warnAt.
 * @returns the window to register + the cache fields to persist + an optional
 *   warning message.
 */
export interface CtxProbeWarmDecision {
  contextWindow: number;
  probedAt: number;
  probeFailCount: number;
  warn: string | null;
  /** "fresh" = caller should fire a background re-probe; "reprobed" = the
   *  re-probe was already awaited (no background re-probe needed). */
  mode: "fresh" | "reprobed";
}

export async function resolveWarmCtxWindow(opts: {
  baseUrl: string;
  cached: { contextWindow: number; probedAt: number; probeFailCount: number };
  now: number;
  /** Injected re-probe (returns the window, or null/undefined on failure). */
  probe: () => Promise<number | null | undefined>;
  maxAgeMs?: number;
  warnAt?: number;
}): Promise<CtxProbeWarmDecision> {
  const {
    baseUrl,
    cached,
    now,
    probe,
    maxAgeMs = CTX_PROBE_CACHE_MAX_AGE_MS,
    warnAt = CTX_PROBE_FAIL_WARN_AT,
  } = opts;
  const age = now - cached.probedAt;
  if (age <= maxAgeMs) {
    return {
      contextWindow: cached.contextWindow,
      probedAt: cached.probedAt,
      probeFailCount: cached.probeFailCount,
      warn: null,
      mode: "fresh",
    };
  }
  const fresh = await probe();
  if (typeof fresh === "number" && Number.isFinite(fresh) && fresh > 0) {
    return {
      contextWindow: fresh,
      probedAt: now,
      probeFailCount: 0,
      warn: null,
      mode: "reprobed",
    };
  }
  const failCount = cached.probeFailCount + 1;
  const days = Math.max(1, Math.round(age / 86400000));
  const warn =
    failCount >= warnAt
      ? `llama-cpp ctx-probe: cached context window for ${baseUrl} is ~${days}d old and the re-probe has failed ${failCount}x in a row — the registered window may be stale. Is the server reachable? Set LITTLE_CODER_NO_CTX_PROBE=1 to disable probing.`
      : null;
  return {
    contextWindow: cached.contextWindow,
    probedAt: cached.probedAt,
    probeFailCount: failCount,
    warn,
    mode: "reprobed",
  };
}

/** Parse the LITTLE_CODER_CTX_PROBE_TIMEOUT_MS env override for the
 *  /props probe. Empty/invalid/0 or negative → undefined, which
 *  probeContextWindow maps to its 500 ms default (deps.timeoutMs ?? 500).
 *  Exported for unit-testing without env mutation. */
export function ctxProbeTimeoutMs(
  envValue: string | undefined,
): number | undefined {
  if (envValue === undefined || envValue.trim() === "") return undefined;
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Write the probed window to the cache. No-op on any failure (read-only
 *  HOME, bad path, serialization error) — caching is best-effort. The write
 *  is ATOMIC (shared settings-write.mjs: 0600 temp + rename), so a reader
 *  never sees a torn cache file. */
export function writeCtxProbeCache(
  baseUrl: string,
  contextWindow: number,
  opts: {
    probedAt?: number;
    env?: NodeJS.ProcessEnv;
    probeFailCount?: number;
  } = {},
): void {
  const { probedAt = Date.now(), env = process.env, probeFailCount = 0 } = opts;
  const path = ctxProbeCachePath(baseUrl, env);
  if (!path) return;
  try {
    const data: CtxProbeCacheFile = {
      contextWindow,
      probedAt,
      baseUrl,
      probeFailCount,
    };
    atomicWriteJson(path, data);
  } catch {
    // best-effort; the next launch simply re-probes
  }
}
