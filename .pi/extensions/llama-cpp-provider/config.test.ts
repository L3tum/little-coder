import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEnvOverrides,
  loadProviders,
  mergeProviders,
  resolveOverridePath,
  propsUrlFor,
  contextWindowFromProps,
  probeContextWindow,
  ctxProbeHostKey,
  ctxProbeCachePath,
  readCtxProbeCache,
  ctxProbeTimeoutMs,
  writeCtxProbeCache,
  resolveWarmCtxWindow,
  CTX_PROBE_FAIL_WARN_AT,
  type ProviderEntry,
} from "./config.ts";
import extensionDefault from "./index.ts";

const sampleProvider = (baseUrl: string, modelId: string): ProviderEntry => ({
  api: "openai-completions",
  baseUrl,
  apiKey: "SAMPLE_KEY",
  models: [
    {
      id: modelId,
      name: modelId,
      reasoning: true,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
});

describe("resolveOverridePath", () => {
  it("prefers LITTLE_CODER_MODELS_FILE", () => {
    expect(
      resolveOverridePath({
        LITTLE_CODER_MODELS_FILE: "/explicit.json",
        HOME: "/h",
      }),
    ).toBe("/explicit.json");
  });
  it("falls back to XDG_CONFIG_HOME", () => {
    expect(resolveOverridePath({ XDG_CONFIG_HOME: "/xdg", HOME: "/h" })).toBe(
      "/xdg/little-coder/models.json",
    );
  });
  it("falls back to HOME/.config", () => {
    expect(resolveOverridePath({ HOME: "/h" })).toBe(
      "/h/.config/little-coder/models.json",
    );
  });
  it("returns undefined when neither is set", () => {
    expect(resolveOverridePath({})).toBeUndefined();
  });
});

describe("mergeProviders", () => {
  it("returns the package default unchanged when there's no override", () => {
    const pkg = { llamacpp: sampleProvider("http://a/v1", "m1") };
    expect(mergeProviders(pkg, undefined)).toEqual(pkg);
  });
  it("user provider replaces same-key package provider", () => {
    const pkg = { llamacpp: sampleProvider("http://a/v1", "pkg-model") };
    const user = { llamacpp: sampleProvider("http://b/v1", "user-model") };
    const merged = mergeProviders(pkg, user);
    expect(merged.llamacpp.baseUrl).toBe("http://b/v1");
    expect(merged.llamacpp.models[0].id).toBe("user-model");
  });
  it("user provider not in package is added", () => {
    const pkg = { llamacpp: sampleProvider("http://a/v1", "m1") };
    const user = { custom: sampleProvider("http://c/v1", "c1") };
    const merged = mergeProviders(pkg, user);
    expect(Object.keys(merged).sort()).toEqual(["custom", "llamacpp"]);
  });
  it("package providers without an override are kept as-is", () => {
    const pkg = {
      llamacpp: sampleProvider("http://a/v1", "m1"),
      ollama: sampleProvider("http://o/v1", "m2"),
    };
    const user = { llamacpp: sampleProvider("http://b/v1", "m1b") };
    const merged = mergeProviders(pkg, user);
    expect(merged.ollama.baseUrl).toBe("http://o/v1");
  });
});

describe("applyEnvOverrides", () => {
  it("LLAMACPP_BASE_URL overrides llamacpp baseUrl", () => {
    const providers = { llamacpp: sampleProvider("http://file/v1", "m1") };
    const out = applyEnvOverrides(providers, {
      LLAMACPP_BASE_URL: "http://env/v1",
    });
    expect(out.llamacpp.baseUrl).toBe("http://env/v1");
  });
  it("OLLAMA_BASE_URL overrides ollama baseUrl", () => {
    const providers = { ollama: sampleProvider("http://file/v1", "m2") };
    const out = applyEnvOverrides(providers, {
      OLLAMA_BASE_URL: "http://env/v1",
    });
    expect(out.ollama.baseUrl).toBe("http://env/v1");
  });
  it("LMSTUDIO_BASE_URL overrides lmstudio baseUrl", () => {
    const providers = {
      lmstudio: sampleProvider("http://127.0.0.1:1234/v1", "local-model"),
    };
    const out = applyEnvOverrides(providers, {
      LMSTUDIO_BASE_URL: "http://127.0.0.1:5678/v1",
    });
    expect(out.lmstudio.baseUrl).toBe("http://127.0.0.1:5678/v1");
  });
  it("does not alter providers without a known env knob", () => {
    const providers = { custom: sampleProvider("http://file/v1", "m") };
    const out = applyEnvOverrides(providers, {
      LLAMACPP_BASE_URL: "http://env/v1",
    });
    expect(out.custom.baseUrl).toBe("http://file/v1");
  });
});

describe("loadProviders (filesystem)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lc-providers-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads the package default when present", () => {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: { llamacpp: sampleProvider("http://a/v1", "m1") },
      }),
    );
    const result = loadProviders(dir, {});
    expect(Object.keys(result.providers)).toEqual(["llamacpp"]);
    expect(result.sources[0]).toMatchObject({ status: "ok" });
  });

  it("merges a user override file when LITTLE_CODER_MODELS_FILE points at one", () => {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: { llamacpp: sampleProvider("http://a/v1", "pkg") },
      }),
    );
    const userPath = join(dir, "user-models.json");
    writeFileSync(
      userPath,
      JSON.stringify({
        providers: { llamacpp: sampleProvider("http://b/v1", "user") },
      }),
    );
    const result = loadProviders(dir, { LITTLE_CODER_MODELS_FILE: userPath });
    expect(result.providers.llamacpp.baseUrl).toBe("http://b/v1");
    expect(result.providers.llamacpp.models[0].id).toBe("user");
  });

  it("reports invalid JSON in the package default and returns empty providers", () => {
    writeFileSync(join(dir, "models.json"), "{ this is not json");
    const result = loadProviders(dir, {});
    expect(result.providers).toEqual({});
    expect(result.sources[0].status).toBe("invalid");
  });

  it("reports a missing user override without failing the load", () => {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: { llamacpp: sampleProvider("http://a/v1", "m1") },
      }),
    );
    const missing = join(dir, "no-such-dir", "models.json");
    const result = loadProviders(dir, { LITTLE_CODER_MODELS_FILE: missing });
    expect(result.providers.llamacpp.baseUrl).toBe("http://a/v1");
    expect(result.sources.find((s) => s.path === missing)?.status).toBe(
      "missing",
    );
  });

  it("env var still overrides baseUrl after merge", () => {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: { llamacpp: sampleProvider("http://file/v1", "m") },
      }),
    );
    const result = loadProviders(dir, { LLAMACPP_BASE_URL: "http://env/v1" });
    expect(result.providers.llamacpp.baseUrl).toBe("http://env/v1");
  });

  it("XDG_CONFIG_HOME overrides applied when no LITTLE_CODER_MODELS_FILE set", () => {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: { llamacpp: sampleProvider("http://a/v1", "pkg") },
      }),
    );
    const xdg = join(dir, "xdg");
    mkdirSync(join(xdg, "little-coder"), { recursive: true });
    writeFileSync(
      join(xdg, "little-coder", "models.json"),
      JSON.stringify({
        providers: { llamacpp: sampleProvider("http://x/v1", "via-xdg") },
      }),
    );
    const result = loadProviders(dir, { XDG_CONFIG_HOME: xdg });
    expect(result.providers.llamacpp.models[0].id).toBe("via-xdg");
  });
});

describe("shipped models.json", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(here, "..", "..", "..");

  it("registers lmstudio/local-model on http://127.0.0.1:1234/v1", () => {
    const result = loadProviders(pkgRoot, {});
    const lmstudio = result.providers.lmstudio;
    expect(
      lmstudio,
      "lmstudio provider should be present in shipped models.json",
    ).toBeDefined();
    expect(lmstudio.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(lmstudio.api).toBe("openai-completions");
    expect(lmstudio.apiKey).toBe("LMSTUDIO_API_KEY");
    expect(lmstudio.models.find((m) => m.id === "local-model")).toBeDefined();
  });

  it("still registers llamacpp and ollama alongside lmstudio", () => {
    const result = loadProviders(pkgRoot, {});
    expect(Object.keys(result.providers).sort()).toEqual([
      "llamacpp",
      "lmstudio",
      "ollama",
    ]);
  });
});

describe("propsUrlFor", () => {
  it("strips a trailing /v1 and points at the server root /props", () => {
    expect(propsUrlFor("http://127.0.0.1:8888/v1")).toBe(
      "http://127.0.0.1:8888/props",
    );
    expect(propsUrlFor("http://host:8888/v1/")).toBe("http://host:8888/props");
    expect(propsUrlFor("http://host:8888")).toBe("http://host:8888/props");
    expect(propsUrlFor("http://host:8888/")).toBe("http://host:8888/props");
  });
});

describe("contextWindowFromProps", () => {
  it("reads default_generation_settings.n_ctx (real llama.cpp shape)", () => {
    expect(
      contextWindowFromProps({
        default_generation_settings: { n_ctx: 131072 },
      }),
    ).toBe(131072);
  });
  it("falls back to a top-level n_ctx", () => {
    expect(contextWindowFromProps({ n_ctx: 65536 })).toBe(65536);
  });
  it("returns undefined when absent or non-positive", () => {
    expect(contextWindowFromProps({})).toBeUndefined();
    expect(
      contextWindowFromProps({ default_generation_settings: { n_ctx: 0 } }),
    ).toBeUndefined();
    expect(
      contextWindowFromProps({
        default_generation_settings: { n_ctx: "lots" },
      }),
    ).toBeUndefined();
    expect(contextWindowFromProps(null)).toBeUndefined();
  });
});

describe("probeContextWindow", () => {
  const okRes = (body: unknown) =>
    ({ ok: true, json: async () => body }) as Response;

  it("returns the server's n_ctx on success", async () => {
    const fetchImpl = (async () =>
      okRes({
        default_generation_settings: { n_ctx: 131072 },
      })) as unknown as typeof fetch;
    expect(await probeContextWindow("http://x:8888/v1", { fetchImpl })).toBe(
      131072,
    );
  });

  it("returns undefined on a non-OK response", async () => {
    const fetchImpl = (async () =>
      ({ ok: false }) as Response) as unknown as typeof fetch;
    expect(
      await probeContextWindow("http://x:8888/v1", { fetchImpl }),
    ).toBeUndefined();
  });

  it("returns undefined when fetch throws (server down / unreachable)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      await probeContextWindow("http://x:8888/v1", { fetchImpl }),
    ).toBeUndefined();
  });

  it("returns undefined when the response lacks n_ctx", async () => {
    const fetchImpl = (async () =>
      okRes({ total_slots: 1 })) as unknown as typeof fetch;
    expect(
      await probeContextWindow("http://x:8888/v1", { fetchImpl }),
    ).toBeUndefined();
  });

  it("honors an explicit props url override", async () => {
    let seen = "";
    const fetchImpl = (async (u: string) => {
      seen = u;
      return okRes({ default_generation_settings: { n_ctx: 40960 } });
    }) as unknown as typeof fetch;
    const got = await probeContextWindow("http://x:8888/v1", {
      fetchImpl,
      url: "http://other/props",
    });
    expect(seen).toBe("http://other/props");
    expect(got).toBe(40960);
  });

  it("defaults to a 500 ms timeout (was 1500) when none is given", async () => {
    // A fetchImpl that only settles via the abort signal: if the abort fires
    // at ~500 ms this resolves fast; with the old 1500 ms default the 1200 ms
    // race below would win instead.
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as unknown as typeof fetch;
    const t0 = Date.now();
    const got = await Promise.race([
      probeContextWindow("http://x:8888/v1", { fetchImpl }),
      new Promise((r) => setTimeout(() => r("timeout"), 1200)),
    ]);
    const elapsed = Date.now() - t0;
    expect(got).toBeUndefined();
    expect(elapsed).toBeLessThan(1200); // 500 ms abort fired, not 1500
  });
});

// ── /props disk cache (startup-performance) ─────────────────────────────────

describe("ctx probe cache", () => {
  let cacheDir: string;
  const env = (e: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    XDG_CACHE_HOME: cacheDir,
    HOME: "/nonexistent-home-for-tests",
    ...e,
  });

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "ctx-probe-cache-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("host-key sanitization: keeps host:port, replaces illegal chars", () => {
    expect(ctxProbeHostKey("http://localhost:8080/v1")).toBe("localhost:8080");
    expect(ctxProbeHostKey("https://OLLAMA.mortimer.website")).toBe(
      "ollama.mortimer.website",
    );
    expect(ctxProbeHostKey("not-a-url")).toBeNull();
  });

  it("ctxProbeCachePath: XDG-aware, host-keyed; null for unparseable baseUrl", () => {
    const p = ctxProbeCachePath("http://localhost:8080/v1", env());
    expect(p).toBe(
      join(cacheDir, "little-coder", "ctx-window-localhost:8080.json"),
    );
    expect(ctxProbeCachePath("not-a-url", env())).toBeNull();
  });

  it("respects XDG_CACHE_HOME; falls back to ~/.cache when unset", () => {
    const p = ctxProbeCachePath("http://a:1/", {
      HOME: "/home/user",
    } as NodeJS.ProcessEnv);
    expect(p).toBe(
      join("/home/user", ".cache", "little-coder", "ctx-window-a:1.json"),
    );
  });

  // empty/whitespace env overrides must never yield a
  // RELATIVE cache path ("" ?? homedir() does not catch ""), which would
  // make writeCtxProbeCache create ./cache/little-coder inside the repo's
  // working tree.
  it("whitespace-only XDG_CACHE_HOME falls back to the home .cache dir", () => {
    const p = ctxProbeCachePath(
      "http://localhost:8080/v1",
      env({ XDG_CACHE_HOME: "   " }),
    );
    expect(p).toBe(
      join(
        "/nonexistent-home-for-tests",
        ".cache",
        "little-coder",
        "ctx-window-localhost:8080.json",
      ),
    );
    expect(isAbsolute(p!)).toBe(true);
  });

  it("whitespace-only HOME falls back to the real homedir()", () => {
    const p = ctxProbeCachePath(
      "http://localhost:8080/v1",
      env({ XDG_CACHE_HOME: undefined, HOME: "   " }),
    );
    expect(p).toBe(
      join(
        homedir(),
        ".cache",
        "little-coder",
        "ctx-window-localhost:8080.json",
      ),
    );
    expect(isAbsolute(p!)).toBe(true);
  });

  it("a write with empty/whitespace HOME never lands in the repo cwd", () => {
    const scratchCwd = mkdtempSync(join(tmpdir(), "h3-cwd-"));
    const prevCwd = process.cwd();
    process.chdir(scratchCwd);
    try {
      const w = {
        XDG_CACHE_HOME: cacheDir,
        HOME: "   ",
      } as NodeJS.ProcessEnv;
      writeCtxProbeCache("http://localhost:8080/v1", 4096, {
        probedAt: 1000,
        env: w,
      });
      // The file lands under the XDG cache dir…
      expect(readCtxProbeCache("http://localhost:8080/v1", w)).toEqual({
        contextWindow: 4096,
        probedAt: 1000,
        probeFailCount: 0,
      });
      // …and nothing is created in the working tree.
      expect(existsSync(join(scratchCwd, "cache"))).toBe(false);
      expect(existsSync(join(scratchCwd, ".cache"))).toBe(false);
    } finally {
      process.chdir(prevCwd);
      rmSync(scratchCwd, { recursive: true, force: true });
    }
  });

  it("a RELATIVE XDG_CACHE_HOME falls back to the home .cache dir (loud)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = ctxProbeCachePath(
        "http://localhost:8080/v1",
        env({ XDG_CACHE_HOME: "relative/cache" }),
      );
      expect(p).toBe(
        join(
          "/nonexistent-home-for-tests",
          ".cache",
          "little-coder",
          "ctx-window-localhost:8080.json",
        ),
      );
      expect(isAbsolute(p!)).toBe(true);
      expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
        /XDG_CACHE_HOME is relative/,
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("H4b: a RELATIVE HOME falls back to the platform homedir (loud)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = ctxProbeCachePath(
        "http://localhost:8080/v1",
        env({ XDG_CACHE_HOME: undefined, HOME: "relative/home" }),
      );
      expect(p).toBe(
        join(
          homedir(),
          ".cache",
          "little-coder",
          "ctx-window-localhost:8080.json",
        ),
      );
      expect(isAbsolute(p!)).toBe(true);
      expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
        /HOME is relative/,
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("round-trips a fresh entry", () => {
    writeCtxProbeCache("http://localhost:8080/v1", 131072, {
      probedAt: 1000,
      env: env(),
    });
    expect(readCtxProbeCache("http://localhost:8080/v1", env())).toEqual({
      contextWindow: 131072,
      probedAt: 1000,
      probeFailCount: 0,
    });
    // The file is real JSON with the documented shape.
    const raw = JSON.parse(
      readFileSync(
        ctxProbeCachePath("http://localhost:8080/v1", env())!,
        "utf-8",
      ),
    );
    expect(raw).toEqual({
      contextWindow: 131072,
      probedAt: 1000,
      baseUrl: "http://localhost:8080/v1",
      probeFailCount: 0,
    });
  });

  it("returns null when no cache exists", () => {
    expect(readCtxProbeCache("http://localhost:8080/v1", env())).toBeNull();
  });

  it("returns null on malformed files", () => {
    const p = ctxProbeCachePath("http://localhost:8080/v1", env())!;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{not-json");
    expect(readCtxProbeCache("http://localhost:8080/v1", env())).toBeNull();
    writeFileSync(p, JSON.stringify({ contextWindow: -5, probedAt: 0 }));
    expect(readCtxProbeCache("http://localhost:8080/v1", env())).toBeNull();
    writeFileSync(p, JSON.stringify({ contextWindow: 131072 }));
    expect(readCtxProbeCache("http://localhost:8080/v1", env())).toBeNull();
  });

  it("writeCtxProbeCache is a no-op (no throw) for unparseable baseUrl", () => {
    expect(() =>
      writeCtxProbeCache("not-a-url", 4096, { probedAt: 1000, env: env() }),
    ).not.toThrow();
  });

  // ctxProbeTimeoutMs: the LITTLE_CODER_CTX_PROBE_TIMEOUT_MS parser.
  // Only a finite positive number is honored; empty/0/invalid → undefined,
  // which probeContextWindow maps to its 500 ms default.
  it("ctxProbeTimeoutMs: valid positive numbers pass through", () => {
    expect(ctxProbeTimeoutMs("250")).toBe(250);
    expect(ctxProbeTimeoutMs("1500")).toBe(1500);
    expect(ctxProbeTimeoutMs(" 75 ")).toBe(75);
  });

  it("ctxProbeTimeoutMs: empty/undefined/0/invalid → undefined (500 ms default)", () => {
    expect(ctxProbeTimeoutMs(undefined)).toBeUndefined();
    expect(ctxProbeTimeoutMs("")).toBeUndefined();
    expect(ctxProbeTimeoutMs("   ")).toBeUndefined();
    expect(ctxProbeTimeoutMs("0")).toBeUndefined();
    expect(ctxProbeTimeoutMs("-5")).toBeUndefined();
    expect(ctxProbeTimeoutMs("abc")).toBeUndefined();
    expect(ctxProbeTimeoutMs("1.5")).toBe(1.5);
  });

  it("isolates caches per host", () => {
    writeCtxProbeCache("http://localhost:8080/v1", 32768, {
      probedAt: 1000,
      env: env(),
    });
    writeCtxProbeCache("http://lan-box:1234/v1", 65536, {
      probedAt: 1000,
      env: env(),
    });
    expect(
      readCtxProbeCache("http://localhost:8080/v1", env())?.contextWindow,
    ).toBe(32768);
    expect(
      readCtxProbeCache("http://lan-box:1234/v1", env())?.contextWindow,
    ).toBe(65536);
  });

  it("readCtxProbeCache: fresh entry returns { contextWindow, probedAt }", () => {
    const now = Date.now();
    writeCtxProbeCache("http://localhost:8080/v1", 131072, {
      probedAt: now - 1000,
      env: env(),
    });
    expect(readCtxProbeCache("http://localhost:8080/v1", env())).toEqual({
      contextWindow: 131072,
      probedAt: now - 1000,
      probeFailCount: 0,
    });
  });

  it("readCtxProbeCache: a very old entry still returns a value (no TTL gate)", () => {
    writeCtxProbeCache("http://localhost:8080/v1", 131072, {
      probedAt: 0,
      env: env(),
    });
    expect(readCtxProbeCache("http://localhost:8080/v1", env())).toEqual({
      contextWindow: 131072,
      probedAt: 0,
      probeFailCount: 0,
    });
  });

  it("readCtxProbeCache: null for a missing or malformed file", () => {
    expect(readCtxProbeCache("http://localhost:8080/v1", env())).toBeNull();
    const p = ctxProbeCachePath("http://localhost:8080/v1", env())!;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{not-json");
    expect(readCtxProbeCache("http://localhost:8080/v1", env())).toBeNull();
  });

  // the host key alone can collide between different paths on the same
  // host — the stored baseUrl must be verified, else one provider's cached
  // window would be registered under a different baseUrl.
  it("readCtxProbeCache: null when the stored baseUrl differs (same host, different path)", () => {
    writeCtxProbeCache(
      "http://localhost:8080/v1",
      131072,
      { probedAt: Date.now() - 1000, env: env() },
    );
    expect(readCtxProbeCache("http://localhost:8080", env())).toBeNull();
  });
});

// ── index.ts probe flow (integration, stubbed fetch) ────────────────────────

describe("llama-cpp-provider extension probe flow", () => {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  let cacheDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "XDG_CACHE_HOME",
    "LITTLE_CODER_NO_CTX_PROBE",
    "LITTLE_CODER_LLAMACPP_PROPS_URL",
    "LITTLE_CODER_CTX_PROBE_TIMEOUT_MS",
  ];

  const okRes = (body: unknown) =>
    ({ ok: true, json: async () => body }) as Response;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "lc-probe-flow-"));
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    rmSync(cacheDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function runExtension(
    fetchStub: unknown,
  ): Promise<Record<string, any>> {
    vi.stubGlobal("fetch", fetchStub);
    const registered: Record<string, any> = {};
    const pi = {
      registerProvider: (name: string, cfg: any) => (registered[name] = cfg),
    };
    await extensionDefault(pi as any);
    return registered;
  }

  it("fresh cache: registers the cached window WITHOUT awaiting the network", async () => {
    // Pre-seed a fresh cache for the shipped llamacpp baseUrl.
    const { providers } = loadProviders(pkgRoot);
    const baseUrl = providers.llamacpp.baseUrl;
    writeCtxProbeCache(baseUrl, 999999, { probedAt: Date.now() });

    // A fetch that NEVER resolves: if the extension awaited it, this test
    // would hang; instead it must register with the cached window immediately.
    const neverResolving = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;
    const registered = await runExtension(neverResolving);
    expect(registered.llamacpp).toBeDefined();
    expect(registered.llamacpp.models[0].contextWindow).toBe(999999);
  });

  it("fresh cache: registers the cached window, fires exactly ONE background re-probe (never awaited); the fresh result applies to the NEXT launch", async () => {
    const { providers } = loadProviders(pkgRoot);
    const baseUrl = providers.llamacpp.baseUrl;
    writeCtxProbeCache(baseUrl, 999999, { probedAt: Date.now() }); // fresh cache

    let fetchCalls = 0;
    const counting = (() => {
      fetchCalls++;
      return okRes({ default_generation_settings: { n_ctx: 262144 } });
    }) as unknown as typeof fetch;
    const registered = await runExtension(counting);
    // this launch registers the CACHED window even though the re-probe
    // already returned a different value — the fresh result is for the next
    // launch only.
    expect(registered.llamacpp.models[0].contextWindow).toBe(999999);
    // exactly one background re-probe fired, and it was never awaited
    // (runExtension already resolved).
    await vi.waitFor(() => expect(fetchCalls).toBe(1));
    expect(fetchCalls).toBe(1);
    // And it wrote the cache for the next launch.
    await vi.waitFor(() =>
      expect(readCtxProbeCache(baseUrl)?.contextWindow).toBe(262144),
    );
  });

  it("stale cache: forces an AWAITED re-probe before use; on failure keeps the stale window and tracks the failure", async () => {
    const { providers } = loadProviders(pkgRoot);
    const baseUrl = providers.llamacpp.baseUrl;
    writeCtxProbeCache(baseUrl, 424242, { probedAt: 0 }); // probedAt = 0 → stale

    let fetchCalls = 0;
    // The re-probe is now AWAITED on the warm path for a stale cache; make it
    // fail fast (immediate reject) so the test does not pay the 500 ms timeout.
    const failing = (() => {
      fetchCalls++;
      return Promise.reject(new Error("ECONNREFUSED"));
    }) as unknown as typeof fetch;
    const registered = await runExtension(failing);
    // The stale window is kept (the re-probe failed), and runExtension only
    // resolves AFTER the awaited re-probe attempt.
    expect(registered.llamacpp.models[0].contextWindow).toBe(424242);
    expect(fetchCalls).toBe(1);
    // The consecutive failure is tracked in the cache (1 < warnAt=3 → no warn
    // yet); the original probe time is preserved so the cache stays stale.
    const cached = readCtxProbeCache(baseUrl);
    expect(cached?.contextWindow).toBe(424242);
    expect(cached?.probeFailCount).toBe(1);
    expect(cached?.probedAt).toBe(0);
  });

  it("LITTLE_CODER_CTX_PROBE_TIMEOUT_MS reaches the warm re-probe (now awaited for a stale cache)", async () => {
    const { providers } = loadProviders(pkgRoot);
    const baseUrl = providers.llamacpp.baseUrl;
    writeCtxProbeCache(baseUrl, 424242, { probedAt: 0 }); // stale → warm re-probe (awaited)
    process.env.LITTLE_CODER_CTX_PROBE_TIMEOUT_MS = "10";

    let signal: AbortSignal | undefined;
    let fetchStartedAt: number | undefined;
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) => {
      signal = init?.signal;
      fetchStartedAt = Date.now();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    }) as unknown as typeof fetch;
    const registered = await runExtension(fetchImpl);
    expect(registered.llamacpp.models[0].contextWindow).toBe(424242);
    expect(signal).toBeDefined();
    // The 10 ms override must abort the warm re-probe well inside ~50 ms; the
    // 500 ms default (i.e. timeoutMs NOT reaching the warm path) fails this.
    const abortedInTime = await Promise.race([
      new Promise<boolean>((resolve) => {
        if (signal!.aborted) return resolve(true);
        signal!.addEventListener("abort", () => resolve(true));
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(abortedInTime).toBe(true);
    expect(Date.now() - fetchStartedAt!).toBeLessThan(50);
  });

  it("no cache + failing fetch: keeps the declared window and writes no cache", async () => {
    const { providers } = loadProviders(pkgRoot);
    const baseUrl = providers.llamacpp.baseUrl;
    const declared = providers.llamacpp.models[0].contextWindow;

    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const registered = await runExtension(failing);
    expect(registered.llamacpp.models[0].contextWindow).toBe(declared);
    expect(readCtxProbeCache(baseUrl)).toBeNull();
  });

  it("no cache + successful probe: registers probed window and writes the cache", async () => {
    const { providers } = loadProviders(pkgRoot);
    const baseUrl = providers.llamacpp.baseUrl;

    const good = (async () =>
      okRes({
        default_generation_settings: { n_ctx: 262144 },
      })) as unknown as typeof fetch;
    const registered = await runExtension(good);
    expect(registered.llamacpp.models[0].contextWindow).toBe(262144);
    expect(readCtxProbeCache(baseUrl)?.contextWindow).toBe(262144);

    // Second launch (same cache dir) uses the written cache.
    const neverResolving = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;
    const registered2 = await runExtension(neverResolving);
    expect(registered2.llamacpp.models[0].contextWindow).toBe(262144);
  });

  it("LITTLE_CODER_NO_CTX_PROBE=1 skips the cache read entirely", async () => {
    const { providers } = loadProviders(pkgRoot);
    const baseUrl = providers.llamacpp.baseUrl;
    writeCtxProbeCache(baseUrl, 999999, { probedAt: Date.now() });
    process.env.LITTLE_CODER_NO_CTX_PROBE = "1";

    const neverResolving = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;
    const registered = await runExtension(neverResolving);
    expect(registered.llamacpp.models[0].contextWindow).toBe(
      providers.llamacpp.models[0].contextWindow, // declared, not cached
    );
  });
});

describe("resolveWarmCtxWindow (bounded staleness, pure)", () => {
  const baseUrl = "http://localhost:8080/v1";
  const now = 1_000_000_000_000; // arbitrary fixed "now"
  const day = 86400000;

  it("fresh cache (age <= 7d) is used as-is; the re-probe is NOT called", async () => {
    let probed = 0;
    const probe = async () => {
      probed++;
      return 999999;
    };
    const d = await resolveWarmCtxWindow({
      baseUrl,
      cached: { contextWindow: 131072, probedAt: now - 1 * day, probeFailCount: 0 },
      now,
      probe,
    });
    expect(d.mode).toBe("fresh");
    expect(d.contextWindow).toBe(131072);
    expect(d.probeFailCount).toBe(0);
    expect(d.warn).toBeNull();
    expect(probed).toBe(0); // re-probe is the caller's background job, not here
  });

  it("stale cache (age > 7d) triggers the re-probe; success uses the fresh window and resets failCount", async () => {
    let probed = 0;
    const probe = async () => {
      probed++;
      return 65536;
    };
    const d = await resolveWarmCtxWindow({
      baseUrl,
      cached: { contextWindow: 131072, probedAt: now - 8 * day, probeFailCount: 2 },
      now,
      probe,
    });
    expect(d.mode).toBe("reprobed");
    expect(probed).toBe(1);
    expect(d.contextWindow).toBe(65536); // fresh value
    expect(d.probedAt).toBe(now); // new timestamp
    expect(d.probeFailCount).toBe(0); // reset on success
    expect(d.warn).toBeNull();
  });

  it("stale cache + re-probe failure keeps the stale window, increments failCount, no warn below threshold", async () => {
    const probe = async () => undefined; // failure
    const d = await resolveWarmCtxWindow({
      baseUrl,
      cached: { contextWindow: 131072, probedAt: now - 8 * day, probeFailCount: 1 },
      now,
      probe,
    });
    expect(d.mode).toBe("reprobed");
    expect(d.contextWindow).toBe(131072); // keep stale value
    expect(d.probedAt).toBe(now - 8 * day); // keep original timestamp (still stale)
    expect(d.probeFailCount).toBe(2); // 1 + 1
    expect(d.warn).toBeNull(); // below warnAt=3
  });

  it("stale cache + re-probe failure reaching warnAt warns loudly", async () => {
    const probe = async () => undefined; // failure
    const d = await resolveWarmCtxWindow({
      baseUrl,
      cached: { contextWindow: 131072, probedAt: now - 30 * day, probeFailCount: 2 },
      now,
      probe,
    });
    expect(d.probeFailCount).toBe(3);
    expect(d.warn).not.toBeNull();
    expect(d.warn).toContain(baseUrl);
    expect(d.warn).toContain(`failed ${CTX_PROBE_FAIL_WARN_AT}x in a row`);
  });
});
