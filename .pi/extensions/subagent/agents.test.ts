import { describe, expect, it } from "vitest";
import { builtInLittleCoderAgents, validateBuiltInAgents } from "./agents.js";

describe("built-in agents", () => {
  it("all built-in agents have required fields", () => {
    expect(() => validateBuiltInAgents()).not.toThrow();
  });

  it("includes all expected built-in agents with unique names", () => {
    const agents = builtInLittleCoderAgents();
    const names = agents.map((a) => a.name);
    // mergeAgents dedupes by name — a duplicate would silently collapse an agent,
    // so the names must be unique.
    expect(new Set(names).size).toBe(agents.length);
    // Core agents
    expect(names).toContain("PLAN");
    expect(names).toContain("EXECUTION");
    expect(names).toContain("REVIEW");
    expect(names).toContain("EXPLORE");
    // Deep plan phase agents
    expect(names).toContain("RESEARCH");
    expect(names).toContain("COMPOSE");
    expect(names).toContain("REVIEW-PLAN");
    expect(names).toContain("REVIEW-PLAN-PONYTAIL");
    expect(names).toContain("REVIEW-SYNTHESIS");
    // Themed review agents
    expect(names).toContain("REVIEW-SECURITY");
    expect(names).toContain("REVIEW-ARCHITECTURE");
    expect(names).toContain("REVIEW-TESTS");
    expect(names).toContain("REVIEW-BUGS");
    expect(names).toContain("REVIEW-PERFORMANCE");
  });

  it("themed review agents have read-only tools", () => {
    const agents = builtInLittleCoderAgents();
    for (const name of [
      "REVIEW-SECURITY",
      "REVIEW-ARCHITECTURE",
      "REVIEW-TESTS",
      "REVIEW-BUGS",
      "REVIEW-PERFORMANCE",
      "REVIEW-LINTING",
      "REVIEW-PONYTAIL",
      "REVIEW-SYNTHESIS",
    ]) {
      const agent = agents.find((a) => a.name === name);
      expect(agent).toBeDefined();
      // Should have read tools
      expect(agent!.tools).toContain("read");
      // Should NOT have write/edit tools (read-only reviewers)
      expect(agent!.tools).not.toContain("write");
      expect(agent!.tools).not.toContain("edit");
    }
  });

  it("PLAN agent has high thinking and planning tools", () => {
    const agents = builtInLittleCoderAgents();
    const plan = agents.find((a) => a.name === "PLAN");
    expect(plan).toBeDefined();
    expect(plan!.thinking).toBe("high");
    expect(plan!.tools).toContain("code_search");
    expect(plan!.tools).toContain("websearch");
  });
});

describe("deep plan phase agents", () => {
  it("has RESEARCH agent with medium thinking and evidence tools (Phase 1)", () => {
    const agents = builtInLittleCoderAgents();
    const research = agents.find((a) => a.name === "RESEARCH");
    expect(research).toBeDefined();
    expect(research!.thinking).toBe("medium");
    expect(research!.tools).toContain("code_search");
    expect(research!.tools).toContain("EvidenceAdd");
    expect(research!.tools).toContain("websearch");
    expect(research!.systemPrompt).toContain("Deep Plan — Research Phase");
    expect(research!.systemPrompt).toContain("Phase 1");
  });

  it("has COMPOSE agent with medium thinking and specification prompt (dual DRAFT/FINAL role)", () => {
    const agents = builtInLittleCoderAgents();
    const compose = agents.find((a) => a.name === "COMPOSE");
    expect(compose).toBeDefined();
    expect(compose!.thinking).toBe("medium");
    expect(compose!.systemPrompt).toContain("Deep Plan — Compose Phase");
    expect(compose!.systemPrompt).toContain("You run");
    expect(compose!.systemPrompt).toContain("twice in the pipeline");
    expect(compose!.systemPrompt).toContain("Implementation Steps");
    // Concise template: checkbox steps, plain-language Overview, no Context section
    expect(compose!.systemPrompt).toContain("- [ ] **Short headline**");
    expect(compose!.systemPrompt).toContain("## Overview");
    expect(compose!.systemPrompt).not.toContain("## Context");
    // Dual role keyed on the explicit DRAFT/FINAL word in the task
    expect(compose!.systemPrompt).toContain("DRAFT");
    expect(compose!.systemPrompt).toContain("FINAL");
  });

  it("has REVIEW-PLAN agent with high thinking for adversarial review (Phase 3)", () => {
    const agents = builtInLittleCoderAgents();
    const reviewPlan = agents.find((a) => a.name === "REVIEW-PLAN");
    expect(reviewPlan).toBeDefined();
    expect(reviewPlan!.thinking).toBe("high");
    expect(reviewPlan!.tools).toContain("read");
    expect(reviewPlan!.tools).toContain("code_search");
    expect(reviewPlan!.tools).toContain("EvidenceAdd");
    expect(reviewPlan!.tools).toContain("EvidenceList");
    expect(reviewPlan!.systemPrompt).toContain("Deep Plan — Review Phase");
    expect(reviewPlan!.systemPrompt).toContain("Phase 3");
    expect(reviewPlan!.systemPrompt).toContain("Verify code references");
    expect(reviewPlan!.systemPrompt).toContain("Confidence Rating");
    // Phase 3 is a parallel review, no longer the final phase
    expect(reviewPlan!.systemPrompt).not.toContain("final phase");
  });

  it("has REVIEW-PLAN-PONYTAIL agent for lazy-engineering plan review (Phase 3, parallel)", () => {
    const agents = builtInLittleCoderAgents();
    const ponytail = agents.find((a) => a.name === "REVIEW-PLAN-PONYTAIL");
    expect(ponytail).toBeDefined();
    expect(ponytail!.thinking).toBe("medium");
    expect(ponytail!.tools).toContain("read");
    expect(ponytail!.tools).toContain("code_search");
    expect(ponytail!.tools).toContain("EvidenceAdd");
    expect(ponytail!.tools).toContain("EvidenceList");
    // Read-only plan reviewer — no bash, no write/edit
    expect(ponytail!.tools).not.toContain("bash");
    expect(ponytail!.tools).not.toContain("write");
    expect(ponytail!.tools).not.toContain("edit");
    expect(ponytail!.systemPrompt).toContain("Plan Ponytail Review Report");
    expect(ponytail!.systemPrompt).toContain("DELETE");
    expect(ponytail!.systemPrompt).toContain("SIMPLIFY");
    expect(ponytail!.systemPrompt).toContain("NOTE");
    expect(ponytail!.systemPrompt).toContain("Verdict");
    // Defers fact-checking to REVIEW-PLAN
    expect(ponytail!.systemPrompt).toContain("REVIEW-PLAN");
  });

  it("read-only agents share the same read-only tool list", () => {
    const agents = builtInLittleCoderAgents();
    const readOnly = ["EXPLORE", "REVIEW-PLAN", "REVIEW-PLAN-PONYTAIL"].map(
      (name) => agents.find((a) => a.name === name)!.tools!,
    );
    // Exact match by VALUE — a stray 9th tool (e.g. bash) must fail this test,
    // while each agent keeps its own array (no shared reference to mutate).
    for (const tools of readOnly) {
      expect(tools).toEqual([
        "read",
        "findRead",
        "glob",
        "grep",
        "code_search",
        "lsp",
        "EvidenceAdd",
        "EvidenceList",
      ]);
    }
  });

  it("phase agents are read-only (no write/edit tools)", () => {
    const agents = builtInLittleCoderAgents();
    for (const name of [
      "RESEARCH",
      "COMPOSE",
      "REVIEW-PLAN",
      "REVIEW-PLAN-PONYTAIL",
    ]) {
      const agent = agents.find((a) => a.name === name);
      expect(agent).toBeDefined();
      expect(agent!.tools).not.toContain("write");
      expect(agent!.tools).not.toContain("edit");
    }
  });
});
