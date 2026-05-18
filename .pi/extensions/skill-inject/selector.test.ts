import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFile } from "./frontmatter.ts";

// Re-implement the INTENT_MAP + predict helpers here (kept in sync with
// index.ts). These are pure functions; extension integration tested via RPC.

const INTENT_MAP: Record<string, string[]> = {
  read: ["Read"], show: ["Read"], view: ["Read"], cat: ["Read"],
  write: ["Write"], create: ["Write", "Bash"],
  implement: ["Write", "Read"], code: ["Write", "Read"],
  function: ["Write", "Edit"], class: ["Write", "Edit"],
  edit: ["Edit"], change: ["Edit"], modify: ["Edit"],
  fix: ["Edit"], update: ["Edit"], replace: ["Edit"],
  add: ["Edit", "Write"], refactor: ["Edit", "Read"],
  run: ["Bash"], execute: ["Bash"], install: ["Bash"],
  build: ["Bash"], test: ["Bash"],
  find: ["Glob", "Grep"], search: ["Grep"],
  grep: ["Grep"], glob: ["Glob"],
  fetch: ["WebFetch"], download: ["WebFetch"], url: ["WebFetch"],
  web: ["WebSearch"],
};

function predictTools(userText: string): string[] {
  const words = new Set(userText.toLowerCase().split(/\s+/).filter(Boolean));
  const predicted: string[] = [];
  for (const [kw, toolNames] of Object.entries(INTENT_MAP)) {
    if (!words.has(kw)) continue;
    for (const tn of toolNames) if (!predicted.includes(tn)) predicted.push(tn);
  }
  return predicted;
}

describe("intent prediction (INTENT_MAP)", () => {
  it("predicts Read for 'read config.py'", () => {
    expect(predictTools("read config.py and show me the output")).toContain("Read");
    expect(predictTools("read config.py and show me the output")).toContain("Read");
  });
  it("predicts Edit for 'fix the bug'", () => {
    const p = predictTools("please fix the bug in auth.py");
    expect(p).toContain("Edit");
  });
  it("predicts Bash for 'run the tests'", () => {
    const p = predictTools("run the tests and build the project");
    expect(p).toContain("Bash");
  });
  it("predicts Glob+Grep for 'find all files'", () => {
    const p = predictTools("find all files matching the pattern");
    expect(p).toContain("Glob");
    expect(p).toContain("Grep");
  });
  it("empty predictions for neutral prompts", () => {
    expect(predictTools("hello there")).toEqual([]);
  });
});

describe("skills directory loads from repo", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const toolsDir = join(here, "..", "..", "..", "skills", "tools");

  it("exists and has at least one markdown file", () => {
    expect(existsSync(toolsDir)).toBe(true);
    const files = readdirSync(toolsDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
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
    for (const core of ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch"]) {
      expect(targets.has(core), `expected target_tool=${core}`).toBe(true);
    }
  });
});
