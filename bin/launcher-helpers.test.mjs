import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySubAgentEnv, discoverBundledExtensionArgs } from "./launcher-helpers.mjs";

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
});
