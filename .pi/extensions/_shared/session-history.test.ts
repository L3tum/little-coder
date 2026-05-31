import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSessions, lexicalSessionScore, parseSessionFile, searchSessions, searchSessionsWithMode, type SessionOutline } from "./session-history.ts";

describe("session-history", () => {
  it("parses mixed session jsonl safely", () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-session-"));
    const file = join(dir, "one.jsonl");
    writeFileSync(file, [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", cwd: "/repo/demo", role: "user", content: "find auth bug" }),
      "not json",
      JSON.stringify({ role: "assistant", message: { content: [{ text: "checked files" }] } }),
      JSON.stringify({ toolName: "read", content: "large tool output" }),
    ].join("\n"));

    const parsed = parseSessionFile(file)!;
    expect(parsed.cwd).toBe("/repo/demo");
    expect(parsed.project).toBe("demo");
    expect(parsed.turns.map((t) => t.role)).toContain("user");
    expect(parsed.turns.some((t) => t.toolName === "read")).toBe(true);
  });

  it("discovers sessions and ranks lexical matches", () => {
    const root = mkdtempSync(join(tmpdir(), "lc-agent-"));
    const sessions = join(root, "sessions", "p");
    mkdirSync(sessions, { recursive: true });
    const a = join(sessions, "a.jsonl");
    const b = join(sessions, "b.jsonl");
    writeFileSync(a, JSON.stringify({ timestamp: "2026-01-02", cwd: "/repo/a", role: "user", content: "fix payment route" }) + "\n");
    writeFileSync(b, JSON.stringify({ timestamp: "2026-01-01", cwd: "/repo/b", role: "user", content: "write docs" }) + "\n");

    const found = discoverSessions(root);
    expect(found).toHaveLength(2);
    const ranked = searchSessions("payment route", found, "/repo/a", 5);
    expect(ranked[0].path).toBe(a);
    expect(ranked[0].snippet.length).toBeLessThanOrEqual(300);
    expect(ranked[0].mode).toBe("lexical");
  });

  it("semantic mode returns an explicit fallback result", async () => {
    const result = await searchSessionsWithMode("anything", "semantic", [], process.cwd(), 5);
    expect(result.mode).toMatch(/fallback/);
    expect(result.note).toContain("fallback");
  });

  it("boosts user prompts, file paths, tool names, and current project matches", () => {
    const strong: SessionOutline = {
      id: "strong",
      path: "/tmp/strong.jsonl",
      cwd: "/repo/current",
      project: "current",
      turns: [
        { role: "user", text: "Fix src/auth/login.ts using grep for auth failure" },
        { role: "tool", toolName: "grep", text: "src/auth/login.ts: failed auth" },
      ],
    };
    const weak: SessionOutline = {
      id: "weak",
      path: "/tmp/weak.jsonl",
      cwd: "/repo/other",
      project: "other",
      turns: [{ role: "assistant", text: "auth mentioned once" }],
    };
    expect(lexicalSessionScore("auth grep src/auth/login.ts", strong, "/repo/current"))
      .toBeGreaterThan(lexicalSessionScore("auth grep src/auth/login.ts", weak, "/repo/current"));
  });
});
