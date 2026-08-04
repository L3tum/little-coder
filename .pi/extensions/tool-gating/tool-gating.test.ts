import { describe, it, expect, beforeEach, afterEach } from "vitest";
import toolGating, { resetToolGatingCache } from "../tool-gating/index.ts";
import { createMockPi } from "../_shared/test-mock";

// Minimal event shape for tests — the real type (BuildSystemPromptOptions)
// has required fields we don't need in tests.
interface TestBeforeAgentStartEvent {
  systemPromptOptions?: Record<string, unknown>;
}

describe("tool-gating extension", () => {
  let handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  let mockPi: ReturnType<typeof createMockPi>["pi"];
  let envBackup: string | undefined;

  beforeEach(() => {
    resetToolGatingCache(); // Clear module-level cache between tests
    const mock = createMockPi();
    handlers = mock.handlers;
    mockPi = mock.pi;
    envBackup = process.env.LITTLE_CODER_ALLOWED_TOOLS;
    delete process.env.LITTLE_CODER_ALLOWED_TOOLS;
  });

  afterEach(() => {
    if (envBackup) {
      process.env.LITTLE_CODER_ALLOWED_TOOLS = envBackup;
    } else {
      delete process.env.LITTLE_CODER_ALLOWED_TOOLS;
    }
  });

  it("allows all tools when LITTLE_CODER_ALLOWED_TOOLS is not set", async () => {
    toolGating(mockPi);
    const handler = handlers.tool_call[0];
    const result = await handler({ toolName: "bash" });
    expect(result).toBeUndefined();
  });

  it("blocks tools not in the allowed list", async () => {
    process.env.LITTLE_CODER_ALLOWED_TOOLS = "read,write";
    toolGating(mockPi);
    const handler = handlers.tool_call[0];
    const result = await handler({ toolName: "bash" });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("not in _allowed_tools"),
    });
  });

  it("allows tools in the allowed list", async () => {
    process.env.LITTLE_CODER_ALLOWED_TOOLS = "read,bash,write";
    toolGating(mockPi);
    const handler = handlers.tool_call[0];
    const result = await handler({ toolName: "bash" });
    expect(result).toBeUndefined();
  });

  it("publishes allowed tools on systemPromptOptions", async () => {
    process.env.LITTLE_CODER_ALLOWED_TOOLS = "read,write";
    toolGating(mockPi);
    const event: TestBeforeAgentStartEvent = { systemPromptOptions: {} };
    await handlers.before_agent_start[0](event);
    const lc = event.systemPromptOptions?.littleCoder as
      { allowedTools?: string[] } | undefined;
    expect(lc?.allowedTools).toEqual(["read", "write"]);
  });
});
