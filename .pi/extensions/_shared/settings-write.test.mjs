// Shared settings writer tests — settings-write.mjs (the ONE implementation
// of the atomic + locked settings write protocol, delegated to by both the
// launcher's writeGlobalSettingsJson and the TS updateGlobalSettings).
//
// Vitest (the repo test runner is `vitest run`). The cross-process lock pin
// is the version the delete was pointing at: the shared module's
// lock (sidecar <settings.json>.lock on the settings dir, realpath: false)
// is genuinely cross-process.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  acquireSettingsLock,
  atomicWriteJson,
  updateSettingsFile,
} from "./settings-write.mjs";

function mkTmp(name) {
  return mkdtempSync(join(tmpdir(), `sw-${name}-`));
}

describe("settings-write.mjs (shared locked atomic writer)", () => {
  it("missing file → creates it (parents included), 0600, no temp left, lock re-acquirable", async () => {
    const root = mkTmp("w1");
    try {
      const path = join(root, "deep", "nested", "settings.json");
      const res = await updateSettingsFile(path, (doc) => {
        doc.little_coder = { bash_allow: ["make "] };
      });
      expect(res.ok).toBe(true);
      expect(res.path).toBe(path);
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
        little_coder: { bash_allow: ["make "] },
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // Atomic write leaves no temp file behind.
      expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
      // The lock is fully released after the write (re-acquirable; the
      // sidecar itself is removed by proper-lockfile on a clean unlock).
      const release = await acquireSettingsLock(path);
      expect(typeof release).toBe("function");
      await release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W1b: existing file is read under the lock, mutated, rewritten (siblings preserved)", async () => {
    const root = mkTmp("w1b");
    try {
      const path = join(root, "settings.json");
      writeFileSync(
        path,
        JSON.stringify({ a: 1, keep: [true] }, null, 2) + "\n",
      );
      const res = await updateSettingsFile(path, (doc) => {
        doc.b = 2;
      });
      expect(res.ok).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
        a: 1,
        keep: [true],
        b: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cross-process — a child OS process holding the lock makes updateSettingsFile refuse, naming the lock path", async () => {
    const root = mkTmp("w2");
    try {
      const path = join(root, "settings.json");
      const lockPath = path + ".lock";
      // A real second process holds the SAME lockfile the shared module uses.
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import lockfile from "proper-lockfile";
           const release = await lockfile.lock(${JSON.stringify(root)}, {
             realpath: false,
             lockfilePath: ${JSON.stringify(lockPath)},
           });
           console.log("held");
           for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 100));
           await release();
           process.exit(0);`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const held = await new Promise((resolve) => {
        let buf = "";
        child.stdout.on("data", (d) => {
          buf += d;
          if (buf.includes("held")) resolve(true);
        });
      });
      expect(held).toBe(true);
      try {
        const start = Date.now();
        const res = await updateSettingsFile(path, (doc) => {
          doc.x = 1;
        });
        // Async 10 × ~20 ms ≈ 200 ms — no busy-wait, comfortably under 5 s.
        expect(Date.now() - start).toBeLessThan(5_000);
        expect(res.ok).toBe(false);
        expect(res.error).toContain(lockPath);
        expect(res.error).toMatch(/lock/i);
        // The file was never created/modified by the blocked writer.
        expect(existsSync(path)).toBe(false);
      } finally {
        child.kill();
        await new Promise((r) => child.once("exit", r));
      }
      // After release is gone the write succeeds (proves the failure was
      // the lock, not the module).
      const ok = await updateSettingsFile(path, (doc) => {
        doc.x = 1;
      });
      expect(ok.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("malformed existing file is REFUSED (never clobbered), ok:false with the reconciled message", async () => {
    const root = mkTmp("w5");
    try {
      const path = join(root, "settings.json");
      writeFileSync(path, "{not-json");
      const res = await updateSettingsFile(path, (doc) => {
        doc.x = 1;
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/malformed JSON/);
      expect(readFileSync(path, "utf-8")).toBe("{not-json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W5b: non-object root is refused", async () => {
    const root = mkTmp("w5b");
    try {
      const path = join(root, "settings.json");
      writeFileSync(path, "[1, 2]");
      const res = await updateSettingsFile(path, () => {});
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not a JSON object/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W5c: malformed pi-better-openai.json is refused, naming THAT file (basename generalized)", async () => {
    const root = mkTmp("w5c");
    try {
      const path = join(root, "pi-better-openai.json");
      writeFileSync(path, "{broken");
      const res = await updateSettingsFile(path, (doc) => {
        doc.footer = { mode: "off" };
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("pi-better-openai.json");
      expect(res.error).toMatch(/malformed JSON/);
      expect(readFileSync(path, "utf-8")).toBe("{broken");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W5d: non-object pi-better-openai.json is refused, naming that file", async () => {
    const root = mkTmp("w5d");
    try {
      const path = join(root, "pi-better-openai.json");
      writeFileSync(path, "[1]");
      const res = await updateSettingsFile(path, () => {});
      expect(res.ok).toBe(false);
      expect(res.error).toContain("pi-better-openai.json");
      expect(res.error).toMatch(/not a JSON object/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("concurrent updateSettingsFile calls — no lost update (lock + under-lock re-read)", async () => {
    const root = mkTmp("w6");
    try {
      const path = join(root, "settings.json");
      const n = 5;
      // A generous retry budget (200 × 5 ms = 1 s per writer) so the
      // test drives to completion rather than depending on the ~200 ms
      // production budget surviving a slow/loaded CI.
      const opts = { maxRetries: 200, retryDelayMs: 5 };
      const results = await Promise.all(
        Array.from({ length: n }, () =>
          updateSettingsFile(
            path,
            (doc) => {
              doc.count = (doc.count ?? 0) + 1;
            },
            opts,
          ),
        ),
      );
      // Every writer must have won the lock (ok:true) — a starved writer
      // would return ok:false and leave count < n.
      expect(results.every((r) => r.ok)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ count: n });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("acquireSettingsLock: resolves to the release function; a nested acquisition while held fails GRACEFULLY (ELOCKED, no deadlock)", async () => {
    const root = mkTmp("lock");
    try {
      const path = join(root, "settings.json");
      const release = await acquireSettingsLock(path);
      expect(typeof release).toBe("function");
      // proper-lockfile 4.x does NOT allow same-PID re-entrancy: while the
      // outer lock is held, an inner updateSettingsFile retries the manual
      // 10 × ~20 ms loop and then REFUSES with ok:false naming the lock
      // path — it never hangs/deadlocks. After release, the write succeeds.
      const start = Date.now();
      const res = await updateSettingsFile(path, (doc) => {
        doc.inner = true;
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/lock/i);
      expect(Date.now() - start).toBeLessThan(5_000);
      await release();
      const ok = await updateSettingsFile(path, (doc) => {
        doc.inner = true;
      });
      expect(ok.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomicWriteJson: writes pretty JSON + newline, 0600, temp name is <path>.tmp-<pid>", () => {
    const root = mkTmp("awj");
    try {
      const path = join(root, "settings.json");
      atomicWriteJson(path, { z: [1, 2] });
      expect(readFileSync(path, "utf-8")).toBe(
        JSON.stringify({ z: [1, 2] }, null, 2) + "\n",
      );
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomicWriteJson: a stale <path>.tmp-<pid> from a crashed writer is unlinked and the write succeeds (EEXIST retry-once)", () => {
    const root = mkTmp("eexist");
    try {
      const path = join(root, "settings.json");
      // Simulate a crashed writer: the temp exists with junk content.
      writeFileSync(`${path}.tmp-${process.pid}`, "stale junk", {
        mode: 0o600,
      });
      atomicWriteJson(path, { recovered: true });
      expect(readFileSync(path, "utf-8")).toBe(
        JSON.stringify({ recovered: true }, null, 2) + "\n",
      );
      expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomicWriteJson: a planted SYMLINK at the temp path is refused (never followed, never replaced, target intact)", () => {
    const root = mkTmp("sym");
    try {
      const path = join(root, "settings.json");
      const target = join(root, "secret.txt");
      writeFileSync(target, "precious");
      // Plant a symlink where the writer will create its temp file.
      const tmp = `${path}.tmp-${process.pid}`;
      symlinkSync(target, tmp);
      // The write is refused — it must not follow the symlink to its target.
      expect(() => atomicWriteJson(path, { x: 1 })).toThrow();
      // The symlink is intact (not replaced with a regular file)...
      expect(lstatSync(tmp).isSymbolicLink()).toBe(true);
      // ...its target is untouched, and the settings file was never written.
      expect(readFileSync(target, "utf-8")).toBe("precious");
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updateSettingsFile: a throwing mutate → ok:false, file untouched, lock released", async () => {
    const root = mkTmp("tmutate");
    try {
      const path = join(root, "settings.json");
      writeFileSync(path, JSON.stringify({ a: 1 }, null, 2) + "\n");
      const before = readFileSync(path, "utf-8");
      const res = await updateSettingsFile(path, () => {
        throw new Error("boom");
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("boom");
      // The file is byte-identical (the throw happened before the write).
      expect(readFileSync(path, "utf-8")).toBe(before);
      // The lock was released: a subsequent write succeeds.
      const ok = await updateSettingsFile(path, (doc) => {
        doc.b = 2;
      });
      expect(ok.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("acquireSettingsLock: non-ELOCKED error rejects immediately (not retried 200 ms)", async () => {
    // A settings path whose dirname is a FILE → mkdirSync throws ENOTDIR,
    // which is non-ELOCKED and must surface raw, fast.
    const root = mkTmp("notdir");
    try {
      const notDir = join(root, "notdir");
      writeFileSync(notDir, "i am a file");
      const path = join(notDir, "child", "settings.json");
      const start = Date.now();
      await expect(acquireSettingsLock(path)).rejects.toThrow(/ENOTDIR/);
      expect(Date.now() - start).toBeLessThan(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanity: lockfile.lockSync on the same sidecar blocks updateSettingsFile (shared lockfile)", async () => {
    const root = mkTmp("sanity");
    try {
      const path = join(root, "settings.json");
      const release = lockfile.lockSync(root, {
        realpath: false,
        lockfilePath: path + ".lock",
      });
      const res = await updateSettingsFile(path, () => {});
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/lock/i);
      release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
