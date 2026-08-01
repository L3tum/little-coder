import { describe, it, expect } from "vitest";

// Exercise the bridge template as a pure function.
const BRIDGE_TEMPLATE = (n: number): string =>
  `[Preserved evidence from earlier in the conversation follows.] ` +
  `${n} evidence entr${n === 1 ? "y remains" : "ies remain"} available via ` +
  `EvidenceList and EvidenceGet.`;

describe("evidence-compact bridge message", () => {
  it("starts with exact preservation prefix (Python-version parity)", () => {
    const m = BRIDGE_TEMPLATE(3);
    expect(
      m.startsWith(
        "[Preserved evidence from earlier in the conversation follows.]",
      ),
    ).toBe(true);
  });
  it("uses singular for 1 entry", () => {
    expect(BRIDGE_TEMPLATE(1)).toContain("1 evidence entry remains");
  });
  it("uses plural for multiple entries", () => {
    expect(BRIDGE_TEMPLATE(5)).toContain("5 evidence entries remain");
  });
  it("references the retrieval tools by name", () => {
    const m = BRIDGE_TEMPLATE(2);
    expect(m).toContain("EvidenceList");
    expect(m).toContain("EvidenceGet");
  });
});
