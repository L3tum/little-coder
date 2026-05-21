import { describe, expect, it } from "vitest";
import { isWithinDirectory, resolveWorkspaceCwd } from "./index.ts";

describe("isWithinDirectory", () => {
  const root = "/home/me/proj";

  it("accepts root and descendants", () => {
    expect(isWithinDirectory(root, root)).toBe(true);
    expect(isWithinDirectory(root, "/home/me/proj/src")).toBe(true);
    expect(isWithinDirectory(root, "/home/me/proj/src/lib")).toBe(true);
  });

  it("rejects parents and siblings", () => {
    expect(isWithinDirectory(root, "/home/me")).toBe(false);
    expect(isWithinDirectory(root, "/home/me/other")).toBe(false);
  });
});

describe("resolveWorkspaceCwd", () => {
  const cwd = "/home/me/proj";

  it("defaults empty cwd to current cwd", () => {
    expect(resolveWorkspaceCwd("", cwd)).toEqual({ ok: true, path: cwd });
  });

  it("accepts relative subdirectories", () => {
    expect(resolveWorkspaceCwd("src", cwd)).toEqual({ ok: true, path: "/home/me/proj/src" });
    expect(resolveWorkspaceCwd("./src/lib", cwd)).toEqual({ ok: true, path: "/home/me/proj/src/lib" });
  });

  it("accepts absolute paths inside workspace", () => {
    expect(resolveWorkspaceCwd("/home/me/proj/src", cwd)).toEqual({ ok: true, path: "/home/me/proj/src" });
  });

  it("rejects parent traversal and external paths", () => {
    expect(resolveWorkspaceCwd("..", cwd)).toEqual({
      ok: false,
      reason: "Error: bash.cwd must be the current working directory or one of its subdirectories. Rejected: /home/me",
    });
    expect(resolveWorkspaceCwd("/tmp", cwd)).toEqual({
      ok: false,
      reason: "Error: bash.cwd must be the current working directory or one of its subdirectories. Rejected: /tmp",
    });
  });
});
