import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachePath,
  readCache,
  readCacheAllowStale,
  writeCache,
  compareSemver,
  shouldSkip,
  fetchLatest,
  checkForUpdate,
  refreshUpdateCache,
  isValidSemver,
  formatAgeHours,
} from "./update-check.mjs";

describe("isValidSemver (gates the update check on a valid version)", () => {
  it("accepts real semver versions", () => {
    expect(isValidSemver("1.8.1")).toBe(true);
    expect(isValidSemver("0.0.0")).toBe(true);
    expect(isValidSemver("v2.3.4")).toBe(true);
    expect(isValidSemver("1.2.3-rc.1+build.5")).toBe(true);
  });
  it("rejects missing/malformed/non-string versions", () => {
    expect(isValidSemver("1.8")).toBe(false);
    expect(isValidSemver(undefined)).toBe(false);
    expect(isValidSemver("")).toBe(false);
    expect(isValidSemver({})).toBe(false);
    expect(isValidSemver(1.81)).toBe(false);
  });
});

describe("formatAgeHours (three display tiers)", () => {
  it("renders minutes below an hour", () => {
    expect(formatAgeHours(0.5)).toBe(" (last checked 30m ago)");
    expect(formatAgeHours(0)).toBe(" (last checked 0m ago)");
  });
  it("renders hours up to 48", () => {
    expect(formatAgeHours(1)).toBe(" (last checked 1h ago)");
    expect(formatAgeHours(23.4)).toBe(" (last checked 23h ago)");
    expect(formatAgeHours(47.9)).toBe(" (last checked 48h ago)");
  });
  it("renders days beyond 48h", () => {
    expect(formatAgeHours(48)).toBe(" (last checked 2d ago)");
    expect(formatAgeHours(72.5)).toBe(" (last checked 3d ago)");
  });
});

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

  // the write is atomic (shared settings-write.mjs): the temp file
  // <cache>.tmp-<pid> is renamed into place, so a successful write leaves no
  // temp litter behind.
  it("writeCache: no .tmp-* file remains after a successful write", () => {
    writeCache("1.0.0", Date.now());
    const dir = join(tmp, "little-coder");
    const leftover = readdirSync(dir).filter((f) => /\.tmp-\d+$/.test(f));
    expect(leftover).toEqual([]);
  });

  it("readCacheAllowStale: returns entries past the 12 h TTL", () => {
    writeCache("1.0.5", 0);
    const stale = readCache(13 * 60 * 60 * 1000);
    expect(stale).toBeNull();
    const staleAllowed = readCacheAllowStale();
    expect(staleAllowed?.latest).toBe("1.0.5");
  });

  it("readCacheAllowStale: null when no cache / malformed", () => {
    expect(readCacheAllowStale()).toBeNull();
    writeCache("1.0.5", 0);
    writeFileSync(cachePath(), "{not-json");
    expect(readCacheAllowStale()).toBeNull();
  });

  it("rejects a non-semver latest but tolerates a pre-release", () => {
    writeCache("not-a-version", Date.now());
    expect(readCache()).toBeNull();
    expect(readCacheAllowStale()).toBeNull();
    writeCache("1.2.3-beta.1", Date.now());
    expect(readCache()?.latest).toBe("1.2.3-beta.1");
    expect(readCacheAllowStale()?.latest).toBe("1.2.3-beta.1");
  });

  it("S1: accepts a combined pre-release+build suffix", () => {
    writeCache("1.2.3-rc.1+build.5", Date.now());
    expect(readCache()?.latest).toBe("1.2.3-rc.1+build.5");
    expect(readCacheAllowStale()?.latest).toBe("1.2.3-rc.1+build.5");
  });

  it("S2: SEMVER_RE regressions — accepts valid, rejects malformed", () => {
    for (const v of ["1.2.3+build", "1.2.3-rc.1", "v1.2.3", "1.2.3"]) {
      writeCache(v, Date.now());
      expect(readCache()?.latest, `should accept ${v}`).toBe(v);
    }
    for (const v of ["1.2", "1.2.3-+x", "1.2.3.4"]) {
      writeCache(v, Date.now());
      expect(readCache(), `should reject ${v}`).toBeNull();
      expect(readCacheAllowStale(), `allowStale should reject ${v}`).toBeNull();
    }
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

  it("returns the highest valid-semver tag from the tag list", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [
        { name: "v1.8.2" },
        { name: "v1.8.10" }, // numerically higher than v1.8.2 (not lexicographic)
        { name: "main" }, // not semver — ignored
        { name: "release-please" }, // not semver — ignored
        { name: "" }, // not semver — ignored
      ],
    });
    const latest = await fetchLatest();
    expect(latest).toBe("v1.8.10");
  });

  it("returns null on non-200 response", async () => {
    global.fetch.mockResolvedValue({ ok: false });
    expect(await fetchLatest()).toBeNull();
  });

  it("returns null when response is not a tag array (e.g. API error body)", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ message: "Not Found" }),
    });
    expect(await fetchLatest()).toBeNull();
  });

  it("returns null when the tag list has no valid-semver tag", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "main" }, { name: "v-next" }],
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

describe("installTargetFor / displayVersion (pinning)", () => {
  it("pins the install target to the discovered tag", async () => {
    const { installTargetFor, displayVersion } =
      await import("./update-check.mjs");
    expect(installTargetFor("v1.8.2")).toBe("github:L3tum/little-coder#v1.8.2");
    expect(installTargetFor("1.8.2")).toBe("github:L3tum/little-coder#1.8.2");
    expect(displayVersion("v1.8.2")).toBe("1.8.2");
    expect(displayVersion("1.8.2")).toBe("1.8.2");
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

  it("defaults to NO on empty input (explicit opt-in)", async () => {
    const { promptYesNo: pyn } = await import("./update-check.mjs");
    const promise = pyn("Test? ");
    questionCallback("");
    expect(await promise).toBe(false);
  });

  it("returns false on 'N' (case-insensitive)", async () => {
    const { promptYesNo: pyn } = await import("./update-check.mjs");
    const promise = pyn("Test? ");
    questionCallback("N");
    expect(await promise).toBe(false);
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
    // Cache-only: the pre-spawn check never fetches, even on an empty cache.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("is cache-only: compares a STALE cache entry without any fetch", async () => {
    writeCache("2.0.0", 0); // checked 13 h ago -> readCache() === null
    const result = await checkForUpdate(
      "1.0.0",
      { skip: "notice-only" }, // notice-only: no prompt, still notices
    );
    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("is cache-only: stale cache with latest <= current -> no notice, no fetch", async () => {
    writeCache("1.0.0", 0);
    const result = await checkForUpdate("1.0.0", { skip: "notice-only" });
    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("prints notice in notice-only mode without prompting", async () => {
    writeCache("v2.0.0", Date.now());
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
      // The install target is PINNED to the cached tag — the displayed
      // version is exactly what npm would fetch (no main-branch drift).
      expect(stderrLog.join("")).toContain(
        "npm install -g github:L3tum/little-coder#v2.0.0",
      );
      // The leading v is stripped for display, not doubled ("v2.0.0" tag
      // renders as "v2.0.0", not "vv2.0.0").
      expect(stderrLog.join("")).toContain("little-coder v2.0.0 is available");
      expect(stderrLog.join("")).not.toContain("vv2.0.0");
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it('notes how old the cached "latest" is in the notice', async () => {
    writeCache("2.0.0", Date.now() - 14 * 3600 * 1000); // 14 h old, ahead
    const stderrLog = [];
    const origStderr = process.stderr.write;
    process.stderr.write = vi.fn((msg) => {
      stderrLog.push(msg);
      return true;
    });
    try {
      const result = await checkForUpdate("1.0.0", { skip: "notice-only" });
      expect(result).toBe(false);
      expect(stderrLog.join("")).toContain("last checked 14h ago");
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it("U2-min: a fresh (<1 h) cache shows minutes in the notice", async () => {
    writeCache("2.0.0", Date.now() - 30 * 60 * 1000); // 30 min old
    const stderrLog = [];
    const origStderr = process.stderr.write;
    process.stderr.write = vi.fn((msg) => {
      stderrLog.push(msg);
      return true;
    });
    try {
      const result = await checkForUpdate("1.0.0", { skip: "notice-only" });
      expect(result).toBe(false);
      expect(stderrLog.join("")).toContain("last checked 30m ago");
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it("U4: a multi-day-old cache shows days in the notice", async () => {
    writeCache("2.0.0", Date.now() - 5 * 24 * 3600 * 1000); // 5 days old
    const stderrLog = [];
    const origStderr = process.stderr.write;
    process.stderr.write = vi.fn((msg) => {
      stderrLog.push(msg);
      return true;
    });
    try {
      const result = await checkForUpdate("1.0.0", { skip: "notice-only" });
      expect(result).toBe(false);
      expect(stderrLog.join("")).toContain("last checked 5d ago");
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it("U2: a future-dated cache clamps age to 0 (no negative age printed)", async () => {
    writeCache("2.0.0", Date.now() + 2 * 3600 * 1000); // clock skew / future
    const stderrLog = [];
    const origStderr = process.stderr.write;
    process.stderr.write = vi.fn((msg) => {
      stderrLog.push(msg);
      return true;
    });
    try {
      const result = await checkForUpdate("1.0.0", { skip: "notice-only" });
      expect(result).toBe(false);
      const text = stderrLog.join("");
      expect(text).toContain("last checked 0m ago");
      expect(text).not.toContain("-0m");
      expect(text).not.toMatch(/checked -\d+h/);
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it("resolves without the network even if fetch hangs forever (non-blocking)", async () => {
    writeCache("2.0.0", 0); // stale cache present
    global.fetch.mockReturnValue(new Promise(() => {})); // hangs forever
    const result = await Promise.race([
      checkForUpdate("1.0.0", { skip: "notice-only" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), 500),
      ),
    ]);
    expect(result).toBe(false);
    // The cache-only pre-spawn check never reaches the network.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("U1: an injected cache snapshot is used and the file is NOT re-read", async () => {
    // Write a valid cache, then pass an injected snapshot, then CORRUPT the
    // file. If checkForUpdate re-read the file it would see the corruption and
    // find no "latest"; using the snapshot, it still reports the injected
    // version — proving no re-read.
    writeCache("2.0.0", Date.now());
    const injected = { checkedAt: Date.now(), latest: "2.0.0" };
    writeFileSync(cachePath(), "{corrupted-after-injection");
    const stderrLog = [];
    const origStderr = process.stderr.write;
    process.stderr.write = vi.fn((msg) => {
      stderrLog.push(msg);
      return true;
    });
    try {
      const result = await checkForUpdate("1.0.0", {
        skip: "notice-only",
        cache: injected,
      });
      expect(result).toBe(false);
      expect(stderrLog.join("")).toContain("v2.0.0 is available");
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it("U3: default path (no injection) reads the file; missing/corrupt cache never throws", async () => {
    // Default path: a fresh on-disk cache is read and compared (no injection).
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
      expect(stderrLog.join("")).toContain("v2.0.0 is available");
    } finally {
      process.stderr.write = origStderr;
    }
    // Missing cache -> false, no throw.
    rmSync(cachePath(), { force: true });
    expect(await checkForUpdate("1.0.0", { skip: "notice-only" })).toBe(false);
    // Corrupt cache -> false, no throw.
    writeFileSync(cachePath(), "{not-json");
    expect(await checkForUpdate("1.0.0", { skip: "notice-only" })).toBe(false);
  });
});

describe("refreshUpdateCache (fire-and-forget next-launch refresh)", () => {
  let tmp, origXdg;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lc-uc-refresh-test-"));
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

  it("fetches and writes a fresh cache when the cache is stale", async () => {
    writeCache("1.0.0", 0); // stale
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "2.1.0" }],
    });
    await refreshUpdateCache({ skip: "notice-only" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(readCache()?.latest).toBe("2.1.0");
  });

  // the launcher's ACTUAL path: it pre-reads the cache once and
  // injects the snapshot via {cache}. The TTL gate applies to the INJECTED
  // snapshot, not a fresh re-read of the file.
  it("injected FRESH snapshot: no fetch, on-disk cache untouched", async () => {
    writeCache("1.0.0", 0); // stale on disk — must be irrelevant
    const onDisk = readFileSync(cachePath(), "utf-8");
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "9.9.9" }],
    });
    await refreshUpdateCache({
      skip: "notice-only",
      cache: { checkedAt: Date.now(), latest: "1.0.0" },
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(readFileSync(cachePath(), "utf-8")).toBe(onDisk);
  });

  it("injected STALE snapshot with a fresh on-disk cache: fetches once + writes (gate is on the snapshot, not a re-read)", async () => {
    writeCache("2.0.0", Date.now()); // fresh on disk — would short-circuit a re-read
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "3.0.0" }],
    });
    await refreshUpdateCache({
      skip: "notice-only",
      cache: { checkedAt: 0, latest: "1.0.0" }, // stale snapshot
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(readCache()?.latest).toBe("3.0.0");
  });

  it("injected garbage snapshot (no checkedAt): fetches", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "4.0.0" }],
    });
    await refreshUpdateCache({
      skip: "notice-only",
      cache: { latest: "1.0.0" }, // no checkedAt -> not fresh
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(readCache()?.latest).toBe("4.0.0");
  });

  it("fetches and writes a cache when none exists", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "3.0.0" }],
    });
    await refreshUpdateCache({ skip: "notice-only" });
    expect(readCache()?.latest).toBe("3.0.0");
  });

  it("does not fetch when the cache is fresh", async () => {
    writeCache("1.0.0", Date.now());
    await refreshUpdateCache({ skip: "notice-only" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not fetch when skip=true (CI / --no-update-check)", async () => {
    await refreshUpdateCache({ skip: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refresh reads the cache once (dedup) — one fetch, one write; a second refresh is a no-op", async () => {
    writeCache("1.0.0", 0); // stale
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "2.1.0" }],
    });
    // Structural dedup (the skip-guard and refresh-guard share a single
    // readCache() result) is verified behaviorally: a stale cache produces
    // exactly ONE fetch and leaves a fresh cache behind, so the next refresh
    // short-circuits without touching the network again.
    await refreshUpdateCache({ skip: "notice-only" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(readCache()?.latest).toBe("2.1.0"); // now fresh
    await refreshUpdateCache({ skip: "notice-only" });
    expect(global.fetch).toHaveBeenCalledTimes(1); // fresh -> no second fetch
  });

  it("never throws on fetch failure and leaves the cache untouched", async () => {
    writeCache("1.0.0", 0); // stale
    global.fetch.mockRejectedValue(new Error("offline"));
    await expect(refreshUpdateCache({ skip: "notice-only" })).resolves.toBe(
      undefined,
    );
    // stale value survives for the next launch
    expect(readCacheAllowStale()?.latest).toBe("1.0.0");
    expect(readCache()).toBeNull();
  });

  it("does not overwrite the cache when the fetch returns no version", async () => {
    writeCache("1.0.0", 0);
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    await refreshUpdateCache({ skip: "notice-only" });
    expect(readCacheAllowStale()?.latest).toBe("1.0.0");
  });

  it("P4: a failed fetch records lastFailedAt (preserving the usable latest)", async () => {
    writeCache("1.0.0", 0); // stale but usable latest
    global.fetch.mockRejectedValue(new Error("offline"));
    await refreshUpdateCache({ skip: "notice-only" });
    const c = readCacheAllowStale();
    expect(c?.latest).toBe("1.0.0"); // usable latest preserved
    expect(c?.lastFailedAt).toBeTypeOf("number");
    expect(Date.now() - c.lastFailedAt).toBeLessThan(1000); // recent
  });

  it("P4: a second call within the TTL window skips the fetch (negative cache)", async () => {
    const now = Date.now();
    // Simulate a recent failed fetch with a usable stale latest.
    mkdirSync(join(tmp, "little-coder"), { recursive: true });
    writeFileSync(
      cachePath(),
      JSON.stringify({ checkedAt: 0, latest: "1.0.0", lastFailedAt: now }),
    );
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "9.9.9" }],
    });
    await refreshUpdateCache({ skip: "notice-only" });
    expect(global.fetch).not.toHaveBeenCalled(); // negative cache: skipped
    expect(readCacheAllowStale()?.lastFailedAt).toBe(now); // unchanged
  });

  it("P4: after the TTL window the fetch is retried", async () => {
    const now = Date.now();
    // A failure 13 h ago (beyond the 12 h TTL) → the gate no longer holds.
    mkdirSync(join(tmp, "little-coder"), { recursive: true });
    writeFileSync(
      cachePath(),
      JSON.stringify({
        checkedAt: 0,
        latest: "1.0.0",
        lastFailedAt: now - 13 * 3_600_000,
      }),
    );
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "9.9.9" }],
    });
    await refreshUpdateCache({ skip: "notice-only" });
    expect(global.fetch).toHaveBeenCalledTimes(1); // retried
    expect(readCache()?.latest).toBe("9.9.9"); // fresh value written
  });
});
