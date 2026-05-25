import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __issueAgentTest } from "./index.ts";

function script(dir: string, body: string): string {
  const file = join(dir, "fake-sub-agent.mjs");
  writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

function assistantLine(text: string): string {
  return JSON.stringify({ message: { role: "assistant", content: text } });
}

describe("issue-agent runSubAgent", () => {
  let tmp: string;
  let oldBin: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lc-issue-agent-test-"));
    oldBin = process.env.ISSUE_AGENT_LITTLE_CODER_BIN;
  });

  afterEach(() => {
    if (oldBin !== undefined) process.env.ISSUE_AGENT_LITTLE_CODER_BIN = oldBin;
    else delete process.env.ISSUE_AGENT_LITTLE_CODER_BIN;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves with a completed plan from the sub-agent", async () => {
    process.env.ISSUE_AGENT_LITTLE_CODER_BIN = script(tmp, `console.log(${JSON.stringify(assistantLine("# PLAN\nDo it"))});`);
    const emitted: string[] = [];
    const out = await __issueAgentTest.runSubAgent("prompt", tmp, tmp, undefined, undefined, (msg: string) => emitted.push(msg));
    expect(out).toBe("# PLAN\nDo it");
    expect(emitted.filter((x) => x.includes("sub-agent assistant"))).toHaveLength(1);
  });

  it("deduplicates repeated assistant snapshots", async () => {
    const line = assistantLine("same message");
    process.env.ISSUE_AGENT_LITTLE_CODER_BIN = script(tmp, `for (let i = 0; i < 4; i++) console.log(${JSON.stringify(line)});`);
    const emitted: string[] = [];
    const out = await __issueAgentTest.runSubAgent("prompt", tmp, tmp, undefined, undefined, (msg: string) => emitted.push(msg));
    expect(out).toBe("same message");
    expect(emitted.filter((x) => x.includes("sub-agent assistant"))).toHaveLength(1);
  });

  it("ignores non-json stdout noise and still parses json", async () => {
    process.env.ISSUE_AGENT_LITTLE_CODER_BIN = script(tmp, `console.log('> little-coder banner'); console.log(${JSON.stringify(assistantLine("valid"))});`);
    const emitted: string[] = [];
    const out = await __issueAgentTest.runSubAgent("prompt", tmp, tmp, undefined, undefined, (msg: string) => emitted.push(msg));
    expect(out).toBe("valid");
    expect(emitted.join("\n")).not.toContain("banner");
  });

  it("reports stderr on non-zero exit", async () => {
    process.env.ISSUE_AGENT_LITTLE_CODER_BIN = script(tmp, `console.error('boom'); process.exit(1);`);
    const emitted: string[] = [];
    await expect(__issueAgentTest.runSubAgent("prompt", tmp, tmp, undefined, undefined, (msg: string) => emitted.push(msg))).rejects.toThrow(/boom/);
    expect(emitted.some((x) => x.includes("sub-agent stderr: boom"))).toBe(true);
  });

  it("passes sub-agent env and removes issueAgentDone marker", async () => {
    process.env.ISSUE_AGENT_LITTLE_CODER_BIN = script(tmp, `
      if (process.env.LITTLE_CODER_SUBAGENT !== '1') process.exit(2);
      await import('node:fs').then(fs => fs.writeFileSync(process.env.ISSUE_AGENT_DONE_FILE, JSON.stringify({ text: 'done' })));
      console.log(${JSON.stringify(assistantLine("complete"))});
    `);
    const out = await __issueAgentTest.runSubAgent("prompt", tmp, tmp, undefined, undefined, () => undefined);
    expect(out).toBe("complete");
    expect(existsSync(join(tmp, ".issue-agent-markers"))).toBe(true);
  });
});
