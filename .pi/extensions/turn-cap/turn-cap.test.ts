import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import turnCap from "../turn-cap/index.ts";
import { createMockPi } from "../_shared/test-mock";

describe("turn-cap extension", () => {
  let handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  let mockPi: ReturnType<typeof createMockPi>["pi"];
  let envBackup: string | undefined;

  beforeEach(() => {
    const mock = createMockPi();
    handlers = mock.handlers;
    mockPi = mock.pi;
    envBackup = process.env.LITTLE_CODER_MAX_TURNS;
    delete process.env.LITTLE_CODER_MAX_TURNS;
  });

  afterEach(() => {
    if (envBackup) {
      process.env.LITTLE_CODER_MAX_TURNS = envBackup;
    } else {
      delete process.env.LITTLE_CODER_MAX_TURNS;
    }
  });

  const mockCtx = (_cap?: number) => {
    const abortFn = vi.fn();
    return {
      abort: abortFn,
      ui: { notify: vi.fn() },
      _abortFn: abortFn,
    };
  };

  it("does not abort when no cap is set", async () => {
    turnCap(mockPi);
    const ctx = mockCtx();
    for (let i = 0; i < 100; i++) {
      await handlers.turn_start[0]({}, ctx);
    }
    expect(ctx._abortFn).not.toHaveBeenCalled();
  });

  it("aborts when turn limit is exceeded", async () => {
    process.env.LITTLE_CODER_MAX_TURNS = "3";
    turnCap(mockPi);
    // Reset counter via before_agent_start
    await handlers.before_agent_start[0]({});

    const ctx = mockCtx();

    await handlers.turn_start[0]({}, ctx); // turn 1
    await handlers.turn_start[0]({}, ctx); // turn 2
    await handlers.turn_start[0]({}, ctx); // turn 3
    expect(ctx._abortFn).not.toHaveBeenCalled();

    await handlers.turn_start[0]({}, ctx); // turn 4 — should abort
    expect(ctx._abortFn).toHaveBeenCalled();
  });

  it("resets counter on before_agent_start", async () => {
    process.env.LITTLE_CODER_MAX_TURNS = "2";
    turnCap(mockPi);

    const ctx = mockCtx();

    await handlers.before_agent_start[0]({});
    await handlers.turn_start[0]({}, ctx);
    await handlers.turn_start[0]({}, ctx);

    // Reset for new "run"
    await handlers.before_agent_start[0]({});
    await handlers.turn_start[0]({}, ctx); // should NOT abort (new run)
    expect(ctx._abortFn).not.toHaveBeenCalled();
  });

  it("reads maxTurns from systemPromptOptions when provided", async () => {
    process.env.LITTLE_CODER_MAX_TURNS = "100"; // high cap via env
    turnCap(mockPi);
    // Override via systemPromptOptions
    await handlers.before_agent_start[0]({
      systemPromptOptions: { littleCoder: { maxTurns: 1 } },
    });

    const ctx = mockCtx();

    await handlers.turn_start[0]({}, ctx); // turn 1 — OK
    expect(ctx._abortFn).not.toHaveBeenCalled();

    await handlers.turn_start[0]({}, ctx); // turn 2 — should abort
    expect(ctx._abortFn).toHaveBeenCalled();
  });
});
