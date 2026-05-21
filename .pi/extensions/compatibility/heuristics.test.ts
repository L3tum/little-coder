import { describe, it, expect } from "vitest";
import { findCompatibleToolName, rewriteValueToSchema } from "./heuristics.ts";

describe("findCompatibleToolName", () => {
  it("matches case-only differences", () => {
    expect(findCompatibleToolName("Bash", ["bash", "read"])).toBe("bash");
  });

  it("matches camel/snake and plural heuristics", () => {
    expect(findCompatibleToolName("Findread", ["findRead", "glob"])).toBe("findRead");
  });
});

describe("rewriteValueToSchema", () => {
  it("renames file_path to path", () => {
    const schema = { type: "object", properties: { path: { type: "string" } } };
    const out = rewriteValueToSchema({ file_path: "/tmp/x" }, schema);
    expect(out.value).toEqual({ path: "/tmp/x" });
    expect(out.changed).toBe(true);
  });

  it("rewrites oldText/newText to old_string/new_string inside arrays", () => {
    const schema = {
      type: "object",
      properties: {
        replacements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
            },
          },
        },
      },
    };
    const out = rewriteValueToSchema({ replacements: [{ oldText: "a", newText: "b" }] }, schema);
    expect(out.value).toEqual({ replacements: [{ old_string: "a", new_string: "b" }] });
  });

  it("renames singular edit to edits and wraps it into an array", () => {
    const schema = {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
            },
          },
        },
      },
    };
    const out = rewriteValueToSchema({ edit: { oldText: "x", newText: "y" } }, schema);
    expect(out.value).toEqual({ edits: [{ old_string: "x", new_string: "y" }] });
  });
});
