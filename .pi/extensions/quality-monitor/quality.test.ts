import { describe, it, expect } from "vitest";
import { assessResponse, buildCorrectionMessage } from "./quality.ts";

const known = new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);

describe("assessResponse", () => {
  it("accepts text-only assistant response", () => {
    expect(assessResponse("here's my thinking", [], [], known)).toEqual({ ok: true });
  });
  it("accepts valid tool calls", () => {
    const calls = [{ name: "Read", input: { file_path: "/a" } }];
    expect(assessResponse("", calls, [], known)).toEqual({ ok: true });
  });
  it("detects empty response (no text, no calls)", () => {
    expect(assessResponse("", [], [], known)).toEqual({
      ok: false, reason: "empty_response",
    });
  });
  it("detects empty tool name", () => {
    expect(assessResponse("", [{ name: "", input: {} }], [], known)).toEqual({
      ok: false, reason: "empty_tool_name",
    });
  });
  it("detects hallucinated tool name", () => {
    const result = assessResponse("", [{ name: "FakeTool", input: {} }], [], known);
    expect(result).toEqual({ ok: false, reason: "unknown_tool:FakeTool" });
  });
  it("detects case-mismatch as unknown tool", () => {
    const result = assessResponse("", [{ name: "bash", input: {} }], [], known);
    expect(result).toEqual({ ok: false, reason: "unknown_tool:bash" });
  });
  it("detects all-lowercase as unknown tool", () => {
    const result = assessResponse("", [{ name: "read", input: {} }], [], known);
    expect(result).toEqual({ ok: false, reason: "unknown_tool:read" });
  });
  it("skips hallucination check when registry empty", () => {
    expect(
      assessResponse("", [{ name: "Anything", input: {} }], [], new Set()),
    ).toEqual({ ok: true });
  });
  it("detects repeated tool call", () => {
    const now = [{ name: "Read", input: { file_path: "/a" } }];
    const prev = [{ name: "Read", input: { file_path: "/a" } }];
    expect(assessResponse("", now, prev, known)).toEqual({
      ok: false, reason: "repeated_tool_call",
    });
  });
  it("does not flag as repeat when inputs differ", () => {
    const now = [{ name: "Read", input: { file_path: "/a" } }];
    const prev = [{ name: "Read", input: { file_path: "/b" } }];
    expect(assessResponse("", now, prev, known)).toEqual({ ok: true });
  });
  it("detects malformed args sentinel", () => {
    const calls = [{ name: "Read", input: { _raw: "garbage" } }];
    expect(assessResponse("", calls, [], known)).toEqual({
      ok: false, reason: "malformed_args:Read",
    });
  });
});

describe("buildCorrectionMessage", () => {
  it("generates empty-response message", () => {
    const m = buildCorrectionMessage("empty_response");
    expect(m).toContain("empty");
  });
  it("generates unknown-tool message with tool name", () => {
    const m = buildCorrectionMessage("unknown_tool:FakeTool");
    expect(m).toContain("'FakeTool'");
    expect(m).toContain("does not exist");
  });
  it("suggests similar tool names for unknown tool", () => {
    const m = buildCorrectionMessage("unknown_tool:Grape", known);
    expect(m).toContain("Did you mean");
    expect(m).toContain("Grep");
  });
  it("suggests similar tool names for close misspelling", () => {
    const m = buildCorrectionMessage("unknown_tool:Bahs", known);
    expect(m).toContain("Did you mean");
    expect(m).toContain("Bash");
  });
  it("omits suggestions when no similar tools exist", () => {
    const m = buildCorrectionMessage("unknown_tool:XYZ123", known);
    expect(m).not.toContain("Did you mean");
  });
  it("suggests correct-casing tool for case-mismatch", () => {
    const m = buildCorrectionMessage("unknown_tool:bash", known);
    expect(m).toContain("Did you mean");
    expect(m).toContain("Bash");
  });
  it("suggests correct-casing tool for all-lowercase", () => {
    const m = buildCorrectionMessage("unknown_tool:read", known);
    expect(m).toContain("Did you mean");
    expect(m).toContain("Read");
  });
  it("generates malformed-args message", () => {
    const m = buildCorrectionMessage("malformed_args:Read");
    expect(m).toContain("'Read'");
    expect(m).toContain("malformed");
  });
  it("generates repeated-tool-call message", () => {
    const m = buildCorrectionMessage("repeated_tool_call");
    expect(m).toContain("loop");
  });
  it("falls back to generic on unknown reason", () => {
    expect(buildCorrectionMessage("weird_thing")).toContain("weird_thing");
  });
});
