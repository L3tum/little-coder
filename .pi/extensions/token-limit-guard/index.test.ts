import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTokenLimitError, MAX_TOTAL_LENGTH_STOPS } from "./index.js";

describe("isTokenLimitError", () => {
  it("detects 'maximum token limit reached'", () => {
    expect(isTokenLimitError("maximum token limit reached")).toBe(true);
  });

  it("detects 'max_tokens exceeded'", () => {
    expect(isTokenLimitError("max_tokens exceeded")).toBe(true);
  });

  it("detects 'exceeded the token limit'", () => {
    expect(isTokenLimitError("exceeded the token limit")).toBe(true);
  });

  it("detects 'token budget exceeded'", () => {
    expect(isTokenLimitError("token budget exceeded")).toBe(true);
  });

  it("detects case-insensitive 'Maximum Output Token Limit'", () => {
    expect(isTokenLimitError("Maximum Output Token Limit")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isTokenLimitError("")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isTokenLimitError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isTokenLimitError(undefined)).toBe(false);
  });

  it("returns false for network error", () => {
    expect(isTokenLimitError("network error")).toBe(false);
  });

  it("returns false for model not found", () => {
    expect(isTokenLimitError("model not found")).toBe(false);
  });

  it("returns false for rate limit error", () => {
    expect(isTokenLimitError("rate limit exceeded")).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(isTokenLimitError("")).toBe(false);
  });

  it("detects 'maximum output token limit exceeded' (multi-word)", () => {
    expect(isTokenLimitError("maximum output token limit exceeded")).toBe(true);
  });
});

describe("token-limit-guard extension behavior (auto-continue OFF — pre-change behavior)", () => {
  let extension: (pi: any) => void;
  let pi: any;
  let handlers: Map<string, any[]>;
  let mod: any;

  // Pin the settings env to fresh EMPTY scratch dirs so
  // token_limit_auto_continue is unresolvable (deterministic default) instead
  // of reading the developer's real ~/.pi/agent/settings.json. The dirs are
  // PER-TEST (not describe-scoped): a trust.json written by one test must not
  // leak its entries into later tests' trust decisions.
  let agentDir: string;
  let pkgRoot: string;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;

  beforeEach(async () => {
    agentDir = mkdtempSync(join(tmpdir(), "tlg-off-agent-"));
    pkgRoot = mkdtempSync(join(tmpdir(), "tlg-off-pkg-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot;

    // These assertions pin the pre-auto-continue behavior (intervention +
    // abort), so run them with the safety-valve off-switch.
    process.env.LITTLE_CODER_TOKEN_LIMIT_AUTO_CONTINUE = "0";
    vi.resetModules();

    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
    };

    mod = await import("./index.js");
    extension = mod.default;
  });

  afterEach(() => {
    delete process.env.LITTLE_CODER_TOKEN_LIMIT_AUTO_CONTINUE;
    // module instances are fresh per test via vi.resetModules — nothing to reset
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
  });

  it("registers handlers for session_start and turn_end", () => {
    extension(pi);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
  });

  it("calls harnessIntervention and ctx.abort for token limit turns", async () => {
    const harnessInterventionSpy = vi.fn();
    const abortSpy = vi.fn();

    vi.doMock("../_shared/intervention.ts", () => ({
      harnessIntervention: harnessInterventionSpy,
    }));

    vi.resetModules();

    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
    };

    const mod = await import("./index.js");
    extension = mod.default;
    // Compaction explicitly disabled so the abort is asserted for the right
    // reason (pi-vcc is not require()'able under vitest) — set on this
    // freshly imported module instance.
    mod._setCompactionCheckerForTests(() => false);
    extension(pi);

    const turnEndHandler = handlers.get("turn_end")[0];

    const ctx = { abort: abortSpy };
    const event = {
      message: {
        stopReason: "length",
        content: [],
      },
    };

    await turnEndHandler(event, ctx);

    expect(harnessInterventionSpy).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("maximum output token limit"),
    );
    expect(abortSpy).toHaveBeenCalled();
  });

  it("does NOT treat an error stop with a token-limit-looking message as a length stop (quota errors must not consume the auto-continue budget)", async () => {
    const harnessInterventionSpy = vi.fn();
    const abortSpy = vi.fn();

    vi.doMock("../_shared/intervention.ts", () => ({
      harnessIntervention: harnessInterventionSpy,
    }));

    vi.resetModules();

    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
    };

    const mod = await import("./index.js");
    extension = mod.default;
    mod._setCompactionCheckerForTests(() => false);
    extension(pi);

    const turnEndHandler = handlers.get("turn_end")[0];

    const ctx = { abort: abortSpy };
    // A provider quota/billing error whose message matches the token-limit
    // regexes ("token ... exceeded"): NOT a context overflow. The guard must
    // leave it alone — no nudge, no budget increment, no abort — so
    // quality-monitor / other error-turn handlers see it.
    const event = {
      message: {
        stopReason: "error",
        errorMessage: "your monthly token budget exceeded",
        content: [],
      },
    };

    await turnEndHandler(event, ctx);

    expect(harnessInterventionSpy).not.toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("skips non-token-limit turns", async () => {
    vi.resetModules();

    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
    };

    const mod = await import("./index.js");
    extension = mod.default;
    extension(pi);

    const turnEndHandler = handlers.get("turn_end")[0];

    const ctx = { abort: vi.fn() };
    const event = {
      message: {
        stopReason: "error",
        errorMessage: "network timeout",
        content: [],
      },
    };

    await turnEndHandler(event, ctx);

    // ctx.abort should NOT be called for non-token-limit errors
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("resets tokenLimitHandled flag on session_start", async () => {
    // Compaction explicitly disabled → both token-limit turns abort.
    mod._setCompactionCheckerForTests(() => false);
    extension(pi);

    const sessionHandler = handlers.get("session_start")[0];
    const turnEndHandler = handlers.get("turn_end")[0];

    // First, trigger a token limit turn to set the flag
    const ctx1 = { abort: vi.fn() };
    await turnEndHandler(
      {
        message: {
          stopReason: "length",
          content: [],
        },
      },
      ctx1,
    );
    expect(ctx1.abort).toHaveBeenCalled();

    // Session start resets the flag
    await sessionHandler();

    // Now a new token limit turn should be handled again
    const ctx2 = { abort: vi.fn() };
    await turnEndHandler(
      {
        message: {
          stopReason: "length",
          content: [],
        },
      },
      ctx2,
    );
    expect(ctx2.abort).toHaveBeenCalled();
  });

  it("handles ctx.abort throwing gracefully", async () => {
    // Compaction explicitly disabled → the abort path is the one under test.
    mod._setCompactionCheckerForTests(() => false);
    extension(pi);

    const turnEndHandler = handlers.get("turn_end")[0];

    const ctx = {
      abort: vi.fn(() => {
        throw new Error("stale context");
      }),
    };

    const event = {
      message: {
        stopReason: "length",
        content: [],
      },
    };

    // Should not throw even if abort fails
    await expect(turnEndHandler(event, ctx)).resolves.not.toThrow();
  });

  it("treats a length stop as a token limit turn (local openai-completions)", async () => {
    const harnessInterventionSpy = vi.fn();
    const abortSpy = vi.fn();

    vi.doMock("../_shared/intervention.ts", () => ({
      harnessIntervention: harnessInterventionSpy,
    }));

    vi.resetModules();

    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
    };

    const mod = await import("./index.js");
    extension = mod.default;
    // Compaction explicitly disabled (see the "calls harnessIntervention" test
    // above) — set on this freshly imported module instance.
    mod._setCompactionCheckerForTests(() => false);
    extension(pi);

    const turnEndHandler = handlers.get("turn_end")[0];

    const ctx = { abort: abortSpy };
    const event = {
      message: {
        stopReason: "length",
        // A single token printed before the output cap was hit
        content: [{ type: "text", text: "I" }],
      },
    };

    await turnEndHandler(event, ctx);

    expect(harnessInterventionSpy).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("maximum output token limit"),
    );
    expect(abortSpy).toHaveBeenCalled();
  });

  it("treats an empty length stop as a token limit turn", async () => {
    const harnessInterventionSpy = vi.fn();
    const abortSpy = vi.fn();

    vi.doMock("../_shared/intervention.ts", () => ({
      harnessIntervention: harnessInterventionSpy,
    }));

    vi.resetModules();

    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
    };

    const mod = await import("./index.js");
    extension = mod.default;
    // Compaction explicitly disabled (see the "calls harnessIntervention" test
    // above) — set on this freshly imported module instance.
    mod._setCompactionCheckerForTests(() => false);
    extension(pi);

    const turnEndHandler = handlers.get("turn_end")[0];

    const ctx = { abort: abortSpy };
    const event = {
      message: {
        stopReason: "length",
        content: [],
      },
    };

    await turnEndHandler(event, ctx);

    expect(harnessInterventionSpy).toHaveBeenCalled();
    expect(abortSpy).toHaveBeenCalled();
  });

  it("does not treat a normal stop as a token limit turn", async () => {
    const harnessInterventionSpy = vi.fn();
    const abortSpy = vi.fn();

    vi.doMock("../_shared/intervention.ts", () => ({
      harnessIntervention: harnessInterventionSpy,
    }));

    vi.resetModules();

    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
    };

    const mod = await import("./index.js");
    extension = mod.default;
    extension(pi);

    const turnEndHandler = handlers.get("turn_end")[0];

    const ctx = { abort: abortSpy };
    const event = {
      message: {
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
      },
    };

    await turnEndHandler(event, ctx);

    expect(harnessInterventionSpy).not.toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("with compaction enabled the off-switch intervenes but does not abort (pi-vcc recovers)", async () => {
    const harnessInterventionSpy = vi.fn();
    const abortSpy = vi.fn();

    vi.doMock("../_shared/intervention.ts", () => ({
      harnessIntervention: harnessInterventionSpy,
    }));

    vi.resetModules();

    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
    };

    const mod = await import("./index.js");
    extension = mod.default;
    // Compaction explicitly enabled — set on this freshly imported module
    // instance (pi-vcc is not require()'able under vitest).
    mod._setCompactionCheckerForTests(() => true);
    extension(pi);

    const turnEndHandler = handlers.get("turn_end")[0];

    const ctx = { abort: abortSpy };
    const event = {
      message: {
        stopReason: "length",
        content: [],
      },
    };

    await turnEndHandler(event, ctx);

    expect(harnessInterventionSpy).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("compaction will recover"),
    );
    expect(abortSpy).not.toHaveBeenCalled();
  });
});

describe("token-limit-guard auto-continue (default ON)", () => {
  let harnessInterventionSpy: any;
  let pi: any;
  let handlers: Map<string, any[]>;
  let sendUserMessage: any;
  let mod: any;

  const lengthStopEvent = { message: { stopReason: "length", content: [] } };

  // Pin the settings env to fresh EMPTY scratch dirs so
  // token_limit_auto_continue is unresolvable (deterministic default) instead
  // of reading the developer's real ~/.pi/agent/settings.json. The dirs are
  // PER-TEST (not describe-scoped): a trust.json written by one test must not
  // leak its entries into later tests' trust decisions.
  let agentDir: string;
  let pkgRoot: string;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;

  beforeEach(async () => {
    agentDir = mkdtempSync(join(tmpdir(), "tlg-on-agent-"));
    pkgRoot = mkdtempSync(join(tmpdir(), "tlg-on-pkg-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot;
    delete process.env.LITTLE_CODER_TOKEN_LIMIT_AUTO_CONTINUE;
    harnessInterventionSpy = vi.fn();
    vi.doMock("../_shared/intervention.ts", () => ({
      harnessIntervention: harnessInterventionSpy,
    }));
    vi.resetModules();
    handlers = new Map();
    sendUserMessage = vi.fn();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      sendUserMessage,
    };
    mod = await import("./index.js");
    mod.default(pi);
  });

  afterEach(() => {
    delete process.env.LITTLE_CODER_TOKEN_LIMIT_AUTO_CONTINUE;
    // module instances are fresh per test via vi.resetModules — nothing to reset
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
  });

  // A real auto-continue sequence is a series of turns: turn_start fires
  // before each turn_end (that is what resets the handled-once flag).
  async function fireTurn(ctx: any, event: any = lengthStopEvent) {
    for (const h of handlers.get("turn_start") ?? []) await h({}, ctx);
    for (const h of handlers.get("turn_end") ?? []) await h(event, ctx);
  }

  it("registers turn_start and session_compact handlers", () => {
    expect(handlers.get("turn_start")).toHaveLength(1);
    expect(handlers.get("session_compact")).toHaveLength(1);
  });

  it("length stop #1: steers a targeted nudge, does not abort", async () => {
    const ctx = { abort: vi.fn() };
    await fireTurn(ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendUserMessage.mock.calls[0];
    expect(opts).toEqual({ deliverAs: "steer" });
    expect(msg).toContain("cut off");
    expect(msg).not.toEqual("Continue");
    expect(harnessInterventionSpy).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("auto-continuing (stop 1/3)"),
    );
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("stops 1→2→3: three nudges, escalating intervention text", async () => {
    const ctx = { abort: vi.fn() };
    await fireTurn(ctx);
    await fireTurn(ctx);
    await fireTurn(ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    expect(
      harnessInterventionSpy.mock.calls.map((c: any[]) => c[1]).join(" "),
    ).toContain("stop 2/3");
    // From the 2nd stop on, the nudge also suggests splitting the work.
    expect(sendUserMessage.mock.calls[1][0]).toContain("smaller steps");
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("stop 4: concise correction (no abort)", async () => {
    const ctx = { abort: vi.fn() };
    for (let i = 0; i < 4; i++) await fireTurn(ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(4);
    expect(sendUserMessage.mock.calls[3][0]).toContain("4 times in a row");
    expect(harnessInterventionSpy).toHaveBeenLastCalledWith(
      ctx,
      expect.stringContaining("more concise"),
    );
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("stop 5: backoff — no new nudge, abort (compaction disabled)", async () => {
    // Explicitly disable compaction so the abort is asserted for the right
    // reason (previously it passed because the checker was undefined).
    mod._setCompactionCheckerForTests(() => false);
    const ctx = { abort: vi.fn() };
    for (let i = 0; i < 5; i++) await fireTurn(ctx);
    // Nudges for stops 1-3 + concise correction for stop 4; nothing for 5.
    expect(sendUserMessage).toHaveBeenCalledTimes(4);
    expect(harnessInterventionSpy).toHaveBeenLastCalledWith(
      ctx,
      expect.stringContaining("5 times in a row"),
    );
    expect(ctx.abort).toHaveBeenCalledTimes(1);
  });

  it("stop 5: backoff — compaction enabled, no abort", async () => {
    mod._setCompactionCheckerForTests(() => true);
    const ctx = { abort: vi.fn() };
    for (let i = 0; i < 5; i++) await fireTurn(ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(4);
    expect(harnessInterventionSpy).toHaveBeenLastCalledWith(
      ctx,
      expect.stringContaining("5 times in a row"),
    );
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("settings read failure: auto-continue stays ON (deliberate fail-open, loud)", async () => {
    // readLittleCoderScope never throws (a malformed/unreadable file simply
    // contributes nothing), so the throw is simulated at the resolver level
    // — the catch in isAutoContinueEnabled is the defensive last line for
    // any read failure from the resolver chain, and it must fail open to
    // the DEFAULT (ON) and stay loud.
    vi.doMock(
      "../_shared/little-coder-settings.mjs",
      async (importOriginal) => {
        const actual = await importOriginal<any>();
        return {
          ...actual,
          resolveLittleCoderSettings: () => {
            throw new Error("simulated settings read failure");
          },
        };
      },
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Fresh module state so the mocked resolver is in the import graph.
      vi.resetModules();
      const freshHandlers = new Map<string, any[]>();
      const freshSend = vi.fn();
      const freshPi = {
        on: vi.fn((event: string, handler: any) => {
          freshHandlers.set(event, [
            ...(freshHandlers.get(event) ?? []),
            handler,
          ]);
        }),
        sendUserMessage: freshSend,
      };
      const freshMod = await import("./index.js");
      freshMod.default(freshPi);
      const ctx = { abort: vi.fn() };
      for (const h of freshHandlers.get("turn_start") ?? []) await h({}, ctx);
      for (const h of freshHandlers.get("turn_end") ?? [])
        await h(lengthStopEvent, ctx);
      // Still auto-continues (the fail-open goes to the DEFAULT, ON) …
      expect(freshSend).toHaveBeenCalledTimes(1);
      expect(ctx.abort).not.toHaveBeenCalled();
      // … and the failure is loud, not silent.
      expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
        /settings read failed, auto-continue stays ON/,
      );
      // … and it fires ONCE per turn (the fail-open is de-spamed, not repeated
      // on every stop in the auto-continue loop).
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
      vi.doUnmock("../_shared/little-coder-settings.mjs");
    }
  });

  it("a healthy (stop) turn between length stops resets the sequence", async () => {
    const ctx = { abort: vi.fn() };
    await fireTurn(ctx);
    await fireTurn(ctx, { message: { stopReason: "stop", content: [] } });
    sendUserMessage.mockClear();
    await fireTurn(ctx);
    // Fresh nudge budget — first nudge again, not the concise correction.
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(harnessInterventionSpy).toHaveBeenLastCalledWith(
      ctx,
      expect.stringContaining("stop 1/3"),
    );
  });

  it("turn_start resets tokenLimitHandled: handled-once-per-turn, then again next turn", async () => {
    const ctx = { abort: vi.fn() };
    const turnEnd = handlers.get("turn_end")[0];
    // Two turn_end events with no turn_start in between: the second must be
    // skipped (handled-once-per-turn), then a new turn handles it again.
    await turnEnd(lengthStopEvent, ctx);
    await turnEnd(lengthStopEvent, ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    for (const h of handlers.get("turn_start") ?? []) await h({}, ctx);
    await turnEnd(lengthStopEvent, ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("session_compact resets the length-stop loop", async () => {
    const ctx = { abort: vi.fn() };
    for (let i = 0; i < 4; i++) await fireTurn(ctx); // escalates to concise
    for (const h of handlers.get("session_compact") ?? []) await h({});
    sendUserMessage.mockClear();
    await fireTurn(ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls[0][0]).toContain("cut off");
    expect(harnessInterventionSpy).toHaveBeenLastCalledWith(
      ctx,
      expect.stringContaining("stop 1/3"),
    );
  });

  it("env off-switch restores the old behavior (abort, no sendUserMessage)", async () => {
    // Compaction explicitly disabled so the abort is asserted for the right
    // reason (pi-vcc is not require()'able under vitest).
    mod._setCompactionCheckerForTests(() => false);
    process.env.LITTLE_CODER_TOKEN_LIMIT_AUTO_CONTINUE = "0";
    const ctx = { abort: vi.fn() };
    await fireTurn(ctx);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(harnessInterventionSpy).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("will not be retried"),
    );
    expect(ctx.abort).toHaveBeenCalled();
  });

  it("off-switch fires on EVERY token-limit turn (two-turn OFF, compaction disabled)", async () => {
    // Pins actual OFF-mode behavior: the intervention (+abort) is not
    // once per session — handled-once-per-turn, reset by turn_start.
    mod._setCompactionCheckerForTests(() => false);
    process.env.LITTLE_CODER_TOKEN_LIMIT_AUTO_CONTINUE = "0";
    const ctx = { abort: vi.fn() };
    await fireTurn(ctx);
    await fireTurn(ctx);
    expect(harnessInterventionSpy).toHaveBeenCalledTimes(2);
    expect(ctx.abort).toHaveBeenCalledTimes(2);
  });

  it("P1: memo — consecutive token-limit turns with unchanged settings read once", async () => {
    // Compaction enabled so the ON path steers (no abort to assert).
    mod._setCompactionCheckerForTests(() => true);
    const cwd = mkdtempSync(join(tmpdir(), "tlg-p1-cwd-"));
    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ little_coder: {} }),
      );
      writeFileSync(
        join(agentDir, "trust.json"),
        JSON.stringify({ [realpathSync(cwd)]: true }),
      );
      // Count the shared resolver's reads. The spy intercepts only if
      // index.js calls through the module namespace — a 0-call result would
      // fail the toHaveBeenCalledTimes(1) below, so a broken spy is caught.
      const settingsMod: any =
        await import("../_shared/little-coder-settings.mjs");
      const spy = vi.spyOn(settingsMod, "resolveLittleCoderSettings");
      const ctx: any = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      // Two consecutive token-limit turns, settings unchanged: the second
      // turn's isAutoContinueEnabled must hit the freshness-keyed memo.
      await fireTurn(ctx);
      await fireTurn(ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("settings off-switch (token_limit_auto_continue: false) disables auto-continue", async () => {
    // Compaction explicitly disabled so the abort is asserted for the right
    // reason (pi-vcc is not require()'able under vitest).
    mod._setCompactionCheckerForTests(() => false);
    const cwd = mkdtempSync(join(tmpdir(), "tlg-test-cwd-"));
    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
          little_coder: { token_limit_auto_continue: false },
        }),
      );
      // the per-repo value is trust-gated — grant trust so this
      // project-scoped false is honored (the untrusted case is pinned by
      // 16.4a).
      writeFileSync(
        join(agentDir, "trust.json"),
        JSON.stringify({ [realpathSync(cwd)]: true }),
      );
      // the settings resolver is unmemoized — no cache to clear; the
      // guard re-reads this settings file fresh on the turn below.)
      const ctx = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      await fireTurn(ctx);
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(ctx.abort).toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a NON-boolean token_limit_auto_continue (string 'false') does NOT disable auto-continue — only a strict boolean false does", async () => {
    // The typeof guard: `"false"` (a string) is not a boolean, so it falls
    // through to the default ON rather than being coerced. Pins the
    // "only a strict boolean false disables it" contract.
    mod._setCompactionCheckerForTests(() => false);
    const cwd = mkdtempSync(join(tmpdir(), "tlg-test-cwd-"));
    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
          little_coder: { token_limit_auto_continue: "false" },
        }),
      );
      writeFileSync(
        join(agentDir, "trust.json"),
        JSON.stringify({ [realpathSync(cwd)]: true }),
      );
      const ctx = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      await fireTurn(ctx);
      // Auto-continue stays ON: the nudge is sent, no abort.
      expect(sendUserMessage).toHaveBeenCalled();
      expect(ctx.abort).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // defensive steer + session-lifetime ceiling.

  it("a throwing sendUserMessage does not crash turn_end (defensive steer)", async () => {
    mod._setCompactionCheckerForTests(() => false);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    sendUserMessage.mockImplementation(() => {
      throw new Error("stale ctx");
    });
    const cwd = mkdtempSync(join(tmpdir(), "tlg-t1-cwd-"));
    try {
      const ctx = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      await expect(fireTurn(ctx)).resolves.toBeUndefined();
      // stderr logged, and the pre-auto-continue fallback ran (abort with
      // compaction disabled).
      expect(consoleError).toHaveBeenCalled();
      expect(ctx.abort).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      consoleError.mockRestore();
    }
  });

  it("11 length-stops across compactions → backoff intervention fires exactly once (lifetime ceiling)", async () => {
    mod._setCompactionCheckerForTests(() => false);
    const cwd = mkdtempSync(join(tmpdir(), "tlg-t2-cwd-"));
    try {
      const ctx = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      // Each compaction resets the STREAK, so without the lifetime ceiling
      // every stop would nudge again.
      for (let stop = 1; stop <= 11; stop++) {
        if (stop > 1) {
          for (const h of handlers.get("session_compact") ?? [])
            await h({}, ctx);
        }
        await fireTurn(ctx);
      }
      // Stops 1-9 steer (nudge each, streak reset to 1 by compaction); the
      // 10th and 11th hit the ceiling: abort, no steer. The cap intervention
      // fires ONCE (on the 10th, backoffNotified) — the 11th is de-spammed
      // (session_compact deliberately does NOT reset backoffNotified).
      expect(sendUserMessage).toHaveBeenCalledTimes(9);
      expect(ctx.abort).toHaveBeenCalledTimes(2);
      expect(harnessInterventionSpy).toHaveBeenCalledTimes(10); // 9 steers + 1 cap
      expect(harnessInterventionSpy).toHaveBeenLastCalledWith(
        ctx,
        expect.stringContaining(`${MAX_TOTAL_LENGTH_STOPS} times this session`),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a healthy turn resets only the streak; session_start resets the lifetime total", async () => {
    mod._setCompactionCheckerForTests(() => true); // no aborts to assert
    const cwd = mkdtempSync(join(tmpdir(), "tlg-t3-cwd-"));
    try {
      const ctx = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      const healthy = { message: { stopReason: "stop", content: [] } };
      // Three nudges, healthy turn, then the streak restarts at 1.
      for (let i = 0; i < 3; i++) await fireTurn(ctx);
      await fireTurn(ctx, healthy);
      await fireTurn(ctx);
      expect(sendUserMessage).toHaveBeenCalledTimes(4);
      expect(harnessInterventionSpy).toHaveBeenLastCalledWith(
        ctx,
        expect.stringContaining("stop 1/3"),
      );
      // Drive the lifetime total to the ceiling (compaction resets the
      // streak between stops), then session_start must reset it.
      for (let stop = 0; stop < 7; stop++) {
        for (const h of handlers.get("session_compact") ?? []) await h({}, ctx);
        await fireTurn(ctx);
      }
      expect(sendUserMessage).toHaveBeenCalledTimes(9); // 9th steer (total=9)
      await fireTurn(ctx); // total=10 -> ceiling, no steer
      expect(sendUserMessage).toHaveBeenCalledTimes(9);
      for (const h of handlers.get("session_start") ?? []) await h({}, ctx);
      await fireTurn(ctx); // fresh session -> auto-continue resumes
      expect(sendUserMessage).toHaveBeenCalledTimes(10);
      expect(ctx.abort).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("session_compact does NOT reset the lifetime total", async () => {
    mod._setCompactionCheckerForTests(() => true);
    const cwd = mkdtempSync(join(tmpdir(), "tlg-t4-cwd-"));
    try {
      const ctx = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      // 9 stops across compactions (total=9), then compaction again, then
      // the 10th stop must still hit the ceiling despite the streak reset.
      for (let stop = 1; stop <= 10; stop++) {
        if (stop > 1) {
          for (const h of handlers.get("session_compact") ?? [])
            await h({}, ctx);
        }
        await fireTurn(ctx);
      }
      expect(sendUserMessage).toHaveBeenCalledTimes(9);
      expect(ctx.abort).not.toHaveBeenCalled(); // compaction enabled
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // 16 series: concise-tier defensive steer, env-vs-settings precedence,
  // double-recovery pin, trust gating.

  it("16.1: a concise-tier steer that throws synchronously logs and aborts once (compaction off)", async () => {
    mod._setCompactionCheckerForTests(() => false);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let calls = 0;
    sendUserMessage.mockImplementation(() => {
      calls += 1;
      if (calls === 4) throw new Error("stale ctx");
    });
    const cwd = mkdtempSync(join(tmpdir(), "tlg-16-1-cwd-"));
    try {
      const ctx = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      // Stops 1-3 nudge fine; stop 4 (concise tier) throws synchronously.
      for (let i = 0; i < 4; i++) await fireTurn(ctx);
      expect(sendUserMessage).toHaveBeenCalledTimes(4);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("concise steer failed"),
      );
      expect(ctx.abort).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      consoleError.mockRestore();
    }
  });

  it("16.2: env off-switch (0) beats a per-repo token_limit_auto_continue: true", async () => {
    mod._setCompactionCheckerForTests(() => false);
    process.env.LITTLE_CODER_TOKEN_LIMIT_AUTO_CONTINUE = "0";
    const cwd = mkdtempSync(join(tmpdir(), "tlg-16-2-cwd-"));
    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ little_coder: { token_limit_auto_continue: true } }),
      );
      const ctx = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      await fireTurn(ctx);
      // Env switch is absolute: auto-continue stays off despite the setting.
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(ctx.abort).toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("16.3 (pin): with compaction ON the continue tier still steers — exactly one steer, no abort", async () => {
    // Pins: no isCompactionEnabled guard on the steer tiers. A guard
    // would silently kill auto-continue in the default (compaction-on)
    // configuration.
    mod._setCompactionCheckerForTests(() => true);
    const ctx = { abort: vi.fn() };
    await fireTurn(ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("16.4a: an UNTRUSTED per-repo token_limit_auto_continue: false is ignored — the safety net stays on", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tlg-16-4a-cwd-"));
    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ little_coder: { token_limit_auto_continue: false } }),
      );
      // No trust.json + no defaultProjectTrust → untrusted (fail closed).
      // (True by construction: the per-test agentDir starts empty, so no
      // earlier test's trust.json entry can leak in.)
      const ctx = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      await fireTurn(ctx);
      // Untrusted repo cannot disable auto-continue: the nudge still fires.
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(ctx.abort).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("16.4b: a TRUSTED per-repo token_limit_auto_continue: false disables auto-continue", async () => {
    mod._setCompactionCheckerForTests(() => false);
    const cwd = mkdtempSync(join(tmpdir(), "tlg-16-4b-cwd-"));
    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ little_coder: { token_limit_auto_continue: false } }),
      );
      writeFileSync(
        join(agentDir, "trust.json"),
        JSON.stringify({ [realpathSync(cwd)]: true }),
      );
      const ctx = {
        abort: vi.fn(),
        sessionManager: { getCwd: () => cwd },
      };
      await fireTurn(ctx);
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(ctx.abort).toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
