import { describe, it, expect } from "vitest";
import {
  bashBlockReason,
  getExternalWorkspaceAccess,
  getSafePrefixes,
  hasParentTraversal,
  isNoopCd,
  isSafeBash,
  isWithinWorkspace,
  parseExtraPrefixes,
  resolveWorkspacePath,
  scanBashSegments,
} from "./index.ts";
import { homedir, tmpdir } from "node:os";

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
  it("git subcommand gating is strict", () => {
    expect(isSafeBash("git log")).toBe(true);
    expect(isSafeBash("git push origin main")).toBe(false);
    expect(isSafeBash("git commit -m x")).toBe(false);
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
  it("allows && chains and | pipelines where every segment is safe", () => {
    expect(isSafeBash("grep -rn foo . | head -20")).toBe(true);
    expect(isSafeBash("ls -la && git status")).toBe(true);
    expect(isSafeBash("git log --oneline | head -5")).toBe(true);
    expect(isSafeBash("grep foo bar && grep baz qux")).toBe(true);
    expect(isSafeBash("cat a.txt | sort | uniq")).toBe(true);
    expect(isSafeBash("npm test | tail -10")).toBe(true);
  });
  it("blocks chains and pipelines containing unsafe segments", () => {
    expect(isSafeBash("grep foo | rm -rf /")).toBe(false);
    expect(isSafeBash("ls && rm -rf .")).toBe(false);
    expect(isSafeBash("grep foo || echo hi")).toBe(false);
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
  it("rejects control operators outside quotes", () => {
    expect(scanBashSegments("ls ; rm -rf /")).toBeNull();
    expect(scanBashSegments("ls |")).toBeNull();
    expect(scanBashSegments("grep foo || echo hi")).toBeNull();
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
