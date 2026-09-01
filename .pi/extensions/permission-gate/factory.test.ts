import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Factory-level tests: invoke the default export with a fake
// ExtensionAPI and drive the registered commands/handlers end-to-end.
// Modeled on token-limit-guard/index.test.ts' harness. No mocks of pi are
// needed: trust comes from a real trust.json in the scratch
// PI_CODING_AGENT_DIR and write-guard's normalizeWritePath is pure.
//
// /workspace-permissions policy-arg writes are hermetic here: the config
// path is derived from getAgentDir() ($PI_CODING_AGENT_DIR), which the
// harness points at the scratch agentDir (F1/F3).
describe("permission-gate factory (extension registration + handlers)", () => {
  let mod: any;
  let extension: (pi: any) => void;
  let pi: any;
  let handlers: Map<string, any[]>;
  let commands: Record<string, any>;
  let agentDir: string;
  let pkgRoot: string;
  let projectCwd: string;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;
  const prevEnv = process.env.LITTLE_CODER_BASH_ALLOW;

  function makeCtx(
    options: {
      hasUI?: boolean;
      messages?: string[];
    } = {},
  ) {
    const messages = options.messages ?? [];
    return {
      cwd: projectCwd,
      hasUI: options.hasUI ?? true,
      ui: {
        notify: vi.fn((message: string) => messages.push(message)),
        confirm: vi.fn().mockResolvedValue(false),
        select: vi.fn().mockResolvedValue(null),
      },
    };
  }

  async function fireToolCall(toolCall: any, command: string, ctx: any) {
    return toolCall({ toolName: "bash", input: { command } }, ctx);
  }

  beforeEach(async () => {
    agentDir = mkdtempSync(join(tmpdir(), "pgf-agent-"));
    pkgRoot = mkdtempSync(join(tmpdir(), "pgf-pkg-")); // empty: no shadowing
    projectCwd = mkdtempSync(join(tmpdir(), "pgf-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot;
    if (prevEnv === undefined) delete process.env.LITTLE_CODER_BASH_ALLOW;

    vi.resetModules();
    mod = await import("./index.js");
    extension = mod.default;
    mod.clearBashAllowCache(); // belt-and-braces: fresh module state anyway

    handlers = new Map();
    commands = {};
    pi = {
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      registerCommand: vi.fn((name: string, def: any) => {
        commands[name] = def;
      }),
      sendUserMessage: vi.fn(),
    };
  });

  afterEach(() => {
    mod?.clearBashAllowCache?.();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    if (prevEnv === undefined) delete process.env.LITTLE_CODER_BASH_ALLOW;
    else process.env.LITTLE_CODER_BASH_ALLOW = prevEnv;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  it("registers the three commands and session_start + tool_call handlers", () => {
    extension(pi);
    expect(Object.keys(commands).sort()).toEqual([
      "allow",
      "deny",
      "workspace-permissions",
    ]);
    expect(handlers.get("session_start")).toHaveLength(1);
    expect(handlers.get("tool_call")).toHaveLength(1);
  });

  it("tool_call auto mode: blocks non-whitelisted bash, passes builtin ls", async () => {
    extension(pi);
    const ctx = makeCtx();
    const toolCall = handlers.get("tool_call")![0];

    const blocked = await fireToolCall(toolCall, "rm -rf /", ctx);
    expect(blocked).toMatchObject({ block: true });
    expect(blocked.reason).toContain("bash whitelist");

    const allowed = await fireToolCall(toolCall, "ls -la", ctx);
    expect(allowed).toBeUndefined(); // no block
  });

  it("the repo-scoped notice fires once and survives a /deny reload", async () => {
    extension(pi);
    const messages: string[] = [];
    const ctx = makeCtx({ messages });
    const toolCall = handlers.get("tool_call")![0];
    const repoNotices = () =>
      messages.filter((m) => m.includes("repo-scoped prefix")).length;

    // Allow a prefix via the command handler (post-write reload, flags false).
    await commands.allow.handler("make test", ctx);
    // First bash tool_call: the one-time repo notice fires.
    await fireToolCall(toolCall, "ls", ctx);
    expect(repoNotices()).toBe(1);

    // /deny of a prefix NOT in the repo list: nothing removed, but the
    // post-write reload must PRESERVE repoNotified — the repo prefix
    // is still active, so the notice must not fire a second time.
    await commands.deny.handler("npm ci", ctx);
    await fireToolCall(toolCall, "ls", ctx);
    expect(repoNotices()).toBe(1);
  });

  it("negative: the notice does NOT fire for non-bash tool calls", async () => {
    extension(pi);
    const messages: string[] = [];
    const ctx = makeCtx({ messages });
    const toolCall = handlers.get("tool_call")![0];
    const notices = () =>
      messages.filter((m) => m.includes("allowlist")).length;

    // Allow a repo prefix, then call a NON-bash tool: the allowlist
    // notices concern shell commands, so a read tool call must not fire
    // them.
    await commands.allow.handler("make test", ctx);
    await toolCall({ toolName: "read", input: { path: "./README.md" } }, ctx);
    expect(notices()).toBe(0);

    // The same repo prefix still fires exactly once on the next BASH call.
    await fireToolCall(toolCall, "ls", ctx);
    expect(
      messages.filter((m) => m.includes("repo-scoped prefix")).length,
    ).toBe(1);
  });

  it("negative: the notice does NOT fire in accept-all mode (gate inactive)", async () => {
    extension(pi);
    const messages: string[] = [];
    const ctx = makeCtx({ messages });
    const toolCall = handlers.get("tool_call")![0];
    process.env.LITTLE_CODER_PERMISSION_MODE = "accept-all";
    try {
      await commands.allow.handler("make test", ctx);
      await fireToolCall(toolCall, "ls", ctx);
      expect(messages.filter((m) => m.includes("allowlist"))).toHaveLength(0);
    } finally {
      delete process.env.LITTLE_CODER_PERMISSION_MODE;
    }
  });

  it("the notice names the active prefixes (first 6, then a count)", async () => {
    extension(pi);
    const messages: string[] = [];
    const ctx = makeCtx({ messages });
    const toolCall = handlers.get("tool_call")![0];

    // Seven /allow ops → seven repo-scoped prefixes (appended per call).
    for (let i = 0; i < 7; i++)
      await commands.allow.handler(`cmd${i} run`, ctx);
    await fireToolCall(toolCall, "ls", ctx);
    const notice = messages.find((m) => m.includes("repo-scoped prefix"));
    expect(notice).toBeDefined();
    // The word-boundary trailing space is visible inside the quotes.
    expect(notice).toContain('"cmd0 run "');
    expect(notice).toContain('"cmd5 run "');
    expect(notice).not.toContain('"cmd6 run"');
    expect(notice).toContain("and 1 more");
  });

  it("/deny of a builtin reports nothing removed AND the surviving source", async () => {
    extension(pi);
    const messages: string[] = [];
    const ctx = makeCtx({ messages });

    await commands.deny.handler("ls", ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      "was not in this repo's allow list (nothing to remove).",
    );
    expect(messages[0]).toContain(
      "still allowed via the built-in safe prefixes",
    );
  });

  it("commands no-op without throwing when ctx.hasUI is false", async () => {
    extension(pi);
    const ctx = makeCtx({ hasUI: false });

    // /allow and /deny still run their (scratch-dir) state changes but never
    // touch ctx.ui; /workspace-permissions with a policy arg still persists
    // to the hermetic agent dir but skips the notify, and empty args just
    // return (no UI to select from).
    await expect(
      commands.allow.handler("make test", ctx),
    ).resolves.toBeUndefined();
    await expect(
      commands.deny.handler("make test", ctx),
    ).resolves.toBeUndefined();
    await expect(
      commands["workspace-permissions"].handler("deny", ctx),
    ).resolves.toBeUndefined();
    expect(readConfig().externalFilePolicy).toBe("deny");
    await expect(
      commands["workspace-permissions"].handler("", ctx),
    ).resolves.toBeUndefined();
  });

  function readConfig(): { externalFilePolicy: string } {
    return JSON.parse(
      readFileSync(
        join(agentDir, "little-coder-workspace-boundary.json"),
        "utf-8",
      ),
    );
  }

  it("F1: /workspace-permissions deny sets the policy and persists it (no picker)", async () => {
    extension(pi);
    const messages: string[] = [];
    const ctx = makeCtx({ messages });
    await commands["workspace-permissions"].handler("deny", ctx);
    expect(readConfig().externalFilePolicy).toBe("deny");
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(messages[messages.length - 1]).toContain("policy set to 'deny'");
  });

  it("F2: /workspace-permissions accept persists, case-insensitive with trailing args", async () => {
    extension(pi);
    const messages: string[] = [];
    const ctx = makeCtx({ messages });
    // First a bogus arg falls through to the picker (mock returns null → no-op).
    await commands["workspace-permissions"].handler("bogus", ctx);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(
      existsSync(join(agentDir, "little-coder-workspace-boundary.json")),
    ).toBe(false); // picker returned null → nothing written

    await commands["workspace-permissions"].handler("  ACCEPT --verbose ", ctx);
    expect(readConfig().externalFilePolicy).toBe("accept");
    expect(messages[messages.length - 1]).toContain("policy set to 'accept'");
  });

  it("F3: empty / whitespace args fall back to the select picker (regression)", async () => {
    extension(pi);
    const ctx = makeCtx();
    const configPath = join(agentDir, "little-coder-workspace-boundary.json");
    for (const arg of ["", "   "]) {
      await commands["workspace-permissions"].handler(arg, ctx);
    }
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    // Picker mock returns null → nothing written.
    expect(existsSync(configPath)).toBe(false);
  });

  it("/allow handler: confirmation names the saved path; malformed settings report an error", async () => {
    extension(pi);
    const messages: string[] = [];
    const ctx = makeCtx({ messages });
    const settingsPath = join(agentDir, "settings.json");

    await commands.allow.handler("make test", ctx);
    expect(messages[messages.length - 1]).toContain(
      'Allowed "make test" for this repo',
    );
    expect(messages[messages.length - 1]).toContain(`saved to ${settingsPath}`);

    // Malformed global settings: the op fails, the file stays untouched,
    // and the handler reports the error (res.ok === false).
    writeFileSync(settingsPath, "{broken");
    const before = readFileSync(settingsPath, "utf-8");
    await commands.allow.handler("make test", ctx);
    expect(messages[messages.length - 1]).toContain("/allow failed");
    expect(messages[messages.length - 1]).toMatch(/malformed/);
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    expect((await mod.allowBashPrefix("make test", projectCwd)).ok).toBe(false);
  });

  it("/allow --reload and /deny --reload: pure cache invalidation — notify, no settings write", async () => {
    extension(pi);
    const messages: string[] = [];
    const ctx = makeCtx({ messages });
    const settingsPath = join(agentDir, "settings.json");
    const toolCall = handlers.get("tool_call")![0];

    // First make the cache non-empty via a real /allow (writes the file),
    // then snapshot the written file.
    await commands.allow.handler("make test", ctx);
    const written = readFileSync(settingsPath, "utf-8");

    await commands.allow.handler("--reload", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "bash allowlist reloaded",
      "info",
    );
    // Nothing written, cache cleared, but the next tool_call re-reads the
    // settings file and the repo prefix is back.
    expect(readFileSync(settingsPath, "utf-8")).toBe(written);
    expect(mod._getBashAllowCacheKeysForTests()).toHaveLength(0);
    await fireToolCall(toolCall, "ls", ctx);
    expect(mod._getLoadedBashAllowPrefixesForTests()).toContain("make test ");

    await commands.deny.handler("--reload", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "bash allowlist reloaded",
      "info",
    );
    expect(readFileSync(settingsPath, "utf-8")).toBe(written);
    expect(mod._getBashAllowCacheKeysForTests()).toHaveLength(0);
  });

  it("/allow --reload is a no-op without throwing when the cache is empty", async () => {
    extension(pi);
    const ctx = makeCtx();
    await expect(
      commands.allow.handler("--reload", ctx),
    ).resolves.toBeUndefined();
    await expect(
      commands.deny.handler("--reload", ctx),
    ).resolves.toBeUndefined();
  });
});
