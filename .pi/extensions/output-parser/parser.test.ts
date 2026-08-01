import { describe, it, expect } from "vitest";
import {
  repairJson,
  parseTextToolCalls,
  escapeNewlinesInJsonStrings,
} from "./parser.ts";

describe("repairJson", () => {
  it("direct parse on valid JSON", () => {
    expect(repairJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("trailing commas", () => {
    expect(repairJson('{"a":1,}')).toEqual({ a: 1 });
    expect(repairJson("[1,2,]")).toEqual([1, 2]);
  });
  it("single quotes", () => {
    expect(repairJson("{'a':1}")).toEqual({ a: 1 });
  });
  it("unquoted keys", () => {
    expect(repairJson("{a:1}")).toEqual({ a: 1 });
  });
  it("missing closing brace", () => {
    expect(repairJson('{"a":1')).toEqual({ a: 1 });
  });
  it("literal newlines in strings", () => {
    const input = '{"text":"line1\nline2"}';
    expect(repairJson(input)).toEqual({ text: "line1\nline2" });
  });
  it("escapeNewlinesInJsonStrings leaves non-string content alone", () => {
    expect(escapeNewlinesInJsonStrings('{"a":1,\n"b":2}')).toBe(
      '{"a":1,\n"b":2}',
    );
  });
  it("truncated / garbage returns _raw sentinel", () => {
    const result = repairJson("not json at all");
    expect(result._raw).toBe("not json at all");
  });
});

describe("parseTextToolCalls", () => {
  it("extracts fenced ```tool block", () => {
    const text =
      'reasoning first\n```tool\n{"name":"Read","input":{"file_path":"/x.py"}}\n```';
    const calls = parseTextToolCalls(text);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("Read");
    expect(calls[0].input).toEqual({ file_path: "/x.py" });
  });
  it("extracts ```json block (Gemma pattern)", () => {
    const text = '```json\n{"name":"Bash","input":{"command":"ls"}}\n```';
    const calls = parseTextToolCalls(text);
    expect(calls[0].name).toBe("Bash");
  });
  it("extracts <tool_call> tag", () => {
    const text =
      '<tool_call>\n{"name":"Edit","input":{"file_path":"/a","old_string":"x","new_string":"y"}}\n</tool_call>';
    const calls = parseTextToolCalls(text);
    expect(calls[0].name).toBe("Edit");
    expect(calls[0].input).toHaveProperty("new_string", "y");
  });
  it("extracts multiple fenced calls", () => {
    const text =
      '```tool\n{"name":"Read","input":{"file_path":"/a"}}\n```\n' +
      'later\n```tool\n{"name":"Read","input":{"file_path":"/b"}}\n```';
    const calls = parseTextToolCalls(text);
    expect(calls.length).toBe(2);
    expect(calls[0].input.file_path).toBe("/a");
    expect(calls[1].input.file_path).toBe("/b");
  });
  it("falls back to bare JSON for flat objects (no nested input)", () => {
    // The bare-JSON regex is restricted to flat objects ([^{}]*), matching
    // the Python implementation. A nested "input": {...} won't match; the
    // model must use a fenced block for those.
    const text = 'the model said: {"name":"Glob","pattern":"**/*.py"}';
    const calls = parseTextToolCalls(text);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("Glob");
  });
  it("does not extract from nested-object bare JSON (matches Python behavior)", () => {
    const text =
      'the model said: {"name":"Glob","input":{"pattern":"**/*.py"}}';
    const calls = parseTextToolCalls(text);
    // Inner object doesn't have "name", outer doesn't match the flat regex
    expect(calls).toEqual([]);
  });
  it("repairs trailing comma inside fenced block", () => {
    const text = '```tool\n{"name":"Read","input":{"file_path":"/x"},}\n```';
    const calls = parseTextToolCalls(text);
    expect(calls[0].name).toBe("Read");
  });
  it("accepts parameters/args alias for input", () => {
    const text =
      '```tool\n{"name":"Read","parameters":{"file_path":"/x"}}\n```';
    const calls = parseTextToolCalls(text);
    expect(calls[0].input.file_path).toBe("/x");
  });
  it("empty on plain text", () => {
    expect(parseTextToolCalls("just regular text, no tools here")).toEqual([]);
  });
});
