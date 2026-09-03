// little-coder update check.
// Polls the L3tum fork's GIT TAGS for a newer version and (in TTY mode)
// offers to install it before the agent starts. Best-effort throughout:
// if anything fails, we skip silently — never block the agent over a
// version check.
//
// Supply-chain pin (Security M2): the version source is the fork's tag LIST
// (immutable, per-tag), never the mutable main branch — a compromised or
// careless push to main used to be both the "latest" we display AND what the
// install would fetch. The displayed version is therefore the exact tag the
// install target pins to (#vX.Y.Z), so what the notice shows is what gets
// installed (no drift). The prompt defaults to NO ([y/N]): an update is an
// explicit opt-in, not an ambient yes-on-empty-Enter.
//
// Startup-performance design: the pre-spawn check is CACHE-ONLY. It never
// touches the network on the launch critical path (an offline machine with a
// stale cache used to pay a ~2 s fetch timeout on every launch). The
// network refresh runs fire-and-forget (refreshUpdateCache) and writes the
// cache for the NEXT launch — so the update notice reflects the last
// successful online refresh (≤ 12 h old once a launch with network has
// run); a stale "latest" is only ever behind reality, and an offline
// machine can see an arbitrarily stale one.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { littleCoderCacheDir } from "../.pi/extensions/_shared/cache-path.mjs";
// The shared lock-FREE atomic writer (Security L2): the version-check cache
// is a SCRATCH file (single-purpose, regenerated on every online launch),
// so it deliberately skips the shared settings LOCK — but it gets the same
// atomic 0600 temp + rename, O_EXCL | O_NOFOLLOW protocol every other
// writer in this repo uses, from one shared implementation instead of a
// second local copy. (Importing settings-write.mjs directly would drag
// proper-lockfile's CJS module into the launcher's module graph at load
// time — a startup critical-path cost; atomic-write.mjs is the lock-free
// half of the same protocol.)
import { atomicWriteJson } from "../.pi/extensions/_shared/atomic-write.mjs";

// The fork's tag list (immutable per tag; per_page=100 covers any realistic
// tag count — fetchLatest picks the highest valid semver among them).
const VERSION_SOURCE =
  "https://api.github.com/repos/L3tum/little-coder/tags?per_page=100";
// The unpinned base; the ACTUAL install target is pinned to the discovered
// tag at update time (installTargetFor) so the displayed version is the
// installed version.
const INSTALL_BASE = "github:L3tum/little-coder";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 h
const MS_PER_HOUR = 3_600_000;
const FETCH_TIMEOUT_MS = 2000;

// Three tiers so a stale cache reads naturally: <1h → minutes,
// <48h → hours, else days. Caller passes an already-clamped (>= 0) ageH.
export function formatAgeHours(ageH) {
  return ageH < 1
    ? ` (last checked ${Math.round(ageH * 60)}m ago)`
    : ageH < 48
      ? ` (last checked ${Math.round(ageH)}h ago)`
      : ` (last checked ${Math.round(ageH / 24)}d ago)`;
}
// A real npm release is always valid semver, so a format-failing `latest` is
// a corrupt/typo/tampered cache — reject it instead of feeding it to
// compareSemver. Tolerates a leading `v` and an optional pre-release
// and/or build suffix — the two are separate optional groups so a combined
// `1.2.3-rc.1+build` (pre-release AND build) is accepted, not just a lone
// `-pre` or `+build`.
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export { SEMVER_RE };

// A root package.json version is only usable for the update check
// if it is real semver; a missing/malformed version (corrupt root
// package.json) means we skip the check entirely rather than comparing
// against a bogus "latest".
//
// SINGLE SOURCE OF TRUTH for semver validation in this repo: bin/little-coder.mjs
// imports isValidSemver from here for its startup --version/update-compare
// gate. Do not fork a second copy — keep every version comparison on this
// one function (behavior pinned in update-check.test.mjs).
export function isValidSemver(v) {
  return typeof v === "string" && SEMVER_RE.test(v);
}

// The version-check cache path. The absolute-home + XDG-cache-base ladder
// lives in the shared cache-path.mjs (previously duplicated verbatim in
// llama-cpp-provider/config.ts); this is just the little-coder/version-
// check.json suffix.
export function cachePath() {
  return join(littleCoderCacheDir(), "version-check.json");
}

export function readCache(now = Date.now(), allowStale = false) {
  try {
    const path = cachePath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof data.checkedAt !== "number" || typeof data.latest !== "string")
      return null;
    if (!SEMVER_RE.test(data.latest)) return null;
    if (!allowStale && now - data.checkedAt > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

// Same parse as readCache but WITHOUT the TTL check: a stale-but-present
// cache is still a usable "latest" for the cache-only pre-spawn comparison.
// Only the `latest` string matters here; checkedAt is ignored by design.
export function readCacheAllowStale() {
  return readCache(Date.now(), true);
}

// TTL gate applied to an ALREADY-parsed+validated cache entry (readCache /
// readCacheAllowStale shape). Lets the caller read the file ONCE and share the
// snapshot between refreshUpdateCache (which needs the TTL gate) and
// checkForUpdate (which does not) instead of both re-reading the file.
export function isFreshCache(data, now = Date.now()) {
  return (
    !!data &&
    typeof data.checkedAt === "number" &&
    now - data.checkedAt <= CACHE_TTL_MS
  );
}

// (M-arch-2) See the module header: scratch file, deliberately lock-FREE —
// but the BYTES go through the shared atomic writer (atomic-write.mjs), so
// a reader never sees a torn file and the protocol lives in one place.
export function writeCache(latest, now = Date.now()) {
  try {
    // A successful fetch clears any prior lastFailedAt (negative-cache stamp).
    atomicWriteJson(cachePath(), { checkedAt: now, latest });
  } catch {
    // best-effort; permission errors etc. are not fatal
  }
}

// (P4) Record a failed background fetch (negative caching): preserve any
// existing usable checkedAt/latest so the next launch reuses it, and stamp
// lastFailedAt so launches within the TTL window skip the network instead of
// re-hammering a known-down endpoint.
function writeFailedAt(now, raw) {
  try {
    const prev =
      raw && typeof raw.checkedAt === "number" && typeof raw.latest === "string"
        ? raw
        : null;
    atomicWriteJson(cachePath(), {
      checkedAt: prev ? prev.checkedAt : now,
      latest: prev ? prev.latest : "",
      lastFailedAt: now,
    });
  } catch {
    // best-effort
  }
}

// Compare semver strings. Handles X.Y.Z[-pre][+build]. Returns 1 if a > b,
// -1 if a < b, 0 if equal. Build metadata is ignored.
export function compareSemver(a, b) {
  const parse = (v) => {
    const withoutBuild = String(v).trim().replace(/^v/i, "").split("+", 1)[0];
    const prereleaseAt = withoutBuild.indexOf("-");
    const core =
      prereleaseAt === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseAt);
    const pre = prereleaseAt === -1 ? "" : withoutBuild.slice(prereleaseAt + 1);
    const parts = core.split(".").map((n) => parseInt(n, 10));
    return {
      major: Number.isFinite(parts[0]) ? parts[0] : 0,
      minor: Number.isFinite(parts[1]) ? parts[1] : 0,
      patch: Number.isFinite(parts[2]) ? parts[2] : 0,
      pre: pre ? pre.split(".") : [],
    };
  };
  const compareNumber = (x, y) => (x === y ? 0 : x > y ? 1 : -1);
  const comparePrerelease = (pa, pb) => {
    if (pa.length === 0 && pb.length === 0) return 0;
    if (pa.length === 0) return 1;
    if (pb.length === 0) return -1;
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      if (pa[i] === undefined) return -1;
      if (pb[i] === undefined) return 1;
      if (pa[i] === pb[i]) continue;
      const aNum = /^\d+$/.test(pa[i]);
      const bNum = /^\d+$/.test(pb[i]);
      if (aNum && bNum) return compareNumber(Number(pa[i]), Number(pb[i]));
      if (aNum) return -1;
      if (bNum) return 1;
      return pa[i] > pb[i] ? 1 : -1;
    }
    return 0;
  };
  const pa = parse(a);
  const pb = parse(b);
  const core =
    compareNumber(pa.major, pb.major) ||
    compareNumber(pa.minor, pb.minor) ||
    compareNumber(pa.patch, pb.patch);
  return core || comparePrerelease(pa.pre, pb.pre);
}

export async function fetchLatest() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(VERSION_SOURCE, { signal: ctrl.signal });
    if (!res.ok) return null;
    const tags = await res.json();
    if (!Array.isArray(tags)) return null;
    // The tag list is the source of truth: keep only valid-semver tags and
    // pick the highest (compareSemver ignores a leading v, so "v1.8.2" and
    // "1.8.2" sort alike). Non-release tags (branch names, release-please
    // noise) are filtered out by isValidSemver.
    let best = null;
    for (const tag of tags) {
      const name = typeof tag?.name === "string" ? tag.name : "";
      if (!isValidSemver(name)) continue;
      if (best === null || compareSemver(name, best) > 0) best = name;
    }
    return best;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Pin the install target to the discovered tag: the version the notice shows
// is the exact ref npm fetches (no main-branch drift between display and
// install). Strips a leading v for display purposes only — the ref keeps it.
export function installTargetFor(latest) {
  return `${INSTALL_BASE}#${String(latest).trim()}`;
}

export function displayVersion(latest) {
  return String(latest).trim().replace(/^v/i, "");
}

// Fire-and-forget cache refresh for the NEXT launch. The launcher starts this
// before the (now cache-only) checkForUpdate and does not await it — the
// launcher process lives for the whole session, so the fetch typically
// completes and writes the cache even though this launch already proceeded.
// Mirrors the old fetch-on-stale behavior without ever touching the launch
// critical path. Never throws.
export async function refreshUpdateCache(opts = {}) {
  try {
    const skip = opts.skip ?? shouldSkip();
    if (skip === true) return; // CI / --no-update-check / non-interactive flags
    // Read the raw (possibly stale) cache once; the caller may pre-share a
    // snapshot (the launcher reads once and shares it with checkForUpdate).
    const raw = opts.cache !== undefined ? opts.cache : readCacheAllowStale();
    // Fresh (checkedAt within TTL) → nothing to do.
    if (raw && isFreshCache(raw)) return;
    const now = Date.now();
    // (P4) Negative caching: the last online fetch FAILED recently (within
    // TTL) and the cache still has a usable latest (raw non-null ⟹ valid
    // checkedAt + semver latest) → don't re-hammer a known-down endpoint; reuse
    // the (possibly stale) latest for another launch. A successful fetch clears
    // lastFailedAt; an expired failure window falls through to a real fetch.
    if (
      raw &&
      typeof raw.lastFailedAt === "number" &&
      now - raw.lastFailedAt < CACHE_TTL_MS
    ) {
      return;
    }
    const latest = await fetchLatest();
    if (latest) {
      writeCache(latest, now);
    } else {
      writeFailedAt(now, raw);
    }
  } catch {
    // best-effort; a failed refresh just means the same (possibly stale)
    // "latest" is used for another launch.
  }
}

// Decide whether to skip the check entirely. Errs toward NOT prompting in
// any context that smells programmatic.
export function shouldSkip(
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
) {
  if (env.LITTLE_CODER_NO_UPDATE_CHECK === "1") return true;
  if (env.CI === "true" || env.CI === "1") return true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-update-check") return true;
    if (a === "--help" || a === "-h") return true;
    if (a === "--version" || a === "-v") return true;
    if (a === "--list-models") return true;
    if (a === "--export") return true;
    if (a === "--mode") {
      const next = argv[i + 1];
      if (next === "rpc" || next === "json") return true;
    }
  }
  // Non-TTY runs: scripts, pipes, --print pipelines. Notice only, no prompt.
  if (!stdout.isTTY) return "notice-only";
  return false;
}

export function promptYesNo(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(question, (answer) => {
      rl.close();
      const a = (answer ?? "").trim().toLowerCase();
      // DEFAULT NO: an update is an explicit opt-in (an empty Enter must not
      // run `npm install -g` against a network-pinned ref).
      resolve(a === "y" || a === "yes");
    });
  });
}

// Returns `true` if the launcher should NOT proceed to spawn pi (because we
// updated and exited / the user opted out and we should re-run).  Returns
// `false` to let the launcher continue.
//
// CACHE-ONLY: uses readCacheAllowStale() — even a stale cache is compared
// (a stale "latest" is only ever behind reality — never a false positive).
// No fetch here; the network refresh is refreshUpdateCache(), started
// fire-and-forget by the launcher.
export async function checkForUpdate(currentVersion, opts = {}) {
  const skip = opts.skip ?? shouldSkip();
  if (skip === true) {
    opts.onDecide?.(); // skipped — the fast "should we even check?" decision is done
    return false;
  }

  // Use the caller-provided snapshot if given (launcher reads once); else read.
  const cache = opts.cache !== undefined ? opts.cache : readCacheAllowStale();
  const latest = cache?.latest;
  const hasUpdate = !!latest && compareSemver(latest, currentVersion) > 0;
  // The decision (cache read + compare) is done. The caller marks the
  // "updatecheck" phase here (via opts.onDecide) so the (possibly slow) TTY
  // prompt below is billed to a separate "updateprompt" phase, not updatecheck.
  opts.onDecide?.();
  if (!hasUpdate) return false;

  // How old the cached "latest" is — shown so a stale cache doesn't look like
  // a just-discovered release. Fresh cache -> "Xm ago", older -> "Xh ago".
  // Clamp ageH to >= 0: a clock skew / future-dated cache (checkedAt in the
  // future) would otherwise render a negative age, e.g. "last checked -3h ago".
  const ageH = Math.max(0, (Date.now() - cache.checkedAt) / MS_PER_HOUR);
  const ageNote = formatAgeHours(ageH);
  const latestV = displayVersion(latest);
  const installTarget = installTargetFor(latest);
  const headline = `\n📦 little-coder v${latestV} is available (you have v${currentVersion})${ageNote}.`;

  if (skip === "notice-only") {
    process.stderr.write(
      `${headline}\n   Update with: npm install -g ${installTarget}\n\n`,
    );
    return false;
  }

  process.stderr.write(`${headline}\n`);
  const wantsUpdate = await promptYesNo("   Update now? [y/N] ");
  if (!wantsUpdate) {
    process.stderr.write("   Skipping update for this run.\n\n");
    return false;
  }

  process.stderr.write(`\n   Running: npm install -g ${installTarget}\n\n`);
  const result = spawnSync("npm", ["install", "-g", installTarget], {
    stdio: "inherit",
  });
  if (result.status === 0) {
    process.stderr.write(
      `\n   ✓ Updated to v${latestV}. Re-run \`little-coder\` to use the new version.\n\n`,
    );
    return true;
  }
  process.stderr.write(
    `\n   ✗ Update failed (npm exit ${result.status}). Continuing with v${currentVersion}.\n\n`,
  );
  return false;
}
