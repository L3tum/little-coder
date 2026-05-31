import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import breadcrumbs from "./index.ts";

afterEach(() => { delete process.env.PI_CODING_AGENT_DIR; });

describe("breadcrumbs extension", () => {
  it("registers search/read tools and /breadcrumbs command", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const pi: any = {
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      registerCommand: (name: string) => commands.push(name),
    };
    breadcrumbs(pi);
    expect(commands).toContain("breadcrumbs");
    expect(tools).toContain("breadcrumbs_search");
    expect(tools).toContain("breadcrumbs_read");
  });

  it("read tool exposes bounded defaults and caps", async () => {
    let readTool: any;
    const pi: any = {
      registerCommand: () => {},
      registerTool: (tool: any) => { if (tool.name === "breadcrumbs_read") readTool = tool; },
    };
    breadcrumbs(pi);
    const result = await readTool.execute("id", { session: "missing", maxTurns: 999, maxCharacters: 999999 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unknown session");
  });

  it("read excludes tool output by default and includes it when requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "lc-breadcrumbs-"));
    process.env.PI_CODING_AGENT_DIR = root;
    const dir = join(root, "sessions", "demo");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "one.jsonl");
    writeFileSync(file, [
      JSON.stringify({ timestamp: "2026-01-01", cwd: "/repo/demo", role: "user", content: "hello" }),
      JSON.stringify({ timestamp: "2026-01-01", toolName: "read", content: "SECRET TOOL OUTPUT" }),
      JSON.stringify({ timestamp: "2026-01-01", role: "assistant", content: "done" }),
    ].join("\n"));
    let readTool: any;
    const pi: any = { registerCommand: () => {}, registerTool: (tool: any) => { if (tool.name === "breadcrumbs_read") readTool = tool; } };
    breadcrumbs(pi);
    const hidden = await readTool.execute("id", { session: "demo/one", maxTurns: 20 });
    expect(hidden.content[0].text).toContain("hello");
    expect(hidden.content[0].text).not.toContain("SECRET TOOL OUTPUT");
    const included = await readTool.execute("id", { session: "demo/one", maxTurns: 20, includeToolOutput: true });
    expect(included.content[0].text).toContain("SECRET TOOL OUTPUT");
  });
});
