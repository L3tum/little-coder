import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globFiles, renderGlobOutcome, DEFAULT_HEAVY_DIRS } from "./glob.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glob-test-"));
  // real source we want to find
  mkdirSync(join(dir, "src", "sub"), { recursive: true });
  writeFileSync(join(dir, "src", "a.py"), "");
  writeFileSync(join(dir, "src", "sub", "b.py"), "");
  writeFileSync(join(dir, "README.md"), "");
  // heavy dirs that must be pruned (with files matching the pattern inside)
  mkdirSync(join(dir, "node_modules", "pkg", "deep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pkg", "deep", "x.py"), "");
  mkdirSync(join(dir, ".git", "objects"), { recursive: true });
  writeFileSync(join(dir, ".git", "objects", "y.py"), "");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "z.py"), "");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("globFiles", () => {
  it("matches real files and prunes heavy dirs (node_modules/.git/dist)", async () => {
    const { matches, scanTruncated, matchTruncated } = await globFiles("**/*.py", { base: dir });
    const rel = matches.map((m) => m.slice(dir.length + 1)).sort();
    expect(rel).toEqual(["src/a.py", "src/sub/b.py"]);
    expect(matches.some((m) => m.includes("node_modules"))).toBe(false);
    expect(matches.some((m) => m.includes(".git"))).toBe(false);
    expect(matches.some((m) => m.includes("/dist/"))).toBe(false);
    expect(scanTruncated).toBe(false);
    expect(matchTruncated).toBe(false);
  });

  it("caps matches at maxMatches and flags matchTruncated", async () => {
    const many = mkdtempSync(join(tmpdir(), "glob-many-"));
    for (let i = 0; i < 50; i++) writeFileSync(join(many, `f${i}.txt`), "");
    try {
      const { matches, matchTruncated } = await globFiles("*.txt", { base: many, maxMatches: 10 });
      expect(matches.length).toBe(10);
      expect(matchTruncated).toBe(true);
    } finally {
      rmSync(many, { recursive: true, force: true });
    }
  });

  it("stops the walk at maxScan and flags scanTruncated (memory bound)", async () => {
    // A low budget must halt the walk regardless of how many entries exist.
    const { scanned, scanTruncated } = await globFiles("**/*", { base: dir, maxScan: 3 });
    expect(scanTruncated).toBe(true);
    expect(scanned).toBeLessThanOrEqual(5); // a couple over the budget, not unbounded
  });

  it("the heavy-dir set covers the usual offenders", () => {
    for (const d of ["node_modules", ".git", "dist", ".cache", "Library", "venv", "target"]) {
      expect(DEFAULT_HEAVY_DIRS.has(d)).toBe(true);
    }
  });
});

describe("renderGlobOutcome", () => {
  it("reports no matches plainly", () => {
    expect(renderGlobOutcome({ matches: [], scanned: 5, scanTruncated: false, matchTruncated: false }))
      .toBe("No files matched");
  });
  it("notes scan truncation when nothing matched", () => {
    expect(renderGlobOutcome({ matches: [], scanned: 9, scanTruncated: true, matchTruncated: false }, 200000))
      .toMatch(/stopped after scanning 200000 entries/);
  });
  it("appends a match-cap note", () => {
    const text = renderGlobOutcome(
      { matches: ["/a", "/b"], scanned: 2, scanTruncated: false, matchTruncated: true },
      200000,
      500,
    );
    expect(text).toMatch(/stopped at 500 matches/);
  });
  it("appends a scan-cap note when there were partial matches", () => {
    const text = renderGlobOutcome(
      { matches: ["/a"], scanned: 9, scanTruncated: true, matchTruncated: false },
      200000,
    );
    expect(text).toMatch(/results may be incomplete/);
  });
});
