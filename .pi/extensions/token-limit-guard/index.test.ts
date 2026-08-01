import { describe, it, expect, vi, beforeEach } from "vitest";
import { isTokenLimitError } from "./index.js";

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

describe("token-limit-guard extension behavior", () => {
  let extension: (pi: any) => void;
  let pi: any;
  let handlers: Map<string, any[]>;

  beforeEach(async () => {
    vi.resetModules();

    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
    };

    const mod = await import("./index.js");
    extension = mod.default;
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
    extension(pi);

    const turnEndHandler = handlers.get("turn_end")[0];

    const ctx = { abort: abortSpy };
    const event = {
      message: {
        stopReason: "error",
        errorMessage: "maximum token limit exceeded",
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
    extension(pi);

    const sessionHandler = handlers.get("session_start")[0];
    const turnEndHandler = handlers.get("turn_end")[0];

    // First, trigger a token limit turn to set the flag
    const ctx1 = { abort: vi.fn() };
    await turnEndHandler(
      {
        message: {
          stopReason: "error",
          errorMessage: "maximum token limit reached",
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
          stopReason: "error",
          errorMessage: "token limit exceeded",
          content: [],
        },
      },
      ctx2,
    );
    expect(ctx2.abort).toHaveBeenCalled();
  });

  it("handles ctx.abort throwing gracefully", async () => {
    extension(pi);

    const turnEndHandler = handlers.get("turn_end")[0];

    const ctx = {
      abort: vi.fn(() => {
        throw new Error("stale context");
      }),
    };

    const event = {
      message: {
        stopReason: "error",
        errorMessage: "maximum token limit reached",
        content: [],
      },
    };

    // Should not throw even if abort fails
    await expect(turnEndHandler(event, ctx)).resolves.not.toThrow();
  });
});
