import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { planningModePrompt, SHARED_PLANNING_GUIDANCE } from "./planning-prompt.js";
import { applyTextPatch, PATCHES } from "../../../scripts/patch-extension-notifications.mjs";

describe("plan mode integration", () => {
  it("adds pi-ask-user to package directives and dependencies", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.littleCoder.packages).toContain("pi-ask-user");
    expect(pkg.dependencies["pi-ask-user"]).toBeDefined();
  });

  it("shared planning prompt prefers code-aware research and evidence", () => {
    expect(SHARED_PLANNING_GUIDANCE).toContain("code_search");
    expect(SHARED_PLANNING_GUIDANCE).toContain("lsp");
    expect(SHARED_PLANNING_GUIDANCE).toContain("findRead");
    expect(SHARED_PLANNING_GUIDANCE).toContain("EvidenceAdd");
    expect(SHARED_PLANNING_GUIDANCE).toContain("websearch");
    expect(SHARED_PLANNING_GUIDANCE).toContain("webfetch");
  });

  it("interactive planning prompt prefers ask_user", () => {
    expect(planningModePrompt({ mode: "interactive" })).toContain("ask_user");
  });

  it("issue-agent planning prompt uses issueAgentAsk instead of ask_user", () => {
    const prompt = planningModePrompt({ mode: "issue-agent" });
    expect(prompt).toContain("issueAgentAsk");
    expect(prompt).toContain("Do not call ask_user");
  });

  it("postinstall patch makes /plan canonical and /plannotator a compat alias", () => {
    const patch = PATCHES.find((p) => p.name === "plannotator /plan canonical command shim");
    expect(patch).toBeDefined();
    const patched = applyTextPatch(patch!.oldText, patch!);
    expect(patched).toContain('registerCommand("plan"');
    expect(patched).toContain('registerCommand("plannotator"');
    expect(patched).toContain("Compatibility alias for /plan");
  });
});
