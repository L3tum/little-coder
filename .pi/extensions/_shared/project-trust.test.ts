// PT# series: unit tests for _shared/project-trust.mjs (the pi-faithful,
// lock-free trust reader + matrix). The full consumer-side matrix oracle
// lives in permission-gate/permission.test.ts (real trust.json files through
// ensureBashAllowLoaded) and must stay green alongside these.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  _clearTrustCacheForTests,
  canonicalRepoKey,
  isProjectTrustedFailClosed,
  readTrustDecision,
} from "./project-trust.mjs";

let agentDir: string;
let projectCwd: string;
let savedAgentDirEnv: string | undefined;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "lc-pt-agent-"));
  projectCwd = mkdtempSync(join(tmpdir(), "lc-pt-repo-"));
  savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // (P2) The trust-map memo is module-level; clear it so no test observes a
  // stale map from a prior test's agentDir (defense in depth on top of the
  // per-test fresh agentDir path key).
  _clearTrustCacheForTests();
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectCwd, { recursive: true, force: true });
  if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
});

function writeTrust(map: Record<string, unknown>): void {
  writeFileSync(join(agentDir, "trust.json"), JSON.stringify(map));
}

describe("readTrustDecision (PT#)", () => {
  it("PT1: stored true for the exact cwd → true", () => {
    writeTrust({ [realpathSync(projectCwd)]: true });
    expect(readTrustDecision(agentDir, projectCwd)).toBe(true);
  });

  it("PT2: stored false for the exact cwd → false", () => {
    writeTrust({ [realpathSync(projectCwd)]: false });
    expect(readTrustDecision(agentDir, projectCwd)).toBe(false);
  });

  it("PT5: a trusted PARENT dir entry is honored for a child cwd (ancestor walk)", () => {
    const parent = realpathSync(dirname(realpathSync(projectCwd)));
    writeTrust({ [parent]: true });
    expect(readTrustDecision(agentDir, projectCwd)).toBe(true);
  });

  it("PT5b: nearest entry wins — exact-cwd false beats trusted parent true", () => {
    const parent = realpathSync(dirname(realpathSync(projectCwd)));
    writeTrust({ [realpathSync(projectCwd)]: false, [parent]: true });
    expect(readTrustDecision(agentDir, projectCwd)).toBe(false);
  });

  it("PT7: a null entry is SKIPPED — the walk continues to the next ancestor", () => {
    const parent = realpathSync(dirname(realpathSync(projectCwd)));
    const grandparent = realpathSync(dirname(parent));
    writeTrust({
      [realpathSync(projectCwd)]: null,
      [parent]: true,
      [grandparent]: true,
    });
    expect(readTrustDecision(agentDir, projectCwd)).toBe(true);
    // ...and a null between the cwd and a false parent still yields false.
    writeTrust({ [realpathSync(projectCwd)]: null, [parent]: false });
    expect(readTrustDecision(agentDir, projectCwd)).toBe(false);
  });

  it("PT8: a non-boolean/non-null value anywhere in the map → null (invalid store, fail closed)", () => {
    writeTrust({ [realpathSync(projectCwd)]: "yes" });
    expect(readTrustDecision(agentDir, projectCwd)).toBe(null);
  });

  it("PT6: malformed JSON → null (no throw)", () => {
    writeFileSync(join(agentDir, "trust.json"), "{not json");
    expect(readTrustDecision(agentDir, projectCwd)).toBe(null);
  });

  it("PT6b: non-object root → null", () => {
    writeFileSync(join(agentDir, "trust.json"), JSON.stringify([true]));
    expect(readTrustDecision(agentDir, projectCwd)).toBe(null);
  });

  it("PT4: trust.json is a DIRECTORY → null (no throw)", () => {
    mkdirSync(join(agentDir, "trust.json"));
    expect(readTrustDecision(agentDir, projectCwd)).toBe(null);
  });

  it("no trust.json at all → null", () => {
    expect(existsSync(join(agentDir, "trust.json"))).toBe(false);
    expect(readTrustDecision(agentDir, projectCwd)).toBe(null);
  });

  it("canonicalRepoKey: realpath, fallback to resolve for missing paths", () => {
    expect(canonicalRepoKey(projectCwd)).toBe(realpathSync(projectCwd));
    const missing = join(projectCwd, "does-not-exist");
    expect(canonicalRepoKey(missing)).toBe(missing);
  });
});

describe("readTrustDecision memo (P2)", () => {
  it("re-reads a SAME-size content change detected via mtime (size alone is insufficient)", () => {
    const file = join(agentDir, "trust.json");
    const key = realpathSync(projectCwd);
    const sTrue = JSON.stringify({ [key]: true });
    const sNull = JSON.stringify({ [key]: null });
    // `true` and `null` are the same length → identical file size; only the
    // mtime can carry the change.
    expect(sTrue.length).toBe(sNull.length);
    writeFileSync(file, sTrue);
    expect(readTrustDecision(agentDir, projectCwd)).toBe(true);
    // Same-size content change (true → null). Force a distinct mtime so the
    // freshness key changes even on coarse-granularity filesystems — size is
    // unchanged, so only the mtimeMs component can invalidate the memo.
    writeFileSync(file, sNull);
    const st = statSync(file);
    utimesSync(file, st.atime, new Date(st.mtimeMs + 1000));
    // `null` entry → the ancestor walk finds nothing → null (fail closed).
    expect(readTrustDecision(agentDir, projectCwd)).toBe(null);
  });

  it("invalidates when the file is deleted", () => {
    const file = join(agentDir, "trust.json");
    writeTrust({ [realpathSync(projectCwd)]: true });
    expect(readTrustDecision(agentDir, projectCwd)).toBe(true);
    rmSync(file);
    expect(readTrustDecision(agentDir, projectCwd)).toBe(null);
  });

  it("serves repeated reads of an unchanged file from the memo (stable decision)", () => {
    writeTrust({ [realpathSync(projectCwd)]: true });
    expect(readTrustDecision(agentDir, projectCwd)).toBe(true);
    expect(readTrustDecision(agentDir, projectCwd)).toBe(true);
    expect(readTrustDecision(agentDir, projectCwd)).toBe(true);
  });
});

describe("isProjectTrustedFailClosed (PT# matrix)", () => {
  it("PT1m: stored true → trusted regardless of default", () => {
    writeTrust({ [realpathSync(projectCwd)]: true });
    expect(isProjectTrustedFailClosed(projectCwd, "never")).toBe(true);
    expect(isProjectTrustedFailClosed(projectCwd, undefined)).toBe(true);
  });

  it("PT2m: stored false beats defaultProjectTrust 'always'", () => {
    writeTrust({ [realpathSync(projectCwd)]: false });
    expect(isProjectTrustedFailClosed(projectCwd, "always")).toBe(false);
  });

  it("PT3m: no entry + 'always' → trusted; 'never'/'ask'/unknown/absent → not", () => {
    expect(isProjectTrustedFailClosed(projectCwd, "always")).toBe(true);
    expect(isProjectTrustedFailClosed(projectCwd, "never")).toBe(false);
    expect(isProjectTrustedFailClosed(projectCwd, "ask")).toBe(false);
    expect(isProjectTrustedFailClosed(projectCwd, "bogus")).toBe(false);
    expect(isProjectTrustedFailClosed(projectCwd, null)).toBe(false);
    expect(isProjectTrustedFailClosed(projectCwd, undefined)).toBe(false);
  });

  it("PT4m: unreadable trust store fails closed to the default", () => {
    mkdirSync(join(agentDir, "trust.json"));
    expect(isProjectTrustedFailClosed(projectCwd, "always")).toBe(true);
    expect(isProjectTrustedFailClosed(projectCwd, "never")).toBe(false);
  });

  it("PT5m: ancestor trust + 'ask' default → trusted (stored decision wins)", () => {
    const parent = realpathSync(dirname(realpathSync(projectCwd)));
    writeTrust({ [parent]: true });
    expect(isProjectTrustedFailClosed(projectCwd, "ask")).toBe(true);
  });
});
