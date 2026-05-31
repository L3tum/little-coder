import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reflectSkills, { readHistory, recordHistory, writeProposal, type Proposal } from "./index.ts";

afterEach(() => {
  delete process.env.LITTLE_CODER_USER_SKILLS_DIR;
  delete process.env.LITTLE_CODER_REFLECT_HISTORY;
});

describe("reflect-skills extension", () => {
  it("registers reflection review and approval commands", () => {
    const commands: string[] = [];
    const pi: any = { registerCommand: (name: string) => commands.push(name) };
    reflectSkills(pi);
    expect(commands).toEqual(expect.arrayContaining([
      "reflect",
      "reflect-review",
      "reflect-accept",
      "reflect-deny",
      "reflect-history",
      "reflect-doctor",
    ]));
  });

  it("doctor command describes bounded breadcrumbs and user skill destination", async () => {
    const commands = new Map<string, any>();
    const messages: string[] = [];
    const pi: any = { registerCommand: (name: string, spec: any) => commands.set(name, spec) };
    reflectSkills(pi);
    await commands.get("reflect-doctor").handler("", { ui: { notify: (msg: string) => messages.push(msg) } });
    expect(messages[0]).toContain("bounded breadcrumbs");
    expect(messages[0]).toContain(".pi/skills");
  });

  it("writes accepted skills under the confined user skills root", () => {
    const root = mkdtempSync(join(tmpdir(), "lc-skills-"));
    process.env.LITTLE_CODER_USER_SKILLS_DIR = root;
    const proposal: Proposal = {
      name: "safe-skill",
      createdAt: "now",
      content: "---\nname: safe-skill\ndescription: Safe test skill.\ntype: workflow\ntoken_cost: 50\nkeywords: [safe]\n---\nBody\n",
    };
    const file = writeProposal(proposal);
    expect(file).toBe(join(root, "safe-skill", "SKILL.md"));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toContain("keywords: [safe]");
  });

  it("rejects invalid skill slugs", () => {
    const proposal: Proposal = { name: "../escape", createdAt: "now", content: "x" };
    expect(() => writeProposal(proposal)).toThrow("invalid skill slug");
  });

  it("records reflection history", () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-reflect-history-"));
    process.env.LITTLE_CODER_REFLECT_HISTORY = join(dir, "history.jsonl");
    recordHistory("propose", { name: "skill-one" });
    recordHistory("accept", { name: "skill-one", file: "/tmp/skill-one/SKILL.md" });
    const history = readHistory();
    expect(history).toContain("propose skill-one");
    expect(history).toContain("accept skill-one -> /tmp/skill-one/SKILL.md");
  });
});
