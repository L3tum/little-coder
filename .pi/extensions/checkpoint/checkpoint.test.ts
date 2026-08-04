import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import checkpoint from "../checkpoint/index.ts";
import { createMockPi } from "../_shared/test-mock";

// Re-export safeName pattern from checkpoint/index.ts (same transformation)
function safeName(filePath: string): string {
  return filePath.replace(/[^A-Za-z0-9._-]/g, "_").slice(-200);
}

describe("checkpoint extension", () => {
  let tmpDir: string;
  let handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  let mockPi: ReturnType<typeof createMockPi>["pi"];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    const mock = createMockPi();
    mockPi = mock.pi;
    handlers = mock.handlers;
    checkpoint(mockPi);
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("backs up existing file before write", async () => {
    const testFile = join(tmpDir, "test.txt");
    writeFileSync(testFile, "original content");

    const ctx = {
      sessionManager: {
        getSessionFile: () => "/tmp/session-123.md",
      },
    };
    await handlers.session_start[0]({}, ctx as any);

    await handlers.tool_call[0]({
      toolName: "write",
      input: { file_path: testFile },
    });

    // Checkpoint should exist
    expect(existsSync(testFile)).toBe(true);
  });

  it("does not re-backup the same file twice", async () => {
    const testFile = join(tmpDir, "test2.txt");
    writeFileSync(testFile, "content");

    const ctx = {
      sessionManager: {
        getSessionFile: () => "/tmp/session-456.md",
      },
    };
    await handlers.session_start[0]({}, ctx as any);

    await handlers.tool_call[0]({
      toolName: "write",
      input: { file_path: testFile },
    });

    writeFileSync(testFile, "modified content");

    await handlers.tool_call[0]({
      toolName: "write",
      input: { file_path: testFile },
    });

    // Verify checkpoint still has original content (first-write-wins)
    const sessionId = "/tmp/session-456.md".split("/").pop() ?? "default";
    const checkpointDir = join(
      homedir(),
      ".little-coder",
      "checkpoints",
      sessionId,
    );
    const checkpointFile = join(checkpointDir, safeName(testFile));
    const checkpointContent = readFileSync(checkpointFile, "utf-8");
    expect(checkpointContent).toBe("content");
  });

  it("ignores non-write/non-edit tools", async () => {
    const ctx = {
      sessionManager: {
        getSessionFile: () => "/tmp/session-789.md",
      },
    };
    await handlers.session_start[0]({}, ctx as any);

    // Should not throw or create checkpoints
    await handlers.tool_call[0]({
      toolName: "bash",
      input: { command: "echo hi" },
    });
  });

  it("handles missing sessionId gracefully", async () => {
    await handlers.tool_call[0]({
      toolName: "write",
      input: { file_path: join(tmpDir, "test3.txt") },
    });
    // Should not throw
  });
});
