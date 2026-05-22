import { describe, expect, it } from "vitest";
import { selectProjectForCwd } from "./index.ts";

describe("selectProjectForCwd", () => {
  it("matches the exact workspace root", () => {
    expect(selectProjectForCwd([
      { name: "proj", root_path: "/home/me/proj" },
    ], "/home/me/proj")).toBe("proj");
  });

  it("matches descendant paths", () => {
    expect(selectProjectForCwd([
      { name: "proj", root_path: "/home/me/proj" },
    ], "/home/me/proj/src/lib")).toBe("proj");
  });

  it("prefers the deepest matching indexed root", () => {
    expect(selectProjectForCwd([
      { name: "parent", root_path: "/home/me/proj" },
      { name: "child", root_path: "/home/me/proj/packages/app" },
    ], "/home/me/proj/packages/app/src")).toBe("child");
  });

  it("returns undefined when nothing matches", () => {
    expect(selectProjectForCwd([
      { name: "other", root_path: "/home/me/other" },
    ], "/home/me/proj")).toBeUndefined();
  });
});
