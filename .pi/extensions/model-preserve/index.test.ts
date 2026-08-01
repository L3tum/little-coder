import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We can't easily import the extension default (it needs a real ExtensionAPI),
// so we test the observable behavior by importing the module source and
// inspecting its internals via its exported/accessible hooks.

// Instead of mocking ExtensionAPI, we test by simulating the event flow
// that the extension would receive. The extension registers handlers via
// pi.on() for three events: before_agent_start, session_start, tool_call.
// We'll verify the handler logic by checking its published behavior.

describe("model-preserve extension", () => {
  // Since the extension uses module-level state (prePlanModel, inPlanningPhase),
  // we need to test the actual default export by passing a mock ExtensionAPI.
  // We'll re-import the module for each test to reset state.

  let extension: (pi: any) => void;
  let pi: any;
  let handlers: Map<string, any[]>;

  beforeEach(async () => {
    // Create a fresh mock ExtensionAPI
    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      getCurrentModel: vi.fn(() => ({
        provider: "llamacpp",
        id: "qwen3.6-27b",
      })),
      getModelRegistry: vi.fn(() => ({
        find: vi.fn(() => ({
          provider: "llamacpp",
          id: "qwen3.6-27b",
        })),
      })),
      setModel: vi.fn().mockResolvedValue(true),
    };

    // Fresh import to reset module-level state
    vi.resetModules();
    const mod = await import("./index.js");
    extension = mod.default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers handlers for before_agent_start, session_start, and tool_call", () => {
    extension(pi);

    expect(pi.on).toHaveBeenCalledWith(
      "before_agent_start",
      expect.any(Function),
    );
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
  });

  it("captures model when system prompt includes PLANNING PHASE", async () => {
    extension(pi);

    const beforeAgentHandler = handlers.get("before_agent_start")[0];
    await beforeAgentHandler({
      systemPrompt: "You are a planning agent. PLANNING PHASE is active.",
      systemPromptOptions: {},
    });

    // Verify getCurrentModel was called to capture the model
    expect(pi.getCurrentModel).toHaveBeenCalledTimes(1);
  });

  it("restores model when system prompt includes EXECUTING PLAN", async () => {
    extension(pi);

    const beforeAgentHandler = handlers.get("before_agent_start")[0];

    // First enter planning phase
    await beforeAgentHandler({
      systemPrompt: "PLANNING PHASE",
      systemPromptOptions: {},
    });

    // Now transition to executing phase
    await beforeAgentHandler({
      systemPrompt: "EXECUTING PLAN",
      systemPromptOptions: {},
    });

    // Verify setModel was called to restore the model
    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(pi.getCurrentModel).toHaveBeenCalledTimes(1);
  });

  it("resets state on session_start", async () => {
    extension(pi);

    const beforeAgentHandler = handlers.get("before_agent_start")[0];
    const sessionHandler = handlers.get("session_start")[0];

    // Enter planning phase
    await beforeAgentHandler({
      systemPrompt: "PLANNING PHASE",
      systemPromptOptions: {},
    });

    // Session start should reset state
    await sessionHandler();

    // Now EXECUTING PLAN should NOT restore because state was reset
    await beforeAgentHandler({
      systemPrompt: "EXECUTING PLAN",
      systemPromptOptions: {},
    });

    // setModel should not have been called (state was reset)
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  it("captures model on plannotator_submit_plan tool call", async () => {
    extension(pi);

    const toolCallHandler = handlers.get("tool_call")[0];

    await toolCallHandler({
      toolName: "plannotator_submit_plan",
    });

    expect(pi.getCurrentModel).toHaveBeenCalledTimes(1);
  });

  it("gracefully handles undefined getCurrentModel", async () => {
    pi.getCurrentModel = undefined;

    extension(pi);

    const beforeAgentHandler = handlers.get("before_agent_start")[0];

    // Should not throw even with undefined getCurrentModel
    await expect(
      beforeAgentHandler({
        systemPrompt: "PLANNING PHASE",
        systemPromptOptions: {},
      }),
    ).resolves.not.toThrow();
  });

  it("does not restore model without prior PLANNING PHASE", async () => {
    extension(pi);

    const beforeAgentHandler = handlers.get("before_agent_start")[0];

    // Go straight to EXECUTING PLAN without PLANNING PHASE first
    await beforeAgentHandler({
      systemPrompt: "EXECUTING PLAN",
      systemPromptOptions: {},
    });

    // setModel should not be called
    expect(pi.setModel).not.toHaveBeenCalled();
  });
});
