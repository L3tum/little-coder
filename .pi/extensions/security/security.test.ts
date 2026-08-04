import { describe, it, expect, vi, beforeEach } from "vitest";

describe("security extension", () => {
  let extension: (pi: any) => void;
  let pi: any;
  let handlers: Map<string, any[]>;
  let ctx: any;
  let notifyMock: any;
  let confirmMock: any;

  beforeEach(async () => {
    notifyMock = vi.fn();
    confirmMock = vi.fn();
    ctx = {
      hasUI: true,
      ui: { notify: notifyMock, confirm: confirmMock },
    };

    handlers = new Map();
    pi = {
      on: vi.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
    };

    vi.resetModules();
    const mod = await import("./index.js");
    extension = mod.default;
  });

  describe("bash dangerous commands", () => {
    beforeEach(() => extension(pi));

    it("blocks rm -rf and prompts user when UI is available", async () => {
      confirmMock.mockResolvedValue(false);
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "bash", input: { command: "rm -rf /tmp/data" } },
        ctx,
      );
      expect(result.block).toBe(true);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("blocks rm -rf without prompt when no UI", async () => {
      const noUiCtx = { hasUI: false };
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "bash", input: { command: "rm -rf /tmp/data" } },
        noUiCtx,
      );
      expect(result.block).toBe(true);
      expect(result.reason).toContain("no UI");
    });
  });

  describe("bash redirect to protected paths", () => {
    beforeEach(() => extension(pi));

    it("notifies user and blocks redirect to .env", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "bash", input: { command: "echo secret > .env" } },
        ctx,
      );
      expect(result.block).toBe(true);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Blocked bash write to protected path",
        "warning",
      );
    });

    it("blocks tee to .env", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "bash", input: { command: "echo secret | tee .env" } },
        ctx,
      );
      expect(result.block).toBe(true);
    });
  });

  describe("direct write/edit to protected paths", () => {
    beforeEach(() => extension(pi));

    it("notifies and blocks write to .env", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { path: ".env" } },
        ctx,
      );
      expect(result.block).toBe(true);
      expect(ctx.ui.notify).toHaveBeenCalled();
    });

    it("blocks write to .ssh directory", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { path: "~/.ssh/authorized_keys" } },
        ctx,
      );
      expect(result.block).toBe(true);
    });

    it("blocks write to SSH key files", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { path: "id_rsa" } },
        ctx,
      );
      expect(result.block).toBe(true);
    });

    it("blocks write to node_modules", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { path: "node_modules/foo/index.js" } },
        ctx,
      );
      expect(result.block).toBe(true);
    });

    it("blocks edit to .git directory", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "edit", input: { path: ".git/config" } },
        ctx,
      );
      expect(result.block).toBe(true);
    });
  });

  describe("soft-protected paths", () => {
    beforeEach(() => extension(pi));

    it("confirms before modifying package-lock.json with UI", async () => {
      confirmMock.mockResolvedValue(true);
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { path: "package-lock.json" } },
        ctx,
      );
      expect(ctx.ui.confirm).toHaveBeenCalled();
      expect(result).toBeUndefined(); // approved, not blocked
    });

    it("blocks package-lock.json without UI", async () => {
      const noUiCtx = { hasUI: false };
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { path: "package-lock.json" } },
        noUiCtx,
      );
      expect(result.block).toBe(true);
    });

    it("blocks on user decline for yarn.lock", async () => {
      confirmMock.mockResolvedValue(false);
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { path: "yarn.lock" } },
        ctx,
      );
      expect(result.block).toBe(true);
      expect(result.reason).toContain("User blocked");
    });
  });

  describe("file_path fallback — direct write/edit to protected paths", () => {
    beforeEach(() => extension(pi));

    it("blocks write to .env via file_path", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { file_path: ".env" } },
        ctx,
      );
      expect(result.block).toBe(true);
      expect(ctx.ui.notify).toHaveBeenCalled();
    });

    it("blocks write to .dev.vars via file_path", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { file_path: ".dev.vars" } },
        ctx,
      );
      expect(result.block).toBe(true);
    });

    it("blocks write to .ssh/authorized_keys via file_path", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { file_path: "~/.ssh/authorized_keys" } },
        ctx,
      );
      expect(result.block).toBe(true);
    });

    it("blocks write to node_modules via file_path", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        {
          toolName: "write",
          input: { file_path: "node_modules/foo/index.js" },
        },
        ctx,
      );
      expect(result.block).toBe(true);
    });

    it("blocks edit to .git/config via file_path", async () => {
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "edit", input: { file_path: ".git/config" } },
        ctx,
      );
      expect(result.block).toBe(true);
    });

    it("confirms before modifying package-lock.json via file_path with UI", async () => {
      confirmMock.mockResolvedValue(true);
      const handler = handlers.get("tool_call")[0];
      const result = await handler(
        { toolName: "write", input: { file_path: "package-lock.json" } },
        ctx,
      );
      expect(ctx.ui.confirm).toHaveBeenCalled();
      expect(result).toBeUndefined(); // approved, not blocked
    });
  });
});
