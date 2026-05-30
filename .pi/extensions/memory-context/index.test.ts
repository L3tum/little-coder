import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memoryContextExtension, { candidateFingerprint, candidateReview, duplicateAcceptedCandidate, filterMemoriesByStatus, formatCandidateBody, isExpired, memoryRankScore, prunableMemories, rankMemories, readQueue, scoreCandidate, staleQueueIndexes, supersededMemoryCandidates, turnCandidate, writeAcceptedMemory, writeQueue, type MemoryNote, type QueueItem } from "./index.ts";

const oldMemoryContextDir = process.env.MEMORY_CONTEXT_DIR;

afterEach(() => {
  if (oldMemoryContextDir === undefined) delete process.env.MEMORY_CONTEXT_DIR;
  else process.env.MEMORY_CONTEXT_DIR = oldMemoryContextDir;
});

function withTempMemory(): string {
  const dir = mkdtempSync(join(tmpdir(), "lc-memory-context-"));
  process.env.MEMORY_CONTEXT_DIR = dir;
  return dir;
}

function candidate(overrides: Partial<QueueItem>): QueueItem {
  return {
    type: "action",
    title: "Updated index.ts",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: "high",
    tags: ["action", "index.ts"],
    evidence: { files_edited: ["index.ts"], files_read: [], tests_run: ["npm test"] },
    body: "## Summary\nUpdated index.ts.\n\n## Validation\n- npm test",
    ...overrides,
  };
}

describe("memory candidate formatting", () => {
  it("does not emit the old boilerplate follow-up", () => {
    const body = formatCandidateBody({
      prompt: "Fix the issue",
      outcome: "Fixed a durable convention and validated it.",
      edited: ["index.ts"],
      read: ["index.ts"],
      tests: ["npm test"],
      confidence: "high",
      type: "observation",
    });

    expect(body).not.toContain("Review for durability before accepting as long-term memory");
    expect(body).not.toContain("## Follow-up");
  });

  it("emits concrete follow-up only for unresolved validation", () => {
    const body = formatCandidateBody({
      prompt: "Fix the issue",
      outcome: "Changed behavior but did not validate it.",
      edited: ["index.ts"],
      read: ["index.ts"],
      tests: [],
      confidence: "low",
      type: "action",
    });

    expect(body).toContain("## Follow-up");
    expect(body).toContain("Run targeted tests before promoting this memory.");
    expect(body).toContain("Verify this against source before accepting.");
  });
});

describe("turn candidate creation", () => {
  it("does not create candidates for turns without edits or tests", () => {
    expect(turnCandidate({
      prompt: "Explain the code",
      outcome: "Explained the code.",
      edited: [],
      read: ["index.ts"],
      tests: [],
      tools: ["read"],
      now: "2026-01-01T00:00:00.000Z",
    })).toBeNull();
  });

  it("creates high-confidence durable candidates for edited and validated decisions", () => {
    const item = turnCandidate({
      prompt: "Implement memory salience policy",
      outcome: "Decided memory-context must use salience before queueing candidates instead of saving every edit.",
      edited: [".pi/extensions/memory-context/index.ts"],
      read: [".pi/extensions/memory-context/index.ts"],
      tests: ["npm test"],
      tools: ["read", "edit", "bash"],
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(item?.confidence).toBe("high");
    expect(item?.type).toBe("decision");
    expect(item?.title).toContain("Decision:");
    expect(scoreCandidate(item!).reason).toBeUndefined();
  });
});

describe("memory candidate novelty", () => {
  it("fingerprints candidates independently of evidence, validation, and file sections", () => {
    const first = candidateFingerprint(candidate({
      body: "## Summary\nDecided memory-context must use salience.\n\n## Evidence\n- Prompt: one\n\n## Validation\n- npm test\n\n## Files\nEdited:\n- a.ts",
    }));
    const second = candidateFingerprint(candidate({
      body: "## Summary\nDecided memory-context must use salience.\n\n## Evidence\n- Prompt: two\n\n## Validation\n- npm run typecheck\n\n## Files\nEdited:\n- b.ts",
    }));

    expect(first).toBe(second);
  });

  it("detects duplicate active accepted memories but ignores inactive history", () => {
    const item = candidate({
      type: "decision",
      title: "Decision: memory-context must use salience",
      body: "## Summary\nDecided memory-context must use salience.",
    });

    expect(duplicateAcceptedCandidate(item, [note({
      type: "decision",
      title: "Decision: memory-context must use salience",
      body: "## Summary\nDecided memory-context must use salience.",
    })])).toBe(true);
    expect(duplicateAcceptedCandidate(item, [note({
      type: "decision",
      title: "Decision: memory-context must use salience",
      status: "superseded",
      body: "## Summary\nDecided memory-context must use salience.",
    })])).toBe(false);
  });
});

describe("memory candidate review", () => {
  it("explains low-confidence rejection separately from salience", () => {
    const item = candidate({
      confidence: "low",
      title: "Decision: memory-context must use salience",
      type: "decision",
      body: "Decided memory-context must use salience before queueing durable memories.",
    });

    const review = candidateReview(item);

    expect(review.accepted).toBe(false);
    expect(review.reason).toBe("confidence below medium");
  });

  it("accepts high-confidence salient candidates", () => {
    const review = candidateReview(candidate({
      confidence: "high",
      type: "decision",
      title: "Decision: memory-context must use salience",
      body: "Decided memory-context must use salience before queueing durable memories. This avoids low-impact memory bloat.",
    }));

    expect(review.accepted).toBe(true);
    expect(review.reason).toBeUndefined();
  });
});

describe("memory candidate scoring", () => {
  it("rejects generic update summaries", () => {
    const scored = scoreCandidate(candidate({}));

    expect(scored.reason).toBeTruthy();
    expect(scored.salience).toBeLessThan(6);
  });

  it("accepts durable decisions with evidence", () => {
    const scored = scoreCandidate(candidate({
      type: "decision",
      title: "Memory-context requires salience before queueing",
      tags: ["decision", "memory-context"],
      body: "## Summary\nDecided memory-context must reject generic edit/test summaries and only queue durable, specific, actionable memories. This avoids low-impact memory bloat.\n\n## Validation\n- npm test",
    }));

    expect(scored.reason).toBeUndefined();
    expect(scored.salience).toBeGreaterThanOrEqual(6);
  });
});

function note(overrides: Partial<MemoryNote>): MemoryNote {
  return {
    path: "/repo/.pi/memory/50-decisions/old.md",
    title: "Decision: memory-context queues all validated edits",
    type: "decision",
    tags: ["decision", "memory-context"],
    confidence: "high",
    salience: 8,
    status: "active",
    useCount: 0,
    lastUsedAt: "active-day:1",
    expiresAt: "",
    body: "Memory-context should queue all validated edits.",
    ...overrides,
  };
}

describe("memory supersession", () => {
  it("detects active overlapping memories when a new convention replaces them", () => {
    const matches = supersededMemoryCandidates(candidate({
      type: "decision",
      title: "Decision: memory-context now uses salience instead of edit activity",
      tags: ["decision", "memory-context"],
      body: "New convention: memory-context now uses salience instead of queueing all validated edits.",
    }), [note({}), note({ path: "/repo/other.md", tags: ["other"], body: "Unrelated decision." })]);

    expect(matches).toHaveLength(1);
    expect(matches[0].path).toContain("old.md");
  });

  it("does not supersede without explicit replacement intent or contradiction", () => {
    const matches = supersededMemoryCandidates(candidate({
      type: "decision",
      title: "Decision: memory-context salience threshold",
      tags: ["decision", "memory-context"],
      body: "Decided memory-context salience threshold is 6.",
    }), [note({})]);

    expect(matches).toHaveLength(0);
  });

  it("detects direct modal contradictions even without replacement wording", () => {
    const matches = supersededMemoryCandidates(candidate({
      type: "decision",
      title: "Decision: memory-context must not queue generic edits",
      tags: ["decision", "memory-context"],
      body: "Memory-context must not queue generic edits.",
    }), [note({
      title: "Decision: memory-context should queue generic edits",
      body: "Memory-context should queue generic edits after validation.",
    })]);

    expect(matches).toHaveLength(1);
  });

  it("detects broader action contradictions such as store vs discard", () => {
    const matches = supersededMemoryCandidates(candidate({
      type: "decision",
      title: "Decision: memory-context discards generic edits",
      tags: ["decision", "memory-context"],
      body: "Memory-context discards generic edits after scoring.",
    }), [note({
      title: "Decision: memory-context stores generic edits",
      body: "Memory-context stores generic edits after validation.",
    })]);

    expect(matches).toHaveLength(1);
  });
});

describe("memory retrieval ranking", () => {
  it("ranks durable decisions above generic action notes with similar lexical terms", () => {
    const query = "memory-context salience queue behavior";
    const decision = memoryRankScore(query, note({
      type: "decision",
      title: "Decision: memory-context requires salience before queueing",
      salience: 8,
      body: "Memory-context uses salience before queueing candidates.",
    }));
    const action = memoryRankScore(query, note({
      type: "action",
      title: "Updated index.ts",
      salience: 8,
      body: "Updated memory-context salience queue behavior in index.ts.",
    }));

    expect(decision).toBeGreaterThan(action);
  });

  it("boosts frequently used memories without overcoming category quality by itself", () => {
    const query = "memory-context salience";
    const unused = memoryRankScore(query, note({ useCount: 0, lastUsedAt: "" }));
    const used = memoryRankScore(query, note({ useCount: 8, lastUsedAt: "active-day:1" }));

    expect(used).toBeGreaterThan(unused);
  });
});

describe("memory active-day expiration", () => {
  it("does not treat active-day expirations as wall-clock dates", () => {
    expect(isExpired(note({ lastUsedAt: "", expiresAt: "active-days:30" }))).toBe(false);
  });
});

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown>>();
  const commands = new Map<string, (args: string, ctx: { hasUI: boolean; ui: { notify: (message: string, level?: string) => void } }) => Promise<void>>();
  const pi = {
    registerCommand: (name: string, command: { handler: (args: string, ctx: { hasUI: boolean; ui: { notify: (message: string, level?: string) => void } }) => Promise<void> }) => commands.set(name, command.handler),
    on: (name: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) => handlers.set(name, handler),
  };
  memoryContextExtension(pi as never);
  return { handlers, commands };
}

function captureCtx() {
  const messages: string[] = [];
  return { messages, ctx: { hasUI: true, ui: { notify: (message: string) => messages.push(message) } } };
}

describe("memory hook integration", () => {
  it("captures tool activity and queues salient turn-end candidates", async () => {
    const dir = withTempMemory();
    const { handlers } = fakePi();
    await handlers.get("before_agent_start")?.({ prompt: "Implement memory salience decision", systemPrompt: "" }, { ui: { notify: () => {} } });
    await handlers.get("tool_call")?.({ toolName: "edit", input: { path: ".pi/extensions/memory-context/index.ts" } });
    await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "npm test" } });
    await handlers.get("turn_end")?.({
      message: {
        content: [{ type: "text", text: "Decided memory-context must use salience before queueing durable memories instead of saving every edit." }],
      },
    });

    const queued = readQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0].type).toBe("decision");
    expect(queued[0].salience).toBeGreaterThanOrEqual(6);

    rmSync(dir, { recursive: true, force: true });
  });

  it("does not queue low-value hook candidates", async () => {
    const dir = withTempMemory();
    const { handlers } = fakePi();
    await handlers.get("before_agent_start")?.({ prompt: "Update file", systemPrompt: "" }, { ui: { notify: () => {} } });
    await handlers.get("tool_call")?.({ toolName: "edit", input: { path: "index.ts" } });
    await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "npm test" } });
    await handlers.get("turn_end")?.({ message: { content: [{ type: "text", text: "Updated index.ts." }] } });

    expect(readQueue()).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory command integration", () => {
  it("accepts queued candidates into markdown through /memory-review", async () => {
    const dir = withTempMemory();
    const { commands } = fakePi();
    const { ctx, messages } = captureCtx();
    const item = candidate({
      type: "decision",
      title: "Decision: memory-context must use salience",
      confidence: "high",
      body: "Decided memory-context must use salience before queueing durable memories.",
    });
    writeQueue([{ ...item, salience: scoreCandidate(item).salience }]);

    await commands.get("memory-review")?.("accept 1", ctx);

    expect(readQueue()).toHaveLength(0);
    expect(messages[messages.length - 1]).toContain("Accepted 1 memory candidate");
    expect(existsSync(join(dir, "50-decisions"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("previews category-pruned memories through /memory-prune --dry-run", async () => {
    const dir = withTempMemory();
    const { commands } = fakePi();
    const { ctx, messages } = captureCtx();
    writeAcceptedMemory(candidate({ type: "action", title: "Action: low value", salience: 1, body: "Observed a low-value action." }));

    await commands.get("memory-prune")?.("--dry-run --category action", ctx);

    expect(messages[messages.length - 1]).toContain("category: 40-actions");
    expect(messages[messages.length - 1]).toContain("Would expire 1 accepted memory");

    rmSync(dir, { recursive: true, force: true });
  });

  it("clears rejection log through /memory-rejections clear", async () => {
    const dir = withTempMemory();
    const { commands } = fakePi();
    const { ctx, messages } = captureCtx();

    await commands.get("memory-rejections")?.("clear", ctx);

    expect(messages[messages.length - 1]).toContain("Cleared rejected memory candidate log");
    expect(readFileSync(join(dir, "rejections.json"), "utf-8")).toBe("[]\n");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory filesystem integration", () => {
  it("writes queue/state/rejection scaffolding under MEMORY_CONTEXT_DIR", () => {
    const dir = withTempMemory();
    writeQueue([candidate({ title: "Decision: memory-context must use salience", type: "decision", body: "Decided memory-context must use salience before queueing memories." })]);

    expect(readQueue()).toHaveLength(1);
    expect(existsSync(join(dir, "queue.json"))).toBe(true);
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    expect(existsSync(join(dir, "rejections.json"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("promotes accepted memories into markdown with lifecycle frontmatter", () => {
    const dir = withTempMemory();
    const path = writeAcceptedMemory(candidate({
      type: "decision",
      title: "Decision: memory-context must use salience",
      confidence: "high",
      salience: 8,
      body: "Decided memory-context must use salience before queueing durable memories.",
    }));
    const text = readFileSync(path, "utf-8");

    expect(path).toContain(join(dir, "50-decisions"));
    expect(text).toContain('status: "active"');
    expect(text).toContain("salience: 8");
    expect(text).toContain("use_count: 0");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("memory prune eval", () => {
  it("prunes unused low-salience action memories but preserves used ones", () => {
    const unused = note({ path: "/repo/unused.md", type: "action", salience: 1, useCount: 0 });
    const used = note({ path: "/repo/used.md", type: "action", salience: 1, useCount: 2 });
    const decision = note({ path: "/repo/decision.md", type: "decision", salience: 1, useCount: 0 });

    expect(prunableMemories([unused, used, decision]).map((item) => item.path)).toEqual(["/repo/unused.md"]);
  });

  it("filters prunable memories by category", () => {
    const action = note({ path: "/repo/action.md", type: "action", salience: 1, useCount: 0 });
    const session = note({ path: "/repo/session.md", type: "session", salience: 1, useCount: 0 });

    expect(prunableMemories([action, session], "40-actions").map((item) => item.path)).toEqual(["/repo/action.md"]);
  });

  it("finds stale queued candidates by wall-clock age", () => {
    const old = candidate({ created_at: "2026-01-01T00:00:00.000Z" });
    const fresh = candidate({ created_at: "2026-01-20T00:00:00.000Z" });
    const now = Date.parse("2026-01-20T00:00:00.000Z");

    expect(staleQueueIndexes([old, fresh], now)).toEqual([0]);
  });
});

describe("memory list filtering", () => {
  it("filters memories by active, superseded, expired, or all status", () => {
    const active = note({ path: "/repo/active.md", status: "active" });
    const superseded = note({ path: "/repo/superseded.md", status: "superseded" });
    const expired = note({ path: "/repo/expired.md", status: "expired" });
    const notes = [active, superseded, expired];

    expect(filterMemoriesByStatus(notes, "active").map((item) => item.path)).toEqual(["/repo/active.md"]);
    expect(filterMemoriesByStatus(notes, "superseded").map((item) => item.path)).toEqual(["/repo/superseded.md"]);
    expect(filterMemoriesByStatus(notes, "expired").map((item) => item.path)).toEqual(["/repo/expired.md"]);
    expect(filterMemoriesByStatus(notes, "all")).toEqual(notes);
  });
});

describe("memory read eval", () => {
  it("retrieves active durable memories and excludes superseded memories", () => {
    const results = rankMemories("memory-context salience queue", [
      note({
        path: "/repo/.pi/memory/50-decisions/new.md",
        title: "Decision: memory-context requires salience before queueing",
        body: "Memory-context queues only salient durable memories.",
      }),
      note({
        path: "/repo/.pi/memory/50-decisions/old.md",
        title: "Decision: memory-context queues all edits",
        status: "superseded",
        body: "Memory-context queues all edits.",
      }),
      note({
        path: "/repo/.pi/memory/40-actions/action.md",
        type: "action",
        tags: ["action", "other"],
        title: "Updated index.ts",
        body: "Unrelated action.",
      }),
    ], 5);

    expect(results.map((result) => result.path)).toEqual(["/repo/.pi/memory/50-decisions/new.md"]);
  });

  it("does not inject weak incidental matches when strong memories exist", () => {
    const results = rankMemories("memory-context salience", [
      note({
        path: "/repo/.pi/memory/50-decisions/strong.md",
        title: "Decision: memory-context salience policy",
        salience: 8,
        body: "Memory-context salience controls durable memory writes.",
      }),
      note({
        path: "/repo/.pi/memory/40-actions/weak.md",
        type: "action",
        tags: ["action"],
        title: "Action with reusable outcome",
        salience: 1,
        body: "Mentioned memory-context once.",
      }),
    ], 5);

    expect(results.map((result) => result.path)).toEqual(["/repo/.pi/memory/50-decisions/strong.md"]);
  });
});
