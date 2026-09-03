import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  allowBashPrefix,
  bashBlockReason,
  BASH_ALLOW_GLOBAL_KEY,
  buildBashAllow,
  canonicalRepoKey,
  clearBashAllowCache,
  denyBashPrefix,
  ensureBashAllowLoaded,
  _getBashAllowCacheKeysForTests,
  getExternalWorkspaceAccess,
  _getLoadedBashAllowPrefixesForTests,
  _getLoadedBashAllowRepoPrefixCountForTests,
  _getLoadedSafePrefixesForTests,
  getSafePrefixes,
  hasParentTraversal,
  isNoopCd,
  isSafeBash,
  isWithinWorkspace,
  normalizeAllowPrefix,
  parseBashAllow,
  parseExtraPrefixes,
  resolveWorkspacePath,
  sanitizeBashAllowEntries,
  scanBashSegments,
  splitGlobalFlag,
} from "./index.ts";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

describe("isSafeBash", () => {
  it("allows whitelisted read-only commands", () => {
    expect(isSafeBash("ls -la")).toBe(true);
    expect(isSafeBash("cat /etc/hosts")).toBe(true);
    expect(isSafeBash("git log --oneline")).toBe(true);
    expect(isSafeBash("grep -r pattern .")).toBe(true);
    expect(isSafeBash("rg pattern src/")).toBe(true);
    expect(isSafeBash("sed -n '1,20p' file.ts")).toBe(true);
    // file inspection
    expect(isSafeBash("file src/main.ts")).toBe(true);
    expect(isSafeBash("stat /tmp/output")).toBe(true);
    expect(isSafeBash("sha256sum Cargo.lock")).toBe(true);
    expect(isSafeBash("md5sum dist/bundle.js")).toBe(true);
    expect(isSafeBash("diff a.txt b.txt")).toBe(true);
  });
  it("allows routine filesystem scaffolding (cp/mv/mkdir/touch/rmdir)", () => {
    expect(isSafeBash("cp a b")).toBe(true);
    expect(isSafeBash("mv old new")).toBe(true);
    expect(isSafeBash("mkdir -p sub/dir")).toBe(true);
    expect(isSafeBash("touch foo.md")).toBe(true);
    expect(isSafeBash("rmdir empty_dir")).toBe(true);
  });
  it("preserves trailing-whitespace word boundary on fs prefixes", () => {
    expect(isSafeBash("cpufetch")).toBe(false);
    expect(isSafeBash("mvtool")).toBe(false);
    expect(isSafeBash("mkdiroops")).toBe(false);
    expect(isSafeBash("touchscreen")).toBe(false);
    // new space-prefixed entries also enforce word boundaries
    expect(isSafeBash("difficult")).toBe(false);
    expect(isSafeBash("filetool")).toBe(false);
    expect(isSafeBash("stattool")).toBe(false);
    // no-space prefixes (like ls, tsc, pytest, jest) have no word boundary
    // this is consistent with the existing behavior of ls/cat/etc.
  });
  it("allows npm/npx test diagnostics", () => {
    expect(isSafeBash("npm test")).toBe(true);
    expect(
      isSafeBash("npm test -- .pi/extensions/compatibility/heuristics.test.ts"),
    ).toBe(true);
    expect(isSafeBash("npm run test -- --runInBand")).toBe(true);
    expect(
      isSafeBash(
        "npx vitest run .pi/extensions/compatibility/heuristics.test.ts",
      ),
    ).toBe(true);
    expect(isSafeBash("npx --yes vitest run permission.test.ts")).toBe(true);
    expect(isSafeBash("npx skills --help")).toBe(true);
    expect(isSafeBash("npx skills find code-review")).toBe(true);
    expect(
      isSafeBash(
        "npm test -- --run .pi/extensions/permission-gate/permission.test.ts && npm run typecheck",
      ),
    ).toBe(true);
  });
  it("blocks non-whitelisted commands", () => {
    expect(isSafeBash("rm -rf /")).toBe(false);
    expect(isSafeBash("npm install foo")).toBe(false);
    expect(isSafeBash("sudo anything")).toBe(false);
  });
  it("handles leading whitespace", () => {
    expect(isSafeBash("   ls")).toBe(true);
  });
  it("git subcommand gating allows read-only and staging, blocks push and destructive writes", () => {
    expect(isSafeBash("git log")).toBe(true);
    // Staging / committing is intentionally allowed (see the "Git write" safe
    // prefixes); only push (and other remote/network writes) is blocked.
    expect(isSafeBash("git add x")).toBe(true);
    expect(isSafeBash("git commit -m x")).toBe(true);
    expect(isSafeBash("git push origin main")).toBe(false);
    // Destructive / history-rewriting local writes stay blocked.
    expect(isSafeBash("git reset --hard HEAD~1")).toBe(false);
    expect(isSafeBash("git checkout other-branch")).toBe(false);
    expect(isSafeBash("git stash pop")).toBe(false);
    expect(isSafeBash("git push --force origin main")).toBe(false);
    // Word-boundary convention: the `git commit ` prefix must not substring-
    // match a longer subcommand token (a bare `startsWith` would allow it).
    expect(isSafeBash("git commitXYZ")).toBe(false);
    expect(isSafeBash("git addXYZ")).toBe(false);
  });
  it("respects an explicit prefix list (LITTLE_CODER_BASH_ALLOW shape)", () => {
    const extra = ["make ", "docker compose ps"];
    expect(isSafeBash("make test", extra)).toBe(true);
    expect(isSafeBash("docker compose ps", extra)).toBe(true);
    expect(isSafeBash("docker compose down", extra)).toBe(false);
  });
  it("allows compilers and test runners", () => {
    expect(isSafeBash("tsc")).toBe(true);
    expect(isSafeBash("tsc --noEmit")).toBe(true);
    expect(isSafeBash("pytest tests/")).toBe(true);
    expect(isSafeBash("pytest -v test_main.py")).toBe(true);
    expect(isSafeBash("jest")).toBe(true);
    expect(isSafeBash("jest --coverage src/")).toBe(true);
    expect(isSafeBash("cargo build")).toBe(true);
    expect(isSafeBash("cargo build --release")).toBe(true);
  });
  it("allows safe stderr redirections (2>/dev/null and 2>&1)", () => {
    // stderr-only redirects are stripped before the control operator check
    expect(isSafeBash("cargo check 2>/dev/null")).toBe(true);
    expect(isSafeBash("cargo test 2>/dev/null")).toBe(true);
    expect(isSafeBash("cargo check 2>&1")).toBe(true);
    expect(isSafeBash("cargo test 2>&1")).toBe(true);
    expect(isSafeBash("cargo build 2>/dev/null")).toBe(true);
    expect(isSafeBash("tsc --noEmit 2>/dev/null")).toBe(true);
    expect(isSafeBash("pytest tests/ 2>&1")).toBe(true);
    // still blocks dangerous redirects
    expect(isSafeBash("cat /etc/passwd > /tmp/leaked")).toBe(false);
    expect(isSafeBash("ls 1>output.txt")).toBe(false);
  });
  it("blocks awk and timeout which can execute arbitrary commands", () => {
    expect(isSafeBash("awk '{print}' file.txt")).toBe(false);
    expect(isSafeBash("timeout 30 npm test")).toBe(false);
    expect(isSafeBash("timeout 10 ls")).toBe(false);
  });
  it("allows path utilities and text processing commands", () => {
    expect(isSafeBash("basename /path/to/file.txt")).toBe(true);
    expect(isSafeBash("dirname /path/to/file.txt")).toBe(true);
    expect(isSafeBash("realpath ./file.txt")).toBe(true);
    expect(isSafeBash("readlink /proc/self/exe")).toBe(true);
    expect(isSafeBash("cut -d, -f1 data.csv")).toBe(true);
    expect(isSafeBash("sort file.txt")).toBe(true);
    expect(isSafeBash("uniq file.txt")).toBe(true);
    expect(isSafeBash("tr 'A-Z' 'a-z' file.txt")).toBe(true);
    expect(isSafeBash("comm file1.txt file2.txt")).toBe(true);
  });
  it("allows quoted metacharacters in arguments (grep patterns etc.)", () => {
    // `|`, `&`, `;`, `$` inside quotes are literals, not shell operators
    expect(isSafeBash('grep -E "foo|bar" file.txt')).toBe(true);
    expect(isSafeBash("grep -E 'foo|bar' file.txt")).toBe(true);
    expect(isSafeBash("grep -n 'a;b' file.txt")).toBe(true);
    expect(isSafeBash("grep -n 'a&b' file.txt")).toBe(true);
    expect(isSafeBash("grep '\\$HOME' script.sh")).toBe(true);
    expect(isSafeBash('grep "a && b" file.txt')).toBe(true);
    expect(isSafeBash('echo "hello && world"')).toBe(true);
  });
  it("allows && chains, || fallbacks, and | pipelines where every segment is safe", () => {
    expect(isSafeBash("grep -rn foo . | head -20")).toBe(true);
    expect(isSafeBash("ls -la && git status")).toBe(true);
    expect(isSafeBash("git log --oneline | head -5")).toBe(true);
    expect(isSafeBash("grep foo bar && grep baz qux")).toBe(true);
    expect(isSafeBash("cat a.txt | sort | uniq")).toBe(true);
    expect(isSafeBash("npm test | tail -10")).toBe(true);
    // `A || B` can only run the listed safe segments (same as `&&`)
    expect(isSafeBash("grep foo || echo hi")).toBe(true);
    expect(
      isSafeBash(
        "cargo clippy --all-targets 2>&1 | grep -i supply || echo none",
      ),
    ).toBe(true);
  });
  it("blocks chains and pipelines containing unsafe segments", () => {
    expect(isSafeBash("grep foo | rm -rf /")).toBe(false);
    expect(isSafeBash("ls && rm -rf .")).toBe(false);
    expect(isSafeBash("ls || rm -rf /")).toBe(false);
    expect(isSafeBash("rm -rf / || ls")).toBe(false);
    expect(isSafeBash("grep foo ; ls")).toBe(false);
    expect(isSafeBash("ls |")).toBe(false);
    expect(isSafeBash('grep "$(ls)" file.txt')).toBe(false);
    // escaped metacharacters do not smuggle operators through
    expect(isSafeBash("find . -exec rm {} \\;")).toBe(false);
  });
  it("allows cd chains only when the remainder is safe (with cwd)", () => {
    const cwd = "/home/me/proj";
    expect(isSafeBash("cd . && grep -E 'a|b' . | head", undefined, cwd)).toBe(
      true,
    );
    expect(isSafeBash("cd subdir && ls -la", undefined, cwd)).toBe(true);
    expect(isSafeBash("cd subdir ; ls -la", undefined, cwd)).toBe(true);
    expect(isSafeBash("cd /home/me/proj && git status", undefined, cwd)).toBe(
      true,
    );
    // the old isNoopCd early-return let these bypass the whitelist
    expect(isSafeBash("cd subdir && rm -rf .", undefined, cwd)).toBe(false);
    expect(isSafeBash("cd . ; rm -rf /", undefined, cwd)).toBe(false);
    expect(isSafeBash("cd $(rm -rf /) && ls", undefined, cwd)).toBe(false);
    expect(isSafeBash("cd /tmp && ls", undefined, cwd)).toBe(false);
  });
});

describe("scanBashSegments", () => {
  it("splits on top-level && and | but not inside quotes", () => {
    expect(scanBashSegments("ls -la && git status")).toEqual([
      "ls -la",
      "git status",
    ]);
    expect(scanBashSegments("grep foo | head -5")).toEqual([
      "grep foo",
      "head -5",
    ]);
    expect(scanBashSegments('grep -E "a|b" file.txt')).toEqual([
      "grep -E a|b file.txt",
    ]);
    expect(scanBashSegments("grep -E 'a&&b' file.txt")).toEqual([
      "grep -E a&&b file.txt",
    ]);
    expect(scanBashSegments("cd subdir && ls")).toEqual(["cd subdir", "ls"]);
  });
  it("splits on top-level || like &&", () => {
    expect(scanBashSegments("grep foo || echo hi")).toEqual([
      "grep foo",
      "echo hi",
    ]);
    expect(scanBashSegments("ls || grep foo | head -5")).toEqual([
      "ls",
      "grep foo",
      "head -5",
    ]);
  });
  it("rejects control operators outside quotes", () => {
    expect(scanBashSegments("ls ; rm -rf /")).toBeNull();
    expect(scanBashSegments("ls |")).toBeNull();
    expect(scanBashSegments("grep foo & echo hi")).toBeNull();
    expect(scanBashSegments('echo "$(ls)"')).toBeNull();
    expect(scanBashSegments("echo `ls`")).toBeNull();
    expect(scanBashSegments("ls > out.txt")).toBeNull();
  });
});

describe("bashBlockReason", () => {
  const cwd = "/home/me/proj";
  it("returns null for safe commands", () => {
    expect(bashBlockReason("ls -la")).toBeNull();
    expect(bashBlockReason("grep foo | head -5")).toBeNull();
    expect(bashBlockReason("cd subdir && ls", undefined, cwd)).toBeNull();
  });
  it("names the failing segment instead of the first token", () => {
    expect(bashBlockReason("grep foo | rm -rf /")).toContain("rm -rf /");
    expect(bashBlockReason("ls -la && rm -rf .")).toContain("rm -rf .");
    expect(bashBlockReason("cd subdir && rm -rf .", undefined, cwd)).toContain(
      "rm -rf .",
    );
  });
  it("keeps the standard advisory suffix", () => {
    expect(bashBlockReason("sudo rm -rf /")).toContain(
      "Ask the user to execute this command instead.",
    );
  });
  it("names the forbidden shell operator instead of the first token", () => {
    expect(bashBlockReason("ls ; rm -rf /")).toContain('";"');
    expect(bashBlockReason("grep $(ls) x")).toContain('"$"');
    expect(bashBlockReason("ls > out.txt")).toContain('">"');
    expect(bashBlockReason("ls & echo hi")).toContain('"&"');
    // a failing || chain must blame the unsafe segment, not the first command
    expect(bashBlockReason("cargo clippy 2>&1 | grep x || rm -rf /")).toContain(
      "rm -rf /",
    );
  });
});

describe("parseExtraPrefixes", () => {
  it("returns empty for undefined / empty / whitespace", () => {
    expect(parseExtraPrefixes(undefined)).toEqual([]);
    expect(parseExtraPrefixes("")).toEqual([]);
    expect(parseExtraPrefixes("   ")).toEqual([]);
  });
  it("splits on comma and trims leading whitespace, preserving trailing space as word boundary", () => {
    expect(parseExtraPrefixes("make , docker compose ps,  bun run")).toEqual([
      "make ",
      "docker compose ps",
      "bun run",
    ]);
  });
  it("drops empty / whitespace-only segments", () => {
    expect(parseExtraPrefixes("a,,b,")).toEqual(["a", "b"]);
    expect(parseExtraPrefixes("a,   ,b")).toEqual(["a", "b"]);
  });
});

describe("isNoopCd", () => {
  const cwd = process.cwd();

  it("allows cd when target resolves to cwd", () => {
    expect(isNoopCd("cd .", cwd)).toBe(true);
    expect(isNoopCd("cd ./", cwd)).toBe(true);
    expect(isNoopCd("cd", homedir())).toBe(true);
  });

  it("allows cd to a subdirectory of cwd", () => {
    expect(isNoopCd("cd subdir", cwd)).toBe(true);
    expect(isNoopCd("cd sub/dir", cwd)).toBe(true);
    expect(isNoopCd("cd ./sub", cwd)).toBe(true);
  });

  it("allows cd with the full cwd path", () => {
    expect(isNoopCd(`cd ${cwd}`, cwd)).toBe(true);
  });

  it("allows cd with ~ when ~ resolves to cwd", () => {
    if (cwd === homedir()) {
      expect(isNoopCd("cd ~", cwd)).toBe(true);
      expect(isNoopCd("cd ~/", cwd)).toBe(true);
    }
  });

  it("allows cd with chained && when target resolves to cwd", () => {
    expect(isNoopCd("cd . && ls -la", cwd)).toBe(true);
    expect(isNoopCd("cd ./ && echo hi", cwd)).toBe(true);
  });

  it("blocks cd when target does not resolve to cwd", () => {
    expect(isNoopCd("cd /", cwd)).toBe(false);
    expect(isNoopCd("cd /tmp", cwd)).toBe(false);
    expect(isNoopCd("cd ..", cwd)).toBe(false);
    expect(isNoopCd("cd /etc", cwd)).toBe(false);
  });

  it("blocks cd with ~ when ~ does not resolve to cwd", () => {
    if (cwd !== homedir()) {
      expect(isNoopCd("cd ~", cwd)).toBe(false);
      expect(isNoopCd("cd ~/", cwd)).toBe(false);
    }
  });

  it("returns false for non-cd commands", () => {
    expect(isNoopCd("ls -la", cwd)).toBe(false);
    expect(isNoopCd("scd foo", cwd)).toBe(false);
  });

  it("handles leading whitespace", () => {
    expect(isNoopCd("   cd .", cwd)).toBe(true);
    expect(isNoopCd("   cd /tmp", cwd)).toBe(false);
  });

  it("handles semicolons as chain separators", () => {
    expect(isNoopCd("cd . ; ls", cwd)).toBe(true);
    expect(isNoopCd("cd /tmp ; ls", cwd)).toBe(false);
  });
});

describe("workspace path helpers", () => {
  const cwd = "/home/me/proj";

  it("resolves relative and home paths", () => {
    expect(resolveWorkspacePath("src/file.ts", cwd)).toBe(
      "/home/me/proj/src/file.ts",
    );
    expect(resolveWorkspacePath("/tmp/x", cwd)).toBe("/tmp/x");
    expect(resolveWorkspacePath("~/notes.txt", cwd)).toBe(
      `${homedir()}/notes.txt`,
    );
  });

  it("detects paths within workspace", () => {
    expect(isWithinWorkspace(cwd, cwd)).toBe(true);
    expect(isWithinWorkspace(cwd, "/home/me/proj/src")).toBe(true);
    expect(isWithinWorkspace(cwd, "/home/me/other")).toBe(false);
    expect(isWithinWorkspace(cwd, "/home/me")).toBe(false);
  });

  it("detects parent traversal patterns", () => {
    expect(hasParentTraversal("../secret.txt")).toBe(true);
    expect(hasParentTraversal("src/**/../*.ts")).toBe(true);
    expect(hasParentTraversal("src/**/*.ts")).toBe(false);
  });
});

describe("getExternalWorkspaceAccess", () => {
  const cwd = "/home/me/proj";

  it("ignores in-workspace read/edit/write", () => {
    expect(
      getExternalWorkspaceAccess("read", { path: "README.md" }, cwd),
    ).toBeNull();
    expect(
      getExternalWorkspaceAccess("edit", { path: "src/app.ts" }, cwd),
    ).toBeNull();
    expect(
      getExternalWorkspaceAccess("write", { path: "notes/plan.md" }, cwd),
    ).toBeNull();
  });

  it("flags external read/edit/write", () => {
    expect(
      getExternalWorkspaceAccess("read", { path: "../secret.txt" }, cwd),
    ).toEqual({
      summary: "/home/me/secret.txt",
    });
    expect(
      getExternalWorkspaceAccess("edit", { path: "/tmp/config.ini" }, cwd),
    ).toBeNull();
    expect(
      getExternalWorkspaceAccess("write", { path: "/etc/hosts" }, cwd),
    ).toEqual({
      summary: "/etc/hosts",
    });
  });

  it("flags external grep and findRead base paths and traversal patterns", () => {
    expect(getExternalWorkspaceAccess("grep", { path: "../" }, cwd)).toEqual({
      summary: "/home/me",
    });
    expect(
      getExternalWorkspaceAccess(
        "findRead",
        { path: "../", pattern: "*.ts" },
        cwd,
      ),
    ).toEqual({
      summary: "/home/me",
    });
    expect(
      getExternalWorkspaceAccess("findRead", { pattern: "../*.ts" }, cwd),
    ).toEqual({
      summary: "/home/me/proj (pattern escapes base: ../*.ts)",
    });
  });

  it("allows trusted bash temp output files outside workspace", () => {
    const tmp = tmpdir();
    expect(
      getExternalWorkspaceAccess(
        "read",
        { path: `${tmp}/pi-bash-abc123.log` },
        cwd,
      ),
    ).toBeNull();
    expect(
      getExternalWorkspaceAccess(
        "findRead",
        { path: tmp, pattern: "pi-bash-*.log" },
        cwd,
      ),
    ).toBeNull();
  });

  it("allows broad temp files outside workspace", () => {
    const tmp = tmpdir();
    expect(
      getExternalWorkspaceAccess("read", { path: `${tmp}/notes.txt` }, cwd),
    ).toBeNull();
    expect(
      getExternalWorkspaceAccess(
        "findRead",
        { path: tmp, pattern: "*.log" },
        cwd,
      ),
    ).toBeNull();
  });
});

describe("getSafePrefixes", () => {
  it("merges builtins with LITTLE_CODER_BASH_ALLOW from the env", () => {
    const prev = process.env.LITTLE_CODER_BASH_ALLOW;
    process.env.LITTLE_CODER_BASH_ALLOW = "make ,docker compose ps";
    try {
      const all = getSafePrefixes();
      expect(all).toContain("ls");
      expect(all).toContain("make ");
      expect(all).toContain("docker compose ps");
    } finally {
      if (prev === undefined) delete process.env.LITTLE_CODER_BASH_ALLOW;
      else process.env.LITTLE_CODER_BASH_ALLOW = prev;
    }
  });
});

// Item 2: little_coder.bash_allow in the existing pi settings files
// (per-user <agentDir>/settings.json always; per-repo <cwd>/.pi/settings.json
// only when the project is trusted), union-merged with builtins + env.
describe("bash allowlist from settings files (little_coder.bash_allow)", () => {
  let agentDir: string;
  let pkgRoot: string;
  let projectCwd: string;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;
  const prevEnv = process.env.LITTLE_CODER_BASH_ALLOW;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pg-agent-"));
    pkgRoot = mkdtempSync(join(tmpdir(), "pg-pkg-")); // empty: no shadowing
    projectCwd = mkdtempSync(join(tmpdir(), "pg-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot;
    if (prevEnv === undefined) delete process.env.LITTLE_CODER_BASH_ALLOW;
    clearBashAllowCache();
  });

  afterEach(() => {
    clearBashAllowCache();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    if (prevEnv === undefined) delete process.env.LITTLE_CODER_BASH_ALLOW;
    else process.env.LITTLE_CODER_BASH_ALLOW = prevEnv;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  function writeGlobalSettings(obj: unknown): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(obj));
  }
  function writeProjectSettings(obj: unknown): void {
    mkdirSync(join(projectCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(projectCwd, ".pi", "settings.json"),
      JSON.stringify(obj),
    );
  }
  // trust.json keys are canonicalized (realpath) cwd paths.
  function writeTrust(decision: boolean): void {
    writeFileSync(
      join(agentDir, "trust.json"),
      JSON.stringify({ [realpathSync(projectCwd)]: decision }),
    );
  }

  it("sanitizeBashAllowEntries: keeps strings, trims leading, preserves trailing space, drops junk", () => {
    expect(
      sanitizeBashAllowEntries([
        "make ",
        "  docker compose ps",
        42,
        null,
        "",
        "   ",
        undefined,
        true,
      ]),
    ).toEqual(["make ", "docker compose ps"]);
    expect(sanitizeBashAllowEntries("not-an-array")).toEqual([]);
    expect(sanitizeBashAllowEntries(null)).toEqual([]);
    expect(sanitizeBashAllowEntries(undefined)).toEqual([]);
    expect(sanitizeBashAllowEntries({})).toEqual([]);
  });

  it("global-scope bash_allow is always honored; env + builtins still merge", () => {
    writeGlobalSettings({ little_coder: { bash_allow: ["make "] } });
    process.env.LITTLE_CODER_BASH_ALLOW = "docker compose ps";
    ensureBashAllowLoaded(projectCwd);
    const all = getSafePrefixes(_getLoadedBashAllowPrefixesForTests());
    expect(all).toContain("ls"); // builtin
    expect(all).toContain("make "); // settings (global)
    expect(all).toContain("docker compose ps"); // env
    expect(isSafeBash("make test", all)).toBe(true);
  });

  // Contract: the tests below pin the trust matrix against pi's
  // own `resolveProjectTrusted` / `findNearestTrustEntry`
  // (pi-coding-agent dist/core/trust-manager.js): stored decision beats
  // defaultProjectTrust, nearest ancestor entry wins (null entries skipped),
  // any read failure fails closed.
  it("project-scope bash_allow is honored when trust.json decision is true", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    writeTrust(true);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");
  });

  it("project-scope bash_allow is NOT honored when trust.json decision is false", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    writeTrust(false);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");
  });

  it("project-scope bash_allow is NOT honored with no trust decision (fail closed)", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    // no trust.json at all -> get(cwd) === null
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");
  });

  it("project-scope entries get a word-boundary trailing space (make → make-<space>)", () => {
    writeProjectSettings({
      little_coder: { bash_allow: ["make", "git status "] },
    });
    writeTrust(true);
    ensureBashAllowLoaded(projectCwd);
    // "make" is normalized to "make " (word boundary); an entry that
    // already ends with a space is untouched.
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("make ");
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("make");
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("git status ");
    // Matching behavior: "make -j" is allowed, "makefoo" is not.
    const safe = _getLoadedSafePrefixesForTests();
    expect(isSafeBash("make -j", safe, projectCwd)).toBe(true);
    expect(isSafeBash("makefoo", safe, projectCwd)).toBe(false);
  });

  it("defaultProjectTrust: 'always' honors project entries without a trust.json entry", () => {
    writeGlobalSettings({
      defaultProjectTrust: "always",
      little_coder: {},
    });
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");
  });

  it("defaultProjectTrust: 'never' never honors project entries (no trust entry needed)", () => {
    writeGlobalSettings({
      defaultProjectTrust: "never",
      little_coder: {},
    });
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");
  });

  it("defaultProjectTrust: 'ask' falls back to the trust.json decision", () => {
    writeGlobalSettings({
      defaultProjectTrust: "ask",
      little_coder: {},
    });
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");
    clearBashAllowCache();
    writeTrust(true);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");
  });

  it("precedence: a stored trust.json false beats defaultProjectTrust 'always'", () => {
    writeGlobalSettings({
      defaultProjectTrust: "always",
      little_coder: {},
    });
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    writeTrust(false);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");
  });

  it("precedence: a stored trust.json true beats defaultProjectTrust 'never'", () => {
    writeGlobalSettings({
      defaultProjectTrust: "never",
      little_coder: {},
    });
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    writeTrust(true);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");
  });

  it("a trusted PARENT directory honors project entries (ancestor walk)", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    // Key the trust.json entry on the project's PARENT dir (canonicalized,
    // like writeTrust does for the exact path) — ProjectTrustStore.get
    // walks ancestors, so the repo inherits the parent's trust.
    const parent = realpathSync(dirname(realpathSync(projectCwd)));
    writeFileSync(
      join(agentDir, "trust.json"),
      JSON.stringify({ [parent]: true }),
    );
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");
  });

  it("a throwing trust store fails closed without throwing", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    // trust.json is a DIRECTORY → readFileSync throws → get() throws →
    // isProjectTrustedFailClosed's catch → false.
    mkdirSync(join(agentDir, "trust.json"));
    expect(() => ensureBashAllowLoaded(projectCwd)).not.toThrow();
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");
  });

  it("keys the cache on the canonical repo key: a symlinked cwd shares one load", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    writeTrust(true);
    const link = join(tmpdir(), `pg-link-${Date.now()}-${process.pid}`);
    symlinkSync(projectCwd, link);
    try {
      ensureBashAllowLoaded(link);
      expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");
      // Mid-session edit while loaded under the link spelling: the real
      // path must hit the SAME canonical key (single load — a reload would
      // pick up the new prefix and reset the notice flags).
      writeProjectSettings({
        little_coder: { bash_allow: ["cmake ", "ninja "] },
      });
      ensureBashAllowLoaded(projectCwd);
      expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("ninja ");
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("cached safe-prefix union: env changes are honored only after a reload", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    writeTrust(true);
    ensureBashAllowLoaded(projectCwd);
    process.env.LITTLE_CODER_BASH_ALLOW = "late env prefix";
    // The union was rebuilt once at load — the late env change is not in it…
    expect(_getLoadedSafePrefixesForTests()).not.toContain("late env prefix");
    // …until a reload rebuilds it.
    clearBashAllowCache();
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedSafePrefixesForTests()).toContain("late env prefix");
  });

  it("describeStillAllowed names the project file for a trusted project", async () => {
    writeProjectSettings({ little_coder: { bash_allow: ["make "] } });
    writeTrust(true);
    // Nothing in the repo list, but the trusted project's own settings
    // keep the prefix allowed.
    const r = await denyBashPrefix("make", projectCwd);
    expect(r).toMatchObject({ ok: true, removed: false });
    expect(r.stillAllowedVia).toBe(
      "the project's .pi/settings.json (project is trusted)",
    );
  });

  it("describeStillAllowed names the diagnostic whitelist for a diagnostic chain", async () => {
    // "npm run lint && npm run typecheck" is not in any settings list and
    // no single builtin prefix covers the chain — only the chain-aware
    // built-in DIAGNOSTIC whitelist keeps it allowed, and the /deny reply
    // must name that source.
    const r = await denyBashPrefix(
      "npm run lint && npm run typecheck",
      projectCwd,
    );
    expect(r).toMatchObject({ ok: true, removed: false });
    expect(r.stillAllowedVia).toBe("the built-in diagnostic whitelist");
  });

  it("malformed bash_allow is ignored without throwing (global and project)", () => {
    writeGlobalSettings({ little_coder: { bash_allow: "make " } });
    writeProjectSettings({
      little_coder: { bash_allow: ["ok ", 5, null, "  ", "ok2", undefined] },
    });
    writeTrust(true);
    expect(() => ensureBashAllowLoaded(projectCwd)).not.toThrow();
    // project entries sanitized AND word-boundary-normalized ("ok2" →
    // "ok2 "); the string-typed global entry dropped
    expect(_getLoadedBashAllowPrefixesForTests()).toEqual(["ok ", "ok2 "]);
  });

  it("is idempotent within a session; clearBashAllowCache forces a reload", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");
    // Trust granted mid-session: cached state must not change until reload.
    writeTrust(true);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");
    clearBashAllowCache();
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");
  });
});

describe("bash allowlist cache: per-repo LRU + trust recheck", () => {
  let agentDir: string;
  let pkgRoot: string;
  let projectCwd: string;
  let otherCwd: string;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;
  const prevEnv = process.env.LITTLE_CODER_BASH_ALLOW;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pg-lru-agent-"));
    pkgRoot = mkdtempSync(join(tmpdir(), "pg-lru-pkg-"));
    projectCwd = mkdtempSync(join(tmpdir(), "pg-lru-a-"));
    otherCwd = mkdtempSync(join(tmpdir(), "pg-lru-b-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot;
    if (prevEnv === undefined) delete process.env.LITTLE_CODER_BASH_ALLOW;
    clearBashAllowCache();
  });

  afterEach(() => {
    clearBashAllowCache();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    if (prevEnv === undefined) delete process.env.LITTLE_CODER_BASH_ALLOW;
    else process.env.LITTLE_CODER_BASH_ALLOW = prevEnv;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  });

  function writeGlobalSettings(obj: unknown): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(obj));
  }
  function writeProjectSettings(cwd: string, obj: unknown): void {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(obj));
  }
  function writeTrust(cwd: string, decision: boolean): void {
    writeFileSync(
      join(agentDir, "trust.json"),
      JSON.stringify({ [realpathSync(cwd)]: decision }),
    );
  }

  it("multi-repo state is independent — repo B's load does not drop repo A's cached state or flags", () => {
    writeGlobalSettings({
      little_coder: {
        bash_allow: {
          [canonicalRepoKey(projectCwd)]: ["makea "],
          [canonicalRepoKey(otherCwd)]: ["makeb "],
        },
      },
    });
    ensureBashAllowLoaded(projectCwd); // A: loads repo prefix, repoNotified false
    // Touch B, then A again. Both stay cached; key order is plain INSERTION
    // order (the cache is an unbounded Map — re-touching A does not move its
    // key, unlike the old LRU which re-inserted on every touch).
    ensureBashAllowLoaded(otherCwd);
    ensureBashAllowLoaded(projectCwd);
    expect(_getBashAllowCacheKeysForTests()).toEqual([
      canonicalRepoKey(projectCwd),
      canonicalRepoKey(otherCwd),
    ]);
    // A's repo prefix is still visible via the last-active fast path, and
    // B's entry is intact in the cache (the old single-slot impl lost it
    // whenever the active repo changed).
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("makea ");
    ensureBashAllowLoaded(otherCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("makeb ");
    expect(_getLoadedBashAllowRepoPrefixCountForTests()).toBe(1);
    // Switch back to A: still there, no reload flicker.
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("makea ");
  });

  it("no eviction: cycling through >8 distinct repos keeps EVERY entry (unbounded Map)", () => {
    // The old LRU (max 8) evicted the oldest repo on the 9th load — the
    // eviction dropped that repo's one-time notice flags, re-firing the
    // "N prefix(es) active" notice on the next visit. The unbounded Map
    // keeps every entry, so the flags (and the stable key order) survive
    // any amount of repo cycling.
    const repos: string[] = [];
    for (let i = 0; i < 12; i++)
      repos.push(mkdtempSync(join(tmpdir(), `pg-unb-r${i}-`)));
    try {
      for (const c of repos) ensureBashAllowLoaded(c);
      // All 12 distinct repos stay cached — nothing was evicted.
      const keys = _getBashAllowCacheKeysForTests();
      expect(keys).toHaveLength(12);
      for (let i = 0; i < 12; i++)
        expect(keys).toContain(canonicalRepoKey(repos[i]));
      // Revisiting the FIRST repo after the cycling still serves its state
      // (no reload flicker that would reset its notice flags).
      ensureBashAllowLoaded(repos[0]);
      expect(_getBashAllowCacheKeysForTests()).toHaveLength(12);
    } finally {
      for (const c of repos) rmSync(c, { recursive: true, force: true });
    }
  });

  it("insertion-ordered keys: re-touching a repo does not move its key (no LRU churn)", () => {
    const repos: string[] = [];
    for (let i = 0; i < 3; i++)
      repos.push(mkdtempSync(join(tmpdir(), `pg-ins-r${i}-`)));
    try {
      ensureBashAllowLoaded(repos[0]); // A
      ensureBashAllowLoaded(repos[1]); // B
      ensureBashAllowLoaded(repos[2]); // C
      // Re-touch A: with the old LRU this re-inserted A at the tail
      // (order B→C→A); the plain Map keeps insertion order A→B→C.
      ensureBashAllowLoaded(repos[0]);
      expect(_getBashAllowCacheKeysForTests()).toEqual([
        canonicalRepoKey(repos[0]),
        canonicalRepoKey(repos[1]),
        canonicalRepoKey(repos[2]),
      ]);
    } finally {
      for (const c of repos) rmSync(c, { recursive: true, force: true });
    }
  });

  it("revoked trust mid-session stops auto-approval on the next touch (one-way)", () => {
    writeProjectSettings(projectCwd, {
      little_coder: { bash_allow: ["cmake "] },
    });
    writeTrust(projectCwd, true);
    ensureBashAllowLoaded(projectCwd); // trusted: project prefix active
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");

    // Revoke trust mid-session (no clearBashAllowCache — that would be a
    // session start, not the point of this test).
    writeTrust(projectCwd, false);
    ensureBashAllowLoaded(projectCwd); // cached entry, trust recheck fires
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");

    // Re-trusting mid-session does NOT restore project prefixes without a
    // reload (one-way; documented in ensureBashAllowLoaded).
    writeTrust(projectCwd, true);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");

    // A reload applies them again.
    clearBashAllowCache();
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");
  });

  it("repo-scoped /allow prefixes SURVIVE a trust revocation (explicit user grants)", () => {
    writeGlobalSettings({
      little_coder: {
        bash_allow: { [canonicalRepoKey(projectCwd)]: ["makea "] },
      },
    });
    writeProjectSettings(projectCwd, {
      little_coder: { bash_allow: ["cmake "] },
    });
    writeTrust(projectCwd, true);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toEqual(
      expect.arrayContaining(["makea ", "cmake "]),
    );
    writeTrust(projectCwd, false);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("makea "); // repo grant survives
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake "); // project prefix dropped
    expect(_getLoadedBashAllowRepoPrefixCountForTests()).toBe(1);
  });

  it("the recheck is skipped (no trust.json read) while no project prefixes are active", () => {
    // Untrusted from the start → projectPrefixes 0 → the fast path must not
    // rebuild on every touch. A trust grant mid-session then stays inert
    // until reload (existing idempotency semantics, preserved).
    writeProjectSettings(projectCwd, {
      little_coder: { bash_allow: ["cmake "] },
    });
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toEqual([]);
    writeTrust(projectCwd, true);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toEqual([]); // one-way: no restore
    clearBashAllowCache();
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");
  });
});

describe("mtime-gated trust recheck (freshness keys, not full re-reads)", () => {
  let agentDir: string;
  let pkgRoot: string;
  let projectCwd: string;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pg-mtime-agent-"));
    pkgRoot = mkdtempSync(join(tmpdir(), "pg-mtime-pkg-")); // empty: no shadowing
    projectCwd = mkdtempSync(join(tmpdir(), "pg-mtime-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot;
    clearBashAllowCache();
  });

  afterEach(() => {
    clearBashAllowCache();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  function writeGlobalSettings(obj: unknown): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(obj));
  }
  function writeProjectSettings(obj: unknown): void {
    mkdirSync(join(projectCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(projectCwd, ".pi", "settings.json"),
      JSON.stringify(obj),
    );
  }
  function writeTrust(decision: boolean): void {
    writeFileSync(
      join(agentDir, "trust.json"),
      JSON.stringify({ [realpathSync(projectCwd)]: decision }),
    );
  }

  it("(a) a project-settings edit is deliberately NOT reloaded on a plain cache hit", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    writeTrust(true);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");

    // Rewrite the PROJECT settings with a different prefix. The mtime key
    // changes, but the hot path deliberately skips project-settings reloads
    // (one-time notice stability + "mid-session edits apply next
    // session/reload"), so the OLD prefixes persist.
    writeProjectSettings({ little_coder: { bash_allow: ["ninja "] } });
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake "); // old, not re-read
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("ninja ");

    // A reload picks up the new prefixes (the documented apply path).
    clearBashAllowCache();
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("ninja ");
  });

  it("(b) a trust.json mtime bump with the SAME true decision keeps prefixes", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    writeTrust(true);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");

    // Same decision, bumped mtime → the recheck fires (key changed) but the
    // decision is still trusted, so prefixes persist.
    const trustPath = join(agentDir, "trust.json");
    writeFileSync(
      trustPath,
      JSON.stringify({ [realpathSync(projectCwd)]: true }),
    );
    utimesSync(
      trustPath,
      new Date(Date.now() + 10_000),
      new Date(Date.now() + 10_000),
    );
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake "); // still trusted
  });

  it("(c) a trust.json flip to false drops prefixes (revocation detected via mtime)", () => {
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    writeTrust(true);
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");

    // Flip the decision. Bump the mtime explicitly (as in (b)) so the
    // mtime-gated recheck fires even if the two writes land in the same
    // millisecond on a coarse-granularity filesystem.
    writeTrust(false);
    utimesSync(
      join(agentDir, "trust.json"),
      new Date(Date.now() + 10_000),
      new Date(Date.now() + 10_000),
    );
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake "); // revoked
  });

  it("(d) a defaultProjectTrust change (agent-dir settings.json, the second source) re-evaluates", () => {
    // Trusted via defaultProjectTrust 'always' with NO trust.json entry.
    writeGlobalSettings({ defaultProjectTrust: "always", little_coder: {} });
    writeProjectSettings({ little_coder: { bash_allow: ["cmake "] } });
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");

    // Flip the second source (the agent-dir settings.json). Bump its mtime
    // explicitly (as in (b)) so the mtime-gated recheck fires even if the two
    // writes land in the same millisecond on a coarse-granularity filesystem.
    writeGlobalSettings({ defaultProjectTrust: "never", little_coder: {} });
    utimesSync(
      join(agentDir, "settings.json"),
      new Date(Date.now() + 10_000),
      new Date(Date.now() + 10_000),
    );
    ensureBashAllowLoaded(projectCwd);
    expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("cmake ");
  });
});

describe("per-repo bash allowlist (/allow, /deny)", () => {
  let agentDir: string;
  let pkgRoot: string;
  let projectCwd: string;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;
  const prevEnv = process.env.LITTLE_CODER_BASH_ALLOW;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pg-repo-agent-"));
    pkgRoot = mkdtempSync(join(tmpdir(), "pg-repo-pkg-")); // empty: no shadowing
    projectCwd = mkdtempSync(join(tmpdir(), "pg-repo-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.LITTLE_CODER_PKG_ROOT = pkgRoot;
    if (prevEnv === undefined) delete process.env.LITTLE_CODER_BASH_ALLOW;
    clearBashAllowCache();
  });

  afterEach(() => {
    clearBashAllowCache();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
    else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
    if (prevEnv === undefined) delete process.env.LITTLE_CODER_BASH_ALLOW;
    else process.env.LITTLE_CODER_BASH_ALLOW = prevEnv;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  function writeGlobalSettings(obj: unknown): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(obj));
  }
  function readGlobalSettings(): any {
    return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
  }
  const repoKey = () => canonicalRepoKey(projectCwd);

  describe("parseBashAllow / buildBashAllow", () => {
    it("array form parses as global only (legacy)", () => {
      const p = parseBashAllow(["make ", 5, null, ""]);
      expect(p.global).toEqual(["make "]);
      expect(p.repos.size).toBe(0);
    });

    it("object form parses the reserved global key + repo keys, dropping junk", () => {
      const p = parseBashAllow({
        [BASH_ALLOW_GLOBAL_KEY]: ["make "],
        "/repo/a": ["cargo test ", "cargo build ", 7],
        "/repo/b": "not-an-array",
      });
      expect(p.global).toEqual(["make "]);
      expect(p.repos.get("/repo/a")).toEqual(["cargo test ", "cargo build "]);
      expect(p.repos.has("/repo/b")).toBe(false);
    });

    it("non-object, non-array values parse to empty", () => {
      expect(parseBashAllow("make ")).toEqual({ global: [], repos: new Map() });
      expect(parseBashAllow(undefined)).toEqual({
        global: [],
        repos: new Map(),
      });
    });

    it("buildBashAllow: array when no repo entries; object with 'global' only when non-empty", () => {
      expect(buildBashAllow({ global: ["a "], repos: new Map() })).toEqual([
        "a ",
      ]);
      expect(buildBashAllow(parseBashAllow(undefined))).toEqual([]);
      const withBoth = buildBashAllow({
        global: ["a "],
        repos: new Map([["/r", ["b "]]]),
      }) as Record<string, string[]>;
      expect(withBoth).toEqual({
        [BASH_ALLOW_GLOBAL_KEY]: ["a "],
        "/r": ["b "],
      });
      const repoOnly = buildBashAllow({
        global: [],
        repos: new Map([["/r", ["b "]]]),
      }) as Record<string, string[]>;
      expect(repoOnly).toEqual({ "/r": ["b "] }); // no "global" key when empty
    });
  });

  describe("normalizeAllowPrefix / canonicalRepoKey", () => {
    it("forces a trailing-space word boundary and collapses whitespace", () => {
      expect(normalizeAllowPrefix("make")).toBe("make ");
      expect(normalizeAllowPrefix("make  test")).toBe("make test ");
      expect(normalizeAllowPrefix("make ")).toBe("make ");
      expect(normalizeAllowPrefix("  docker compose ps  ")).toBe(
        "docker compose ps ",
      );
    });

    it("collapses whitespace around and inside surrounding quotes", () => {
      expect(normalizeAllowPrefix('"  make   test  "')).toBe("make test ");
    });

    it("canonicalRepoKey is the absolute real path; falls back for missing dirs", () => {
      expect(canonicalRepoKey(projectCwd)).toBe(realpathSync(projectCwd));
      expect(canonicalRepoKey("/nonexistent/xyz")).toBe("/nonexistent/xyz");
    });
  });

  describe("ensureBashAllowLoaded with a per-repo map", () => {
    it("honors the entry for the current repo, not other repos", () => {
      writeGlobalSettings({
        little_coder: {
          bash_allow: {
            [repoKey()]: ["cmake "],
            "/some/other/repo": ["ninja "],
          },
        },
      });
      ensureBashAllowLoaded(projectCwd);
      expect(_getLoadedBashAllowPrefixesForTests()).toContain("cmake ");
      expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("ninja ");
      expect(_getLoadedBashAllowRepoPrefixCountForTests()).toBe(1);
    });

    it("honors the reserved 'global' key as global (no trust gating needed)", () => {
      writeGlobalSettings({
        little_coder: { bash_allow: { [BASH_ALLOW_GLOBAL_KEY]: ["make "] } },
      });
      ensureBashAllowLoaded(projectCwd);
      expect(_getLoadedBashAllowPrefixesForTests()).toContain("make ");
      expect(_getLoadedBashAllowRepoPrefixCountForTests()).toBe(0);
    });

    it("legacy array form still works (backward compatible)", () => {
      writeGlobalSettings({ little_coder: { bash_allow: ["make "] } });
      ensureBashAllowLoaded(projectCwd);
      expect(_getLoadedBashAllowPrefixesForTests()).toContain("make ");
    });

    it("repo-scoped prefixes flow into the gate (pure union with builtins)", () => {
      writeGlobalSettings({
        little_coder: { bash_allow: { [repoKey()]: ["cmake "] } },
      });
      ensureBashAllowLoaded(projectCwd);
      const all = getSafePrefixes(_getLoadedBashAllowPrefixesForTests());
      expect(isSafeBash("cmake -S . -B build", all)).toBe(true);
      expect(all).toContain("ls"); // builtins still there
      expect(isSafeBash("ninja", all)).toBe(false);
    });
  });

  describe("allowBashPrefix (/allow)", () => {
    it("adds a prefix for the current repo, effective immediately, idempotent", async () => {
      const r1 = await allowBashPrefix("make test", projectCwd);
      expect(r1).toMatchObject({
        ok: true,
        prefix: "make test ",
        added: true,
        repoKey: repoKey(),
      });
      expect(readGlobalSettings().little_coder.bash_allow).toEqual({
        [repoKey()]: ["make test "],
      });
      // Effective in this session without a restart:
      expect(_getLoadedBashAllowPrefixesForTests()).toContain("make test ");
      const all = getSafePrefixes(_getLoadedBashAllowPrefixesForTests());
      expect(isSafeBash("make test", all)).toBe(true);
      // Idempotent — no duplicate entry.
      const r2 = await allowBashPrefix("make test", projectCwd);
      expect(r2).toMatchObject({ ok: true, added: false });
      expect(readGlobalSettings().little_coder.bash_allow[repoKey()]).toEqual([
        "make test ",
      ]);
    });

    it("converts a legacy array to the object form, preserving globals under 'global'", async () => {
      writeGlobalSettings({
        defaultProjectTrust: "ask",
        little_coder: {
          bash_allow: ["pip show "],
          token_limit_auto_continue: false,
        },
      });
      await allowBashPrefix("docker compose ps", projectCwd);
      const doc = readGlobalSettings();
      expect(doc.defaultProjectTrust).toBe("ask"); // sibling top-level key preserved
      expect(doc.little_coder.token_limit_auto_continue).toBe(false); // sibling ns key preserved
      expect(doc.little_coder.bash_allow).toEqual({
        [BASH_ALLOW_GLOBAL_KEY]: ["pip show "],
        [repoKey()]: ["docker compose ps "],
      });
    });

    it("--global writes to the 'global' key, coexisting with repo entries", async () => {
      await allowBashPrefix("localtool", projectCwd); // repo-scoped
      const r = await allowBashPrefix("globtool", projectCwd, true);
      expect(r).toMatchObject({
        ok: true,
        prefix: "globtool ",
        added: true,
        repoKey: BASH_ALLOW_GLOBAL_KEY,
      });
      const ba = readGlobalSettings().little_coder.bash_allow as Record<
        string,
        string[]
      >;
      expect(ba[BASH_ALLOW_GLOBAL_KEY]).toEqual(["globtool "]);
      expect(ba[repoKey()]).toEqual(["localtool "]); // repo entry untouched
      // Effective in this session (global prefix is in the loaded safe set):
      const all = getSafePrefixes(_getLoadedBashAllowPrefixesForTests());
      expect(isSafeBash("globtool run", all)).toBe(true);
      expect(isSafeBash("localtool run", all)).toBe(true);
      // Idempotent in global scope (no duplicate entry):
      const r2 = await allowBashPrefix("globtool", projectCwd, true);
      expect(r2).toMatchObject({ ok: true, added: false });
      expect(ba[BASH_ALLOW_GLOBAL_KEY]).toEqual(["globtool "]);
    });

    it("--global prefix is honored in a DIFFERENT repo (not just the current one)", async () => {
      const otherCwd = mkdtempSync(join(tmpdir(), "pg-repo-global-"));
      try {
        await allowBashPrefix("globtool", projectCwd, true);
        clearBashAllowCache();
        ensureBashAllowLoaded(otherCwd);
        const all = getSafePrefixes(_getLoadedBashAllowPrefixesForTests());
        expect(isSafeBash("globtool run", all)).toBe(true);
      } finally {
        rmSync(otherCwd, { recursive: true, force: true });
      }
    });

    it("different repos get different keys", async () => {
      const otherCwd = mkdtempSync(join(tmpdir(), "pg-repo-other-"));
      try {
        await allowBashPrefix("make", projectCwd);
        await allowBashPrefix("make", otherCwd);
        const keys = Object.keys(
          readGlobalSettings().little_coder.bash_allow,
        ).filter((k) => k !== BASH_ALLOW_GLOBAL_KEY);
        expect(keys).toEqual([repoKey(), canonicalRepoKey(otherCwd)]);
      } finally {
        rmSync(otherCwd, { recursive: true, force: true });
      }
    });

    it("empty input fails with 'empty' and writes nothing", async () => {
      expect((await allowBashPrefix("   ", projectCwd)).error).toBe("empty");
      expect((await allowBashPrefix("", projectCwd)).ok).toBe(false);
      expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
    });

    it("strips one pair of surrounding quotes", async () => {
      const r = await allowBashPrefix('"cargo build"', projectCwd);
      expect(r).toMatchObject({
        ok: true,
        prefix: "cargo build ",
        quotesStripped: true,
        added: true,
      });
      expect(readGlobalSettings().little_coder.bash_allow[repoKey()]).toEqual([
        "cargo build ",
      ]);
      const r2 = await allowBashPrefix("'make test'", projectCwd);
      expect(r2).toMatchObject({
        ok: true,
        prefix: "make test ",
        quotesStripped: true,
      });
    });

    it("stores mismatched quotes verbatim", async () => {
      const r = await allowBashPrefix('"make', projectCwd);
      expect(r).toMatchObject({
        ok: true,
        prefix: `"make `,
        quotesStripped: false,
      });
      expect(readGlobalSettings().little_coder.bash_allow[repoKey()]).toEqual([
        `"make `,
      ]);
    });

    it("post-strip-empty input fails with 'empty' and writes nothing", async () => {
      expect((await allowBashPrefix('""', projectCwd)).error).toBe("empty");
      expect((await allowBashPrefix("''", projectCwd)).ok).toBe(false);
      expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
    });

    it("refuses to clobber a malformed settings file (fail-safe)", async () => {
      writeFileSync(join(agentDir, "settings.json"), "{broken");
      const r = await allowBashPrefix("make", projectCwd);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/malformed/);
      // A write failure must NOT report the entry as added.
      expect(r.added).toBe(false);
      expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe(
        "{broken",
      );
    });
  });

  describe("denyBashPrefix (/deny)", () => {
    it("removes a repo-scoped prefix and it stops passing the gate", async () => {
      await allowBashPrefix("make test", projectCwd);
      const r = await denyBashPrefix("make test", projectCwd);
      expect(r).toMatchObject({
        ok: true,
        removed: true,
        stillAllowedVia: null,
        prefix: "make test ",
      });
      // No repo entries and no globals left → collapses back to an array.
      expect(readGlobalSettings().little_coder.bash_allow).toEqual([]);
      expect(_getLoadedBashAllowPrefixesForTests()).not.toContain("make test ");
      const all = getSafePrefixes(_getLoadedBashAllowPrefixesForTests());
      expect(isSafeBash("make test", all)).toBe(false);
    });

    it("--global deny removes from the 'global' key, leaving repo entries intact", async () => {
      writeGlobalSettings({
        little_coder: {
          bash_allow: {
            [BASH_ALLOW_GLOBAL_KEY]: ["globtool "],
            [repoKey()]: ["localtool "],
          },
        },
      });
      const r = await denyBashPrefix("globtool", projectCwd, true);
      expect(r).toMatchObject({
        ok: true,
        removed: true,
        repoKey: BASH_ALLOW_GLOBAL_KEY,
      });
      const ba = readGlobalSettings().little_coder.bash_allow as Record<
        string,
        string[]
      >;
      expect(ba[BASH_ALLOW_GLOBAL_KEY]).toBeUndefined(); // collapsed away
      expect(ba[repoKey()]).toEqual(["localtool "]); // repo entry intact
      // The global prefix no longer passes the gate:
      const all = getSafePrefixes(_getLoadedBashAllowPrefixesForTests());
      expect(isSafeBash("globtool run", all)).toBe(false);
    });

    it("--global deny of a builtin reports stillAllowedVia (builtins can't be denied)", async () => {
      writeGlobalSettings({
        little_coder: { bash_allow: { [BASH_ALLOW_GLOBAL_KEY]: ["ls "] } },
      });
      const r = await denyBashPrefix("ls", projectCwd, true);
      expect(r.removed).toBe(true);
      expect(r.stillAllowedVia).toBe("the built-in safe prefixes");
    });

    it("keeps other repos' entries intact", async () => {
      const otherCwd = mkdtempSync(join(tmpdir(), "pg-repo-other2-"));
      try {
        await allowBashPrefix("make", projectCwd);
        await allowBashPrefix("make", otherCwd);
        await denyBashPrefix("make", projectCwd);
        const map = readGlobalSettings().little_coder.bash_allow as Record<
          string,
          string[]
        >;
        expect(map[repoKey()]).toBeUndefined();
        expect(map[canonicalRepoKey(otherCwd)]).toEqual(["make "]);
      } finally {
        rmSync(otherCwd, { recursive: true, force: true });
      }
    });

    it("reports stillAllowedVia for built-ins (ls can't be denied)", async () => {
      await allowBashPrefix("ls -la", projectCwd);
      const r = await denyBashPrefix("ls -la", projectCwd);
      expect(r.removed).toBe(true);
      expect(r.stillAllowedVia).toBe("the built-in safe prefixes");
    });

    it("reports stillAllowedVia when the global list still covers the prefix", async () => {
      writeGlobalSettings({
        little_coder: { bash_allow: { [BASH_ALLOW_GLOBAL_KEY]: ["make "] } },
      });
      await allowBashPrefix("make test", projectCwd);
      const r = await denyBashPrefix("make test", projectCwd);
      expect(r.removed).toBe(true);
      expect(r.stillAllowedVia).toBe("your global bash_allow list");
    });

    it("denying something not in the list reports nothing removed (builtins noted)", async () => {
      const r = await denyBashPrefix("ls", projectCwd);
      expect(r).toMatchObject({
        ok: true,
        removed: false,
        stillAllowedVia: "the built-in safe prefixes",
      });
    });

    it("empty input fails with 'empty'", async () => {
      expect((await denyBashPrefix("  ", projectCwd)).error).toBe("empty");
      expect((await denyBashPrefix("", projectCwd)).ok).toBe(false);
    });

    it("refuses to clobber a malformed settings file (fail-safe), removed: false", async () => {
      writeFileSync(join(agentDir, "settings.json"), "{broken");
      const r = await denyBashPrefix("make", projectCwd);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/malformed/);
      expect(r.removed).toBe(false);
      expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe(
        "{broken",
      );
    });
  });
});

describe("splitGlobalFlag (--global parsing)", () => {
  it("no flag: whole arg is the command, global false", () => {
    expect(splitGlobalFlag("make test")).toEqual({
      command: "make test",
      global: false,
    });
  });
  it("trailing --global: stripped, global true", () => {
    expect(splitGlobalFlag("git push --global")).toEqual({
      command: "git push",
      global: true,
    });
  });
  it("leading --global: stripped, global true", () => {
    expect(splitGlobalFlag("--global git push")).toEqual({
      command: "git push",
      global: true,
    });
  });
  it("collapses internal whitespace and trims", () => {
    expect(splitGlobalFlag("  make   test  --global  ")).toEqual({
      command: "make test",
      global: true,
    });
  });
  it("flag-only / empty: empty command", () => {
    expect(splitGlobalFlag("")).toEqual({ command: "", global: false });
    expect(splitGlobalFlag("   ")).toEqual({ command: "", global: false });
    expect(splitGlobalFlag("--global")).toEqual({ command: "", global: true });
    expect(splitGlobalFlag(undefined)).toEqual({ command: "", global: false });
  });
});

describe("BUILTIN_SAFE_PREFIXES whitelist coverage", () => {
  it("every builtin prefix passes isSafeBash", () => {
    const prev = process.env.LITTLE_CODER_BASH_ALLOW;
    delete process.env.LITTLE_CODER_BASH_ALLOW;
    try {
      const prefixes = getSafePrefixes(); // returns BUILTIN_SAFE_PREFIXES when env is empty
      for (const prefix of prefixes) {
        // Prefixes with trailing spaces need an argument since isSafeBash trims
        const command = prefix.endsWith(" ") ? prefix + "test-arg" : prefix;
        expect(isSafeBash(command, prefixes), `prefix "${prefix}"`).toBe(true);
      }
      expect(prefixes.length).toBeGreaterThan(50);
    } finally {
      process.env.LITTLE_CODER_BASH_ALLOW = prev;
    }
  });
});
