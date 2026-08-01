import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
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
} from "./launcher-internal.mjs";

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
const { spawnSync } = await import("node:child_process");
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

  it("handles corrupted settings.json gracefully", () => {
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
      expect(result.status).toBe(0);
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(settings.quietStartup).toBe(true);
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
});
