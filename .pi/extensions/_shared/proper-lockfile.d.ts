// Ambient declaration for proper-lockfile@^4.1.2 (ships no types). Re-verify
// against the package API on every major upgrade.
declare module "proper-lockfile" {
  export interface LockOptions {
    realpath?: boolean;
    lockfilePath?: string;
    stale?: number;
    fs?: unknown;
    // retries intentionally omitted: proper-lockfile throws ESYNC if retries
    // are passed to the sync API, and little-coder's writers use their own
    // (async, 10 × ~20 ms) ELOCKED retry loop instead — as pi does.
  }
  /**
   * proper-lockfile 4.x: the async lock RESOLVES TO THE RELEASE FUNCTION
   * (`const release = await lockfile.lock(f, opts); … await release();`) —
   * it is not a bare Promise<void>. An acquired async lock also refreshes
   * the sidecar lockfile's dir mtime on an unref'd timer until released —
   * harmless for process-lifetime and session writers.
   */
  export function lock(
    file: string,
    options?: LockOptions,
  ): Promise<() => void>;
  export function unlock(file: string, options?: LockOptions): Promise<void>;
  export function lockSync(file: string, options?: LockOptions): () => void;
  const lockfile: {
    lock: typeof lock;
    unlock: typeof unlock;
    lockSync: typeof lockSync;
  };
  export default lockfile;
}
