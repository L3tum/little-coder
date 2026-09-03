// Shared lock-FREE atomic JSON writer: 0600 temp file + rename, exclusive
// temp creation (O_EXCL), and symlink-refusing temp paths (O_NOFOLLOW on
// POSIX).
//
// This is the protocol half of settings-write.mjs with the LOCK removed, so
// callers that deliberately write WITHOUT the shared settings lock (today:
// the launcher's update-check cache — a non-settings file, best-effort,
// never worth dragging proper-lockfile into the launcher's module graph)
// still get the same atomicity + symlink-refusal protocol. Callers that
// write a settings file MUST use settings-write.mjs's updateSettingsFile
// (which takes the shared lock around a read-modify-write and delegates
// every byte here).
//
// Plain dependency-light ESM: the plain-.mjs launcher can import it natively
// and jiti-loaded TS extensions import it through settings-write.mjs's
// re-export (typed via the sibling settings-write.d.mts).

import fs, {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

// Node's ESM wrapper for node:fs does not expose the O_* open flags as
// named exports (plain `import { O_WRONLY } from "node:fs"` is a
// SyntaxError in ESM, and undefined under vite-node) — read them from
// fs.constants, which is the platform-correct source under both ESM and
// CJS (jiti). Same convention as little-coder-settings.mjs.
const O_WRONLY = fs.constants.O_WRONLY;
const O_CREAT = fs.constants.O_CREAT;
const O_EXCL = fs.constants.O_EXCL;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW;

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
 * Atomically write `value` as pretty JSON to `path` (0o600 temp + rename,
 * O_EXCL | O_NOFOLLOW temp, parent dirs created). Synchronous — the file is
 * small; any LOCK around the surrounding read-modify-write is the caller's
 * async concern. The full-write loop guarantees a rename never lands a
 * truncated (malformed) file where there was a valid one.
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
