import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFile } from "./frontmatter.ts";
import { predictTools, type SkillEntry } from "./index.ts";

function toolSkill(targetTool: string, keywords: string[]): SkillEntry {
  return {
    name: `${targetTool}-guidance`,
    type: "tool-guidance",
    sourceDir: "tools",
    origin: "repo",
    path: `/skills/tools/${targetTool}.md`,
    body: "",
    tokenCost: 100,
    targetTool,
    keywords,
    requiresTools: [],
  };
}

const toolSkills = [
  toolSkill("read", ["read", "show", "view"]),
  toolSkill("edit", ["edit", "fix", "change", "update"]),
  toolSkill("bash", ["run", "test", "build", "install"]),
  toolSkill("glob", ["find", "glob", "files", "pattern"]),
  toolSkill("grep", ["find", "search", "grep", "regex"]),
  toolSkill("webfetch", ["fetch", "download", "url"]),
];

describe("frontmatter-driven tool prediction", () => {
  it("predicts read for 'read config.py'", () => {
    expect(predictTools("read config.py and show me the output", toolSkills)).toContain("read");
  });
  it("predicts edit for 'fix the bug'", () => {
    const p = predictTools("please fix the bug in auth.py", toolSkills);
    expect(p).toContain("edit");
  });
  it("predicts bash for 'run the tests'", () => {
    const p = predictTools("run the tests and build the project", toolSkills);
    expect(p).toContain("bash");
  });
  it("predicts glob+grep for 'find all files'", () => {
    const p = predictTools("find all files matching the pattern", toolSkills);
    expect(p).toContain("glob");
    expect(p).toContain("grep");
  });
  it("empty predictions for neutral prompts", () => {
    expect(predictTools("hello there", toolSkills)).toEqual([]);
  });
});

describe("skills directory loads from repo", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const skillsRoot = join(here, "..", "..", "..", "skills");
  const toolsDir = join(skillsRoot, "tools");
  const knowledgeDir = join(skillsRoot, "knowledge");
  const protocolsDir = join(skillsRoot, "protocols");

  it("exists and has markdown files in each bundled skill subdirectory", () => {
    for (const dir of [toolsDir, knowledgeDir, protocolsDir]) {
      expect(existsSync(dir)).toBe(true);
      const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      expect(files.length).toBeGreaterThan(0);
    }
  });

  it("every tool skill has target_tool in frontmatter", () => {
    const files = readdirSync(toolsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const parsed = parseSkillFile(readFileSync(join(toolsDir, file), "utf-8"));
      expect(parsed, `${file} should parse`).not.toBeNull();
      expect(typeof parsed!.frontmatter.target_tool).toBe("string");
    }
  });

  it("core tools are all represented", () => {
    const files = readdirSync(toolsDir).filter((f) => f.endsWith(".md"));
    const targets = new Set<string>();
    for (const file of files) {
      const parsed = parseSkillFile(readFileSync(join(toolsDir, file), "utf-8"));
      const t = parsed?.frontmatter.target_tool;
      if (typeof t === "string") targets.add(t);
    }
    for (const core of ["read", "write", "edit", "bash", "glob", "grep", "webfetch"]) {
      expect(targets.has(core), `expected target_tool=${core}`).toBe(true);
    }
  });

  it("knowledge/protocol skills are selectable by keyword metadata", () => {
    const entries = [knowledgeDir, protocolsDir].flatMap((dir) =>
      readdirSync(dir).filter((f) => f.endsWith(".md")).map((file) => parseSkillFile(readFileSync(join(dir, file), "utf-8"))),
    );
    expect(entries.some((entry) => Array.isArray(entry?.frontmatter.keywords) && entry.frontmatter.keywords.length > 0)).toBe(true);
    expect(entries.some((entry) => Array.isArray(entry?.frontmatter.requires_tools))).toBe(true);
  });
});
