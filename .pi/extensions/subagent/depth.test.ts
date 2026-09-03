import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDelegationDepthConfig } from "./depth.js";

// The pipeline (mode-commands) and the subagent tool both call this as their
// single delegation gate; it resolves maxDepth with the precedence
// argv > runtime flag > env > default, and currentDepth from the env the
// runner propagates to children.
type FakePi = { getFlag: (name: string) => unknown };

const ENV_KEYS = [
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_MAX_DEPTH",
  "PI_SUBAGENT_STACK",
  "PI_SUBAGENT_PREVENT_CYCLES",
] as const;

describe("resolveDelegationDepthConfig", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      origEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (origEnv[k] === undefined) delete process.env[k];
      else process.env[k] = origEnv[k];
    }
  });

  it("defaults: depth 0, max 3, tool usable, cycles prevented", () => {
    const cfg = resolveDelegationDepthConfig({ getFlag: () => undefined });
    expect(cfg).toEqual({
      currentDepth: 0,
      maxDepth: 3,
      canUseSubagentTool: true,
      ancestorAgentStack: [],
      preventCycles: true,
    });
  });

  it("currentDepth === maxDepth closes the gate (the boundary the pipelines rely on)", () => {
    process.env.PI_SUBAGENT_DEPTH = "3";
    expect(
      resolveDelegationDepthConfig({ getFlag: () => undefined })
        .canUseSubagentTool,
    ).toBe(false);
    process.env.PI_SUBAGENT_DEPTH = "2";
    expect(
      resolveDelegationDepthConfig({ getFlag: () => undefined })
        .canUseSubagentTool,
    ).toBe(true);
  });

  it("maxDepth precedence: argv > runtime flag > env > default", () => {
    process.env.PI_SUBAGENT_MAX_DEPTH = "5";
    expect(
      resolveDelegationDepthConfig({ getFlag: () => undefined }).maxDepth,
    ).toBe(5);

    // Runtime flag beats env.
    expect(
      resolveDelegationDepthConfig({
        getFlag: (f) => (f === "subagent-max-depth" ? "7" : undefined),
      }).maxDepth,
    ).toBe(7);

    // An argv flag beats the runtime flag.
    process.argv.push("--subagent-max-depth=9");
    try {
      expect(
        resolveDelegationDepthConfig({
          getFlag: (f) => (f === "subagent-max-depth" ? "7" : undefined),
        }).maxDepth,
      ).toBe(9);
    } finally {
      process.argv.pop();
    }
  });

  it("an empty PI_SUBAGENT_DEPTH means unset (depth 0), not an invalid value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.PI_SUBAGENT_DEPTH = "   ";
      const cfg = resolveDelegationDepthConfig({ getFlag: () => undefined });
      expect(cfg.currentDepth).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("invalid values fall back with a warning; preventCycles env is honored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.PI_SUBAGENT_MAX_DEPTH = "lots";
      process.env.PI_SUBAGENT_PREVENT_CYCLES = "false";
      const cfg = resolveDelegationDepthConfig({ getFlag: () => undefined });
      expect(cfg.maxDepth).toBe(3); // invalid -> default
      expect(cfg.preventCycles).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
