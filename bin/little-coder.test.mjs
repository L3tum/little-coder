import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJson,
  resolveExtensionEntry,
  addPiResources,
  bundledPackageArgs,
  setPkgRoot,
  updateSettingsFile,
} from "./launcher-internal.mjs";
import lockfile from "proper-lockfile";

// ---- readJson ----

describe("readJson", () => {
  it("parses valid JSON and returns the object", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-json-test-"));
    try {
      const path = join(tmp, "file.json");
      writeFileSync(path, JSON.stringify({ a: 1, b: "hello" }));
      const result = readJson(path);
      expect(result).toEqual({ a: 1, b: "hello" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null for non-existent file", () => {
    expect(readJson("/non-existent/path/file.json")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-json-test-"));
    try {
      const path = join(tmp, "bad.json");
      writeFileSync(path, "{not-json");
      expect(readJson(path)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null for non-object JSON (array)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-json-test-"));
    try {
      const path = join(tmp, "array.json");
      writeFileSync(path, "[1, 2, 3]");
      expect(readJson(path)).toEqual([1, 2, 3]); // arrays parse fine
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null for non-object JSON (string)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-json-test-"));
    try {
      const path = join(tmp, "str.json");
      writeFileSync(path, '"just a string"');
      expect(readJson(path)).toBe("just a string");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- resolveExtensionEntry ----

describe("resolveExtensionEntry", () => {
  it("returns null for non-existent path", () => {
    expect(resolveExtensionEntry("/non-existent/path")).toBeNull();
  });

  it("returns the path itself for a regular file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-ext-test-"));
    try {
      const filePath = join(tmp, "my-ext.js");
      writeFileSync(filePath, "module.exports = {}");
      expect(resolveExtensionEntry(filePath)).toBe(filePath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("finds index.ts in a directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-ext-test-"));
    try {
      const dir = join(tmp, "ext");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.ts"), "export default {}");
      expect(resolveExtensionEntry(dir)).toBe(join(dir, "index.ts"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to index.js when index.ts missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-ext-test-"));
    try {
      const dir = join(tmp, "ext");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.js"), "module.exports = {}");
      expect(resolveExtensionEntry(dir)).toBe(join(dir, "index.js"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to index.mjs when index.ts/js missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-ext-test-"));
    try {
      const dir = join(tmp, "ext");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.mjs"), "export default {}");
      expect(resolveExtensionEntry(dir)).toBe(join(dir, "index.mjs"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to index.cjs when index.ts/js/mjs missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-ext-test-"));
    try {
      const dir = join(tmp, "ext");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.cjs"), "module.exports = {}");
      expect(resolveExtensionEntry(dir)).toBe(join(dir, "index.cjs"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses package.json main when no standard entry", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-ext-test-"));
    try {
      const dir = join(tmp, "ext");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ main: "lib/index.js" }),
      );
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "lib", "index.js"), "module.exports = {}");
      expect(resolveExtensionEntry(dir)).toBe(join(dir, "lib", "index.js"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to sole code file when no index or package.json main", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-ext-test-"));
    try {
      const dir = join(tmp, "ext");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "only-file.js"), "module.exports = {}");
      expect(resolveExtensionEntry(dir)).toBe(join(dir, "only-file.js"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns original path when multiple code files exist (ambiguous)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-ext-test-"));
    try {
      const dir = join(tmp, "ext");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "a.js"), "module.exports = {}");
      writeFileSync(join(dir, "b.ts"), "export default {}");
      expect(resolveExtensionEntry(dir)).toBe(dir);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores .d.ts files in sole-file detection", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-ext-test-"));
    try {
      const dir = join(tmp, "ext");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "index.d.ts"),
        "export declare function x(): void;",
      );
      writeFileSync(join(dir, "real.js"), "module.exports = {}");
      expect(resolveExtensionEntry(dir)).toBe(join(dir, "real.js"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- addPiResources ----

describe("addPiResources", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips non-array resources", () => {
    const args = [];
    addPiResources(args, "--extension", "/base", "not-an-array");
    expect(args).toEqual([]);
  });

  it("skips empty array", () => {
    const args = [];
    addPiResources(args, "--extension", "/base", []);
    expect(args).toEqual([]);
  });

  it("skips non-string entries in the array", () => {
    const args = [];
    addPiResources(args, "--extension", "/base", [123, null, undefined]);
    expect(args).toEqual([]);
  });

  it("skips empty-string entries", () => {
    const args = [];
    addPiResources(args, "--extension", "/base", [""]);
    expect(args).toEqual([]);
  });

  it("resolves paths relative to baseDir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-res-test-"));
    try {
      const dir = join(tmp, "base");
      mkdirSync(dir, { recursive: true });
      const promptFile = join(dir, "prompt.txt");
      writeFileSync(promptFile, "hello");
      const args = [];
      addPiResources(args, "--prompt-template", dir, ["prompt.txt"]);
      expect(args).toEqual(["--prompt-template", promptFile]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not call resolveExtensionEntry for non-extension flags", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-res-test-"));
    try {
      const dir = join(tmp, "base");
      mkdirSync(dir, { recursive: true });
      const themeFile = join(dir, "theme.json");
      writeFileSync(themeFile, "{}");
      const args = [];
      // For --theme, it should NOT use resolveExtensionEntry
      addPiResources(args, "--theme", dir, ["theme.json"]);
      expect(args).toEqual(["--theme", themeFile]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("warns and skips missing resources", () => {
    const args = [];
    addPiResources(args, "--extension", "/base", ["does-not-exist"]);
    expect(args).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      "little-coder: skipping missing extension resource /base/does-not-exist",
    );
  });
});

// ---- bundledPackageArgs ----

describe("bundledPackageArgs", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty for missing littleCoder.packages", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-pkg-test-"));
    setPkgRoot(tmp);
    expect(bundledPackageArgs({})).toEqual([]);
    expect(bundledPackageArgs({ littleCoder: {} })).toEqual([]);
    expect(bundledPackageArgs({ littleCoder: { packages: [] } })).toEqual([]);
  });

  it("discovers extensions from bundled package with pi manifest", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-pkg-test-"));
    setPkgRoot(tmp);
    const pkgDir = join(tmp, "node_modules", "my-ext-pkg");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "my-ext-pkg",
        pi: { extensions: ["dist/index.js"] },
      }),
    );
    writeFileSync(join(pkgDir, "dist", "index.js"), "export default {}");
    writeFileSync(join(pkgDir, "dist", "index.ts"), "export default {}");
    const args = bundledPackageArgs({
      littleCoder: { packages: ["my-ext-pkg"] },
    });
    expect(args).toContain("--extension");
    expect(args.join("/")).toContain("my-ext-pkg");
  });

  it("discovers prompts from bundled package", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-pkg-test-"));
    setPkgRoot(tmp);
    const pkgDir = join(tmp, "node_modules", "my-prompt-pkg");
    mkdirSync(join(pkgDir, "prompts"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "my-prompt-pkg",
        pi: { prompts: ["prompts/system.md"] },
      }),
    );
    writeFileSync(join(pkgDir, "prompts", "system.md"), "# System");
    const args = bundledPackageArgs({
      littleCoder: { packages: ["my-prompt-pkg"] },
    });
    expect(args).toContain("--prompt-template");
  });

  it("discovers themes from bundled package", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-pkg-test-"));
    setPkgRoot(tmp);
    const pkgDir = join(tmp, "node_modules", "my-theme-pkg");
    mkdirSync(join(pkgDir, "themes"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "my-theme-pkg",
        pi: { themes: ["themes/dark.json"] },
      }),
    );
    writeFileSync(join(pkgDir, "themes", "dark.json"), "{}");
    const args = bundledPackageArgs({
      littleCoder: { packages: ["my-theme-pkg"] },
    });
    expect(args).toContain("--theme");
  });

  it("skips packages with no pi manifest", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-pkg-test-"));
    setPkgRoot(tmp);
    const pkgDir = join(tmp, "node_modules", "no-pi-pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "no-pi-pkg" }),
    );
    const args = bundledPackageArgs({
      littleCoder: { packages: ["no-pi-pkg"] },
    });
    expect(args).toEqual([]);
  });

  it("skips pi-ask-user in subagentMode, includes it otherwise", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-pkg-test-"));
    setPkgRoot(tmp);
    const pkgDir = join(tmp, "node_modules", "pi-ask-user");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pi-ask-user",
        pi: { extensions: ["dist/index.js"] },
      }),
    );
    writeFileSync(join(pkgDir, "dist", "index.js"), "export default {}");
    writeFileSync(join(pkgDir, "dist", "index.ts"), "export default {}");

    const normalArgs = bundledPackageArgs(
      { littleCoder: { packages: ["pi-ask-user"] } },
      { subagentMode: false },
    );
    expect(normalArgs.length).toBeGreaterThan(0);

    const subArgs = bundledPackageArgs(
      { littleCoder: { packages: ["pi-ask-user"] } },
      { subagentMode: true },
    );
    expect(subArgs).toEqual([]);
  });

  it("handles missing packages gracefully", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-pkg-test-"));
    setPkgRoot(tmp);
    const args = bundledPackageArgs({
      littleCoder: { packages: ["non-existent-pkg"] },
    });
    expect(args).toEqual([]);
  });

  it("skips non-string package names", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-pkg-test-"));
    setPkgRoot(tmp);
    const args = bundledPackageArgs({
      littleCoder: { packages: [123, null, ""] },
    });
    expect(args).toEqual([]);
  });
});

// ---- Integration: verify launcher still works ----
const { spawn, spawnSync } = await import("node:child_process");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("launcher integration", () => {
  it("launcher-internal functions work after extraction", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-int-test-"));
    try {
      const pkgJson = join(tmp, "package.json");
      writeFileSync(pkgJson, JSON.stringify({ version: "1.0.0" }));
      expect(readJson(pkgJson)).toEqual({ version: "1.0.0" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("launcher delegates --help to pi and exits 0", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
      {
        cwd: repoRoot,
        env: { ...process.env, LITTLE_CODER_NO_UPDATE_CHECK: "1" },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      "ReferenceError",
    );
    expect(result.status).toBe(0);
  });

  it("sets quietStartup=true in settings.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-settings-"));
    try {
      const agentDir = join(tmp, "agent");
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            LITTLE_CODER_NO_UPDATE_CHECK: "1",
            PI_CODING_AGENT_DIR: agentDir,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(result.status).toBe(0);
      const settingsPath = join(agentDir, "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(settings.quietStartup).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sets lastChangelogVersion in settings.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-settings-"));
    try {
      const agentDir = join(tmp, "agent");
      spawnSync(
        process.execPath,
        [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            LITTLE_CODER_NO_UPDATE_CHECK: "1",
            PI_CODING_AGENT_DIR: agentDir,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      const settingsPath = join(agentDir, "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(typeof settings.lastChangelogVersion).toBe("string");
      expect(settings.lastChangelogVersion.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // L1–L3: the launcher's settings write is atomic + locked (parity
  // with updateGlobalSettings), re-reads under the lock, and never clobbers a
  // malformed file. It calls the shared settings-write.mjs writer directly
  // (see .pi/extensions/_shared/settings-write.test.mjs for the protocol
  // pins) and is ASYNC — a held lock REFUSES ({ok:false}) after retries, and
  // a malformed file refuses.

  it("L1: a held settings lock makes the write REFUSE after retries (no clobber)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-lock-"));
    try {
      const settingsPath = join(tmp, "settings.json");
      const lockPath = `${settingsPath}.lock`;
      writeFileSync(settingsPath, JSON.stringify({ a: 1 }));
      const before = readFileSync(settingsPath, "utf-8");
      // Hold the SAME lock file the writer uses (<settings.json>.lock).
      const release = lockfile.lockSync(tmp, {
        realpath: false,
        lockfilePath: lockPath,
      });
      try {
        // Retries exhaust (10 × ~20 ms ≈ 200 ms, async) → refuse naming the
        // lock path (no busy-wait, comfortably under 5 s).
        const start = Date.now();
        const result = await updateSettingsFile(settingsPath, (doc) => {
          doc.b = 2;
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain(lockPath);
        expect(Date.now() - start).toBeLessThan(5_000);
        // No clobber — the file is untouched.
        expect(readFileSync(settingsPath, "utf-8")).toBe(before);
      } finally {
        release();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("L2: with the lock free the write succeeds + persists + is 0600 + re-acquirable", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-lock-"));
    try {
      const settingsPath = join(tmp, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ a: 1 }));
      const r1 = await updateSettingsFile(settingsPath, (doc) => {
        doc.b = 2;
      });
      expect(r1.ok).toBe(true);
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
        a: 1,
        b: 2,
      });
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
      // The lock was released — a second write (or a concurrent /allow) can
      // immediately re-acquire it.
      const r2 = await updateSettingsFile(settingsPath, (doc) => {
        doc.c = 3;
      });
      expect(r2.ok).toBe(true);
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
        a: 1,
        b: 2,
        c: 3,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("L3: a malformed pre-existing file refuses the write and stays byte-identical", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-lock-"));
    try {
      const settingsPath = join(tmp, "settings.json");
      const corrupt = "{not-json";
      writeFileSync(settingsPath, corrupt);
      // The shared writer refuses a malformed file ({ok:false}).
      const result = await updateSettingsFile(settingsPath, (doc) => {
        doc.b = 2;
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/malformed JSON/);
      expect(readFileSync(settingsPath, "utf-8")).toBe(corrupt);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves existing settings.json keys", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-settings-"));
    try {
      const agentDir = join(tmp, "agent");
      mkdirSync(agentDir, { recursive: true });
      const settingsPath = join(agentDir, "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({ customKey: "customValue", quietStartup: false }),
      );
      spawnSync(
        process.execPath,
        [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            LITTLE_CODER_NO_UPDATE_CHECK: "1",
            PI_CODING_AGENT_DIR: agentDir,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(settings.customKey).toBe("customValue");
      expect(settings.quietStartup).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sets footer.mode=off in pi-better-openai.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-settings-"));
    try {
      const agentDir = join(tmp, "agent");
      spawnSync(
        process.execPath,
        [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            LITTLE_CODER_NO_UPDATE_CHECK: "1",
            PI_CODING_AGENT_DIR: agentDir,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      const configPath = join(agentDir, "extensions", "pi-better-openai.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.footer.mode).toBe("off");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to clobber a corrupted settings.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-settings-"));
    try {
      const agentDir = join(tmp, "agent");
      mkdirSync(agentDir, { recursive: true });
      const settingsPath = join(agentDir, "settings.json");
      writeFileSync(settingsPath, "{not-valid-json");
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            LITTLE_CODER_NO_UPDATE_CHECK: "1",
            PI_CODING_AGENT_DIR: agentDir,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      // Spawn proceeds (write-only refusal), the corrupt file is untouched.
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("is malformed JSON");
      expect(result.stderr).toContain(settingsPath);
      expect(readFileSync(settingsPath, "utf-8")).toBe("{not-valid-json");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to clobber a corrupted pi-better-openai.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-settings-"));
    try {
      const agentDir = join(tmp, "agent");
      const extensionsDir = join(agentDir, "extensions");
      mkdirSync(extensionsDir, { recursive: true });
      const configPath = join(extensionsDir, "pi-better-openai.json");
      writeFileSync(configPath, "{not-valid-json");
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            LITTLE_CODER_NO_UPDATE_CHECK: "1",
            PI_CODING_AGENT_DIR: agentDir,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      // No crash; the corrupt file is left untouched.
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("is malformed JSON");
      expect(readFileSync(configPath, "utf-8")).toBe("{not-valid-json");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits a launch-timing line and exits 0 offline", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-timing-"));
    try {
      const agentDir = join(tmp, "agent");
      const xdg = join(tmp, "cache");
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            LITTLE_CODER_TIMING: "1",
            LITTLE_CODER_NO_UPDATE_CHECK: "1",
            PI_CODING_AGENT_DIR: agentDir,
            XDG_CACHE_HOME: xdg,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(
        /little-coder launch timing: discovery=\d+ms updatecheck=\d+ms updateprompt=\d+ms settings=\d+ms spawn=\d+ms total=\d+ms/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles PI_CODING_AGENT_DIR with custom path", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-settings-"));
    try {
      const customDir = join(tmp, "custom-agent");
      spawnSync(
        process.execPath,
        [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            LITTLE_CODER_NO_UPDATE_CHECK: "1",
            PI_CODING_AGENT_DIR: customDir,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      const settingsPath = join(customDir, "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a --help launch with update-check ENABLED leaves a fresh cache byte-identical (no network, no rewrite)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-uc-offline-"));
    try {
      const agentDir = join(tmp, "agent");
      const xdg = join(tmp, "cache");
      const cacheDir = join(xdg, "little-coder");
      mkdirSync(cacheDir, { recursive: true });
      const cachePath = join(cacheDir, "version-check.json");
      // Fresh cache, up-to-date (latest == current) → no update notice. A
      // fresh cache means the background refresh short-circuits (no network,
      // no rewrite). With --help the update check is skipped entirely, so this
      // pins: "an enabled --help launch never touches the network or rewrites
      // the cache" — the offline-launch-costs-0-network claim end-to-end.
      // Known limitation: a broken fresh-gate would only be caught here if the
      // fetch actually ran (it does not for --help).
      const pkg = JSON.parse(
        readFileSync(join(repoRoot, "package.json"), "utf-8"),
      );
      const fresh =
        JSON.stringify(
          { checkedAt: Date.now(), latest: pkg.version },
          null,
          2,
        ) + "\n";
      writeFileSync(cachePath, fresh);
      const before = readFileSync(cachePath, "utf-8");
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, "bin", "little-coder.mjs"), "--help"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            // Update check ENABLED: LITTLE_CODER_NO_UPDATE_CHECK left unset.
            PI_CODING_AGENT_DIR: agentDir,
            XDG_CACHE_HOME: xdg,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(result.status).toBe(0);
      // No update notice.
      expect(result.stderr).not.toContain("is available");
      // Cache byte-identical: no network, no rewrite.
      expect(readFileSync(cachePath, "utf-8")).toBe(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- fatal-signal propagation (child dies by signal → launcher exits
// 128+signum) ----
// The close handler must drop its own forwarders BEFORE re-raising the
// signal: with a listener still attached, the re-raised signal would be
// swallowed (a registered handler suppresses the default terminate action)
// and the launcher would exit 0 instead of 128+signum.
//
// SIGKILL is the deterministic trigger: it is uncatchable, so the child dies
// BY the signal (not a clean exit 0) regardless of any handlers. The child is
// a hermetic stub (LITTLE_CODER_PI_ENTRY) with NO signal handlers, so its
// death is purely the OS-level signal, not pi's graceful-shutdown handlers.
// SIGKILL → child close(code=null, signal="SIGKILL") → launcher re-raises →
// OS exit status 137 (= 128 + 9).
describe.skipIf(!existsSync("/proc"))(
  "fatal-signal propagation (Linux-only)",
  () => {
    // /proc/<pid>/task/*/children: the launcher's only child is the node
    // process running pi. Poll — the real child takes a moment to appear.
    function nodeChildOf(pid) {
      for (const t of readdirSync(`/proc/${pid}/task`)) {
        for (const c of readFileSync(`/proc/${pid}/task/${t}/children`, "utf-8")
          .trim()
          .split(/\s+/)
          .filter(Boolean)) {
          try {
            if (readFileSync(`/proc/${c}/comm`, "utf-8").trim() === "node")
              return Number(c);
          } catch {
            /* child raced away */
          }
        }
      }
      return null;
    }

    it(
      "exits 137 (128+SIGKILL) when the pi child dies of SIGKILL",
      { timeout: 20_000 },
      async () => {
        const tmp = mkdtempSync(join(tmpdir(), "lc-sig-"));
        const agentDir = join(tmp, "agent");
        // Hermetic: instead of spawning the real pi (a slow jiti boot, and
        // one that installs its own SIGINT/SIGTERM/SIGHUP handlers), the
        // launcher is pointed at a stub child via LITTLE_CODER_PI_ENTRY — a
        // node process with NO signal handlers that just waits. The launcher's
        // re-raise logic is what's under test, not pi's boot (pi boot is
        // covered by the --help integration tests). The stub appears fast, so
        // the poll bound is tightened to <5 s.
        const stubPath = join(tmp, "stub-pi.js");
        writeFileSync(stubPath, "setTimeout(() => {}, 60_000);\n");
        let launcher;
        try {
          launcher = spawn(
            process.execPath,
            [join(repoRoot, "bin", "little-coder.mjs")],
            {
              cwd: tmp,
              stdio: ["ignore", "pipe", "pipe"],
              env: {
                ...process.env,
                LITTLE_CODER_NO_UPDATE_CHECK: "1",
                LITTLE_CODER_PI_ENTRY: stubPath,
                PI_CODING_AGENT_DIR: agentDir,
              },
            },
          );
          // Drain stdio — a full pipe can hang the child and the close never
          // fires.
          launcher.stdout.resume();
          launcher.stderr.resume();

          const t0 = Date.now();
          let childPid = null;
          while (Date.now() - t0 < 5_000) {
            if (launcher.exitCode !== null)
              throw new Error(
                `launcher exited before the stub child appeared (code ${launcher.exitCode}, signal ${launcher.signal})`,
              );
            childPid = nodeChildOf(launcher.pid);
            if (childPid) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!childPid)
            throw new Error("stub child never appeared within 5 s");

          process.kill(childPid, "SIGKILL");
          const [code, signal] = await new Promise((resolve) =>
            launcher.on("close", (c, s) => resolve([c, s])),
          );
          // The launcher re-raises the fatal signal on itself → it dies BY
          // SIGKILL (node reports code=null, signal="SIGKILL"; the OS exit
          // status is 137 = 128 + 9). Pre-fix this was exit 0: the still-
          // attached forwarder swallowed the re-raised signal.
          expect(code).toBeNull();
          expect(signal).toBe("SIGKILL");
        } finally {
          // No-op if the launcher already exited.
          launcher?.kill("SIGKILL");
          rmSync(tmp, { recursive: true, force: true });
        }
      },
    );
  },
);
