import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import benchmarkProfiles, {
  resolveProfileFrom,
  normKey,
  resolveContextLimit,
  CONTEXT_FALLBACK,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(here, "..", "..", "settings.json");

describe("benchmark-profiles resolution against real settings.json", () => {
  const settings = JSON.parse(readFileSync(settingsPath, "utf-8")).little_coder;

  it("resolves base profile for llamacpp/qwen3.6-35b-a3b (budget bumped to 4096)", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b");
    expect(p.thinking_budget).toBe(4096);
    // base profiles no longer hardcode context_limit — it derives from the
    // model's live registered window at runtime (see resolveContextLimit).
    expect(p.context_limit).toBeUndefined();
    expect(p.max_turns).toBeUndefined();
  });

  it("applies terminal_bench overrides", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b", "terminal_bench");
    expect(p.thinking_budget).toBe(3000); // benchmark override kept
    expect(p.temperature).toBe(0.2);
    expect(p.max_turns).toBe(40);
    expect(p.context_limit).toBeUndefined(); // no override → live model window
  });

  it("applies gaia overrides", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b", "gaia");
    expect(p.thinking_budget).toBe(2000);
    expect(p.temperature).toBe(0.4);
    expect(p.max_turns).toBe(40);
    expect(p.context_limit).toBe(65536);
  });

  it("unknown model falls back to default_model_profile (also 4096)", () => {
    const p = resolveProfileFrom(settings, "fake-provider/fake-model");
    expect(p.thinking_budget).toBe(4096);
    expect(p.context_limit).toBeUndefined();
  });

  it("unknown benchmark name yields base profile unchanged", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b", "totally_made_up");
    expect(p.thinking_budget).toBe(4096);
    expect(p.max_turns).toBeUndefined();
  });

  it("every shipped per-model profile carries the 4096 budget", () => {
    for (const key of Object.keys(settings.model_profiles)) {
      expect(resolveProfileFrom(settings, key).thinking_budget, key).toBe(4096);
    }
  });
});

describe("separator-insensitive model-key matching (issue #8 quirk)", () => {
  // The reproduction noted runtime ids using a colon (`qwen3.6:35b-a3b`) never
  // matched the hyphenated profile key, so per-model profiles were silently
  // skipped and everything fell back to default.
  const settings = {
    default_model_profile: { thinking_budget: 4096 },
    model_profiles: {
      "llamacpp/qwen3.6-35b-a3b": { thinking_budget: 1234, temperature: 0.3 },
    },
  };

  it("normKey collapses ':' to '-'", () => {
    expect(normKey("llamacpp/qwen3.6:35b-a3b")).toBe("llamacpp/qwen3.6-35b-a3b");
  });

  it("matches a colon runtime id to a hyphenated profile key", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6:35b-a3b");
    expect(p.thinking_budget).toBe(1234); // per-model profile, NOT the default
  });

  it("still matches the exact hyphenated id", () => {
    expect(resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b").thinking_budget).toBe(1234);
  });

  it("matches via prefix when the runtime id has a tag suffix", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6:35b-a3b:Q4_K_M");
    expect(p.thinking_budget).toBe(1234);
  });

  it("an unrelated model still falls back to default", () => {
    expect(resolveProfileFrom(settings, "ollama/llama3").thinking_budget).toBe(4096);
  });
});

describe("resolveContextLimit", () => {
  it("uses the model's live registered window when no profile override", () => {
    expect(resolveContextLimit(undefined, 131072)).toBe(131072);
    expect(resolveContextLimit(undefined, 32768)).toBe(32768);
  });
  it("an explicit profile/benchmark context_limit wins over the model window", () => {
    expect(resolveContextLimit(65536, 131072)).toBe(65536);
  });
  it("falls back to CONTEXT_FALLBACK when neither is known", () => {
    expect(resolveContextLimit(undefined, undefined)).toBe(CONTEXT_FALLBACK);
    expect(resolveContextLimit(undefined, 0)).toBe(CONTEXT_FALLBACK);
    expect(resolveContextLimit(undefined, Number.NaN)).toBe(CONTEXT_FALLBACK);
    expect(CONTEXT_FALLBACK).toBe(32768);
  });
});

// End-to-end: the before_agent_start handler must publish contextLimit from the
// live model.contextWindow against the REAL shipped settings.json.
describe("before_agent_start publishes a model-window contextLimit", () => {
  function fireWith(model: any, benchmark?: string) {
    const prev = process.env.LITTLE_CODER_BENCHMARK;
    if (benchmark) process.env.LITTLE_CODER_BENCHMARK = benchmark;
    else delete process.env.LITTLE_CODER_BENCHMARK;
    try {
      const handlers: Record<string, ((e: any, c: any) => any)[]> = {};
      const pi = { on: (n: string, h: any) => ((handlers[n] ??= []).push(h)) };
      benchmarkProfiles(pi as any);
      const event: any = { systemPromptOptions: {} };
      const ctx: any = { model };
      for (const h of handlers["before_agent_start"] ?? []) h(event, ctx);
      return event.systemPromptOptions.littleCoder;
    } finally {
      if (prev === undefined) delete process.env.LITTLE_CODER_BENCHMARK;
      else process.env.LITTLE_CODER_BENCHMARK = prev;
    }
  }

  it("follows the model's contextWindow for a normal (non-benchmark) run", () => {
    const lc = fireWith({ provider: "llamacpp", id: "qwen3.6-35b-a3b", contextWindow: 131072 });
    expect(lc.contextLimit).toBe(131072);
  });

  it("falls back to 32768 when the model reports no usable window", () => {
    const lc = fireWith({ provider: "llamacpp", id: "qwen3.6-35b-a3b", contextWindow: 0 });
    expect(lc.contextLimit).toBe(32768);
  });

  it("an explicit gaia override still wins over the live window", () => {
    const lc = fireWith(
      { provider: "llamacpp", id: "qwen3.6-35b-a3b", contextWindow: 131072 },
      "gaia",
    );
    expect(lc.contextLimit).toBe(65536);
  });
});
