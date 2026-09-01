import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { LittleCoderOptions } from "../_shared/little-coder-options.ts";
import {
  getAgentDir,
  mergeNamespaces,
  pkgSettingsRoot,
  resolveLittleCoderSettings,
} from "../_shared/little-coder-settings.mjs";
import { isProjectTrustedFailClosed } from "../_shared/project-trust.mjs";
import { fileFreshnessKey } from "../_shared/freshness.mjs";

// Port of local/config.py::MODEL_PROFILES + get_model_profile with
// benchmark_overrides. Reads the `little_coder.model_profiles` block from pi's
// settings files via the shared little-coder-settings helper (per-key
// precedence: <cwd>/.pi/settings.json → <agentDir>/settings.json → shipped
// .pi/settings.json), applies the matching per-model profile (plus
// benchmark_overrides when LITTLE_CODER_BENCHMARK=terminal_bench|gaia is set),
// and publishes the resolved values on event.systemPromptOptions.littleCoder
// so the other extensions (skill-inject, knowledge-inject, thinking-budget,
// turn-cap) read them from a single source of truth.
//
// Context budget: `contextLimit` is NOT a hardcoded settings value — it
// follows the model's live registered window (ctx.model.contextWindow, the
// same window pi shows and read-guard/getContextUsage use), so bumping a
// model's contextWindow in models.json propagates everywhere. An explicit
// per-profile/benchmark `context_limit` (e.g. gaia) still wins, and
// CONTEXT_FALLBACK (32768) is the last resort when no window is known.

interface ModelProfile {
  context_limit?: number;
  max_tokens?: number;
  thinking_budget?: number;
  skill_token_budget?: number;
  knowledge_token_budget?: number;
  system_prompt_budget?: number;
  max_retries?: number;
  temperature?: number;
  max_turns?: number;
  prefer_text_tools?: boolean;
  benchmark_overrides?: Record<string, Partial<ModelProfile>>;
}

interface LittleCoderSettings {
  default_model_profile?: ModelProfile;
  model_profiles?: Record<string, ModelProfile>;
}

// Normalize the separator between model-name segments so a profile key written
// with hyphens (`llamacpp/qwen3.6-35b-a3b`) matches a runtime model id that uses
// a colon (`llamacpp/qwen3.6:35b-a3b`) and vice-versa. Without this the prefix
// match silently fails and EVERY model falls back to default_model_profile —
// per-model thinking_budget / context_limit / temperature are skipped (the
// quirk surfaced in issue #8's reproduction). Dots (`qwen3.6`) are preserved.
export function normKey(s: string): string {
  return s.replace(/:/g, "-");
}

// Pure resolver, exported for testing. Exact match → separator-insensitive
// prefix match → default_model_profile, then benchmark_overrides if `bench` set.
export function resolveProfileFrom(
  s: LittleCoderSettings | null,
  providerSlashModel: string,
  bench?: string,
): ModelProfile {
  if (!s) return {};
  const profiles = s.model_profiles ?? {};
  const target = normKey(providerSlashModel);

  let base: ModelProfile | undefined = profiles[providerSlashModel];
  if (!base) {
    for (const [pattern, p] of Object.entries(profiles)) {
      if (target === normKey(pattern) || target.startsWith(normKey(pattern))) {
        base = p;
        break;
      }
    }
  }
  if (!base) base = s.default_model_profile ?? {};

  const { benchmark_overrides, ...basePlain } = { ...base };
  if (bench && benchmark_overrides && benchmark_overrides[bench]) {
    return { ...basePlain, ...benchmark_overrides[bench] };
  }
  return basePlain;
}

// Last-resort context window when neither an explicit profile override nor the
// model's registered window is available (also the shipped models.json default).
export const CONTEXT_FALLBACK = 32768;

// little-coder's context budget follows the model's live registered window.
// Precedence: an explicit profile/benchmark context_limit (e.g. gaia) wins, then
// the model's registered contextWindow (provider-defined, user-overridable in
// models.json), then CONTEXT_FALLBACK. A non-positive / non-finite window is
// treated as "unknown" and falls through.
export function resolveContextLimit(
  profileContextLimit?: number,
  modelWindow?: number,
): number {
  if (typeof profileContextLimit === "number" && profileContextLimit > 0) {
    return profileContextLimit;
  }
  if (
    typeof modelWindow === "number" &&
    Number.isFinite(modelWindow) &&
    modelWindow > 0
  ) {
    return modelWindow;
  }
  return CONTEXT_FALLBACK;
}

// Resolve via the shared settings helper (per-key project → global → pkg
// precedence). `cwd` comes from the session (the repo the user is actually
// working in), not from this package's install dir.
//
// Project-scope model_profiles / default_model_profile are honored ONLY when
// the project is trusted (same fail-closed matrix as the project-scope
// bash_allow gate) — an untrusted repo's .pi/settings.json must not be able
// to configure its session's model knobs (temperature, max_tokens, …).
// Global (user) and package-shipped scopes are never gated.
function resolveProfile(
  providerSlashModel: string,
  cwd?: string,
): ModelProfile {
  const effectiveCwd = cwd ?? process.cwd();
  const r = resolveLittleCoderSettings(effectiveCwd);
  let s = r.merged as LittleCoderSettings;
  if (
    (r.project?.model_profiles !== undefined ||
      r.project?.default_model_profile !== undefined) &&
    !isProjectTrustedFailClosed(effectiveCwd, r.defaultProjectTrust)
  ) {
    // Drop the project scope entirely: fall back to global → pkg.
    s = mergeNamespaces(null, r.global, r.pkg) as LittleCoderSettings;
  }
  return resolveProfileFrom(
    s,
    providerSlashModel,
    process.env.LITTLE_CODER_BENCHMARK,
  );
}

// Per-benchmark tools that should always have skill cards present on turn 1,
// even before the agent has used them. Without this, skill-inject relies on
// recency / error-recovery / intent-matching, none of which fire on the
// opening turn — and the wrong skills (Edit/Write) can win the budget on a
// pure research question.
const BENCHMARK_REQUIRED_TOOLS: Record<string, string[]> = {
  gaia: ["enableBrowserTools", "EvidenceAdd"],
};

// Sentinel cap for `max_tokens: 0` ("no output limit"). The payload always
// carries a clamped max_tokens >= 1 (pi-ai's clampMaxTokensToContext floors at
// MIN_MAX_TOKENS = 1), so "no limit" cannot be expressed by omitting the
// value — it must be overridden post-clamp. LOCAL openai-completions servers
// (llama.cpp/ollama/lmstudio, the shipped providers) clamp an oversized
// max_tokens to the remaining context, so a huge-but-finite value is safe —
// on a REMOTE provider the sentinel is never sent (max_tokens: 0 there means
// "omit the cap, catalog default applies"). See isLocalProvider below.
export const NO_OUTPUT_LIMIT_SENTINEL = 2147483647;

// Local openai-completions provider ids (the shipped providers). A static
// set: a user-override models.json can register additional local servers
// outside this set — for those, max_tokens: 0 degrades to "no cap injected"
// (the catalog default), which is safe (no oversized request).
export const LOCAL_OPENAI_COMPLETION_PROVIDERS = new Set([
  "llamacpp",
  "ollama",
  "lmstudio",
]);

export function isLocalProvider(providerId?: string): boolean {
  return (
    typeof providerId === "string" &&
    LOCAL_OPENAI_COMPLETION_PROVIDERS.has(providerId)
  );
}

// Pure, exported for testing. Maps a profile's max_tokens to the value to put
// on the outgoing provider payload:
//   > 0  -> min(profileValue, modelWindow) when the window is known/positive,
//           otherwise the profile value;
//   === 0 -> NO_OUTPUT_LIMIT_SENTINEL when `isLocal` (server-side clamp to
//           remaining context); undefined otherwise (remote providers
//           reject/mis-behave on the sentinel — omit the cap instead);
//   invalid (non-number / non-finite / negative) -> undefined — the caller
//   omits the cap fields entirely.
export function maxTokensCapForRequest(
  profileValue: number,
  modelWindow?: number,
  isLocal = true,
): number | undefined {
  if (
    typeof profileValue !== "number" ||
    !Number.isFinite(profileValue) ||
    profileValue < 0
  ) {
    return undefined;
  }
  if (profileValue === 0) return isLocal ? NO_OUTPUT_LIMIT_SENTINEL : undefined;
  if (
    typeof modelWindow === "number" &&
    Number.isFinite(modelWindow) &&
    modelWindow > 0
  ) {
    return Math.min(profileValue, modelWindow);
  }
  return profileValue;
}

function toLittleCoderOptions(p: ModelProfile): Record<string, unknown> {
  const benchmark = process.env.LITTLE_CODER_BENCHMARK;
  const out: Record<string, unknown> = {
    contextLimit: p.context_limit,
    maxTokens: p.max_tokens,
    thinkingBudget: p.thinking_budget,
    skillTokenBudget: p.skill_token_budget,
    knowledgeTokenBudget: p.knowledge_token_budget,
    systemPromptBudget: p.system_prompt_budget,
    maxRetries: p.max_retries,
    temperature: p.temperature,
    maxTurns: p.max_turns,
    preferTextTools: p.prefer_text_tools,
    benchmark,
  };
  if (benchmark && BENCHMARK_REQUIRED_TOOLS[benchmark]) {
    out.requiredTools = BENCHMARK_REQUIRED_TOOLS[benchmark];
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  // Shared across handlers so before_provider_request can re-read the most
  // recently resolved temperature without re-parsing settings every turn.
  let resolvedTemperature: number | undefined;
  let resolvedMaxTokens: number | undefined;
  let resolvedProvider: string | undefined;
  let modelContextWindow: number | undefined;

  // E1: resolveProfile is MODULE-level, so the memo lives in the FACTORY
  // CLOSURE — its lifecycle is the session, and it clears per session
  // automatically (a new factory invocation gets a fresh closure). The
  // key MUST include the settings files' freshness (mtime+size) AND the
  // trust.json freshness — a plain model+cwd memo would serve stale settings
  // and regress the deliberately-unmemoized resolver's mid-session-edit
  // behavior. trust.json is in the key because resolveProfile's trust gate
  // (isProjectTrustedFailClosed) reads it: a mid-session /trust decision must
  // re-resolve the project-scope drop, not serve the cached decision. (The
  // LITTLE_CODER_BENCHMARK env var is a launch-time constant, so it is not
  // in the key.)
  let profileMemo: {
    key: string;
    value: ReturnType<typeof resolveProfile>;
  } | null = null;
  function resolveProfileCached(
    providerSlashModel: string,
    cwd: string,
  ): ReturnType<typeof resolveProfile> {
    const key =
      `${providerSlashModel}|${cwd}|` +
      `${fileFreshnessKey(join(cwd, ".pi", "settings.json"))}|` +
      `${fileFreshnessKey(join(getAgentDir(), "settings.json"))}|` +
      `${fileFreshnessKey(join(pkgSettingsRoot(), ".pi", "settings.json"))}|` +
      `${fileFreshnessKey(join(getAgentDir(), "trust.json"))}`;
    if (profileMemo && profileMemo.key === key) return profileMemo.value;
    const value = resolveProfile(providerSlashModel, cwd);
    return (profileMemo = { key, value }).value;
  }

  // NOTE: there is deliberately no session_start handler here — the memo
  // above is per-session (factory closure), and its key tracks the settings
  // files' + trust.json freshness, so mid-session settings/trust edits
  // invalidate it on the next turn (the resolver re-reads fresh when the key
  // changes).

  pi.on("before_agent_start", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const key = `${model.provider}/${model.id}`;
    const cwd = ctx.sessionManager?.getCwd?.() ?? process.cwd();
    const profile = resolveProfileCached(key, cwd);

    const eventAny = event as unknown as {
      systemPromptOptions?: Record<string, any>;
    };
    const opts = eventAny.systemPromptOptions ?? {};
    const resolved = toLittleCoderOptions(profile) as LittleCoderOptions;

    // Merge; existing (set by other extensions earlier) wins over defaults
    // from this profile, but undefined existing values fall back.
    opts.littleCoder = { ...resolved, ...(opts.littleCoder ?? {}) };
    // Re-copy so undefined existing values don't overwrite resolved values
    for (const [k, v] of Object.entries(resolved)) {
      if (opts.littleCoder[k] === undefined) opts.littleCoder[k] = v;
    }

    // Context budget follows the model's live registered window (the same
    // window pi displays and read-guard reads), not a hardcoded settings value.
    // An explicit profile/benchmark context_limit still wins; 32k is the floor.
    const modelWindow = Number((model as any)?.contextWindow);
    opts.littleCoder.contextLimit = resolveContextLimit(
      profile.context_limit,
      modelWindow,
    );

    resolvedTemperature = opts.littleCoder.temperature;
    // The profile's max_tokens is otherwise display-only (published on
    // systemPromptOptions for pi-insights) — capture it so
    // before_provider_request can actually apply it to the request.
    // Guard the cast: a user settings file may hold a JSON string ("4096")
    // or a bad number (-1/NaN) — invalid values must not reach the wire
    // (undefined → cap field omitted, mirroring the helper's contract).
    const mt = opts.littleCoder.maxTokens;
    resolvedMaxTokens =
      typeof mt === "number" && Number.isFinite(mt) && mt >= 0 ? mt : undefined;
    // Provider id drives the max_tokens: 0 sentinel decision (local-only —
    // remote providers would reject the sentinel on the wire).
    resolvedProvider = model.provider;
    modelContextWindow = Number.isFinite(modelWindow) ? modelWindow : undefined;
  });

  // Inject the profile's temperature and max_tokens onto the outgoing
  // provider payload. Without the temperature part, pi-ai uses the provider
  // default (typically ~0.8 for llama.cpp), which adds measurable stochastic
  // variance on hard algorithmic exercises. Matches local-coder's
  // profiles[].temperature=0.3.
  //
  // Without the max_tokens part, the model catalog's maxTokens
  // (models.json: 8192/4096) stays in force and the profile's documented
  // max_tokens (16384) is silently ignored. A profile max_tokens of 0 means
  // "no output limit" on LOCAL servers (sentinel; the server clamps to
  // remaining context) and "omit the cap" on remote providers.
  //
  // SIDE-CALL CAVEAT: pi's runner fires this hook for compaction side-calls
  // too (agent-session.js compact() reuses the session streamFn), carrying
  // whatever state the LAST before_agent_start captured. With the local-only
  // sentinel guard above, a compaction side-call against a remote model with
  // max_tokens: 0 injects no sentinel (safe); a small positive cap may still
  // truncate side-call outputs (accepted: compaction runs on the session
  // model, whose profile is what the user configured for it).
  //
  // IMPORTANT: pi's runner passes payload by reference but only adopts
  // *returned* values. Mutating in place is discarded between handlers, so
  // we build a new payload object and return it explicitly. Also: the guard
  // must not early-return on temperature alone — a profile with max_tokens
  // but no temperature must still get its cap applied.
  pi.on("before_provider_request", async (event) => {
    if (resolvedTemperature === undefined && resolvedMaxTokens === undefined)
      return;
    // Single structural cast for the before_provider_request event; the
    // payload is a free-form provider request object we copy and patch.
    const payload: Record<string, unknown> | undefined = (
      event as { payload?: Record<string, unknown> }
    ).payload;
    if (!payload || typeof payload !== "object") return;
    const next: Record<string, unknown> = { ...payload };
    if (resolvedTemperature !== undefined) {
      next.temperature = resolvedTemperature;
    }
    if (resolvedMaxTokens !== undefined) {
      const cap = maxTokensCapForRequest(
        resolvedMaxTokens,
        modelContextWindow,
        isLocalProvider(resolvedProvider),
      );
      // Keep the payload's existing cap-field shape (some providers emit
      // max_completion_tokens); if neither is present, use max_tokens.
      // cap === undefined is reachable only when max_tokens: 0 targets a
      // non-local provider (deliberate omission → the catalog default cap
      // applies); the cast-site guard rejects all other invalid values.
      if (cap === undefined) {
        // Omit the cap fields (max_tokens: 0 on a remote provider).
      } else if (payload.max_completion_tokens !== undefined) {
        next.max_completion_tokens = cap;
      } else {
        next.max_tokens = cap;
      }
    }
    return next;
  });
}
