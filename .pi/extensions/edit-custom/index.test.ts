import { describe, expect, it } from "vitest";
import { normalizeEditArguments } from "./index.ts";

describe("normalizeEditArguments", () => {
  it("normalizes snake_case edit keys", () => {
    expect(normalizeEditArguments({
      path: "/tmp/a",
      edits: [{ old_string: "old", new_string: "new" }],
    })).toEqual({ path: "/tmp/a", edits: [{ oldText: "old", newText: "new" }] });
  });

  it("normalizes camelCase and snake_text aliases", () => {
    expect(normalizeEditArguments({
      file_path: "/tmp/a",
      edits: [
        { oldString: "old1", newString: "new1" },
        { old_text: "old2", new_text: "new2" },
      ],
    })).toEqual({
      path: "/tmp/a",
      edits: [
        { oldText: "old1", newText: "new1" },
        { oldText: "old2", newText: "new2" },
      ],
    });
  });

  it("normalizes top-level old/new aliases", () => {
    expect(normalizeEditArguments({
      path: "/tmp/a",
      oldText: "old",
      newText: "new",
    })).toEqual({ path: "/tmp/a", edits: [{ oldText: "old", newText: "new" }] });
  });
});
