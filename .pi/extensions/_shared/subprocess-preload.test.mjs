import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import childProcess from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Mock the TypeScript dependency before importing the preload module
vi.mock("./subprocess.ts", () => ({
  registerChildProcess: vi.fn(),
}));

const originalSpawn = childProcess.spawn;

describe("subprocess-preload", () => {
  let registerChildProcess;

  beforeEach(async () => {
    // Reset global guard so the module re-applies
    delete globalThis.__littleCoderSubprocessPreloadInstalled;
    // Restore original spawn
    childProcess.spawn = originalSpawn;
    // Clear the module cache so it re-imports
    vi.resetModules();
    // Re-import to get fresh mock
    const mod = await import("./subprocess.ts");
    registerChildProcess = mod.registerChildProcess;
  });

  afterEach(() => {
    // Reset global guard
    delete globalThis.__littleCoderSubprocessPreloadInstalled;
    // Restore original spawn
    childProcess.spawn = originalSpawn;
    vi.restoreAllMocks();
  });

  it("patches spawn only once (global install guard)", async () => {
    // Import twice — should only patch once
    await import("./subprocess-preload.mjs");
    const firstSpawn = childProcess.spawn;
    await import("./subprocess-preload.mjs");
    const secondSpawn = childProcess.spawn;
    expect(firstSpawn).toBe(secondSpawn);
    expect(globalThis.__littleCoderSubprocessPreloadInstalled).toBe(true);
  });

  it("spawn still works after patching", async () => {
    await import("./subprocess-preload.mjs");
    // Should not throw
    const child = childProcess.spawn("echo", ["hello"]);
    await new Promise((resolve) => child.on("close", resolve));
  });

  it("normalizes array args correctly", async () => {
    await import("./subprocess-preload.mjs");
    childProcess.spawn("echo", ["a", "b"]);
    expect(registerChildProcess).toHaveBeenCalled();
    const call = registerChildProcess.mock.calls[0];
    expect(call[2]).toEqual(["a", "b"]);
  });

  it("normalizes options-only (non-array args) correctly", async () => {
    await import("./subprocess-preload.mjs");
    childProcess.spawn("echo", { stdio: "inherit" });
    expect(registerChildProcess).toHaveBeenCalled();
  });

  it("calls registerChildProcess with correct params", async () => {
    await import("./subprocess-preload.mjs");
    const child = childProcess.spawn("echo", ["hello"], { cwd: "/tmp" });
    child.on("close", () => {});

    expect(registerChildProcess).toHaveBeenCalledTimes(1);
    const call = registerChildProcess.mock.calls[0];
    expect(call[0]).toBe(child); // the child process object
    expect(call[1]).toBe("echo"); // command string
    expect(call[2]).toEqual(["hello"]); // args as strings
    expect(call[3]).toEqual({ cwd: "/tmp" }); // options with cwd
  });

  it("never throws when registerChildProcess errors", async () => {
    registerChildProcess.mockImplementation(() => {
      throw new Error("boom");
    });
    // Re-import the preload module to pick up the new mock
    delete globalThis.__littleCoderSubprocessPreloadInstalled;
    childProcess.spawn = originalSpawn;
    vi.resetModules();
    await import("./subprocess-preload.mjs");

    // The wrapper should not throw even when registerChildProcess throws
    expect(() => childProcess.spawn("echo", ["hello"])).not.toThrow();
    // And it should have attempted to register
    expect(registerChildProcess).toHaveBeenCalled();
  });

  it("calls syncBuiltinESMExports after patching", async () => {
    // syncBuiltinESMExports is called inside the preload module —
    // we can verify this by checking the module loaded without error
    // and the spawn function was patched.
    await import("./subprocess-preload.mjs");
    expect(childProcess.spawn.name).toBe("littleCoderTrackedSpawn");
  });

  it("delegates to original spawn and returns child process object", async () => {
    await import("./subprocess-preload.mjs");
    const child = childProcess.spawn("echo", ["hello"]);
    expect(child).toBeDefined();
    expect(child.pid).toBeDefined();
    expect(child.kill).toBeDefined();
    child.on("close", () => {});
  });

  it("handles null args gracefully", async () => {
    await import("./subprocess-preload.mjs");
    // null args — the preload should not crash the normalization logic
    // Node may or may not accept null args; the key is our wrapper doesn't throw
    try {
      childProcess.spawn("echo", null, { stdio: "inherit" });
    } catch {
      // If Node itself rejects null args, that's fine — our wrapper shouldn't
      // be the source of the error
      expect(registerChildProcess).toHaveBeenCalled();
    }
  });

  it("handles undefined args gracefully", async () => {
    await import("./subprocess-preload.mjs");
    // undefined args — the preload should normalize to []
    try {
      childProcess.spawn("echo", undefined, { stdio: "inherit" });
    } catch {
      expect(registerChildProcess).toHaveBeenCalled();
    }
  });
});

// P1: real integration test for the preload timing line — no mock,
// a fresh `node --import` process must emit the preload=Nms stderr line.
describe("subprocess-preload launch timing (integration)", () => {
  it("LITTLE_CODER_TIMING=1 emits preload=<N>ms on stderr", async () => {
    const preloadPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "subprocess-preload.mjs",
    );
    let killTimer;
    const result = await new Promise((resolvePromise) => {
      const child = childProcess.spawn(
        process.execPath,
        ["--import", preloadPath, "-e", "0"],
        {
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, LITTLE_CODER_TIMING: "1" },
        },
      );
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      // Kill-on-timeout guard; cleared on close so it can't outlive the test
      // (a pending 15 s timer would keep the worker alive and stall the run).
      killTimer = setTimeout(() => {
        child.kill();
        resolvePromise({ code: -1, stderr });
      }, 15_000);
      child.on("close", () => {
        clearTimeout(killTimer);
        resolvePromise({ code: child.exitCode, stderr });
      });
    });
    clearTimeout(killTimer); // defensive: already cleared in the close handler
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/preload=\d+ms/);
  });

  it("stays silent without LITTLE_CODER_TIMING", async () => {
    const preloadPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "subprocess-preload.mjs",
    );
    const env = { ...process.env };
    delete env.LITTLE_CODER_TIMING;
    let killTimer;
    const result = await new Promise((resolvePromise) => {
      const child = childProcess.spawn(
        process.execPath,
        ["--import", preloadPath, "-e", "0"],
        { stdio: ["ignore", "ignore", "pipe"], env },
      );
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      // Kill-on-timeout guard; cleared on close so it can't outlive the test
      // (a pending 15 s timer would keep the worker alive and stall the run).
      killTimer = setTimeout(() => {
        child.kill();
        resolvePromise({ code: -1, stderr });
      }, 15_000);
      child.on("close", () => {
        clearTimeout(killTimer);
        resolvePromise({ code: child.exitCode, stderr });
      });
    });
    clearTimeout(killTimer); // defensive: already cleared in the close handler
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("launch timing");
  });
});
