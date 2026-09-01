// Shared atomic + locked JSON settings writer for little-coder — the ONE
// implementation of the write protocol that every writer of the user's
// settings files delegates to:
//
//   - the TS extensions' updateGlobalSettings (permission-gate /allow /deny)
//     via _shared/little-coder-settings.mjs (loaded through jiti);
//   - the plain-.mjs launcher (bin/little-coder.mjs step 8, via
//     bin/launcher-internal.mjs writeGlobalSettingsJson).
//
// Plain dependency-light ESM (node:fs + proper-lockfile, which is a direct
// little-coder dependency): importable both from the launcher's native ESM
// and from jiti-loaded TS (tsc type-checks the .ts importers against the
// sibling settings-write.d.mts).
//
// Protocol (parity with the old duplicated writers):
//   1. the ENTIRE read-modify-write runs under a proper-lockfile lock on the
//      settings DIRECTORY with a sidecar lockfile at <settings.json>.lock
//      (realpath: false) — two little-coder processes (a session's /allow
//      vs the launcher's quietStartup stamp) cannot clobber each other, and
//      the re-read under the lock prevents a lost update;
//   2. retries on ELOCKED are a MANUAL 10 × ~20 ms ASYNC loop (proper-
//      lockfile's sync API refuses `retries`, and the async `retries`
//      option would pull in a second retry implementation — the manual
//      loop keeps one, and is async, so no busy-wait blocks the event
//      loop); on exhaustion the promise REJECTS naming the lock path;
//   3. the write is atomic: <settings.json>.tmp-<pid> created with
//      O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW at 0o600, written, then renamed
//      over the target — a reader never sees a torn file, a stale temp from
//      a crashed writer (pid reuse / crash between create and rename) is
//      unlinked and retried once, and a planted symlink is never followed;
//   4. fail-safe: a malformed existing file is REFUSED (never clobbered) —
//      updateSettingsFile reports it as {ok:false} with one reconciled
//      message (the TS wording), which the launcher wrapper re-throws.
//
// ASYNC ONLY, on purpose: a sync entry point could only retry ELOCKED by
// spinning the CPU (proper-lockfile's sync API never retries itself), and
// after the migration every production caller is already async.
//
// LOCATION WARNING: _shared/ must stay under .pi/extensions/ so jiti-loaded
// TS extensions can import it (tsc checks them against the sibling .d.mts).
// Relocating this directory requires updating every bin/ import edge and the
// relative import in little-coder-settings.mjs first.

import fs, {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import lockfile from "proper-lockfile";

// Node's ESM wrapper for node:fs does not expose the O_* open flags as
// named exports (plain `import { O_WRONLY } from "node:fs"` is a
// SyntaxError in ESM, and undefined under vite-node) — read them from
// fs.constants, which is the platform-correct source under both ESM and
// CJS (jiti). Same convention as little-coder-settings.mjs.
const O_WRONLY = fs.constants.O_WRONLY;
const O_CREAT = fs.constants.O_CREAT;
const O_EXCL = fs.constants.O_EXCL;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW;

const SETTINGS_LOCK_MAX_ATTEMPTS = 10;
const SETTINGS_LOCK_DELAY_MS = 20;
// A lock held longer than this is considered abandoned and reaped.
// Raised from 10 s to 30 s: the critical section is a tiny JSON
// read-modify-write that never legitimately runs near 10 s, so a 10 s
// staleness let a second writer reap a legitimately-held lock (suspend /
// slow disk) and interleave two read-modify-write cycles (lost update).
// 30 s is well above any realistic critical section while still reaping a
// truly-crashed writer. (proper-lockfile's own default is max(2000, …).)
const SETTINGS_LOCK_STALE_MS = 30_000;

// Production defaults for the lock retry budget. Injectable per call via
// updateSettingsFile's opts ({ staleMs, maxRetries, retryDelayMs }) so tests
// can drive the concurrent-writers case to completion without a fixed
// ~200 ms wall-clock budget.
const DEFAULT_LOCK_OPTS = {
  staleMs: SETTINGS_LOCK_STALE_MS,
  maxRetries: SETTINGS_LOCK_MAX_ATTEMPTS,
  retryDelayMs: SETTINGS_LOCK_DELAY_MS,
};

const errMsg = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Acquire the settings lock ASYNC (resource = the settings DIRECTORY,
 * sidecar lockfile at <settings.json>.lock, realpath: false, explicit
 * stale). Retries ELOCKED (default 10 × ~20 ms, injectable via `opts`);
 * non-ELOCKED errors reject immediately; exhaustion rejects with an error
 * naming the lock path.
 *
 * Resolves to the release function — `const release = await
 * acquireSettingsLock(p); try { … } finally { await release(); }`
 * (proper-lockfile's async `lock` resolves to a release wrapper, not a
 * bare Promise<void>).
 */
export async function acquireSettingsLock(settingsPath, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_OPTS.staleMs;
  const maxRetries = opts.maxRetries ?? DEFAULT_LOCK_OPTS.maxRetries;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_LOCK_OPTS.retryDelayMs;
  const dir = dirname(settingsPath);
  mkdirSync(dir, { recursive: true });
  const lockPath = `${settingsPath}.lock`;
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // proper-lockfile 4.x: `await lock(file, options)` resolves to the
      // (not-yet-invoked) release function; calling it unlocks.
      return await lockfile.lock(dir, {
        realpath: false,
        lockfilePath: lockPath,
        stale: staleMs,
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : undefined;
      // Non-ELOCKED errors are not retryable — reject raw immediately.
      if (code !== "ELOCKED") throw error;
      lastError = error;
      // Final attempt: break to the descriptive rejection below (it names
      // the lock file — the lock tests assert on it). Rethrowing the raw
      // ELOCKED would make that message unreachable (its text is just
      // "Lock file is already being held", no path).
      if (attempt === maxRetries) break;
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  if (lastError instanceof Error)
    throw new Error(
      `could not acquire settings lock ${lockPath}: ${lastError.message}`,
    );
  throw new Error(`could not acquire settings lock ${lockPath}`);
}

/**
 * Open the temp file exclusively (O_EXCL: never truncate a pre-existing
 * temp; O_NOFOLLOW: never follow a planted symlink). A stale temp left by
 * a crashed writer (pid reuse, or crash between create and rename) makes
 * the first open fail EEXIST — unlink it once and retry; a second failure
 * (e.g. a racing writer recreated it in between) is rethrown raw.
 */
function openTmpExclusive(tmp) {
  try {
    return openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  } catch (err) {
    if (err instanceof Error && err.code === "EEXIST") {
      // The temp path already exists. Distinguish the two cases:
      //   - a regular file → a stale temp left by a crashed writer (pid reuse
      //     or a crash between create and rename): unlink once and retry.
      //   - a symlink → never delete or follow it: rethrow (refuse). A planted
      //     symlink must not be replaced with our regular file.
      let st;
      try {
        st = lstatSync(tmp);
      } catch {
        st = null; // vanished between the open and the lstat
      }
      if (st !== null && st.isSymbolicLink()) throw err;
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      return openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    }
    throw err;
  }
}

/**
 * Atomically write `value` as pretty JSON to `path` (0o600 temp + rename;
 * creates parent dirs). Synchronous — the file is small; the LOCK around
 * the surrounding read-modify-write is the async part.
 */
export function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  let fd;
  try {
    fd = openTmpExclusive(tmp);
    try {
      // writeSync can in theory partial-write; loop to a FULL write so a
      // rename never lands a truncated (malformed) file where there was a valid
      // one — the "a reader never sees a torn file" guarantee, made airtight.
      const buf = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf-8");
      let offset = 0;
      while (offset < buf.length) {
        offset += writeSync(fd, buf, offset, buf.length - offset);
      }
    } finally {
      closeSync(fd);
      fd = undefined;
    }
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    // Never unlink a symlink at the temp path — only remove a temp file we
    // created (a regular file). A planted symlink is left intact (refused).
    try {
      const st = lstatSync(tmp);
      if (!st.isSymbolicLink()) unlinkSync(tmp);
    } catch {
      /* renamed, never created, or a symlink we must not touch */
    }
    throw err;
  }
}

/**
 * Read-modify-write a settings file under the shared lock. `mutate`
 * receives the parsed top-level JSON document (a plain object; {} when the
 * file does not exist yet) and may modify it in place. Idempotent mutates
 * are applied to a FRESH under-lock read, so a concurrent writer's change
 * is not clobbered.
 *
 * `opts` (optional) = `{ staleMs?, maxRetries?, retryDelayMs? }` tunes the
 * lock retry budget (production defaults in DEFAULT_LOCK_OPTS); primarily
 * for tests to drive contention to completion.
 *
 * NEVER rejects: every failure (lock exhaustion, unreadable file,
 * malformed JSON, non-object root, write error) is returned as
 * `{ ok: false, path, error }`. The ONE reconciled malformed message
 * ("existing <basename> is malformed JSON — fix it before saving: …")
 * names the file actually being written (settings.json or
 * pi-better-openai.json — same writer, any settings file) and is the
 * contract both the TS delegate (returned as {ok:false}) and the
 * launcher delegate (re-thrown) expose.
 */
export async function updateSettingsFile(settingsPath, mutate, opts = {}) {
  let release;
  try {
    release = await acquireSettingsLock(settingsPath, opts);
  } catch (err) {
    return { ok: false, path: settingsPath, error: errMsg(err) };
  }
  try {
    let doc = {};
    if (existsSync(settingsPath)) {
      let raw;
      try {
        raw = readFileSync(settingsPath, "utf-8");
      } catch (err) {
        return {
          ok: false,
          path: settingsPath,
          error: `cannot read existing settings: ${errMsg(err)}`,
        };
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          ok: false,
          path: settingsPath,
          error: `existing ${basename(settingsPath)} is malformed JSON — fix it before saving: ${errMsg(err)}`,
        };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          ok: false,
          path: settingsPath,
          error: `existing ${basename(settingsPath)} is not a JSON object`,
        };
      }
      doc = parsed;
    }
    mutate(doc);
    atomicWriteJson(settingsPath, doc);
    return { ok: true, path: settingsPath, value: doc };
  } catch (err) {
    return { ok: false, path: settingsPath, error: errMsg(err) };
  } finally {
    try {
      await release();
    } catch {
      // best-effort release; a failed unlock does not change the result
      // of the read-modify-write above
    }
  }
}
