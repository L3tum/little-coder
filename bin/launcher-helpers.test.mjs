import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySubAgentEnv, discoverBundledExtensionArgs, shouldAppendSystemPrompt } from "./launcher-helpers.mjs";

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

      const normal = discoverBundledExtensionArgs(extDir, { subagentMode: false });
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
      expect(shouldAppendSystemPrompt(base, join(tmp, "missing.md"))).toBe(false);
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
    const result = spawnSync(process.execPath, [join(repoRoot, "bin", "little-coder.mjs"), "--help"], {
      cwd: repoRoot,
      env: { ...process.env, LITTLE_CODER_NO_UPDATE_CHECK: "1" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("ReferenceError");
    expect(result.status).toBe(0);
  });
});
