import { describe, it, expect, vi, beforeEach } from "vitest";

// Extension-level tests for quality-monitor's turn_end corrections:
// - an empty response normally triggers a "STOP: previous response was empty" steer
// - the FIRST empty response after a compaction is suppressed (resume artifact)
// - a later empty response is corrected again
// - interrupted turns (aborted / length) never trigger corrections
describe("quality-monitor extension behavior", () => {
  let extension: (pi: any) => void;
  let pi: any;
  let handlers: Map<string, any[]>;
  let sendUserMessage: ReturnType<typeof vi.fn>;

  function emptyTurn(stopReason = "stop") {
    return {
      message: {
        role: "assistant",
        stopReason,
        content: [],
      },
      toolResults: [],
    };
  }

  beforeEach(async () => {
    vi.resetModules();

    handlers = new Map();
    sendUserMessage = vi.fn();
    pi = {
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      sendUserMessage,
    };

    const mod = await import("./index.js");
    extension = mod.default;
  });

  it("registers handlers for its events", () => {
    extension(pi);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_compact", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
  });

  it("corrects a plain empty response with a steer", async () => {
    extension(pi);

    const sessionStart = handlers.get("session_start")[0];
    const turnEnd = handlers.get("turn_end")[0];
    await sessionStart();

    const ctx = { ui: { notify: vi.fn() } };
    await turnEnd(emptyTurn(), ctx);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls[0][0]).toContain(
      "STOP: Your previous response was empty",
    );
    expect(sendUserMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer" });
  });

  it("suppresses the first empty response after a compaction", async () => {
    extension(pi);

    const sessionStart = handlers.get("session_start")[0];
    const sessionCompact = handlers.get("session_compact")[0];
    const turnEnd = handlers.get("turn_end")[0];
    await sessionStart();

    const ctx = { ui: { notify: vi.fn() } };

    // Compaction completes -> resume turn comes back empty -> no "STOP!" steer
    await sessionCompact();
    await turnEnd(emptyTurn(), ctx);
    expect(sendUserMessage).not.toHaveBeenCalled();

    // A SECOND empty response (still no progress) IS corrected again
    await turnEnd(emptyTurn(), ctx);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls[0][0]).toContain(
      "STOP: Your previous response was empty",
    );
  });

  it("only suppresses empty responses, not other corrections, after compaction", async () => {
    extension(pi);

    const sessionStart = handlers.get("session_start")[0];
    const sessionCompact = handlers.get("session_compact")[0];
    const turnEnd = handlers.get("turn_end")[0];
    await sessionStart();

    const ctx = { ui: { notify: vi.fn() } };

    // After compaction, a non-empty violation (empty tool name) still steers.
    await sessionCompact();
    await turnEnd(
      {
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "toolCall", name: "", input: {} }],
        },
        toolResults: [],
      },
      ctx,
    );
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls[0][0]).toContain(
      "STOP: Your tool call had an empty tool name",
    );
  });

  it("never corrects an aborted turn", async () => {
    extension(pi);

    const sessionStart = handlers.get("session_start")[0];
    const turnEnd = handlers.get("turn_end")[0];
    await sessionStart();

    const ctx = { ui: { notify: vi.fn() } };
    await turnEnd(emptyTurn("aborted"), ctx);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("never corrects a length-stopped turn (max output tokens)", async () => {
    extension(pi);

    const sessionStart = handlers.get("session_start")[0];
    const turnEnd = handlers.get("turn_end")[0];
    await sessionStart();

    const ctx = { ui: { notify: vi.fn() } };

    // Empty length stop — this is an interrupted turn, not a model refusing
    // to answer. Steering would waste context right at the token cliff.
    await turnEnd(emptyTurn("length"), ctx);
    expect(sendUserMessage).not.toHaveBeenCalled();

    // A one-token length stop (partial output) is also left alone.
    await turnEnd(
      {
        message: {
          role: "assistant",
          stopReason: "length",
          content: [{ type: "text", text: "I" }],
        },
        toolResults: [],
      },
      ctx,
    );
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});
