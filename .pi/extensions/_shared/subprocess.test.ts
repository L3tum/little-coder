import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We mock the full subprocess module to isolate tests from real child processes
vi.mock("node:child_process", () => {
  const spawn = vi.fn();
  return {
    spawn,
    default: { spawn },
  };
});

import childProcess from "node:child_process";

function makeMockChild(pid = 1234) {
  const onceHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    pid,
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn((_event, handler) => {
      onceHandlers[_event] = onceHandlers[_event] || [];
      onceHandlers[_event].push(handler);
    }),
    _onceHandlers: onceHandlers,
    stdout: null,
    stderr: null,
    stdin: null,
  };
}

import {
  registerChildProcess,
  startSubprocess,
  listSubprocesses,
  stopSubprocess,
  stopAllSubprocesses,
  __resetForTests,
} from "./subprocess.js";

describe("subprocess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // registerChildProcess
  // ---------------------------------------------------------------------------

  describe("registerChildProcess", () => {
    it("registers a child process and returns a ManagedSubprocess", () => {
      const child = makeMockChild(5678);

      const entry = registerChildProcess(child, "node", ["--version"]);
      expect(entry.id).toBeGreaterThan(0);
      expect(entry.name).toBe("node");
      expect(entry.command).toBe("node");
      expect(entry.args).toEqual(["--version"]);
      expect(entry.pid).toBe(5678);
      expect(entry.status).toBe("running");
    });

    it("deduplicates registration for the same child process", () => {
      const child = makeMockChild(9999);

      const first = registerChildProcess(child, "echo", ["hello"]);
      const second = registerChildProcess(child, "echo", ["world"]);

      expect(first.id).toBe(second.id);
      expect(second.args).toEqual(["world"]);
    });

    it("unregisters on close event", () => {
      const child = makeMockChild(42);
      const initialLen = listSubprocesses().length;

      registerChildProcess(child, "test", ["arg"]);
      expect(listSubprocesses().length).toBe(initialLen + 1);

      // Trigger the close handler
      const closeHandler = (child._onceHandlers?.close || [])[0];
      closeHandler(0, null);

      expect(listSubprocesses().length).toBe(initialLen);
    });

    it("unregisters on error event", () => {
      const child = makeMockChild(42);
      const initialLen = listSubprocesses().length;

      registerChildProcess(child, "test", ["arg"]);
      expect(listSubprocesses().length).toBe(initialLen + 1);

      const errorHandler = (child._onceHandlers?.error || [])[0];
      errorHandler(new Error("boom"));

      expect(listSubprocesses().length).toBe(initialLen);
    });
  });

  // ---------------------------------------------------------------------------
  // startSubprocess
  // ---------------------------------------------------------------------------

  describe("startSubprocess", () => {
    it("delegates to spawn and registers the child", () => {
      const child = makeMockChild(1111);
      vi.mocked(childProcess.spawn).mockReturnValueOnce(child);

      const entry = startSubprocess("node", ["--version"], {
        name: "version-check",
      });

      // Note: name is stripped from spawn options, passed only to registerChildProcess
      expect(childProcess.spawn).toHaveBeenCalledWith(
        "node",
        ["--version"],
        {},
      );
      expect(entry.name).toBe("version-check");
    });

    it("uses command as name when name not provided", () => {
      const child = makeMockChild(2222);
      vi.mocked(childProcess.spawn).mockReturnValueOnce(child);

      const entry = startSubprocess("echo", ["hello"]);

      expect(entry.name).toBe("echo");
    });
  });

  // ---------------------------------------------------------------------------
  // listSubprocesses
  // ---------------------------------------------------------------------------

  describe("listSubprocesses", () => {
    it("returns empty list when no processes registered", () => {
      expect(listSubprocesses()).toHaveLength(0);
    });

    it("returns managed subprocesses sorted by id", () => {
      const child1 = makeMockChild(100);
      const child2 = makeMockChild(200);
      const child3 = makeMockChild(300);

      registerChildProcess(child3, "c", []);
      registerChildProcess(child1, "a", []);
      registerChildProcess(child2, "b", []);

      const list = listSubprocesses();
      // Should be sorted by id (registration order)
      expect(list.map((e) => e.id)).toEqual(
        list.map((e) => e.id).sort((a, b) => a - b),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // stopSubprocess
  // ---------------------------------------------------------------------------

  describe("stopSubprocess", () => {
    it("sends SIGTERM to the process", () => {
      const child = makeMockChild(42);
      const entry = registerChildProcess(child, "test", []);
      const id = entry.id;

      const result = stopSubprocess(id);
      expect(result).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("returns false for missing id", () => {
      expect(stopSubprocess(999999)).toBe(false);
    });

    it("handles kill errors gracefully", () => {
      const child = makeMockChild(42);
      (child.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("EPERM");
      });
      const entry = registerChildProcess(child, "test", []);

      const result = stopSubprocess(entry.id);
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // stopAllSubprocesses
  // ---------------------------------------------------------------------------

  describe("stopAllSubprocesses", () => {
    it("stops all registered processes", () => {
      const child1 = makeMockChild(100);
      const child2 = makeMockChild(200);

      registerChildProcess(child1, "a", []);
      registerChildProcess(child2, "b", []);

      stopAllSubprocesses();

      expect(child1.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child2.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });
});
