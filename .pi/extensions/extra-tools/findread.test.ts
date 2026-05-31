import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extraTools from "./index.ts";

let dir: string;

function registeredTool(name: string): any {
  const tools = new Map<string, any>();
  const pi: any = {
    getAllTools: () => [],
    registerCommand: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
  };
  extraTools(pi);
  return tools.get(name);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "findread-test-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.txt"), "hello world");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("findRead tool", () => {
  it("prefixes effective invocation for matches", async () => {
    const tool = registeredTool("findRead");
    const result = await tool.execute("id", { pattern: "**/*.txt", path: dir, maxFiles: 3, maxCharacters: 20 });
    const text = result.content[0].text;
    expect(text).toContain("findRead invocation:");
    expect(text).toContain('pattern="**/*.txt"');
    expect(text).toContain(`path=${JSON.stringify(dir)}`);
    expect(text).toContain("maxFiles=3");
    expect(text).toContain("maxCharacters=20");
    expect(text).toContain("hello world");
  });

  it("prefixes effective invocation for no matches", async () => {
    const tool = registeredTool("findRead");
    const result = await tool.execute("id", { pattern: "**/*.missing", path: dir });
    const text = result.content[0].text;
    expect(text).toContain("findRead invocation:");
    expect(text).toContain("No files matched");
  });
});
