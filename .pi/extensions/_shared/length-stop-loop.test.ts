import { describe, it, expect } from "vitest";
import {
  LENGTH_STOP_CONTINUE_LIMIT,
  LENGTH_STOP_CONCISE_AT,
  buildLengthStopConciseCorrection,
  buildLengthStopContinueNudge,
  lengthStopTierFor,
} from "./length-stop-loop.ts";

describe("length-stop loop detector", () => {
  it("tier sequence for counts 1..6: continue x3 -> concise -> backoff x", () => {
    expect(LENGTH_STOP_CONTINUE_LIMIT).toBe(3);
    expect(LENGTH_STOP_CONCISE_AT).toBe(4);
    expect(lengthStopTierFor(1)).toBe("continue");
    expect(lengthStopTierFor(2)).toBe("continue");
    expect(lengthStopTierFor(3)).toBe("continue");
    expect(lengthStopTierFor(4)).toBe("concise");
    expect(lengthStopTierFor(5)).toBe("backoff");
    expect(lengthStopTierFor(6)).toBe("backoff");
  });

  it("nudge: targeted resume, not a bare Continue", () => {
    const n = buildLengthStopContinueNudge(1);
    expect(n).not.toBe("Continue");
    expect(n).toContain("cut off");
    expect(n).toContain("Resume exactly where you stopped");
    expect(n).toContain("Do not restate what you already wrote");
  });

  it("nudge: n >= 2 mentions splitting the work; n = 1 does not", () => {
    expect(buildLengthStopContinueNudge(1)).not.toContain("smaller steps");
    expect(buildLengthStopContinueNudge(2)).toContain("smaller steps");
    expect(buildLengthStopContinueNudge(3)).toContain("smaller steps");
  });

  it("nudge and correction are non-empty and distinct", () => {
    const nudge = buildLengthStopContinueNudge(1);
    const correction = buildLengthStopConciseCorrection();
    expect(nudge.length).toBeGreaterThan(0);
    expect(correction.length).toBeGreaterThan(0);
    expect(nudge).not.toEqual(correction);
    expect(correction).toContain("4 times in a row");
    expect(correction).toMatch(/concise/i);
  });
});
