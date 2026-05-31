import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkillCatalog } from "./skill-catalog.ts";

afterEach(() => { delete process.env.LITTLE_CODER_USER_SKILLS_DIR; });

describe("skill-catalog", () => {
  it("lists repo skills with descriptions and origins", () => {
    const skills = listSkillCatalog();
    expect(skills.some((s) => s.origin === "repo" && s.name === "bash-guidance" && s.description)).toBe(true);
  });

  it("includes user-level skills", () => {
    const root = mkdtempSync(join(tmpdir(), "lc-user-skills-"));
    const dir = join(root, "custom");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: custom-user-skill\ndescription: User skill.\ntype: workflow\ntoken_cost: 50\nkeywords: [custom]\n---\nBody\n");
    process.env.LITTLE_CODER_USER_SKILLS_DIR = root;
    const skills = listSkillCatalog();
    expect(skills.some((s) => s.origin === "user" && s.name === "custom-user-skill" && s.description === "User skill.")).toBe(true);
  });
});
