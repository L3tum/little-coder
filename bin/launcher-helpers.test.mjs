import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySubAgentEnv, discoverBundledExtensionArgs, shouldAppendSystemPrompt } from "./launcher-helpers.mjs";

function makeExt(root, name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), "export default function() {}\n");
}

describe("launcher helpers", () => {
  it("keeps branding in normal mode and removes it in issue-agent sub-agent mode", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-launcher-test-"));
    try {
      const extDir = join(tmp, ".pi", "extensions");
      makeExt(extDir, "branding");
      makeExt(extDir, "issue-agent");

      const normal = discoverBundledExtensionArgs(extDir, { issueAgentSubagent: false });
      expect(normal.join("\n")).toContain("branding/index.ts");
      expect(normal.join("\n")).toContain("issue-agent/index.ts");

      const sub = discoverBundledExtensionArgs(extDir, { issueAgentSubagent: true });
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
});
