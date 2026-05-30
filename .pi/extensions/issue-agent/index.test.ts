import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

describe("issue-agent lifecycle helpers", () => {
  it("parses command args, truthy flags, and ai label syntaxes", () => {
    expect(__issueAgentTest.parseArgs('--repos "https://github.com/a/b" --dry-run --interval=50')).toEqual({ repos: "https://github.com/a/b", "dry-run": "true", interval: "50" });
    expect(__issueAgentTest.isTruthy("yes")).toBe(true);
    expect(__issueAgentTest.isTruthy("false")).toBe(false);
    expect(__issueAgentTest.labelValue(["ai:priority/5", "ai[planning-model:openai/o3]"], "priority")).toBe("5");
    expect(__issueAgentTest.labelValue(["ai:priority/5", "ai[planning-model:openai/o3]"], "planning-model")).toBe("openai/o3");
  });

  it("parses REQUESTING_REVIEW state labels and priority defaults", () => {
    expect(__issueAgentTest.stateOf(["ai:state/REQUESTING_REVIEW"])).toBe("REQUESTING_REVIEW");
    expect(__issueAgentTest.stateOf(["ai[state:REQUESTING_REVIEW]"])).toBe("REQUESTING_REVIEW");
    expect(__issueAgentTest.stateOf(["ai:state/unknown"])).toBe("PLANNING");
    expect(__issueAgentTest.priorityOf(["ai:priority:2"])).toBe(2);
    expect(__issueAgentTest.priorityOf(["ai:priority/not-a-number"])).toBe(100);
  });

  it("derives model, thinking, dependency, branch, and autoresearch metadata", () => {
    const labels = ["ai:planning-model/plan-model", "ai:execution-model:exec-model", "ai:fallback-small-model/fallback-a", "ai[fallback-large-model:fallback-b]", "ai:thinking-level/high"];
    expect(__issueAgentTest.modelsOf(labels, { fallback: [] })).toEqual({ planning: "plan-model", execution: "exec-model", fallback: ["fallback-a", "fallback-b"] });
    expect(__issueAgentTest.modelsOf(labels, { planning: "override", fallback: ["fallback-override"] })).toEqual({ planning: "override", execution: "exec-model", fallback: ["fallback-override"] });
    expect(__issueAgentTest.thinkingLevelOf(labels)).toBe("high");
    expect(__issueAgentTest.thinkingLevelOf(["ai:thinking-level/banana"])).toBeUndefined();
    const issue = { number: 7, title: "Fix: Thing!!!", body: "Depends-On: #42", labels: [] as string[], url: "u", apiUrl: "a" };
    expect(__issueAgentTest.dependencyOf(issue)).toBe(42);
    expect(__issueAgentTest.branchName(issue)).toBe("ai/7-fix-thing");
    expect(__issueAgentTest.isAutoresearch({ ...issue, labels: ["ai:autoresearch"] })).toBe(true);
    expect(__issueAgentTest.autoresearchConfig({ ...issue, labels: ["autoresearch:max-iterations=3", "autoresearch:metric=accuracy", "autoresearch:direction=max"] })).toEqual({ maxIterations: "3", metric: "accuracy", direction: "max" });
  });

  it("normalizes pull request rows with branch/base metadata", () => {
    const pr = __issueAgentTest.normalizePullRequest({ number: 7, title: "T", labels: [{ name: "ai:state/REQUESTING_REVIEW" }], html_url: "h", issue_url: "i", url: "p", head: { label: "owner:feature", repo: { html_url: "not-a-clone-url" } }, base: { ref: "main" } });
    expect(pr.kind).toBe("pr");
    expect(pr.head).toBe("feature");
    expect(pr.base).toBe("main");
    expect(pr.apiUrl).toBe("i");
    expect(pr.headRepo).toBeUndefined();
  });

  it("detects slash review comments and review cycles", () => {
    expect(__issueAgentTest.hasReviewCommand([{ body: "please\n/review" }])).toBe(true);
    expect(__issueAgentTest.hasUnansweredReviewCommand([{ body: "/review", created_at: "2026-01-01T00:00:00Z" }, { body: "## AI Review Summary", created_at: "2026-01-01T00:01:00Z" }])).toBe(false);
    expect(__issueAgentTest.hasUnansweredReviewCommand([{ body: "/review", created_at: "2026-01-01T00:00:00Z" }, { body: "## AI Review Summary", created_at: "2026-01-01T00:00:00Z" }])).toBe(false);
    expect(__issueAgentTest.hasUnansweredReviewCommand([{ body: "## AI Review Summary", created_at: "2026-01-01T00:00:00Z" }, { body: "/review", created_at: "2026-01-01T00:00:00Z" }])).toBe(true);
    expect(__issueAgentTest.hasUnansweredReviewCommand([{ body: "## AI Review Summary", created_at: "2026-01-01T00:00:00Z" }, { body: "/review", created_at: "2026-01-01T00:01:00Z" }])).toBe(true);
    expect(__issueAgentTest.hasUnansweredReviewCommand([{ body: "## AI Review Summary" }, { body: "/review" }])).toBe(true);
    expect(__issueAgentTest.hasUnansweredReviewCommand([{ body: "## AI Review Summary", created_at: "2026-01-01T00:00:00Z" }, { body: "/review" }])).toBe(true);
    expect(__issueAgentTest.hasUnansweredReviewCommand([{ body: "/review", id: 1 }, { body: "## AI Review Summary", id: 2 }])).toBe(false);
    expect(__issueAgentTest.reviewCycle(["ai:review-cycle/2"])).toBe(2);
    expect(__issueAgentTest.hasAgentSource(["ai:source/AGENT"])).toBe(true);
  });

  it("validates required tool markers and parses verdicts", () => {
    expect(__issueAgentTest.validMarker("done", "anything")).toBe(true);
    expect(__issueAgentTest.validMarker("plan", "# PLAN\nDo it")).toBe(true);
    expect(__issueAgentTest.validMarker("plan", "Do it")).toBe(false);
    expect(__issueAgentTest.validMarker("verdict", "verdict: request_changes\n\nFix it")).toBe(true);
    expect(__issueAgentTest.validMarker("verdict", "Fix it")).toBe(false);
    expect(__issueAgentTest.parseVerdict("verdict: approve\n\nLGTM")).toBe("approve");
  });

  it("constructs platform-specific PR review events", () => {
    expect(__issueAgentTest.reviewEvent("approve")).toBe("APPROVE");
    expect(__issueAgentTest.reviewEvent("request_changes")).toBe("REQUEST_CHANGES");
  });

  it("round-trips issue-agent ask comments and /answer comments", () => {
    const ask = { question: "Which API?", choices: ["A", "B"], context: "Found callers in src/api.ts" };
    const askComment = __issueAgentTest.formatIssueAgentAskComment(ask);
    expect(askComment).toContain("/answer");
    expect(askComment).toContain("Found callers");
    const answer = __issueAgentTest.latestIssueAgentAnswer([{ body: askComment }, { body: "/answer Use A" }]);
    expect(answer?.answer).toBe("Use A");
    expect(answer?.ask.context).toBe(ask.context);
    expect(__issueAgentTest.latestIssueAgentAnswer([{ body: askComment }, { body: "/answer Use A" }, { body: "## AI Plan" }])).toBeUndefined();
  });

  it("matches the latest /answer with the most recent unanswered clarification", () => {
    const first = __issueAgentTest.formatIssueAgentAskComment({ question: "First?", context: "first context" });
    const second = __issueAgentTest.formatIssueAgentAskComment({ questions: ["Second?", "More detail?"], context: "second context" });
    const answer = __issueAgentTest.latestIssueAgentAnswer([
      { body: first },
      { body: "/answer stale" },
      { body: second },
      { body: "/answer fresh" },
    ]);
    expect(answer?.answer).toBe("fresh");
    expect(answer?.ask.context).toBe("second context");
  });

  it("handles sub-agent json tool events, errors, and assistant content", () => {
    const emitted: Array<{ msg: string; type?: string }> = [];
    const emit = (msg: string, type?: "info" | "warning" | "error") => emitted.push({ msg, type });
    expect(__issueAgentTest.handleSubAgentJsonLine(JSON.stringify({ type: "tool_execution_start", toolName: "read" }), emit)).toBeUndefined();
    expect(__issueAgentTest.handleSubAgentJsonLine(JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: true }), emit)).toBeUndefined();
    expect(__issueAgentTest.handleSubAgentJsonLine(JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "done" }] } }), emit, new Set())).toBe("done");
    expect(__issueAgentTest.handleSubAgentJsonLine(JSON.stringify({ message: { stopReason: "error", errorMessage: "bad" } }), emit)).toBe("bad");
    expect(__issueAgentTest.handleSubAgentJsonLine("not json", emit)).toBeUndefined();
    expect(emitted.map((e) => e.msg)).toEqual([
      "sub-agent tool started: read",
      "sub-agent tool failed: read",
      "sub-agent assistant:\ndone",
      "sub-agent error: bad",
    ]);
    expect(emitted.map((e) => e.type)).toEqual(["info", "warning", "info", "error"]);
  });

  it("issue planning prompt includes shared guidance and issueAgentAsk", () => {
    const prompt = __issueAgentTest.issuePrompt("PLANNING", "https://github.com/acme/repo", { number: 1, title: "T", body: "B", labels: [], url: "u", apiUrl: "a" }, "/tmp/repo", { fallback: [] }, undefined, "");
    expect(prompt).toContain("code_search");
    expect(prompt).toContain("EvidenceAdd");
    expect(prompt).toContain("issueAgentAsk");
  });

  it("repairs discovered PR issue API URLs even when PR rows already include labels", async () => {
    const oldFetch = global.fetch;
    global.fetch = vi.fn(async (url: any) => {
      expect(String(url)).toBe("https://api.github.com/repos/acme/repo/pulls?state=open&per_page=100");
      return new Response(JSON.stringify([{ number: 9, title: "PR", html_url: "html", url: "pull-api", labels: [{ name: "ai:state/REQUESTING_REVIEW" }], head: { ref: "feature" }, base: { ref: "main" } }]), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    try {
      const prs = await __issueAgentTest.listPullRequests("https://github.com/acme/repo.git", "tok");
      expect(prs).toHaveLength(1);
      expect(prs[0].apiUrl).toBe("https://api.github.com/repos/acme/repo/issues/9");
    } finally {
      global.fetch = oldFetch;
    }
  });

  it("uses PR labels as authoritative after PR creation and marks the issue PR_PENDING", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const oldFetch = global.fetch;
    global.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/pulls")) return new Response(JSON.stringify({ number: 9, title: "PR", html_url: "html", url: "pull-api", head: { ref: "ai/1-test" }, base: { ref: "main" } }), { status: 201, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    try {
      const issue = { number: 1, title: "Test", body: "", labels: ["ai:state/EXECUTING"], url: "issue-html", apiUrl: "https://github.com/api-issue" };
      const pr = await __issueAgentTest.createPullRequest("https://github.com/acme/repo.git", issue, "ai/1-test", "tok", "done");
      await __issueAgentTest.addLabels("https://github.com/acme/repo.git", pr, ["ai:source/AGENT", __issueAgentTest.stateLabel("REQUESTING_REVIEW")], "tok");
      await __issueAgentTest.setAiState("https://github.com/acme/repo.git", issue, "PR_PENDING", "tok");
    } finally {
      global.fetch = oldFetch;
    }
    expect(calls.some((c) => c.url === "https://api.github.com/repos/acme/repo/pulls")).toBe(true);
    expect(calls.some((c) => c.url === "https://api.github.com/repos/acme/repo/issues/9/labels" && String(c.init?.body).includes("REQUESTING_REVIEW"))).toBe(true);
    expect(calls.some((c) => c.url === "https://github.com/api-issue/labels/ai%3Astate%2FEXECUTING" && c.init?.method === "DELETE")).toBe(true);
    expect(calls.some((c) => c.url === "https://github.com/api-issue/labels" && String(c.init?.body).includes("PR_PENDING"))).toBe(true);
  });
});

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
