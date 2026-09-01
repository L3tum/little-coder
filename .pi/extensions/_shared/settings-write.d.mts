// Type declarations for settings-write.mjs (the shared atomic + locked JSON
// settings writer). Sibling `.d.mts` next to the `.mjs`: under the repo's
// `moduleResolution: "bundler"`, a `./settings-write.mjs` import from TS
// resolves to this declaration (TS maps `.mjs` → `.d.mts`). Note there is no
// `.d.ts` fallback for a `.mjs` source under bundler resolution — if this
// declaration is wrong the fix is a declaration fix (or renaming the source
// to `.mts`), not a `.d.ts`.
//
// The module itself is plain dependency-light ESM so the plain-.mjs
// launcher (bin/launcher-internal.mjs) can import it natively and the jiti-
// loaded TS extensions can import it with these types.

export interface SettingsLockOptions {
  /** proper-lockfile `stale` (ms). Default 30000. */
  staleMs?: number;
  /** Max ELOCKED retry attempts. Default 10. */
  maxRetries?: number;
  /** Delay between ELOCKED retries (ms). Default 20. */
  retryDelayMs?: number;
}

/**
 * Acquire the shared settings lock (resource = the settings DIRECTORY,
 * sidecar lockfile at `<settingsPath>.lock`, realpath: false, explicit
 * stale). `opts` tunes the retry budget (see SettingsLockOptions).
 *
 * ASYNC retry loop on ELOCKED (no busy-wait); non-ELOCKED
 * errors and exhaustion reject — exhaustion names the lock path.
 *
 * proper-lockfile 4.x quirk: `lock(file, options)` resolves to the
 * release function — `const release = await acquireSettingsLock(p);
 * try { … } finally { await release(); }`. (An acquired async lock also
 * refreshes the sidecar lockfile's dir mtime on an unref'd timer until
 * released — harmless for process-lifetime and session writers.)
 */
export function acquireSettingsLock(
  settingsPath: string,
  opts?: SettingsLockOptions,
): Promise<() => void>;

/**
 * Atomically write `value` as pretty JSON to `path` (0o600 temp + rename,
 * O_EXCL | O_NOFOLLOW temp, parent dirs created). Synchronous; the caller
 * holds the lock for the surrounding read-modify-write.
 */
export function atomicWriteJson(path: string, value: unknown): void;

export interface SettingsFileUpdateResult {
  ok: boolean;
  /** The settings path that was (or would have been) written. */
  path: string;
  /** One reconciled error message (malformed file, lock exhaustion, …). */
  error?: string;
  /** The written document (ok path only). */
  value?: Record<string, unknown>;
}

/**
 * Read-modify-write a settings file under the shared lock. NEVER rejects:
 * every failure is returned as `{ ok: false, path, error }`.
 */
export function updateSettingsFile(
  settingsPath: string,
  mutate: (doc: Record<string, unknown>) => void,
  opts?: SettingsLockOptions,
): Promise<SettingsFileUpdateResult>;
