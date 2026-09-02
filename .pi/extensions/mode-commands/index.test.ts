import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

async function makePi(
  opts: { respondPlannotator?: boolean; emitThrows?: boolean } = {},
) {
  // Dynamic import so each test gets the fresh module instance registered by
  // the resetModules() in beforeEach (mode-commands keeps module-level mode
  // and handoff state).
  const { default: modeCommands } = await import("./index.ts");
  const commands: string[] = [];
  const handlers: Record<string, (args?: string, ctx?: any) => Promise<void>> =
    {};
  const beforeAgentStart: Record<string, (...args: unknown[]) => unknown> = {};
  const userMessages: string[] = [];
  const messageOpts: unknown[] = [];
  const pi: any = {
    registerCommand: (name: string, def: any) => {
      commands.push(name);
      handlers[name] = def.handler;
    },
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      beforeAgentStart[event] = fn;
    },
    events: {
      emit: (_channel: string, payload: { respond: (r: unknown) => void }) => {
        if (opts.emitThrows) {
          throw new Error("plannotator emit failed (simulated)");
        }
        // Answer plannotator's plan-mode request immediately (unless told
        // otherwise) so the handler's fallback timeout is cleared and the
        // test doesn't wait on it.
        if (opts.respondPlannotator !== false) payload.respond({});
      },
    },
    sendUserMessage: (text: string, options?: unknown) => {
      userMessages.push(text);
      messageOpts.push(options);
    },
  };
  modeCommands(pi);
  return { commands, handlers, beforeAgentStart, userMessages, messageOpts };
}

function makeCtx() {
  const notifications: { text: string; level?: string }[] = [];
  const ctx: any = {
    ui: {
      notify: (text: string, level?: string) =>
        notifications.push({ text, level }),
    },
    cwd: process.cwd(),
  };
  return { ctx, notifications };
}

beforeEach(() => {
  // Fresh module state per test, and no ambient subagent markers: the
  // /deep-plan handler is interactive-only and bails when these are set —
  // which they are whenever this suite runs inside a little-coder subagent
  // (e.g. an EXECUTION subagent running the checks). stubEnv sets an empty
  // string rather than unsetting (vitest has no "delete" mode) — fine while
  // the handler checks truthiness; if it ever switches to an `in process.env`
  // check, update these stubs too.
  vi.resetModules();
  vi.stubEnv("LITTLE_CODER_SUBAGENT", "");
  vi.stubEnv("PI_SUBAGENT_DEPTH", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mode-commands command registration", () => {
  it("does not register prompt-only /plan", async () => {
    const { commands } = await makePi();
    expect(commands).not.toContain("plan");
    expect(commands).toContain("plan-prompt");
    expect(commands).toContain("execute");
    expect(commands).toContain("review");
    expect(commands).toContain("review-focused");
    expect(commands).toContain("review-project");
    expect(commands).toContain("deep-plan");
  });
});

describe("deep-plan handoff lifecycle", () => {
  it("injects the handoff reminder once, clears it on mode switch, re-arms on re-run", async () => {
    const { handlers, beforeAgentStart, userMessages, messageOpts } =
      await makePi();
    const { DEEP_PLAN_HANDOFF_REMINDER } = await import("./index.ts");
    const { ctx } = makeCtx();
    const start = () => beforeAgentStart["before_agent_start"]();

    // No mode active yet — nothing to return.
    expect(await start()).toBeUndefined();

    // Entering deep-plan mode arms the handoff and sends the pipeline message.
    await handlers["deep-plan"]("some feature", ctx);
    expect(userMessages).toHaveLength(1);
    // The follow-up message must be persistent: it is the handoff rule's
    // primary carrier, so a regression to a non-followUp delivery would
    // silently lose the rule's guaranteed transcript slot.
    expect(messageOpts[0]).toEqual({ deliverAs: "followUp" });
    expect(userMessages[0]).toContain("POST-APPROVAL HANDOFF RULE");
    expect(userMessages[0]).toContain("REVIEW-PLAN-PONYTAIL");
    expect(userMessages[0]).toContain("plannotator_submit_plan");

    // First agent start: system prompt + the handoff reminder (injected once).
    let result: any = await start();
    expect(result.systemPrompt).toContain("Deep Plan Pipeline");
    expect(result.message?.customType).toBe("deep-plan-handoff");
    // The hidden message is the compact reminder, not a second full copy of
    // the rule.
    expect(result.message?.content).toBe(DEEP_PLAN_HANDOFF_REMINDER);
    expect(result.message?.content).toContain("EXECUTION");

    // Second agent start: the message already persists in the transcript, so
    // it must NOT be re-injected.
    result = await start();
    expect(result.systemPrompt).toContain("Deep Plan Pipeline");
    expect(result.message).toBeUndefined();

    // Switching to any other mode clears the deep-plan handoff entirely.
    await handlers["plan-prompt"](undefined, ctx);
    result = await start();
    expect(result.systemPrompt).not.toContain("Deep Plan Pipeline");
    expect(result.message).toBeUndefined();

    // Re-running deep-plan re-arms the handoff for the new run.
    await handlers["deep-plan"]("another feature", ctx);
    expect(userMessages).toHaveLength(2);
    result = await start();
    expect(result.systemPrompt).toContain("Deep Plan Pipeline");
    expect(result.message?.customType).toBe("deep-plan-handoff");
    expect(result.message?.content).toBe(DEEP_PLAN_HANDOFF_REMINDER);
  });

  it("every other mode command clears an armed deep-plan handoff", async () => {
    const { handlers, beforeAgentStart } = await makePi();
    const { ctx } = makeCtx();
    const start = () => beforeAgentStart["before_agent_start"]();
    const modes = [
      "plan-prompt",
      "execute",
      "review",
      "review-focused",
      "review-project",
      "autoresearch",
    ] as const;
    for (const mode of modes) {
      // Same starting state for every mode: a freshly armed deep-plan run.
      await handlers["deep-plan"]("some feature", ctx);
      const armed = await start();
      expect(armed.systemPrompt, `${mode}: starting state`).toContain(
        "Deep Plan Pipeline",
      );

      await handlers[mode]("x", ctx);
      const result: any = await start();
      expect(
        result,
        `${mode}: should still return a mode prompt`,
      ).toBeDefined();
      expect(
        result.systemPrompt,
        `${mode}: deep-plan prompt leaked`,
      ).not.toContain("Deep Plan Pipeline");
      expect(result.message, `${mode}: handoff message leaked`).toBeUndefined();
    }
  });

  it("warns and does nothing without a prompt", async () => {
    const { handlers, beforeAgentStart, userMessages } = await makePi();
    const { ctx, notifications } = makeCtx();
    await handlers["deep-plan"]("   ", ctx);
    await handlers["deep-plan"](undefined, ctx);
    expect(
      notifications.filter((n) => n.text.includes("Usage: /deep-plan")),
    ).toHaveLength(2);
    expect(userMessages).toHaveLength(0);
    // No pipeline started → no mode armed either.
    expect(await beforeAgentStart["before_agent_start"]()).toBeUndefined();
  });

  it("warns and does nothing in subagent mode", async () => {
    vi.stubEnv("LITTLE_CODER_SUBAGENT", "1");
    const { handlers, beforeAgentStart, userMessages } = await makePi();
    const { ctx, notifications } = makeCtx();
    await handlers["deep-plan"]("some feature", ctx);
    expect(notifications.some((n) => n.text.includes("subagent mode"))).toBe(
      true,
    );
    expect(userMessages).toHaveLength(0);
    expect(await beforeAgentStart["before_agent_start"]()).toBeUndefined();
  });
});

describe("deep-plan handoff single source of truth", () => {
  it("the handoff rule mentions every approval trigger", async () => {
    const { DEEP_PLAN_APPROVAL_TRIGGERS, DEEP_PLAN_HANDOFF_RULE } =
      await import("./index.ts");
    for (const trigger of DEEP_PLAN_APPROVAL_TRIGGERS) {
      expect(DEEP_PLAN_HANDOFF_RULE).toContain(trigger);
    }
  });

  it("escapes quotes, backslashes, and newlines in the user prompt (no instruction breakout)", async () => {
    const { handlers, userMessages } = await makePi();
    const { ctx } = makeCtx();
    // Contains a double quote, an apostrophe, a backslash, and a real newline
    // — the shapes that would terminate the double-quoted task strings if the
    // escape chain were missing or mis-ordered.
    const raw = 'Fix "user\'s" \\path\ntimeout';
    const escaped = 'Fix \\"user\'s\\" \\\\path\\ntimeout';
    await handlers["deep-plan"](raw, ctx);
    expect(userMessages[0]).toContain(`Deep plan pipeline for: "${escaped}".`);
    // The unescaped form must not survive anywhere: a raw quote would
    // terminate the quoted request and let the remainder rewrite the
    // pipeline instructions.
    expect(userMessages[0]).not.toContain(raw);
  });

  it("the follow-up user message carries the full rule (not the reminder)", async () => {
    const { handlers, userMessages } = await makePi();
    const { DEEP_PLAN_HANDOFF_RULE, DEEP_PLAN_HANDOFF_REMINDER } =
      await import("./index.ts");
    const { ctx } = makeCtx();
    await handlers["deep-plan"]("some feature", ctx);
    expect(userMessages[0]).toContain(DEEP_PLAN_HANDOFF_RULE);
    // The full rule must live in exactly one persistent carrier: the
    // follow-up message — not duplicated into the hidden reminder as well.
    expect(DEEP_PLAN_HANDOFF_REMINDER).not.toContain(DEEP_PLAN_HANDOFF_RULE);
  });
});

describe("deep-plan plannotator handshake", () => {
  // Real-timer yield captured BEFORE any test installs fake timers — fake
  // timers stall fake time, so the handler's cold dynamic import needs real
  // event-loop turns to finish. (Referencing the global setTimeout from
  // inside a test would create a FAKE timer — deadlock.)
  const realSetTimeout = globalThis.setTimeout;
  const realYield = (ms: number) =>
    new Promise<void>((resolve) => realSetTimeout(resolve, ms));

  it("a responsive plannotator clears the fallback timer", async () => {
    vi.useFakeTimers();
    try {
      const { handlers, userMessages } = await makePi();
      const { ctx } = makeCtx();
      await handlers["deep-plan"]("some feature", ctx);
      // Handler completed (sendUserMessage called). If clearTimeout(fallback)
      // were missing, the 5 s fallback timer would still be pending.
      expect(userMessages).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues cleanly when plannotator emit throws (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      const { handlers, userMessages } = await makePi({ emitThrows: true });
      const { ctx } = makeCtx();
      // The outer catch swallows the emit failure (plannotator inactive) — the
      // pipeline must still start, and the fallback timer must have been
      // cleared on the throw path.
      await handlers["deep-plan"]("some feature", ctx);
      expect(userMessages).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves via the fallback timeout when no listener answers", async () => {
    vi.useFakeTimers();
    try {
      const { handlers } = await makePi({ respondPlannotator: false });
      const { ctx } = makeCtx();
      const pending = handlers["deep-plan"]("some feature", ctx);
      // PLANNOTATOR_TIMEOUT_MS is 5000. The handler is async (dynamic import
      // before the timer registers), so interleave real yields with
      // fake-time advancement until the timer exists, then fire it. The 500 ×
      // 10 ms = ~5 s real-time budget sits far above cold-import latency even
      // on slow CI; the loop normally exits after a couple of iterations.
      for (let i = 0; i < 500 && vi.getTimerCount() === 0; i++) {
        await realYield(10);
        await vi.advanceTimersByTimeAsync(250);
      }
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("plannotator approval trigger substrings", () => {
  // DEEP_PLAN_APPROVAL_TRIGGERS[0..2] are a string contract with the
  // installed @plannotator/pi-extension package: the handoff rule triggers on
  // them verbatim. If a plannotator update rewords an approval prompt, this
  // test fails — update DEEP_PLAN_APPROVAL_TRIGGERS in index.ts (see its doc
  // comment and the /deep-plan CHANGELOG entry).
  let promptsPath: string | undefined;
  try {
    promptsPath =
      require.resolve("@plannotator/pi-extension/generated/prompts.ts");
  } catch {
    promptsPath = undefined; // package not installed — skip below
  }
  const itIfInstalled = promptsPath ? it : it.skip;

  itIfInstalled(
    "the first three triggers still exist in the installed plannotator prompts",
    async () => {
      const { DEEP_PLAN_APPROVAL_TRIGGERS } = await import("./index.ts");
      const text = readFileSync(promptsPath as string, "utf-8");
      // slice(0, 3): triggers[0..2] are plannotator strings; triggers[3]
      // ("Continue with the approved plan.") is our own user-message
      // convention, not a package string, so it cannot drift.
      for (const trigger of DEEP_PLAN_APPROVAL_TRIGGERS.slice(0, 3)) {
        expect(text).toContain(trigger);
      }
    },
  );
});
