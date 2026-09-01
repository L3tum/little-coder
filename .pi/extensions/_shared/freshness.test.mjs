import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileFreshnessKey } from "./freshness.mjs";

describe("fileFreshnessKey", () => {
  const dir = mkdtempSync(join(tmpdir(), "freshness-"));
  const file = join(dir, "f.json");

  it("missing file → null (never throws)", () => {
    expect(fileFreshnessKey(join(dir, "does-not-exist.json"))).toBeNull();
  });

  it("existing file → a non-null string key", () => {
    writeFileSync(file, JSON.stringify({ a: 1 }));
    const k = fileFreshnessKey(file);
    expect(typeof k).toBe("string");
    expect(k).toMatch(/:\d+$/);
  });

  it("a content change (different size) → different key", () => {
    writeFileSync(file, JSON.stringify({ a: 1 }));
    const k1 = fileFreshnessKey(file);
    writeFileSync(file, JSON.stringify({ a: 1, b: 2, c: 3 }));
    const k2 = fileFreshnessKey(file);
    expect(k2).not.toBe(k1);
  });

  it("an mtime bump with unchanged content → different key (mtime-sensitive)", () => {
    writeFileSync(file, "x".repeat(100));
    const k1 = fileFreshnessKey(file);
    // Bump mtime into the future so mtimeMs definitely changes.
    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);
    const k2 = fileFreshnessKey(file);
    expect(k2).not.toBe(k1);
  });

  it("never throws on weird inputs (null path, directory, garbage)", () => {
    expect(() => fileFreshnessKey(dir)).not.toThrow(); // directory lstats fine
    expect(typeof fileFreshnessKey(dir)).toBe("string");
    expect(() =>
      fileFreshnessKey("/nonexistent-dir-xyz/nope.json"),
    ).not.toThrow();
    expect(fileFreshnessKey("/nonexistent-dir-xyz/nope.json")).toBeNull();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
