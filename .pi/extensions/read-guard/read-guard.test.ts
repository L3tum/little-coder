import { describe, it, expect } from "vitest";
import setupReadGuard, {
  HEAD_LINES,
  FALLBACK_FRACTION,
  estimateTokens,
  firstLines,
  countLines,
  shouldTrimRead,
  trimmedReadMessage,
} from "./index.ts";

// ── pure helpers ────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("uses the 3.5 chars/token ratio, rounding up", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1); // ceil(1/3.5)
    expect(estimateTokens(35)).toBe(10);
    expect(estimateTokens(36)).toBe(11); // ceil(36/3.5)
  });
});

describe("firstLines", () => {
  const sample = Array.from({ length: 100 }, (_, i) => `${i + 1}\tline ${i + 1}`).join("\n");

  it("returns the first n lines and preserves cat -n prefixes", () => {
    const out = firstLines(sample, 30);
    expect(countLines(out)).toBe(30);
    expect(out.startsWith("1\tline 1")).toBe(true);
    expect(out.endsWith("30\tline 30")).toBe(true);
  });

  it("is safe when the text has fewer than n lines", () => {
    expect(firstLines("a\nb", 30)).toBe("a\nb");
    expect(firstLines("", 30)).toBe("");
  });
});

describe("countLines", () => {
  it("counts newline-separated lines, with empty string as zero", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\ntwo\nthree")).toBe(3);
    expect(countLines("trailing\n")).toBe(2); // trailing newline => empty final line
  });
});

describe("shouldTrimRead", () => {
  const base = { contextWindow: 32768, headN: HEAD_LINES };

  it("trims when current tokens + estimate would exceed the window", () => {
    // 100k chars ≈ 28572 tokens; with 10000 already used that crosses 32768.
    expect(
      shouldTrimRead({ ...base, contentChars: 100_000, currentTokens: 10_000, lineCount: 2000 }),
    ).toBe(true);
  });

  it("does not trim when the result comfortably fits", () => {
    expect(
      shouldTrimRead({ ...base, contentChars: 4_000, currentTokens: 1_000, lineCount: 200 }),
    ).toBe(false);
  });

  it("never trims when the result is <= headN lines", () => {
    expect(
      shouldTrimRead({ ...base, contentChars: 1_000_000, currentTokens: 30_000, lineCount: HEAD_LINES }),
    ).toBe(false);
  });

  it("falls back to a window fraction when current usage is unknown (null)", () => {
    const window = 10_000;
    const overChars = Math.ceil(window * FALLBACK_FRACTION * 3.5) + 100; // est just over half
    const underChars = Math.floor(window * FALLBACK_FRACTION * 3.5) - 100; // est just under half
    expect(
      shouldTrimRead({ contextWindow: window, headN: HEAD_LINES, currentTokens: null, contentChars: overChars, lineCount: 2000 }),
    ).toBe(true);
    expect(
      shouldTrimRead({ contextWindow: window, headN: HEAD_LINES, currentTokens: null, contentChars: underChars, lineCount: 2000 }),
    ).toBe(false);
  });

  it("returns false when there is no context window to judge against", () => {
    expect(
      shouldTrimRead({ contextWindow: 0, headN: HEAD_LINES, currentTokens: 1, contentChars: 1_000_000, lineCount: 2000 }),
    ).toBe(false);
  });
});

describe("trimmedReadMessage", () => {
  it("explains the trim and directs to grep/find + targeted read", () => {
    const msg = trimmedReadMessage({ shownLines: 30, totalLines: 2000, estTokens: 28572, contextWindow: 32768 });
    expect(msg).toContain("too large");
    expect(msg).toContain("first 30 lines");
    expect(msg).toContain("grep");
    expect(msg).toContain("find");
    expect(msg).toContain("offset");
    expect(msg).toContain("limit");
    expect(msg).toContain("Do NOT re-read");
  });
});

// ── tool_result handler ─────────────────────────────────────────────────────

function getToolResultHandler() {
  let handler: ((event: any, ctx: any) => any) | undefined;
  const pi = {
    on(name: string, h: (event: any, ctx: any) => any) {
      if (name === "tool_result") handler = h;
    },
  };
  setupReadGuard(pi as any);
  if (!handler) throw new Error("read-guard did not register a tool_result handler");
  return handler;
}

function makeCtx(usage: { tokens: number | null; contextWindow: number } | undefined) {
  const notifies: string[] = [];
  return {
    notifies,
    ui: { notify: (m: string) => notifies.push(m) },
    getContextUsage: () => (usage ? { ...usage, percent: null } : undefined),
  };
}

// A read result whose text is `lines` numbered lines, ~chars wide each.
function bigReadEvent(lines: number, width = 80) {
  const text = Array.from({ length: lines }, (_, i) => `${i + 1}\t${"x".repeat(width)}`).join("\n");
  return { toolName: "read", isError: false, content: [{ type: "text", text }] };
}

describe("read-guard tool_result handler", () => {
  it("trims an oversized read to 30 lines + a directive and fires one intervention", async () => {
    const handler = getToolResultHandler();
    const ctx = makeCtx({ tokens: 20_000, contextWindow: 32768 });
    const result = await handler(bigReadEvent(2000), ctx);

    expect(result?.content).toHaveLength(1);
    const out = result.content[0].text as string;
    // first 30 lines preserved (and only those), then the directive
    expect(out.startsWith("1\t")).toBe(true);
    expect(out).not.toContain("\n31\t"); // line 31's content must be gone
    const [headPart] = out.split("⚠️");
    expect(countLines(headPart.trimEnd())).toBe(30);
    expect(out).toContain("grep");
    expect(ctx.notifies).toHaveLength(1);
    expect(ctx.notifies[0]).toMatch(/harness intervention:.*first 30 lines/i);
  });

  it("leaves a read that fits the window untouched", async () => {
    const handler = getToolResultHandler();
    const ctx = makeCtx({ tokens: 1_000, contextWindow: 32768 });
    const result = await handler(bigReadEvent(50), ctx);
    expect(result).toBeUndefined();
    expect(ctx.notifies).toHaveLength(0);
  });

  it("ignores error results", async () => {
    const handler = getToolResultHandler();
    const ctx = makeCtx({ tokens: 30_000, contextWindow: 32768 });
    const ev = { ...bigReadEvent(2000), isError: true };
    expect(await handler(ev, ctx)).toBeUndefined();
    expect(ctx.notifies).toHaveLength(0);
  });

  it("ignores results that contain an image block (can't line-trim an image)", async () => {
    const handler = getToolResultHandler();
    const ctx = makeCtx({ tokens: 30_000, contextWindow: 32768 });
    const ev = {
      toolName: "read",
      isError: false,
      content: [{ type: "image", data: "…", mimeType: "image/png" }],
    };
    expect(await handler(ev, ctx)).toBeUndefined();
  });

  it("ignores non-read tools", async () => {
    const handler = getToolResultHandler();
    const ctx = makeCtx({ tokens: 30_000, contextWindow: 32768 });
    const ev = { ...bigReadEvent(2000), toolName: "bash" };
    expect(await handler(ev, ctx)).toBeUndefined();
  });

  it("does nothing when context usage is unavailable", async () => {
    const handler = getToolResultHandler();
    const ctx = makeCtx(undefined);
    expect(await handler(bigReadEvent(2000), ctx)).toBeUndefined();
    expect(ctx.notifies).toHaveLength(0);
  });
});
