import { describe, expect, it } from "vitest";
import { summarizeCosts } from "./cost-history.ts";

describe("cost-history", () => {
  it("returns a stable summary shape", () => {
    const summary = summarizeCosts();
    expect(summary.sessions).toBeGreaterThanOrEqual(0);
    expect(summary.messages).toBeGreaterThanOrEqual(0);
    expect(summary.totalCost).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(summary.topSessions)).toBe(true);
  });
});
