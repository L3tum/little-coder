import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveTaskArg,
  TASK_INLINE_MAX_BYTES,
  writeTaskToTempFile,
  mapConcurrent,
  runAgent,
} from "./runner.js";
import { type SingleResult } from "./types.js";

// The node:fs namespace is non-redefinable, so vi.spyOn on writeFileSync
// cannot work; a module mock with a runtime toggle is the seam for
// simulating a task-file write failure (ENOSPC) without affecting the real
// file writes of the other tests in this file.
const fsMockState = { failSubagentTaskWrites: false };
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (
        fsMockState.failSubagentTaskWrites &&
        String(args[0]).includes("pi-subagent-")
      ) {
        throw new Error("ENOSPC: simulated write failure");
      }
      return actual.writeFileSync(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// resolveTaskArg — the inline vs @file routing decision
// ---------------------------------------------------------------------------
// This is the branch inside runAgent that decides how the task reaches the
// child: an inline `Task: <task>` argv element while under
// TASK_INLINE_MAX_BYTES, otherwise a 0600 temp file referenced as `@<file>`
// (so spawn cannot throw E2BIG and a large task is not exposed on the process
// command line). It is tested here as an exported function because runAgent
// itself spawns a real process.

describe("resolveTaskArg routing", () => {
  it("routes a small task inline as 'Task: <task>'", () => {
    const { dir, arg } = resolveTaskArg("TEST-AGENT", "short task");
    expect(dir).toBeNull();
    expect(arg).toBe("Task: short task");
  });

  it("routes an ASCII task exactly at the threshold inline", () => {
    const task = "a".repeat(TASK_INLINE_MAX_BYTES);
    const { dir, arg } = resolveTaskArg("TEST-AGENT", task);
    expect(dir).toBeNull();
    expect(arg).toBe(`Task: ${task}`);
  });

  it("routes an ASCII task one byte over the threshold to a temp file", () => {
    const task = "a".repeat(TASK_INLINE_MAX_BYTES + 1);
    const { dir, arg } = resolveTaskArg("TEST-AGENT", task);
    try {
      expect(dir).not.toBeNull();
      expect(arg.startsWith("@")).toBe(true);
      expect(path.dirname(arg.slice(1))).toBe(dir);
      expect(path.basename(arg.slice(1))).toMatch(
        /^task-TEST-AGENT-[0-9a-f]{8}\.md$/,
      );
      // The child reads exactly the inline-format content via @file.
      const content = fs.readFileSync(arg.slice(1), "utf-8");
      expect(content).toBe(`Task: ${task}`);
    } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes by UTF-8 BYTES, not UTF-16 code units (CJK case)", () => {
    // 70K CJK characters are ~210 KB in UTF-8 (over the byte threshold) but
    // only 70K in UTF-16 code units — this is exactly the case a
    // task.length-based check would misroute.
    const task = "中".repeat(70_000);
    expect(task.length).toBe(70_000); // UTF-16 code units
    expect(Buffer.byteLength(task, "utf8")).toBe(210_000); // UTF-8 bytes
    const { dir, arg } = resolveTaskArg("TEST-AGENT", task);
    try {
      expect(dir).not.toBeNull();
      expect(arg.startsWith("@")).toBe(true);
      const content = fs.readFileSync(arg.slice(1), "utf-8");
      expect(content).toBe(`Task: ${task}`);
    } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes a multibyte task INSIDE the code-unit budget to a temp file (in-window regression)", () => {
    // Regression for the removed length-based fast path: 50K CJK chars is
    // 50,000 code units (UNDER the 65,536-unit inline budget, so the old
    // fast path inlined it) but 150,000 UTF-8 bytes (over the byte budget,
    // over Linux MAX_ARG_STRLEN). The routing decision must key on bytes,
    // so this routes to the @file temp file, not argv.
    const task = "中".repeat(50_000);
    expect(task.length).toBe(50_000); // code units: under the old fast-path threshold
    expect(Buffer.byteLength(task, "utf8")).toBe(150_000); // bytes: over the budget
    const { dir, arg } = resolveTaskArg("TEST-AGENT", task);
    try {
      expect(dir).not.toBeNull();
      expect(arg.startsWith("@")).toBe(true);
    } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// writeTaskToTempFile — file layout, permissions, name sanitization
// ---------------------------------------------------------------------------

describe("writeTaskToTempFile", () => {
  it("creates a 0600 file with Task: prefix in a 0700 mkdtemp dir", () => {
    const agent = "TEST-AGENT";
    const task = "some task content";
    const { dir, filePath } = writeTaskToTempFile(agent, task);
    try {
      expect(dir).toContain("pi-subagent-");
      expect(filePath).toContain("task-TEST-AGENT-");
      expect(filePath.endsWith(".md")).toBe(true);

      // File content includes the "Task: " prefix (matches the inline format)
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toBe(`Task: ${task}`);

      // Mode bits are ignored on win32, so these assertions are POSIX-only.
      if (process.platform !== "win32") {
        // File mode is 0600 (the task may carry repository content).
        const st = fs.statSync(filePath);
        expect(st.mode & 0o777).toBe(0o600);

        // Directory mode is 0700 (mkdtemp default on most systems).
        const dirSt = fs.statSync(dir);
        expect(dirSt.mode & 0o777).toBe(0o700);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes agent name for the file name (crypto-random hex suffix)", () => {
    const agent = "REVIEW/SECURITY?";
    const task = "test";
    const { dir, filePath } = writeTaskToTempFile(agent, task);
    try {
      // [^\w.-]+ is replaced with _, so "REVIEW/SECURITY?" becomes
      // "REVIEW_SECURITY_" (trailing _ kept); the suffix is 4 random hex bytes.
      expect(path.basename(filePath)).toMatch(
        /^task-REVIEW_SECURITY_-[0-9a-f]{8}\.md$/,
      );
      expect(filePath).toBe(path.join(dir, path.basename(filePath)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mapConcurrent rejection handling", () => {
  it("records the first rejection, waits out in-flight workers, rethrows after the barrier, and leaks no unhandled rejection", async () => {
    // The pre-fix bug: the fan-out awaited a Promise.all built from promises
    // that no variable referenced, so a single worker rejection settled an
    // unobserved promise (unhandledRejection) before the barrier. The worker
    // now catches, records firstError, and the barrier rethrows it — so this
    // test asserts all three: first-error wins, in-flight workers finish,
    // and the process sees no unhandled rejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    const started: number[] = [];
    const tick = () => new Promise((r) => setTimeout(r, 10));
    try {
      await expect(
        mapConcurrent([0, 1, 2], 3, async (i) => {
          started.push(i);
          await tick();
          if (i === 1) throw new Error("boom");
          return `ok-${i}`;
        }),
      ).rejects.toThrow("boom");
      // Barrier held: every in-flight worker ran to completion despite the
      // rejection (a pre-fix early-exit would have skipped some).
      expect(started.sort((a, b) => a - b)).toEqual([0, 1, 2]);
      await tick(); // let any (buggy) unobserved rejection surface
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("clamps a non-finite concurrency to 1 instead of spawning zero workers", async () => {
    // Number.isFinite(NaN) is false -> safeConcurrency 1 (a NaN limit would
    // have Array.from({length: NaN}) spawn nothing and resolve with holes).
    const results = await mapConcurrent(["a", "b"], NaN, async (x) =>
      x.toUpperCase(),
    );
    expect(results).toEqual(["A", "B"]);
  });
});

// ---------------------------------------------------------------------------
// runAgent failure paths (no spawn: unknown agent / prep-sequence write fail)
// ---------------------------------------------------------------------------

describe("runAgent failure paths", () => {
  const baseOpts = {
    cwd: process.cwd(),
    delegationMode: "spawn" as const,
    parentDepth: 0,
    parentAgentStack: [] as string[],
    maxDepth: 3,
    preventCycles: true,
    makeDetails: (results: SingleResult[]) => ({
      mode: "single" as const,
      delegationMode: "spawn" as const,
      projectAgentsDir: null,
      results,
    }),
  };
  const testAgent = {
    name: "TEST-AGENT",
    description: "test",
    systemPrompt: "",
    source: "user" as const,
    filePath: "/tmp/test-agent.md",
  };

  it("unknown agent returns the canonical failure shape (stopReason + errorMessage set)", async () => {
    // Regression: this path used to hand-build its SingleResult WITHOUT
    // stopReason:"error"/errorMessage, so a classifier keying off stopReason
    // would have silently treated an unknown agent as a non-error.
    const result = await runAgent({
      ...baseOpts,
      agents: [testAgent],
      agentName: "NOPE",
      task: "short task",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('Unknown agent: "NOPE"');
    expect(result.messages).toEqual([]);
  });

  it("a task-file write failure returns a well-formed failure and leaks no pi-subagent-* temp dir", async () => {
    // The prep sequence's catch must clean up every temp dir it created
    // before the early failure return (that return never reaches the
    // post-spawn try/finally). Force the failure by making the task file
    // write throw (ENOSPC simulation); the oversized task guarantees the
    // @file routing actually creates a temp dir first.
    const before = new Set(
      fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("pi-subagent-")),
    );
    fsMockState.failSubagentTaskWrites = true;
    try {
      const result = await runAgent({
        ...baseOpts,
        agents: [testAgent],
        agentName: "TEST-AGENT",
        task: "x".repeat(TASK_INLINE_MAX_BYTES + 1), // over budget -> @file
      });
      expect(result.exitCode).toBe(1);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("Failed to prepare subagent files");
      expect(result.errorMessage).toContain("ENOSPC");
      // No leaked temp dir: every pi-subagent-* dir present after was present
      // before (the mkdtemp'd dir was removed by the prep-sequence catch).
      const after = fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("pi-subagent-"));
      for (const d of after) expect(before.has(d)).toBe(true);
    } finally {
      fsMockState.failSubagentTaskWrites = false;
    }
  });
});
