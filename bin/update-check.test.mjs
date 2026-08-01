import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachePath,
  readCache,
  writeCache,
  compareSemver,
  shouldSkip,
  fetchLatest,
  checkForUpdate,
} from "./update-check.mjs";

describe("compareSemver", () => {
  it("orders major / minor / patch correctly", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("1.1.0", "1.0.99")).toBe(1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("0.99.99", "1.0.0")).toBe(-1);
  });

  it("treats releases as greater than pre-releases of same core", () => {
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.1")).toBe(1);
  });

  it("orders pre-release identifiers by semver rules", () => {
    expect(compareSemver("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareSemver("1.0.0-beta", "1.0.0-beta.2")).toBe(-1);
    expect(compareSemver("1.0.0-beta.11", "1.0.0-beta.2")).toBe(1);
  });

  it("ignores build metadata and tolerates a leading v", () => {
    expect(compareSemver("v1.2.3+build.5", "1.2.3+build.1")).toBe(0);
  });

  it("tolerates short version strings", () => {
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
    expect(compareSemver("1", "1.0.0")).toBe(0);
  });
});

describe("cachePath", () => {
  it("uses XDG_CACHE_HOME when set", () => {
    const orig = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/tmp/xdg-test";
    try {
      expect(cachePath()).toBe("/tmp/xdg-test/little-coder/version-check.json");
    } finally {
      if (orig !== undefined) process.env.XDG_CACHE_HOME = orig;
      else delete process.env.XDG_CACHE_HOME;
    }
  });

  it("falls back to ~/.cache when XDG is unset", () => {
    const orig = process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CACHE_HOME;
    try {
      const p = cachePath();
      expect(p).toMatch(/\.cache\/little-coder\/version-check\.json$/);
    } finally {
      if (orig !== undefined) process.env.XDG_CACHE_HOME = orig;
    }
  });
});

describe("read/writeCache", () => {
  let tmp;
  let origXdg;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lc-uc-test-"));
    origXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = tmp;
  });
  afterEach(() => {
    if (origXdg !== undefined) process.env.XDG_CACHE_HOME = origXdg;
    else delete process.env.XDG_CACHE_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no cache exists", () => {
    expect(readCache()).toBeNull();
  });

  it("round-trips a fresh entry", () => {
    writeCache("1.0.5", 1000);
    const cached = readCache(2000);
    expect(cached?.latest).toBe("1.0.5");
    expect(cached?.checkedAt).toBe(1000);
  });

  it("returns null for stale entries past 12h TTL", () => {
    writeCache("1.0.5", 0);
    const stale = readCache(13 * 60 * 60 * 1000);
    expect(stale).toBeNull();
  });

  it("returns the entry if exactly at TTL boundary", () => {
    writeCache("1.0.5", 0);
    const at = readCache(12 * 60 * 60 * 1000);
    expect(at?.latest).toBe("1.0.5");
  });

  it("handles malformed cache files gracefully", () => {
    writeCache("garbage", 1000);
    const path = cachePath();
    // Corrupt the file
    const fs = readFileSync(path, "utf-8");
    expect(fs).toContain("garbage");
    // Now write actual garbage
    require("node:fs").writeFileSync(path, "{not-json");
    expect(readCache()).toBeNull();
  });

  it("creates the cache directory if missing", () => {
    rmSync(join(tmp, "little-coder"), { recursive: true, force: true });
    writeCache("1.2.3", 5000);
    expect(existsSync(cachePath())).toBe(true);
    expect(readCache(5000)?.latest).toBe("1.2.3");
  });
});

describe("shouldSkip", () => {
  function ttyStdout() {
    return { isTTY: true };
  }
  function pipeStdout() {
    return { isTTY: false };
  }
  const noEnv = {};

  it("returns false in plain TTY interactive mode", () => {
    expect(shouldSkip([], noEnv, ttyStdout())).toBe(false);
  });

  it("skips when LITTLE_CODER_NO_UPDATE_CHECK=1", () => {
    expect(
      shouldSkip([], { LITTLE_CODER_NO_UPDATE_CHECK: "1" }, ttyStdout()),
    ).toBe(true);
  });

  it("skips on --no-update-check flag", () => {
    expect(shouldSkip(["--no-update-check"], noEnv, ttyStdout())).toBe(true);
  });

  it("skips on --help / -h", () => {
    expect(shouldSkip(["--help"], noEnv, ttyStdout())).toBe(true);
    expect(shouldSkip(["-h"], noEnv, ttyStdout())).toBe(true);
  });

  it("skips on --version / -v", () => {
    expect(shouldSkip(["--version"], noEnv, ttyStdout())).toBe(true);
    expect(shouldSkip(["-v"], noEnv, ttyStdout())).toBe(true);
  });

  it("skips on --list-models and --export", () => {
    expect(shouldSkip(["--list-models"], noEnv, ttyStdout())).toBe(true);
    expect(shouldSkip(["--export", "session.jsonl"], noEnv, ttyStdout())).toBe(
      true,
    );
  });

  it("skips for --mode rpc / --mode json", () => {
    expect(shouldSkip(["--mode", "rpc"], noEnv, ttyStdout())).toBe(true);
    expect(shouldSkip(["--mode", "json"], noEnv, ttyStdout())).toBe(true);
  });

  it("does not skip for --mode text", () => {
    expect(shouldSkip(["--mode", "text"], noEnv, ttyStdout())).toBe(false);
  });

  it("skips in CI environments", () => {
    expect(shouldSkip([], { CI: "true" }, ttyStdout())).toBe(true);
    expect(shouldSkip([], { CI: "1" }, ttyStdout())).toBe(true);
  });

  it("returns notice-only on non-TTY pipelines", () => {
    expect(shouldSkip([], noEnv, pipeStdout())).toBe("notice-only");
  });
});

describe("fetchLatest", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns version on 200 response", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: "2.0.0" }),
    });
    const latest = await fetchLatest();
    expect(latest).toBe("2.0.0");
  });

  it("returns null on non-200 response", async () => {
    global.fetch.mockResolvedValue({ ok: false });
    expect(await fetchLatest()).toBeNull();
  });

  it("returns null when response has no version field", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    expect(await fetchLatest()).toBeNull();
  });

  it("returns null on network error", async () => {
    global.fetch.mockRejectedValue(new Error("network error"));
    expect(await fetchLatest()).toBeNull();
  });

  it("aborts when fetch times out (simulated via AbortError)", async () => {
    global.fetch.mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );
    expect(await fetchLatest()).toBeNull();
  });
});

describe("promptYesNo", () => {
  let mockRl;
  let questionCallback;

  beforeEach(() => {
    vi.resetModules();
    questionCallback = null;
    mockRl = {
      question: vi.fn((q, cb) => {
        questionCallback = cb;
      }),
      close: vi.fn(),
    };
    vi.doMock("node:readline", () => ({
      createInterface: vi.fn(() => mockRl),
    }));
    // Ensure stdin.isTTY is true
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.doUnmock("node:readline");
    vi.restoreAllMocks();
  });

  it("defaults to yes on empty input", async () => {
    const { promptYesNo: pyn } = await import("./update-check.mjs");
    const promise = pyn("Test? ");
    questionCallback("");
    expect(await promise).toBe(true);
  });

  it("returns true for 'y' and 'yes'", async () => {
    const { promptYesNo: pyn } = await import("./update-check.mjs");
    const promise = pyn("Test? ");
    questionCallback("y");
    expect(await promise).toBe(true);
  });

  it("returns true for 'yes'", async () => {
    const { promptYesNo: pyn } = await import("./update-check.mjs");
    const promise = pyn("Test? ");
    questionCallback("yes");
    expect(await promise).toBe(true);
  });

  it("returns false for 'n' and 'no'", async () => {
    const { promptYesNo: pyn } = await import("./update-check.mjs");
    const promise = pyn("Test? ");
    questionCallback("n");
    expect(await promise).toBe(false);
  });

  it("returns false for 'no'", async () => {
    const { promptYesNo: pyn } = await import("./update-check.mjs");
    const promise = pyn("Test? ");
    questionCallback("no");
    expect(await promise).toBe(false);
  });
});

describe("checkForUpdate", () => {
  let tmp, origXdg;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lc-uc-check-test-"));
    origXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = tmp;
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    if (origXdg !== undefined) process.env.XDG_CACHE_HOME = origXdg;
    else delete process.env.XDG_CACHE_HOME;
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("returns false when skip=true", async () => {
    const result = await checkForUpdate("1.0.0", { skip: true });
    expect(result).toBe(false);
  });

  it("returns false when current version >= latest", async () => {
    writeCache("1.0.0", Date.now());
    const result = await checkForUpdate("1.0.0");
    expect(result).toBe(false);
  });

  it("returns false when current version > latest", async () => {
    writeCache("0.9.0", Date.now());
    const result = await checkForUpdate("1.0.0");
    expect(result).toBe(false);
  });

  it("returns false when no version found (cache empty, fetch returns null)", async () => {
    global.fetch.mockRejectedValue(new Error("no network"));
    const result = await checkForUpdate("1.0.0", { skip: false });
    expect(result).toBe(false);
  });

  it("prints notice in notice-only mode without prompting", async () => {
    writeCache("2.0.0", Date.now());
    const stderrLog = [];
    const origStderr = process.stderr.write;
    process.stderr.write = vi.fn((msg) => {
      stderrLog.push(msg);
      return true;
    });
    try {
      const result = await checkForUpdate("1.0.0", { skip: "notice-only" });
      expect(result).toBe(false);
      expect(stderrLog.join("").includes("available")).toBe(true);
      expect(stderrLog.join("").includes("npm install -g")).toBe(true);
    } finally {
      process.stderr.write = origStderr;
    }
  });
});
