import { describe, it, expect } from "vitest";
import { bashBlockReason, isSafeBash } from "./index.ts";

// Regression: a leading no-op `cd` chain combined with `||` used to be
// rejected by the segment scanner, and the block reason blamed the first
// token of the remainder ("cargo") instead of naming the real problem.
describe("cd-chain + || regression (war-of-dots)", () => {
  const cwd = "/home/tom/workspace/war-of-dots";
  const cmd =
    'cd /home/tom/workspace/war-of-dots && cargo clippy --all-targets --features microbenchmarks 2>&1 | tail -8 && echo "=== SUPPLY WARNINGS (empty=none) ===" && cargo clippy --all-targets --features microbenchmarks 2>&1 | grep -i supply || echo "none"';
  it("allows the previously blocked clippy+grep||echo command", () => {
    expect(isSafeBash(cmd, undefined, cwd)).toBe(true);
    expect(bashBlockReason(cmd, undefined, cwd)).toBeNull();
  });
  it("names the forbidden operator instead of the first token", () => {
    const r = bashBlockReason(
      "cd /home/tom/workspace/war-of-dots && cargo clippy 2>&1 | grep -i supply ; rm -rf /",
      undefined,
      cwd,
    );
    expect(r).toContain('";"');
    expect(r).not.toContain('"cargo"');
  });
});
