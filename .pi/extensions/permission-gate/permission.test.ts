import { describe, it, expect } from "vitest";
import { isSafeBash, parseExtraPrefixes, getSafePrefixes, isNoopCd } from "./index.ts";
import { resolve } from "node:path";
import { homedir } from "node:os";

describe("isSafeBash", () => {
  it("allows whitelisted read-only commands", () => {
    expect(isSafeBash("ls -la")).toBe(true);
    expect(isSafeBash("cat /etc/hosts")).toBe(true);
    expect(isSafeBash("git log --oneline")).toBe(true);
    expect(isSafeBash("grep -r pattern .")).toBe(true);
    expect(isSafeBash("rg pattern src/")).toBe(true);
  });
  it("allows routine filesystem scaffolding (cp/mv/mkdir/touch)", () => {
    expect(isSafeBash("cp a b")).toBe(true);
    expect(isSafeBash("mv old new")).toBe(true);
    expect(isSafeBash("mkdir -p sub/dir")).toBe(true);
    expect(isSafeBash("touch foo.md")).toBe(true);
  });
  it("preserves trailing-whitespace word boundary on fs prefixes", () => {
    // Without the trailing space, "cp" would match "cpufetch". With it, these stay blocked.
    expect(isSafeBash("cpufetch")).toBe(false);
    expect(isSafeBash("mvtool")).toBe(false);
    expect(isSafeBash("mkdiroops")).toBe(false);
    expect(isSafeBash("touchscreen")).toBe(false);
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
    expect(isNoopCd("cd", homedir())).toBe(true); // cd with no args → $HOME; only no-op if cwd === $HOME
  });

  it("allows cd to a subdirectory of cwd", () => {
    expect(isNoopCd("cd subdir", cwd)).toBe(true);
    expect(isNoopCd("cd sub/dir", cwd)).toBe(true);
    expect(isNoopCd("cd ./sub", cwd)).toBe(true);
  });

  it("allows cd <cwd-basename> when it resolves to cwd via .", () => {
    // cd . is the canonical no-op; cd <basename> from parent would not
    // resolve to cwd (it'd be cwd/basename), so test the real case.
    expect(isNoopCd("cd .", cwd)).toBe(true);
  });

  it("allows cd with the full cwd path", () => {
    expect(isNoopCd(`cd ${cwd}`, cwd)).toBe(true);
  });

  it("allows cd with ~ when ~ resolves to cwd", () => {
    // Only true when cwd === $HOME
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

describe("getSafePrefixes", () => {
  it("merges builtins with LITTLE_CODER_BASH_ALLOW from the env", () => {
    const prev = process.env.LITTLE_CODER_BASH_ALLOW;
    process.env.LITTLE_CODER_BASH_ALLOW = "make ,docker compose ps";
    try {
      const all = getSafePrefixes();
      expect(all).toContain("ls"); // builtin still present
      expect(all).toContain("make ");
      expect(all).toContain("docker compose ps");
    } finally {
      if (prev === undefined) delete process.env.LITTLE_CODER_BASH_ALLOW;
      else process.env.LITTLE_CODER_BASH_ALLOW = prev;
    }
  });
});
