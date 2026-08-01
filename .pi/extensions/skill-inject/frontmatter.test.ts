import { describe, it, expect } from "vitest";
import { parseSkillFile } from "./frontmatter.ts";

describe("parseSkillFile", () => {
  it("parses basic tool-guidance frontmatter", () => {
    const text = `---
name: read-guidance
type: tool-guidance
target_tool: Read
priority: 10
token_cost: 100
user-invocable: false
---
## Read Tool
Body content here.`;
    const p = parseSkillFile(text);
    expect(p).not.toBeNull();
    expect(p!.frontmatter.name).toBe("read-guidance");
    expect(p!.frontmatter.target_tool).toBe("Read");
    expect(p!.frontmatter.token_cost).toBe(100);
    expect(p!.frontmatter.priority).toBe(10);
    expect(p!.body.startsWith("## Read Tool")).toBe(true);
  });

  it("parses knowledge frontmatter with keyword arrays", () => {
    const text = `---
name: bfs-state-space
type: domain-knowledge
topic: State-Space Search
token_cost: 120
keywords: [bucket, pouring, state space, minimum moves, shortest sequence]
---
When a problem asks for minimum moves.`;
    const p = parseSkillFile(text);
    expect(p).not.toBeNull();
    expect(p!.frontmatter.topic).toBe("State-Space Search");
    expect(p!.frontmatter.keywords).toEqual([
      "bucket",
      "pouring",
      "state space",
      "minimum moves",
      "shortest sequence",
    ]);
  });

  it("parses multi-line flow arrays (Prettier reformatted)", () => {
    const text = `---
name: bfs-state-space
type: domain-knowledge
topic: State-Space Search
token_cost: 120
keywords:
  [
    bucket,
    pouring,
    state space,
  ]
requires_tools: [Read]
user-invocable: false
description: Test.
---
Body content.`;
    const p = parseSkillFile(text);
    expect(p).not.toBeNull();
    expect(Array.isArray(p!.frontmatter.keywords)).toBe(true);
    expect(p!.frontmatter.keywords).toEqual([
      "bucket",
      "pouring",
      "state space",
    ]);
    expect(p!.frontmatter.requires_tools).toEqual(["Read"]);
    expect(p!.frontmatter["user-invocable"]).toBe(false);
    expect(p!.frontmatter.description).toBe("Test.");
  });

  it("parses requires_tools arrays", () => {
    const text = `---
name: workspace-docs
topic: Workspace Documentation
keywords: [spec, readme]
requires_tools: [Read, Glob]
---
body`;
    const p = parseSkillFile(text);
    expect(p!.frontmatter.requires_tools).toEqual(["Read", "Glob"]);
  });

  it("returns null on missing frontmatter", () => {
    expect(parseSkillFile("no frontmatter here")).toBeNull();
  });

  it("handles body with multiple --- separators", () => {
    const text = `---
name: x
topic: X
---
body line 1
---
body line 2`;
    const p = parseSkillFile(text);
    expect(p).not.toBeNull();
    // Body should preserve everything after the closing ---
    expect(p!.body).toContain("body line 1");
    expect(p!.body).toContain("body line 2");
  });
});
