import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  planningModePrompt,
  SHARED_PLANNING_GUIDANCE,
} from "./planning-prompt.js";
import {
  applyTextPatch,
  isPatchApplied,
  PATCHES,
} from "../../../scripts/patch-extension-notifications.mjs";

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
    const patch = PATCHES.find(
      (p) => p.name === "plannotator /plan canonical command shim",
    );
    expect(patch).toBeDefined();
    const patched = applyTextPatch(patch!.oldText, patch!);
    expect(patched).toContain('registerCommand("plan"');
    expect(patched).toContain('registerCommand("plannotator"');
    expect(patched).toContain("Compatibility alias for /plan");
  });

  it("pi-vcc proactive trigger patch guards against double compaction", () => {
    const patch = PATCHES.find(
      (p) =>
        p.name ===
        "pi-vcc: proactive trigger guards against double/triple compaction",
    );
    expect(patch).toBeDefined();
    const patched = applyTextPatch(patch!.oldText, patch!);
    // Pre-flight check: don't call ctx.compact() when the branch still ends in
    // a compaction entry (the manual path would throw "Already compacted").
    expect(patched).toContain("requestCompaction");
    expect(patched).toContain(
      "skipping compaction — no new messages since the last compaction",
    );
    // All three trigger sites route through the guarded helper.
    expect(patched.match(/requestCompaction\(ctx/g)).toHaveLength(3);
    // Benign no-ops are swallowed instead of surfacing as failed compactions.
    expect(patched).toContain('msg === "Already compacted"');
  });

  it("pi-vcc proactive trigger patch matches the installed dependency", () => {
    const patch = PATCHES.find(
      (p) =>
        p.name ===
        "pi-vcc: proactive trigger guards against double/triple compaction",
    );
    expect(patch).toBeDefined();
    const file = patch!.path.join("/");
    if (!existsSync(file)) return; // node_modules absent (CI pruned install)
    const current = readFileSync(file, "utf8");
    // The patch may have been superseded by later patches inserting text
    // inside its newText — the applicator's idempotency check is the right
    // way to assert the patch is present.
    expect(isPatchApplied(current, patch!)).toBe(true);
  });

  it("pi-vcc defers to pi-core when pi-core will compact on agent_end", () => {
    const patch = PATCHES.find(
      (p) =>
        p.name ===
        "pi-vcc: proactive trigger defers to pi-core threshold compaction",
    );
    expect(patch).toBeDefined();
    const patched = applyTextPatch(patch!.oldText, patch!);
    expect(patched).toContain("pi-core runs its own threshold check");
    expect(patched).toContain("readPiCoreReserveTokens(cwd)");
    expect(patched).toContain('source === "auto"');

    // Also verify the supporting patches apply on top of the main patch.
    const helper = PATCHES.find(
      (p) =>
        p.name === "pi-vcc: proactive threshold mirrors pi-core reserveTokens",
    );
    expect(helper).toBeDefined();
    const withHelper = applyTextPatch(helper!.oldText, helper!);
    expect(withHelper).toContain("const readPiCoreReserveTokens");
    expect(withHelper).toContain("return 16384;");
  });

  it("pi-vcc deferred resume swallows a stale extension ctx", () => {
    const patch = PATCHES.find(
      (p) =>
        p.name ===
        "pi-vcc: make deferred invisible continue resilient to stale ctx",
    );
    expect(patch).toBeDefined();
    const patched = applyTextPatch(patch!.oldText, patch!);
    // The resume body is wrapped in a try/catch so a stale ctx (session
    // replaced/reloaded after scheduling) is a silent no-op, not a crash.
    expect(patched).toContain("setImmediate(() => {");
    expect(patched).toContain("try {");
    expect(patched).toContain("ctx is stale");
    expect(patched).toContain("} catch {");
    expect(patched).toContain("triggerInvisibleContinue(pi);");
  });
});
