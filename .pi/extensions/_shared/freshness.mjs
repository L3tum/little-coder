// File-freshness keys for mtime-gated caches (permission-gate's trust
// recheck, benchmark-profiles' resolve memo). The key is `${mtimeMs}:${size}`
// from lstatSync — cheap (one syscall, no open/read) and sensitive to both
// content edits (size or mtime) and external metadata bumps.
import { lstatSync } from "node:fs";

/** `${mtimeMs}:${size}` via lstatSync; null on any error (ENOENT = "no file").
 *  lstat (never stat): no symlink following, one syscall. A directory
 *  lstats fine — its key just tracks the directory's own metadata. */
export function fileFreshnessKey(path) {
  try {
    const s = lstatSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}
