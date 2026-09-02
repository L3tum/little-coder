import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import benchmarkProfiles, {
  resolveProfileFrom,
  normKey,
  resolveContextLimit,
  CONTEXT_FALLBACK,
  maxTokensCapForRequest,
  NO_OUTPUT_LIMIT_SENTINEL,
  isLocalProvider,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(here, "..", "..", "settings.json");

describe("benchmark-profiles resolution against real settings.json", () => {
  const settings = JSON.parse(readFileSync(settingsPath, "utf-8")).little_coder;

  it("resolves base profile for llamacpp/qwen3.6-35b-a3b (budget bumped to 16384)", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b");
    expect(p.thinking_budget).toBe(16384);
    // base profiles no longer hardcode context_limit — it derives from the
    // model's live registered window at runtime (see resolveContextLimit).
    expect(p.context_limit).toBeUndefined();
    expect(p.max_turns).toBeUndefined();
  });

  it("applies terminal_bench overrides", () => {
    const p = resolveProfileFrom(
      settings,
      "llamacpp/qwen3.6-35b-a3b",
      "terminal_bench",
    );
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

  it("unknown model falls back to default_model_profile (also 16384)", () => {
    const p = resolveProfileFrom(settings, "fake-provider/fake-model");
    expect(p.thinking_budget).toBe(16384);
    expect(p.context_limit).toBeUndefined();
  });

  it("unknown benchmark name yields base profile unchanged", () => {
    const p = resolveProfileFrom(
      settings,
      "llamacpp/qwen3.6-35b-a3b",
      "totally_made_up",
    );
    expect(p.thinking_budget).toBe(16384);
    expect(p.max_turns).toBeUndefined();
  });

  it("every shipped per-model profile carries the 16384 budget", () => {
    for (const key of Object.keys(settings.model_profiles)) {
      expect(resolveProfileFrom(settings, key).thinking_budget, key).toBe(
        16384,
      );
    }
  });
});

describe("separator-insensitive model-key matching (issue #8 quirk)", () => {
  // The reproduction noted runtime ids using a colon (`qwen3.6:35b-a3b`) never
  // matched the hyphenated profile key, so per-model profiles were silently
  // skipped and everything fell back to default.
  const settings = {
    default_model_profile: { thinking_budget: 16384 },
    model_profiles: {
      "llamacpp/qwen3.6-35b-a3b": { thinking_budget: 1234, temperature: 0.3 },
    },
  };

  it("normKey collapses ':' to '-'", () => {
    expect(normKey("llamacpp/qwen3.6:35b-a3b")).toBe(
      "llamacpp/qwen3.6-35b-a3b",
    );
  });

  it("matches a colon runtime id to a hyphenated profile key", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6:35b-a3b");
    expect(p.thinking_budget).toBe(1234); // per-model profile, NOT the default
  });

  it("still matches the exact hyphenated id", () => {
    expect(
      resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b").thinking_budget,
    ).toBe(1234);
  });

  it("matches via prefix when the runtime id has a tag suffix", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6:35b-a3b:Q4_K_M");
    expect(p.thinking_budget).toBe(1234);
  });

  it("an unrelated model still falls back to default", () => {
    expect(resolveProfileFrom(settings, "ollama/llama3").thinking_budget).toBe(
      16384,
    );
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
      const pi = { on: (n: string, h: any) => (handlers[n] ??= []).push(h) };
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
    const lc = fireWith({
      provider: "llamacpp",
      id: "qwen3.6-35b-a3b",
      contextWindow: 131072,
    });
    expect(lc.contextLimit).toBe(131072);
  });

  it("falls back to 32768 when the model reports no usable window", () => {
    const lc = fireWith({
      provider: "llamacpp",
      id: "qwen3.6-35b-a3b",
      contextWindow: 0,
    });
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

// Regression: the old loadSettings() only ever read the package-root
// .pi/settings.json (first whole-file match won), so a user's actual repo
// (<cwd>/.pi/settings.json) profiles were silently ignored — and so were the
// user's global file's little_coder block. The shared helper fixes both.
describe("project-scope settings resolve (regression: per-repo profiles)", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lcs-test-agent-"));
  const pkgRoot = mkdtempSync(join(tmpdir(), "lcs-test-pkg-"));
  const cwd = mkdtempSync(join(tmpdir(), "lcs-test-cwd-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;

  beforeAll(() => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot; // empty pkg: no shadowing
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    // Project-scope profiles are trust-gated: grant an explicit trust.json
    // decision for this repo so the regression below exercises the
    // trusted-project path.
    writeFileSync(
      join(agentDir, "trust.json"),
      JSON.stringify({ [realpathSync(cwd)]: true }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        little_coder: {
          model_profiles: {
            "llamacpp/qwen3.6-35b-a3b": { thinking_budget: 7777 },
          },
        },
      }),
    );
  });

  afterAll(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("a <cwd>/.pi/settings.json profile wins over the shipped one", () => {
    const handlers: Record<string, ((e: any, c: any) => any)[]> = {};
    const pi = { on: (n: string, h: any) => (handlers[n] ??= []).push(h) };
    benchmarkProfiles(pi as any);
    const event: any = { systemPromptOptions: {} };
    const ctx: any = {
      model: {
        provider: "llamacpp",
        id: "qwen3.6-35b-a3b",
        contextWindow: 32768,
      },
      sessionManager: { getCwd: () => cwd },
    };
    for (const h of handlers["before_agent_start"] ?? []) h(event, ctx);
    expect(event.systemPromptOptions.littleCoder.thinkingBudget).toBe(7777);
  });
});

describe("resolve memo (factory closure, freshness-keyed)", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lcs-memo-agent-"));
  const pkgRoot = mkdtempSync(join(tmpdir(), "lcs-memo-pkg-"));
  const cwd = mkdtempSync(join(tmpdir(), "lcs-memo-cwd-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;

  beforeAll(() => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot; // empty pkg: no shadowing
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    // Trust is granted via defaultProjectTrust (NO explicit trust.json), so
    // flipping it below re-evaluates the project-scope trust decision on
    // re-resolve.
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProjectTrust: "always", little_coder: {} }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        little_coder: {
          model_profiles: {
            "llamacpp/qwen3.6-35b-a3b": { thinking_budget: 7777 },
          },
        },
      }),
    );
  });

  afterAll(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const model = {
    provider: "llamacpp",
    id: "qwen3.6-35b-a3b",
    contextWindow: 32768,
  };
  function fireOnce(
    handlers: Record<string, any[]>,
    ctx: any,
    event: any,
  ): void {
    for (const h of handlers["before_agent_start"] ?? []) h(event, ctx);
  }

  it("memo hit: two turns with unchanged settings files resolve identically", () => {
    const handlers: Record<string, any[]> = {};
    const pi = { on: (n: string, h: any) => (handlers[n] ??= []).push(h) };
    benchmarkProfiles(pi as any);
    const ctx: any = { model, sessionManager: { getCwd: () => cwd } };
    const e1: any = { systemPromptOptions: {} };
    fireOnce(handlers, ctx, e1);
    expect(e1.systemPromptOptions.littleCoder.thinkingBudget).toBe(7777);
    // Second turn, no file changes: memo hit — same value, no per-turn drift.
    const e2: any = { systemPromptOptions: {} };
    fireOnce(handlers, ctx, e2);
    expect(e2.systemPromptOptions.littleCoder.thinkingBudget).toBe(7777);
  });

  it("invalidation: rewriting the agent-dir settings.json re-resolves on the next turn", () => {
    const handlers: Record<string, any[]> = {};
    const pi = { on: (n: string, h: any) => (handlers[n] ??= []).push(h) };
    benchmarkProfiles(pi as any); // fresh closure → fresh memo
    const ctx: any = { model, sessionManager: { getCwd: () => cwd } };
    const e1: any = { systemPromptOptions: {} };
    fireOnce(handlers, ctx, e1);
    expect(e1.systemPromptOptions.littleCoder.thinkingBudget).toBe(7777);

    // Flip defaultProjectTrust in the AGENT-DIR settings (a file the memo key
    // must track): the project scope drops out of the merge on re-resolve.
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProjectTrust: "never", little_coder: {} }),
    );
    const e2: any = { systemPromptOptions: {} };
    fireOnce(handlers, ctx, e2);
    expect(e2.systemPromptOptions.littleCoder.thinkingBudget).not.toBe(7777);

    // Flipping back restores the project value (memo invalidates again).
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProjectTrust: "always", little_coder: {} }),
    );
    const e3: any = { systemPromptOptions: {} };
    fireOnce(handlers, ctx, e3);
    expect(e3.systemPromptOptions.littleCoder.thinkingBudget).toBe(7777);
  });
});

describe("resolve memo tracks trust.json freshness", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lcs-trust-agent-"));
  const pkgRoot = mkdtempSync(join(tmpdir(), "lcs-trust-pkg-"));
  const cwd = mkdtempSync(join(tmpdir(), "lcs-trust-cwd-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;

  beforeAll(() => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot; // empty pkg: no shadowing
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    // NO trust.json, NO defaultProjectTrust => fail-closed untrusted. The
    // project-scope profile is dropped until trust.json grants this repo.
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        little_coder: {
          model_profiles: {
            "llamacpp/qwen3.6-35b-a3b": { thinking_budget: 7777 },
          },
        },
      }),
    );
  });

  afterAll(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writing trust.json mid-session re-resolves: project profile applies on the next turn", () => {
    const handlers: Record<string, any[]> = {};
    const pi = { on: (n: string, h: any) => (handlers[n] ??= []).push(h) };
    benchmarkProfiles(pi as any); // one factory => one memo (session lifetime)
    const ctx: any = {
      model: {
        provider: "llamacpp",
        id: "qwen3.6-35b-a3b",
        contextWindow: 32768,
      },
      sessionManager: { getCwd: () => cwd },
    };

    // Turn 1: no trust.json => untrusted => project profile dropped.
    const e1: any = { systemPromptOptions: {} };
    for (const h of handlers["before_agent_start"] ?? []) h(e1, ctx);
    expect(e1.systemPromptOptions.littleCoder.thinkingBudget).not.toBe(7777);

    // Mid-session /trust: grant this repo. Force a distinct mtime so the
    // freshness key changes even on coarse-granularity filesystems.
    const trustFile = join(agentDir, "trust.json");
    writeFileSync(trustFile, JSON.stringify({ [realpathSync(cwd)]: true }));
    const st = statSync(trustFile);
    utimesSync(trustFile, st.atime, new Date(st.mtimeMs + 1000));

    // Turn 2: the memo key now includes the changed trust.json freshness =>
    // the project-scope trust gate re-evaluates => project profile applies.
    const e2: any = { systemPromptOptions: {} };
    for (const h of handlers["before_agent_start"] ?? []) h(e2, ctx);
    expect(e2.systemPromptOptions.littleCoder.thinkingBudget).toBe(7777);
  });
});

// Item 1a: the profile's max_tokens must actually reach the provider payload
// (previously display-only), with 0 = "no output limit" sentinel and a
// model-window clamp.
describe("maxTokensCapForRequest", () => {
  it("0 -> sentinel (no output limit)", () => {
    expect(maxTokensCapForRequest(0, 32768)).toBe(NO_OUTPUT_LIMIT_SENTINEL);
    expect(maxTokensCapForRequest(0, undefined)).toBe(NO_OUTPUT_LIMIT_SENTINEL);
  });
  it("positive value under the window passes through", () => {
    expect(maxTokensCapForRequest(4096, 32768)).toBe(4096);
  });
  it("positive value over the window is clamped to the window", () => {
    expect(maxTokensCapForRequest(65536, 32768)).toBe(32768);
  });
  it("unknown/invalid window leaves the value untouched", () => {
    expect(maxTokensCapForRequest(4096, undefined)).toBe(4096);
    expect(maxTokensCapForRequest(4096, Number.NaN)).toBe(4096);
    expect(maxTokensCapForRequest(4096, 0)).toBe(4096);
  });
  it("negative value -> undefined (cap fields omitted)", () => {
    expect(maxTokensCapForRequest(-1, 32768)).toBeUndefined();
  });
  it("NaN -> undefined (cap fields omitted)", () => {
    expect(maxTokensCapForRequest(Number.NaN, 32768)).toBeUndefined();
  });
  it("string value (from a user settings file) -> undefined (cap omitted)", () => {
    expect(maxTokensCapForRequest("4096" as any, 32768)).toBeUndefined();
  });
});

describe("before_provider_request applies the profile max_tokens", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lcs-mp-agent-"));
  const pkgRoot = mkdtempSync(join(tmpdir(), "lcs-mp-pkg-"));
  const cwd = mkdtempSync(join(tmpdir(), "lcs-mp-cwd-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;

  beforeAll(() => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot; // empty pkg: no shadowing
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    // Project-scope profiles are trust-gated: grant an explicit trust.json
    // decision for this repo so these cap tests exercise the profile
    // values rather than the trust fallback.
    writeFileSync(
      join(agentDir, "trust.json"),
      JSON.stringify({ [realpathSync(cwd)]: true }),
    );
  });

  afterAll(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  // Write a controlled profile, fire before_agent_start +
  // before_provider_request, return the adopted payload.
  async function fire(
    profile: Record<string, unknown>,
    modelWindow: number | undefined,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        little_coder: { default_model_profile: profile },
      }),
    );
    // the settings resolver is unmemoized — the re-read below picks up
    // this file automatically; no cache to clear.)
    const handlers: Record<string, ((e: any, c: any) => any)[]> = {};
    const pi = { on: (n: string, h: any) => (handlers[n] ??= []).push(h) };
    benchmarkProfiles(pi as any);
    const model: any = { provider: "llamacpp", id: "test-model" };
    if (modelWindow !== undefined) model.contextWindow = modelWindow;
    const ctx: any = { model, sessionManager: { getCwd: () => cwd } };
    for (const h of handlers["before_agent_start"] ?? [])
      await h({ systemPromptOptions: {} }, ctx);
    for (const h of handlers["before_provider_request"] ?? []) {
      const result = await h({ payload }, ctx);
      if (result !== undefined) return result as Record<string, unknown>;
    }
    return payload;
  }

  // Like fire(), but with a REMOTE provider id (remote → no sentinel).
  async function fireRemote(
    profile: Record<string, unknown>,
    modelWindow: number | undefined,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        little_coder: { default_model_profile: profile },
      }),
    );
    const handlers: Record<string, ((e: any, c: any) => any)[]> = {};
    const pi = { on: (n: string, h: any) => (handlers[n] ??= []).push(h) };
    benchmarkProfiles(pi as any);
    const model: any = { provider: "openai", id: "remote-model" };
    if (modelWindow !== undefined) model.contextWindow = modelWindow;
    const ctx: any = { model, sessionManager: { getCwd: () => cwd } };
    for (const h of handlers["before_agent_start"] ?? [])
      await h({ systemPromptOptions: {} }, ctx);
    for (const h of handlers["before_provider_request"] ?? []) {
      const result = await h({ payload }, ctx);
      if (result !== undefined) return result as Record<string, unknown>;
    }
    return payload;
  }

  it("max_tokens 4096 + window 32768 -> payload max_tokens = 4096", async () => {
    const out = await fire({ max_tokens: 4096 }, 32768, { model: "x" });
    expect(out.max_tokens).toBe(4096);
  });

  it("max_tokens 0 -> payload max_tokens = no-limit sentinel", async () => {
    const out = await fire({ max_tokens: 0 }, 32768, { model: "x" });
    expect(out.max_tokens).toBe(NO_OUTPUT_LIMIT_SENTINEL);
  });

  it("max_tokens 65536 + window 32768 -> clamped to 32768", async () => {
    const out = await fire({ max_tokens: 65536 }, 32768, { model: "x" });
    expect(out.max_tokens).toBe(32768);
  });

  it("max_tokens without temperature is still applied (early-return trap)", async () => {
    const out = await fire({ max_tokens: 4096 }, 32768, { model: "x" });
    expect(out.max_tokens).toBe(4096);
    expect(out.temperature).toBeUndefined();
  });

  it("no max_tokens and no temperature -> payload unchanged", async () => {
    const payload = { model: "x", max_tokens: 8192 };
    const out = await fire({}, 32768, payload);
    expect(out).toBe(payload); // handler returned undefined
  });

  it("respects a payload that already uses max_completion_tokens", async () => {
    const out = await fire({ max_tokens: 4096 }, 32768, {
      model: "x",
      max_completion_tokens: 123,
    });
    expect(out.max_completion_tokens).toBe(4096);
    expect(out.max_tokens).toBeUndefined();
  });

  it("temperature-only profile still injects temperature, cap untouched", async () => {
    const out = await fire({ temperature: 0.3 }, 32768, {
      model: "x",
      max_tokens: 8192,
    });
    expect(out.temperature).toBe(0.3);
    expect(out.max_tokens).toBe(8192);
  });

  it("string max_tokens in project settings -> no cap fields, temperature still applied", async () => {
    // A hand-edited settings file may hold max_tokens as a JSON string —
    // it must be rejected at the cast site (cap fields omitted) rather
    // than forwarded to the wire, while temperature keeps applying.
    const out = await fire({ max_tokens: "4096", temperature: 0.3 }, 32768, {
      model: "x",
    });
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBeUndefined();
    expect(out.temperature).toBe(0.3);
  });

  it("max_tokens 0 on a REMOTE provider -> no cap fields (sentinel is local-only)", async () => {
    // M9: the sentinel must never be injected for a remote provider —
    // the catalog default cap applies instead.
    const out = await fireRemote({ max_tokens: 0 }, 32768, {
      model: "x",
      max_tokens: 8192,
    });
    expect(out.max_tokens).toBe(8192); // untouched catalog default
    expect(out.max_completion_tokens).toBeUndefined();
  });
});

// M# trust-gating tests: a project's own .pi/settings.json may only
// contribute model_profiles / default_model_profile when the project is
// trusted (same fail-closed matrix as the project-scope bash_allow gate).
describe("project-scope model profiles are trust-gated (M#)", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lcs-mg-agent-"));
  const pkgRoot = mkdtempSync(join(tmpdir(), "lcs-mg-pkg-"));
  const cwd = mkdtempSync(join(tmpdir(), "lcs-mg-cwd-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;

  function fireBudget(
    opts: { trust?: boolean; always?: boolean } = {},
  ): number {
    if (opts.trust)
      writeFileSync(
        join(agentDir, "trust.json"),
        JSON.stringify({ [realpathSync(cwd)]: true }),
      );
    else rmSync(join(agentDir, "trust.json"), { force: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        ...(opts.always ? { defaultProjectTrust: "always" } : {}),
        little_coder: {
          // Global scope: the fallback when the project scope is gated out.
          model_profiles: {
            "llamacpp/qwen3.6-35b-a3b": { thinking_budget: 5555 },
          },
        },
      }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        little_coder: {
          model_profiles: {
            "llamacpp/qwen3.6-35b-a3b": { thinking_budget: 7777 },
          },
        },
      }),
    );
    const handlers: Record<string, ((e: any, c: any) => any)[]> = {};
    const pi = { on: (n: string, h: any) => (handlers[n] ??= []).push(h) };
    benchmarkProfiles(pi as any);
    const event: any = { systemPromptOptions: {} };
    const ctx: any = {
      model: {
        provider: "llamacpp",
        id: "qwen3.6-35b-a3b",
        contextWindow: 32768,
      },
      sessionManager: { getCwd: () => cwd },
    };
    for (const h of handlers["before_agent_start"] ?? []) h(event, ctx);
    return event.systemPromptOptions.littleCoder.thinkingBudget;
  }

  beforeAll(() => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot; // empty pkg: no shadowing
    mkdirSync(join(cwd, ".pi"), { recursive: true });
  });

  afterAll(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("M1: untrusted project profiles are ignored (falls back to global)", () => {
    expect(fireBudget()).toBe(5555); // global, NOT the project's 7777
  });

  it("M2: trusted project profiles are honored", () => {
    expect(fireBudget({ trust: true })).toBe(7777);
  });

  it("M4: defaultProjectTrust 'always' + project profile -> honored (no trust.json)", () => {
    expect(fireBudget({ always: true })).toBe(7777);
  });

  it("M3: global-scope profiles are honored for an untrusted project", () => {
    // M1's assertion already shows the global value winning; make it
    // explicit: with no project settings at all the global still applies.
    rmSync(join(cwd, ".pi", "settings.json"), { force: true });
    expect(fireBudget()).toBe(5555);
  });
});

describe("maxTokensCapForRequest isLocal flag + isLocalProvider (M#)", () => {
  it("M5: (0, window, local) -> sentinel", () => {
    expect(maxTokensCapForRequest(0, 32768, true)).toBe(
      NO_OUTPUT_LIMIT_SENTINEL,
    );
  });

  it("M6: (0, window, non-local) -> undefined (cap omitted)", () => {
    expect(maxTokensCapForRequest(0, 32768, false)).toBeUndefined();
  });

  it("M7: positive values are unaffected by the local flag", () => {
    expect(maxTokensCapForRequest(16384, 32768, true)).toBe(16384);
    expect(maxTokensCapForRequest(16384, 32768, false)).toBe(16384);
    // 2-arg default stays isLocal=true (existing behavior).
    expect(maxTokensCapForRequest(0, 32768)).toBe(NO_OUTPUT_LIMIT_SENTINEL);
  });

  it("M8: isLocalProvider truth table", () => {
    expect(isLocalProvider("llamacpp")).toBe(true);
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("lmstudio")).toBe(true);
    expect(isLocalProvider("openai")).toBe(false);
    expect(isLocalProvider(undefined)).toBe(false);
    expect(isLocalProvider(42 as any)).toBe(false);
  });
});
