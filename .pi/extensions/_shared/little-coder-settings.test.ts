import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  getAgentDir,
  mergeNamespaces,
  pkgSettingsRoot,
  readLittleCoderScope,
  resolveKey,
  resolveLittleCoderSettings,
  updateGlobalSettings,
} from "./little-coder-settings.mjs";

const tmpRoots: string[] = [];
// capture the real env at describe scope; afterEach restores it
// (delete only if previously undefined) so the developer's own
// PI_CODING_AGENT_DIR / LITTLE_CODER_PKG_ROOT never leak across test files.
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
const prevPkgRoot = process.env.LITTLE_CODER_PKG_ROOT;

function mkTmp(name: string): string {
  const p = mkdtempSync(join(tmpdir(), `lc-${name}-`));
  tmpRoots.push(p);
  return p;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeRaw(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  // Point agent dir + pkg root at scratch dirs so real user state never leaks in.
  process.env.PI_CODING_AGENT_DIR = mkTmp("agent");
  process.env.LITTLE_CODER_PKG_ROOT = mkTmp("pkg");
});

afterEach(() => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  if (prevPkgRoot === undefined) delete process.env.LITTLE_CODER_PKG_ROOT;
  else process.env.LITTLE_CODER_PKG_ROOT = prevPkgRoot;
  while (tmpRoots.length > 0) {
    const p = tmpRoots.pop()!;
    rmSync(p, { recursive: true, force: true });
  }
});

describe("getAgentDir / pkgSettingsRoot", () => {
  it("honors PI_CODING_AGENT_DIR with tilde expansion", () => {
    process.env.PI_CODING_AGENT_DIR = "~";
    expect(getAgentDir()).toBe(process.env.HOME);
    process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
    expect(getAgentDir()).toBe(join(process.env.HOME!, "custom-agent"));
  });

  it("falls back to ~/.pi/agent when unset", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    expect(getAgentDir()).toBe(join(process.env.HOME!, ".pi", "agent"));
  });

  it("honors LITTLE_CODER_PKG_ROOT override", () => {
    process.env.LITTLE_CODER_PKG_ROOT = "/some/pkg";
    expect(pkgSettingsRoot()).toBe("/some/pkg");
  });
});

describe("resolveLittleCoderSettings", () => {
  it("merges per key: project bash_allow + global model_profiles both present", () => {
    const cwd = mkTmp("cwd");
    writeJson(join(cwd, ".pi", "settings.json"), {
      little_coder: { bash_allow: ["make "] },
    });
    writeJson(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), {
      little_coder: { model_profiles: { "llamacpp/x": { max_tokens: 1 } } },
    });

    const r = resolveLittleCoderSettings(cwd);
    expect(r.merged.bash_allow).toEqual(["make "]);
    expect(r.merged.model_profiles).toEqual({
      "llamacpp/x": { max_tokens: 1 },
    });
    expect(r.project?.bash_allow).toEqual(["make "]);
    expect(r.global?.model_profiles).toEqual({
      "llamacpp/x": { max_tokens: 1 },
    });
  });

  it("project key wins over global for the same key", () => {
    const cwd = mkTmp("cwd");
    writeJson(join(cwd, ".pi", "settings.json"), {
      little_coder: { token_limit_auto_continue: false },
    });
    writeJson(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), {
      little_coder: { token_limit_auto_continue: true },
    });

    const r = resolveLittleCoderSettings(cwd);
    expect(r.merged.token_limit_auto_continue).toBe(false);
  });

  it("pkg-shipped file fills keys absent elsewhere", () => {
    const cwd = mkTmp("cwd");
    writeJson(join(cwd, ".pi", "settings.json"), {
      little_coder: { bash_allow: ["go "] },
    });
    writeJson(
      join(process.env.LITTLE_CODER_PKG_ROOT!, ".pi", "settings.json"),
      { little_coder: { model_profiles: { "ollama/y": {} } } },
    );

    const r = resolveLittleCoderSettings(cwd);
    expect(r.merged.bash_allow).toEqual(["go "]);
    expect(r.merged.model_profiles).toEqual({ "ollama/y": {} });
    expect(r.pkg?.model_profiles).toEqual({ "ollama/y": {} });
  });

  it("malformed JSON in one scope is ignored, others still resolve", () => {
    const cwd = mkTmp("cwd");
    writeRaw(join(cwd, ".pi", "settings.json"), "{ not valid json");
    writeJson(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), {
      little_coder: { bash_allow: ["cargo "] },
    });
    writeRaw(
      join(process.env.LITTLE_CODER_PKG_ROOT!, ".pi", "settings.json"),
      "[]",
    );

    const r = resolveLittleCoderSettings(cwd);
    expect(r.project).toBeNull();
    expect(r.pkg).toBeNull();
    expect(r.merged.bash_allow).toEqual(["cargo "]);
  });

  it("a scope whose little_coder is not an object contributes nothing", () => {
    const cwd = mkTmp("cwd");
    writeJson(join(cwd, ".pi", "settings.json"), { little_coder: "oops" });
    const r = resolveLittleCoderSettings(cwd);
    expect(r.project).toBeNull();
    expect(r.merged).toEqual({});
  });

  it("reads defaultProjectTrust from the global file only", () => {
    const cwd = mkTmp("cwd");
    writeJson(join(cwd, ".pi", "settings.json"), {
      defaultProjectTrust: "always",
    });
    writeJson(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), {
      defaultProjectTrust: "never",
    });
    const r = resolveLittleCoderSettings(cwd);
    expect(r.defaultProjectTrust).toBe("never");

    writeJson(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), {
      defaultProjectTrust: "bogus-value-but-a-string",
    });
    expect(resolveLittleCoderSettings(cwd).defaultProjectTrust).toBe(
      "bogus-value-but-a-string",
    );
  });

  it("re-reads on every call: mid-session edits apply on the next call", () => {
    const cwd = mkTmp("cwd");
    expect(resolveLittleCoderSettings(cwd).merged.bash_allow).toBeUndefined();
    writeJson(join(cwd, ".pi", "settings.json"), {
      little_coder: { bash_allow: ["late "] },
    });
    // Same cwd again, no cache clear in between (resolver is unmemoized).
    expect(resolveLittleCoderSettings(cwd).merged.bash_allow).toEqual([
      "late ",
    ]);
    // Re-resolution on a different cwd still works.
    const cwdB = mkTmp("cwd-b");
    writeJson(join(cwdB, ".pi", "settings.json"), {
      little_coder: { bash_allow: ["other "] },
    });
    expect(resolveLittleCoderSettings(cwdB).merged.bash_allow).toEqual([
      "other ",
    ]);
  });
});

describe("readLittleCoderScope", () => {
  it("returns null for missing files", () => {
    expect(readLittleCoderScope(join(mkTmp("x"), "nope.json"))).toBeNull();
  });
});

describe("updateGlobalSettings", () => {
  const settingsPath = () => join(getAgentDir(), "settings.json");

  it("creates the file (and dir) when missing", async () => {
    const res = await updateGlobalSettings((doc) => {
      doc.little_coder = { bash_allow: { [mkTmp("repo")]: ["make "] } };
    });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(settingsPath());
    const doc = JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(doc.little_coder).toEqual({
      bash_allow: expect.any(Object),
    });
    // Atomic write leaves no temp file behind.
    expect(existsSync(`${settingsPath()}.tmp-${process.pid}`)).toBe(false);
  });

  it("writes the settings file with 0600 mode", async () => {
    const res = await updateGlobalSettings((doc) => {
      doc.little_coder = { bash_allow: ["make "] };
    });
    expect(res.ok).toBe(true);
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
  });

  it("(delegate lock-pin): a held lock makes updateGlobalSettings fail, naming the lock path (async, no busy-wait)", async () => {
    const lockPath = settingsPath() + ".lock";
    const release = lockfile.lockSync(getAgentDir(), {
      realpath: false,
      lockfilePath: lockPath,
    });
    try {
      const before = existsSync(settingsPath())
        ? readFileSync(settingsPath(), "utf-8")
        : null;
      const start = Date.now();
      const res = await updateGlobalSettings((doc) => {
        doc.little_coder = { bash_allow: ["x "] };
      });
      // Async: the ELOCKED retry loop must not spin the event loop —
      // 10 × ~20 ms ≈ 200 ms total, well under 5 s.
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(res.ok).toBe(false);
      // Descriptive, names the lock file (the shared module's contract —
      // the cross-process version of this pin lives in
      // settings-write.test.mjs).
      expect(res.error).toContain(lockPath);
      expect(res.error).toMatch(/lock/i);
      expect(
        existsSync(settingsPath())
          ? readFileSync(settingsPath(), "utf-8")
          : null,
      ).toBe(before);
    } finally {
      release();
    }
    const ok = await updateGlobalSettings((doc) => {
      doc.little_coder = { bash_allow: ["x "] };
    });
    expect(ok.ok).toBe(true); // succeeds once the lock is free
  });

  it("preserves unrelated top-level keys and sibling little_coder keys", async () => {
    writeJson(settingsPath(), {
      defaultProjectTrust: "ask",
      otherTopLevel: 42,
      little_coder: {
        token_limit_auto_continue: false,
        model_profiles: { "x/y": { temperature: 0.5 } },
      },
    });
    await updateGlobalSettings((doc) => {
      const ns = doc.little_coder as Record<string, unknown>;
      ns.bash_allow = ["make "];
    });
    const doc = JSON.parse(readFileSync(settingsPath(), "utf-8")) as any;
    expect(doc.defaultProjectTrust).toBe("ask");
    expect(doc.otherTopLevel).toBe(42);
    expect(doc.little_coder.token_limit_auto_continue).toBe(false);
    expect(doc.little_coder.model_profiles).toEqual({
      "x/y": { temperature: 0.5 },
    });
    expect(doc.little_coder.bash_allow).toEqual(["make "]);
  });

  it("mutates the parsed doc in place", async () => {
    writeJson(settingsPath(), { a: 1 });
    await updateGlobalSettings((doc) => {
      doc.b = 2;
    });
    expect(JSON.parse(readFileSync(settingsPath(), "utf-8"))).toEqual({
      a: 1,
      b: 2,
    });
  });

  it("refuses to overwrite a malformed existing file (fail-safe)", async () => {
    writeRaw(settingsPath(), "{not-json");
    const res = await updateGlobalSettings((doc) => {
      doc.little_coder = {};
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/malformed/);
    expect(readFileSync(settingsPath(), "utf-8")).toBe("{not-json");
  });

  it("refuses to overwrite a non-object root", async () => {
    writeRaw(settingsPath(), "[1, 2]");
    const res = await updateGlobalSettings(() => undefined);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a JSON object/);
  });
});

describe("mergeNamespaces", () => {
  it("handles all-null scopes", () => {
    expect(mergeNamespaces(null, null, null)).toEqual({});
  });
});

describe("resolveKey", () => {
  const resolved = {
    project: { a: "project", b: "project" } as Record<string, unknown>,
    global: { b: "global", c: "global" } as Record<string, unknown>,
    pkg: { c: "pkg", d: "pkg" } as Record<string, unknown>,
  };

  it("trusted: project scope wins when it has the key", () => {
    expect(resolveKey(resolved, "a", true)).toBe("project");
    expect(resolveKey(resolved, "b", true)).toBe("project");
  });

  it("trusted: falls back to global, then pkg", () => {
    expect(resolveKey(resolved, "c", true)).toBe("global");
    expect(resolveKey(resolved, "d", true)).toBe("pkg");
  });

  it("trusted: matches resolved.merged semantics (project → global → pkg)", () => {
    const merged = mergeNamespaces(
      resolved.project,
      resolved.global,
      resolved.pkg,
    );
    expect(resolveKey(resolved, "a", true)).toBe(merged["a"]);
    expect(resolveKey(resolved, "b", true)).toBe(merged["b"]);
    expect(resolveKey(resolved, "c", true)).toBe(merged["c"]);
    expect(resolveKey(resolved, "d", true)).toBe(merged["d"]);
  });

  it("untrusted: project scope is ignored (global → pkg)", () => {
    expect(resolveKey(resolved, "a", false)).toBeUndefined();
    expect(resolveKey(resolved, "b", false)).toBe("global");
    expect(resolveKey(resolved, "c", false)).toBe("global");
    expect(resolveKey(resolved, "d", false)).toBe("pkg");
  });

  it("untrusted: matches mergeNamespaces(null, global, pkg)", () => {
    const merged = mergeNamespaces(null, resolved.global, resolved.pkg);
    expect(resolveKey(resolved, "b", false)).toBe(merged["b"]);
    expect(resolveKey(resolved, "c", false)).toBe(merged["c"]);
    expect(resolveKey(resolved, "d", false)).toBe(merged["d"]);
  });

  it("returns undefined when no in-scope scope has the key", () => {
    expect(resolveKey(resolved, "missing", true)).toBeUndefined();
    expect(resolveKey(resolved, "missing", false)).toBeUndefined();
  });

  it("handles null scopes without throwing", () => {
    expect(
      resolveKey({ project: null, global: null, pkg: null }, "a", true),
    ).toBeUndefined();
    expect(
      resolveKey({ project: null, global: null, pkg: null }, "a", false),
    ).toBeUndefined();
  });
});
