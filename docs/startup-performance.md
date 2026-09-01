# Startup performance

How to measure and understand little-coder's launch cost, and what each
number means.

## Enabling timing

```sh
LITTLE_CODER_TIMING=1 little-coder
```

One environment variable drives both sides of the launch:

1. **Launcher side** — `bin/little-coder.mjs` measures its own critical-path
   phases and prints one line to stderr _after_ spawning pi:

   ```
   little-coder launch timing: discovery=12ms updatecheck=0ms updateprompt=0ms settings=3ms spawn=4ms total=25ms
   ```

   - `discovery` — preflight + package.json reads + extension discovery
   - `updatecheck` — the (cache-only) update check: cache read + version
     decision (fast; never touches the network)
   - `updateprompt` — the awaited TTY "Update now?" prompt (0 ms when no
     prompt is offered — notice-only, no update, or a non-TTY run)
   - `settings` — settings merge / lastChangelogVersion bookkeeping
   - `spawn` — `child_process.spawn` call itself
   - `total` — from process start to child spawned

2. **Child side** — the launcher passes `PI_TIMING=1` through to pi, which
   reports its own startup timings, including **per-extension** module import
   and factory times, as a `--- Startup Timings: extensions ---` block on
   stderr. (Set `PI_TIMING=1` manually to get the same without
   `LITTLE_CODER_TIMING`.)

3. **Preload** — `_shared/subprocess-preload.mjs` (loaded via `--import`
   before pi starts) prints its own evaluation cost:

   ```
   little-coder launch timing: preload=87ms
   ```

This is the `--import` critical path: it runs _before_ pi's entry point and
includes loading pi's extension modules through jiti.

## Where the child-side time goes

Measured with `LITTLE_CODER_TIMING=1` on a cold cache (fresh clone, no
`node_modules/.cache/jiti`):

| Phase                       | Typical cold   | Typical warm |
| --------------------------- | -------------- | ------------ |
| launcher (total)            | ~30 ms         | ~30 ms       |
| preload (`--import`)        | hundreds of ms | tens of ms   |
| pi boot + extensions (jiti) | seconds        | seconds      |

**The dominant cost is pi loading ~14 extension modules through jiti.** Pi's
loader creates a fresh `jiti` instance per extension with
`moduleCache: false`, and jiti re-transforms TypeScript on every import.
Shared CJS dependencies (e.g. `semver`, `undici`, `proper-lockfile`) are
re-resolved per extension. jiti's disk cache
(`node_modules/.cache/jiti`) absorbs part of the transform cost on the second
launch, but not all of it.

This cost lives in pi's loader, not in little-coder's code, so it is not
something little-coder can remove directly. The measurement exists so that
(a) regressions in our own phase (`preload`, launcher) are visible, and
(b) we can report the jiti-dominated extension phase upstream to pi with
numbers.

## Update check: cache-only by design

`checkForUpdate()` (bin/update-check.mjs) is **cache-only**: it never touches
the network on the launch critical path. It compares the installed version
against the last-known `latest` in the local cache (even a stale cache entry
is compared — `readCacheAllowStale()` — a stale value is only ever behind
reality, never a false positive; offline, `latest` can be arbitrarily stale).

The network refresh is `refreshUpdateCache()`, started fire-and-forget by the
launcher before the check. The launcher process stays alive for the whole
session, so the fetch typically completes and writes the cache **for the next
launch**. Consequences:

- offline launch, stale cache: 0 ms update-check cost (previously up to the
  fetch timeout);
- an update notice appears within **one launch after the next successful
  online refresh** (up to 12 h after a release); while offline, the cached
  `latest` can be arbitrarily stale;
- `LITTLE_CODER_NO_UPDATE_CHECK=1` / `--no-update-check` / CI still suppress
  both the check and the background refresh.

## Settings writes: one shared locked writer

The launcher's startup stamps (`quietStartup`, `lastChangelogVersion`, and the
`pi-better-openai.json` footer) are written through the ONE shared writer
(`_shared/settings-write.mjs`), the same implementation the TS extensions use
for `/allow` and `/deny`. This matters for startup performance in two ways:

- **Module load cost** — importing that writer pulls `proper-lockfile` (CJS)
  into the launcher's module graph at load time (a small, one-time cost on the
  critical path). The version-check cache write is deliberately decoupled: it
  uses a small UNLOCKED atomic writer (O_EXCL 0600 temp + rename), so the
  update-check module does not drag the locked writer (and `proper-lockfile`)
  into its own path. The cache is a scratch file — last-writer-wins across
  concurrent launchers is fine, and there is no read-modify-write to protect.
- **Bounded lock wait** — the shared writer takes a `proper-lockfile` lock on
  `<settings.json>.lock`, the same lock a live session's `/allow`/`/deny`
  takes. If a session holds it, the launcher's settings stamp retries with an
  ASYNC ELOCKED backoff (~10 × ~20 ms), so the worst-case `settings` phase
  under contention is ~200 ms (never a busy-wait; a lock that never frees
  simply refuses the stamp and startup continues, leaving the file untouched).
  On an uncontended launch the settings phase is a few ms.

## Related settings

| Knob                                                         | Effect                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `LITTLE_CODER_TIMING=1`                                      | timing lines (this doc)                                                                                  |
| `PI_TIMING=1`                                                | pi's own startup timings (set automatically by the launcher when `LITTLE_CODER_TIMING=1`)                |
| `LITTLE_CODER_NO_UPDATE_CHECK=1`                             | disable update check + background refresh                                                                |
| `little_coder.model_profiles["<provider/model>"].max_tokens` | settings file: per-profile request-level max_tokens cap (see benchmark-profiles); `0` = no output limit. |
| `little_coder.token_limit_auto_continue`                     | settings file: off-switch for the auto-continue length-stop loop (default on)                            |

## Reproducing the measurement

```sh
LITTLE_CODER_TIMING=1 little-coder 2> timing.txt
# ... use the agent, exit
cat timing.txt
```

Both lines (`launch timing:` and `Startup Timings:`) appear on stderr at
startup; the `Startup Timings: extensions` block lists every extension with
its module-import and factory times.
