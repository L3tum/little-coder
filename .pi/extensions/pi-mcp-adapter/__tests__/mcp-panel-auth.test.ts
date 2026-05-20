import { describe, expect, it, vi } from "vitest";
import { createMcpPanel } from "../mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import type { McpConfig, McpPanelCallbacks } from "../types.ts";

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function createCache(config: McpConfig): MetadataCache {
  return {
    version: 1,
    servers: {
      github: {
        configHash: computeServerHash(config.mcpServers.github),
        cachedAt: Date.now(),
        tools: [{ name: "search", description: "Search" }],
        resources: [],
      },
    },
  };
}

function createCallbacks(status: "connected" | "idle" | "failed" | "needs-auth" = "needs-auth") {
  let currentStatus = status;
  const callbacks: McpPanelCallbacks = {
    reconnect: async () => true,
    canAuthenticate: (serverName) => serverName === "github",
    authenticate: vi.fn(async () => {
      currentStatus = "idle";
      return { ok: true };
    }),
    getConnectionStatus: () => currentStatus,
    refreshCacheAfterReconnect: () => null,
  };
  return callbacks;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("mcp-panel auth actions", () => {
  it("authenticates a needs-auth server when pressing enter", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    const tui = { requestRender: vi.fn() };
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, tui, () => {});

    panel.handleInput("\r");
    await Promise.resolve();

    expect(callbacks.authenticate).toHaveBeenCalledWith("github");
    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("OAuth finished for github");
    panel.dispose();
  });

  it("authenticates OAuth-capable idle servers with ctrl+a", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("idle");
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\x01");
    await Promise.resolve();

    expect(callbacks.authenticate).toHaveBeenCalledWith("github");
    panel.dispose();
  });

  it("shows concrete auth failure messages in the panel", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    callbacks.authenticate = vi.fn(async () => ({ ok: false, message: "browser launch failed" }));
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");
    await Promise.resolve();

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("OAuth failed for github: browser launch failed");
    panel.dispose();
  });

  it("does not start duplicate auth while auth is already in flight", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    const auth = deferred<{ ok: boolean }>();
    callbacks.authenticate = vi.fn(() => auth.promise);
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");
    panel.handleInput("\r");
    panel.handleInput("\x01");

    expect(callbacks.authenticate).toHaveBeenCalledTimes(1);
    auth.resolve({ ok: true });
    await Promise.resolve();
    panel.dispose();
  });

  it("filters the auth picker to OAuth-capable servers", () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
        local: { command: "node", args: ["server.js"] },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {}, {
      authOnly: true,
      noticeLines: ["Select an OAuth MCP server"],
    });

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("MCP OAuth");
    expect(output).toContain("github");
    expect(output).not.toContain("local");
    panel.dispose();
  });

  it("treats Space as a no-op in auth-only mode", () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {}, {
      authOnly: true,
    });

    panel.handleInput(" ");

    expect(callbacks.authenticate).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("searches server rows directly in auth-only mode", () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
        gitlab: { url: "https://gitlab.example.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    callbacks.canAuthenticate = () => true;
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {}, {
      authOnly: true,
    });

    panel.handleInput("l");
    panel.handleInput("a");
    panel.handleInput("b");

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("gitlab");
    expect(output).not.toContain("github");
    panel.dispose();
  });

  it("ignores description-search shortcut in auth-only mode", () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
        gitlab: { url: "https://gitlab.example.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    callbacks.canAuthenticate = () => true;
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {}, {
      authOnly: true,
    });

    panel.handleInput("?");
    panel.handleInput("l");
    panel.handleInput("a");
    panel.handleInput("b");

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).not.toContain("desc:");
    expect(output).toContain("gitlab");
    expect(output).not.toContain("github");
    panel.dispose();
  });
});
