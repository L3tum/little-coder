import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySubAgentEnv,
  discoverBundledExtensionArgs,
  shouldAppendSystemPrompt,
  isBrandingExtensionPath,
  formatLaunchTiming,
} from "./launcher-helpers.mjs";

function makeExt(root, name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), "export default function() {}\n");
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("launcher helpers", () => {
  it("keeps branding in normal mode and removes it in issue-agent sub-agent mode", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-launcher-test-"));
    try {
      const extDir = join(tmp, ".pi", "extensions");
      makeExt(extDir, "branding");
      makeExt(extDir, "issue-agent");

      const normal = discoverBundledExtensionArgs(extDir, {
        subagentMode: false,
      });
      expect(normal.join("\n")).toContain("branding/index.ts");
      expect(normal.join("\n")).toContain("issue-agent/index.ts");

      const sub = discoverBundledExtensionArgs(extDir, { subagentMode: true });
      expect(sub.join("\n")).not.toContain("branding/index.ts");
      expect(sub.join("\n")).toContain("issue-agent/index.ts");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sets quiet/offline sub-agent environment", () => {
    const env = applySubAgentEnv({});
    expect(env).toMatchObject({
      LITTLE_CODER_NO_UPDATE_CHECK: "1",
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      CI: "1",
      LITTLE_CODER_SUBAGENT: "1",
    });
  });

  it("does not append the same system prompt path twice", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-prompt-test-"));
    try {
      const agents = join(tmp, "AGENTS.md");
      writeFileSync(agents, "prompt\n");
      expect(shouldAppendSystemPrompt(agents, agents)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("appends different existing system prompt paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-prompt-test-"));
    try {
      const base = join(tmp, "base.md");
      const append = join(tmp, "append.md");
      writeFileSync(base, "base\n");
      writeFileSync(append, "append\n");
      expect(shouldAppendSystemPrompt(base, append)).toBe(true);
      expect(shouldAppendSystemPrompt(base, join(tmp, "missing.md"))).toBe(
        false,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not append a symlink to the same system prompt", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-prompt-test-"));
    try {
      const agents = join(tmp, "AGENTS.md");
      const link = join(tmp, "LINK.md");
      writeFileSync(agents, "prompt\n");
      symlinkSync(agents, link);
      expect(shouldAppendSystemPrompt(agents, link)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("launcher starts far enough to delegate --help to pi", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
      {
        cwd: repoRoot,
        env: { ...process.env, LITTLE_CODER_NO_UPDATE_CHECK: "1" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      "ReferenceError",
    );
    expect(result.status).toBe(0);
  });

  // ---- issueAgentSubagent mode ----

  it("issueAgentSubagent=true skips branding even without subagentMode", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-launcher-test-"));
    try {
      const extDir = join(tmp, ".pi", "extensions");
      makeExt(extDir, "branding");
      makeExt(extDir, "issue-agent");

      const args = discoverBundledExtensionArgs(extDir, {
        subagentMode: false,
        issueAgentSubagent: true,
      });
      expect(args.join("\n")).not.toContain("branding/index.ts");
      expect(args.join("\n")).toContain("issue-agent/index.ts");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- discoverBundledExtensionArgs edge cases ----

  it("returns empty array for empty directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-launcher-test-"));
    try {
      const extDir = join(tmp, ".pi", "extensions");
      mkdirSync(extDir, { recursive: true });
      const args = discoverBundledExtensionArgs(extDir);
      expect(args).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns empty array for non-existent directory", () => {
    const args = discoverBundledExtensionArgs(join(tmpdir(), "no-such-dir"));
    expect(args).toEqual([]);
  });

  it("skips subdirectories without index.ts", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-launcher-test-"));
    try {
      const extDir = join(tmp, ".pi", "extensions");
      mkdirSync(join(extDir, "has-index"), { recursive: true });
      writeFileSync(join(extDir, "has-index", "index.ts"), "code");
      mkdirSync(join(extDir, "no-index"), { recursive: true });
      writeFileSync(join(extDir, "no-index", "main.js"), "code");
      const args = discoverBundledExtensionArgs(extDir);
      expect(args.join("\n")).toContain("has-index");
      expect(args.join("\n")).not.toContain("no-index");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips file entries in extDir (only directories)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-launcher-test-"));
    try {
      const extDir = join(tmp, ".pi", "extensions");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "just-a-file.js"), "code");
      makeExt(extDir, "real-ext");
      const args = discoverBundledExtensionArgs(extDir);
      expect(args.join("\n")).toContain("real-ext");
      expect(args.join("\n")).not.toContain("just-a-file");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // `_`-prefixed dirs are support/shared code, never loadable
  // extensions — a stray `_shared/index.ts` must not become a --extension arg.
  it("skips `_`-prefixed dirs while a normal sibling is still discovered", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-launcher-test-"));
    try {
      const extDir = join(tmp, ".pi", "extensions");
      makeExt(extDir, "_shared");
      makeExt(extDir, "real-ext");
      const args = discoverBundledExtensionArgs(extDir);
      expect(args.join("\n")).toContain("real-ext/index.ts");
      expect(args.join("\n")).not.toContain("_shared");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- applySubAgentEnv edge cases ----

  it("mutates environment in place (same reference)", () => {
    const env = { PATH: "/usr/bin" };
    const result = applySubAgentEnv(env);
    expect(result).toBe(env);
    expect(env.LITTLE_CODER_SUBAGENT).toBe("1");
  });

  it("preserves existing environment variables", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/user" };
    applySubAgentEnv(env);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.LITTLE_CODER_SUBAGENT).toBe("1");
  });

  // ---- isBrandingExtensionPath ----

  it("matches standard unix branding path", () => {
    expect(
      isBrandingExtensionPath("/home/user/.pi/extensions/branding/index.ts"),
    ).toBe(true);
  });

  it("matches windows-style branding path", () => {
    expect(
      isBrandingExtensionPath(
        "C:\\Users\\user\\.pi\\extensions\\branding\\index.ts",
      ),
    ).toBe(true);
  });

  it("does not match non-branding extensions", () => {
    expect(
      isBrandingExtensionPath("/home/user/.pi/extensions/issue-agent/index.ts"),
    ).toBe(false);
    expect(
      isBrandingExtensionPath("/home/user/.pi/extensions/branding/main.ts"),
    ).toBe(false);
  });
});

// ---- formatLaunchTiming (LITTLE_CODER_TIMING=1) ----

describe("formatLaunchTiming", () => {
  it("renders all phases in a single line", () => {
    const line = formatLaunchTiming({
      discovery: 3.4,
      updatecheck: 0.1,
      updateprompt: 0.1,
      settings: 1.9,
      spawn: 5.2,
      total: 12.7,
    });
    expect(line).toBe(
      "little-coder launch timing: " +
        "discovery=3ms updatecheck=0ms updateprompt=0ms settings=2ms spawn=5ms total=13ms",
    );
  });

  it("clamps negative/float values to whole milliseconds", () => {
    const line = formatLaunchTiming({
      discovery: -1,
      updatecheck: 0.4,
      updateprompt: 0.6,
      settings: 0.6,
      spawn: 1,
      total: 2.49,
    });
    expect(line).toBe(
      "little-coder launch timing: " +
        "discovery=0ms updatecheck=0ms updateprompt=1ms settings=1ms spawn=1ms total=2ms",
    );
  });

  // a missing/non-finite mark must render as 0ms, never "NaNms".
  it("renders 0ms for missing/non-finite marks (no NaN)", () => {
    const line = formatLaunchTiming({ discovery: 1, spawn: 2 });
    expect(line).toBe(
      "little-coder launch timing: " +
        "discovery=1ms updatecheck=0ms updateprompt=0ms settings=0ms spawn=2ms total=0ms",
    );
    expect(line).not.toContain("NaN");
  });
});
