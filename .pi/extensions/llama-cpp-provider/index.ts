import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadProviders, probeContextWindow } from "./config.ts";

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
    if (!probeDisabled && name === "llamacpp" && entry.models.length > 0) {
      const probed = await probeContextWindow(entry.baseUrl, {
        url: process.env.LITTLE_CODER_LLAMACPP_PROPS_URL || undefined,
        timeoutMs: Number(process.env.LITTLE_CODER_CTX_PROBE_TIMEOUT_MS) || undefined,
      });
      if (probed) {
        models = entry.models.map((m) => ({ ...m, contextWindow: probed }));
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
