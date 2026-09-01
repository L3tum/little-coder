import { describe, it, expect, vi, afterEach } from "vitest";
import { isAbsolute } from "node:path";
import {
  absoluteHome,
  cacheBaseDir,
  littleCoderCacheDir,
} from "./cache-path.mjs";

// The absolute-home + XDG-cache-base ladder, shared by bin/update-check.mjs
// (version-check cache) and llama-cpp-provider (ctx-window cache). Pass an
// explicit env object for determinism; the homedir()/userInfo() fallbacks
// read the real system, so assertions check absoluteness + the loud message
// rather than an exact home value.

describe("absoluteHome", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns an absolute $HOME as-is", () => {
    expect(absoluteHome({ HOME: "/home/user" })).toBe("/home/user");
  });

  it("trims $HOME before the absolute check", () => {
    expect(absoluteHome({ HOME: "  /home/user  " })).toBe("/home/user");
  });

  it("a RELATIVE $HOME falls back to the platform home (loud, never relative)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = absoluteHome({ HOME: "relative/home" });
    expect(isAbsolute(h)).toBe(true);
    expect(h).not.toContain("relative");
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /HOME is relative/,
    );
  });

  it("an empty/whitespace-only $HOME falls back to the platform home", () => {
    const h = absoluteHome({ HOME: "   " });
    expect(isAbsolute(h)).toBe(true);
  });

  it("an unset $HOME falls back to the platform home", () => {
    const h = absoluteHome({});
    expect(isAbsolute(h)).toBe(true);
  });
});

describe("cacheBaseDir", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns an absolute XDG_CACHE_HOME as-is", () => {
    expect(
      cacheBaseDir({ XDG_CACHE_HOME: "/tmp/xdg", HOME: "/home/user" }),
    ).toBe("/tmp/xdg");
  });

  it("falls back to ~/.cache when XDG is unset", () => {
    expect(cacheBaseDir({ HOME: "/home/user" })).toBe("/home/user/.cache");
  });

  it("an empty/whitespace-only XDG_CACHE_HOME falls back to ~/.cache", () => {
    expect(cacheBaseDir({ XDG_CACHE_HOME: "   ", HOME: "/home/user" })).toBe(
      "/home/user/.cache",
    );
  });

  it("a RELATIVE XDG_CACHE_HOME falls back to ~/.cache (loud, never ./cache)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = cacheBaseDir({
      XDG_CACHE_HOME: "relative/cache",
      HOME: "/home/user",
    });
    expect(dir).toBe("/home/user/.cache");
    expect(dir).not.toContain("relative");
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /XDG_CACHE_HOME is relative/,
    );
  });
});

describe("littleCoderCacheDir", () => {
  it("is <base>/little-coder under an absolute XDG", () => {
    expect(
      littleCoderCacheDir({ XDG_CACHE_HOME: "/tmp/xdg", HOME: "/home/user" }),
    ).toBe("/tmp/xdg/little-coder");
  });

  it("is ~/.cache/little-coder when XDG is unset", () => {
    expect(littleCoderCacheDir({ HOME: "/home/user" })).toBe(
      "/home/user/.cache/little-coder",
    );
  });
});
