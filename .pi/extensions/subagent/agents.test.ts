import { describe, expect, it } from "vitest";
import { builtInLittleCoderAgents, validateBuiltInAgents } from "./agents.js";

describe("built-in agents", () => {
  it("all built-in agents have required fields", () => {
    expect(() => validateBuiltInAgents()).not.toThrow();
  });

  it("includes all expected built-in agents", () => {
    const agents = builtInLittleCoderAgents();
    const names = agents.map((a) => a.name);
    // Core agents
    expect(names).toContain("PLAN");
    expect(names).toContain("EXECUTION");
    expect(names).toContain("REVIEW");
    expect(names).toContain("EXPLORE");
    // Deep plan phase agents
    expect(names).toContain("REFINE");
    expect(names).toContain("RESEARCH");
    expect(names).toContain("COMPOSE");
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
  it("has REFINE agent with medium thinking and read-only tools", () => {
    const agents = builtInLittleCoderAgents();
    const refine = agents.find((a) => a.name === "REFINE");
    expect(refine).toBeDefined();
    expect(refine!.thinking).toBe("medium");
    expect(refine!.tools).toContain("read");
    expect(refine!.tools).toContain("code_search");
    expect(refine!.systemPrompt).toContain("Deep Plan — Refine Phase");
  });

  it("has RESEARCH agent with medium thinking and evidence tools", () => {
    const agents = builtInLittleCoderAgents();
    const research = agents.find((a) => a.name === "RESEARCH");
    expect(research).toBeDefined();
    expect(research!.thinking).toBe("medium");
    expect(research!.tools).toContain("code_search");
    expect(research!.tools).toContain("EvidenceAdd");
    expect(research!.tools).toContain("websearch");
    expect(research!.systemPrompt).toContain("Deep Plan — Research Phase");
  });

  it("has COMPOSE agent with medium thinking and specification prompt", () => {
    const agents = builtInLittleCoderAgents();
    const compose = agents.find((a) => a.name === "COMPOSE");
    expect(compose).toBeDefined();
    expect(compose!.thinking).toBe("medium");
    expect(compose!.systemPrompt).toContain("Deep Plan — Compose Phase");
    expect(compose!.systemPrompt).toContain("Implementation Steps");
  });

  it("phase agents are read-only (no write/edit tools)", () => {
    const agents = builtInLittleCoderAgents();
    for (const name of ["REFINE", "RESEARCH", "COMPOSE"]) {
      const agent = agents.find((a) => a.name === name);
      expect(agent).toBeDefined();
      expect(agent!.tools).not.toContain("write");
      expect(agent!.tools).not.toContain("edit");
    }
  });
});
