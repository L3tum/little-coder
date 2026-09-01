import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadProviders,
  probeContextWindow,
  readCtxProbeCache,
  ctxProbeTimeoutMs,
  writeCtxProbeCache,
  resolveWarmCtxWindow,
} from "./config.ts";

// Data-driven provider registration. Reads:
//   1. <pkgRoot>/models.json                       (shipped default)
//   2. $LITTLE_CODER_MODELS_FILE (if set), else
//      $XDG_CONFIG_HOME/little-coder/models.json, else
//      $HOME/.config/little-coder/models.json     (user override; per-provider replace)
//   3. LLAMACPP_BASE_URL / OLLAMA_BASE_URL env    (per-provider baseUrl override)
//
// Issue #13: previously the model list was hardcoded here and models.json was
// only documentation, which made any user edit a no-op until they forked.

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..", "..", "..");

export default async function (pi: ExtensionAPI) {
  const result = loadProviders(pkgRoot);

  for (const src of result.sources) {
    if (src.status === "invalid") {
      console.error(`[llama-cpp-provider] ignoring ${src.path}: ${src.error}`);
    }
  }

  const providerCount = Object.keys(result.providers).length;
  if (providerCount === 0) {
    console.error(
      `[llama-cpp-provider] no providers loaded — checked: ${result.sources.map((s) => `${s.path} [${s.status}]`).join(", ")}`,
    );
    return;
  }

  // Opt-out for offline / CI / no-server launches that don't want a startup probe.
  const probeDisabled = process.env.LITTLE_CODER_NO_CTX_PROBE === "1";

  for (const [name, entry] of Object.entries(result.providers)) {
    let models = entry.models;

    // Auto-detect the server's live context window so the model registers with
    // the real n_ctx (e.g. a `-c 131072` server) instead of models.json's
    // declared default — the TUI readout, read-guard, and context budget all
    // follow the registered window. llama.cpp-only (the /props endpoint); any
    // failure silently keeps the declared window, so this never breaks startup.
    //
    // Startup-performance: the probe result is disk-cached (XDG-aware,
    // keyed by host) so a warm launch pays 0 ms BLOCKING. Bounded staleness
    // a FRESH cache (≤7 days, CTX_PROBE_CACHE_MAX_AGE_MS) registers the
    // cached window immediately and fires ONE background re-probe (never
    // awaited) — even with a fresh cache, so a server restarted with a
    // different `-c` self-corrects on the NEXT launch; this launch keeps the
    // cached window. An EXPIRED cache (>7 days) forces a re-probe ATTEMPT
    // before use: on success it registers the fresh window; on failure it
    // keeps the stale window, tracks consecutive failures in the cache, and
    // warns loudly at CTX_PROBE_FAIL_WARN_AT (a very-stale window that can't
    // be refreshed — the server is likely unreachable). Only a fully cold
    // launch also awaits the probe, with a 500 ms default timeout (was 1500).
    if (!probeDisabled && name === "llamacpp" && entry.models.length > 0) {
      // ONE deps object for BOTH paths: the warm background re-probe
      // used to get no timeoutMs override, so LITTLE_CODER_CTX_PROBE_TIMEOUT_MS
      // only reached the cold path. Invalid/0/empty → the 500 ms default.
      const probeDeps = {
        url: process.env.LITTLE_CODER_LLAMACPP_PROPS_URL || undefined,
        timeoutMs: ctxProbeTimeoutMs(
          process.env.LITTLE_CODER_CTX_PROBE_TIMEOUT_MS,
        ),
      };
      const cached = readCtxProbeCache(entry.baseUrl);
      if (cached) {
        // warm: bounded staleness. A fresh cache (≤7 days) is used as-is
        // with a background re-probe; an expired cache forces a re-probe
        // ATTEMPT before use, and on failure keeps the stale window while
        // tracking + loudly warning the consecutive failures.
        const decision = await resolveWarmCtxWindow({
          baseUrl: entry.baseUrl,
          cached,
          now: Date.now(),
          probe: () => probeContextWindow(entry.baseUrl, probeDeps),
        });
        models = entry.models.map((m) => ({
          ...m,
          contextWindow: decision.contextWindow,
        }));
        if (decision.warn) console.error(decision.warn);
        writeCtxProbeCache(entry.baseUrl, decision.contextWindow, {
          probedAt: decision.probedAt,
          probeFailCount: decision.probeFailCount,
        });
        if (decision.mode === "fresh") {
          // Unconditional background re-probe (never awaited — zero blocking
          // cost): refreshes the cache for the next launch, including the
          // case where the server restarted with a different -c since the
          // last probe.
          void probeContextWindow(entry.baseUrl, probeDeps)
            .then((w) => {
              if (w)
                writeCtxProbeCache(entry.baseUrl, w, { probeFailCount: 0 });
            })
            .catch(() => {
              // background re-probe is best-effort; keep the cached value
            });
        }
      } else {
        const probed = await probeContextWindow(entry.baseUrl, probeDeps);
        if (probed) {
          models = entry.models.map((m) => ({ ...m, contextWindow: probed }));
          writeCtxProbeCache(entry.baseUrl, probed, { probeFailCount: 0 });
        }
      }
    }

    pi.registerProvider(name, {
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      api: entry.api,
      models,
    });
  }
}
