#!/usr/bin/env node
// little-coder launcher.
// Spawns the bundled pi runtime with our AGENTS.md and custom extensions
// wired in — works from any working directory.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkForUpdate,
  refreshUpdateCache,
  readCacheAllowStale,
  isValidSemver,
} from "./update-check.mjs";
import {
  discoverBundledExtensionArgs,
  formatLaunchTiming,
  shouldAppendSystemPrompt,
} from "./launcher-helpers.mjs";
import {
  bundledPackageArgs,
  readJson,
  resolveExtensionEntry,
  setPkgRoot,
  updateSettingsFile,
} from "./launcher-internal.mjs";

// ---- 0. Optional launch timing (LITTLE_CODER_TIMING=1) ----
// Phase marks on the launcher's critical path; one stderr line after spawn.
// The child side emits per-extension load timings from
// _shared/subprocess-preload.mjs under the same env var. See
// docs/startup-performance.md.
const LAUNCH_TIMING = process.env.LITTLE_CODER_TIMING === "1";
const TIMING = {
  t0: performance.now(),
  discovery: 0,
  updatecheck: 0,
  updateprompt: 0,
  settings: 0,
  spawn: 0,
};
// recordPhase stores ABSOLUTE performance.now() marks (elapsed since process
// start). The emit near the end converts successive marks into PER-PHASE
// durations (discovery, updatecheck−discovery, updateprompt−updatecheck,
// settings−updateprompt, spawn−settings) so the phases sum to ≈ total.
// Every mark is recorded unconditionally — a phase whose work is skipped
// (e.g. LITTLE_CODER_NO_UPDATE_CHECK=1 or a missing/invalid version) still
// records its mark, so skipped work simply shows as a ≈0 ms phase.
const recordPhase = (name) => {
  TIMING[name] = performance.now();
};

// ---- 1. Node version preflight (>= 22.19.0, matching pi.dev) ----
const MIN_NODE = [22, 19, 0];
const cur = process.versions.node.split(".").map((n) => parseInt(n, 10));
const tooOld =
  cur[0] < MIN_NODE[0] ||
  (cur[0] === MIN_NODE[0] && cur[1] < MIN_NODE[1]) ||
  (cur[0] === MIN_NODE[0] && cur[1] === MIN_NODE[1] && cur[2] < MIN_NODE[2]);
if (tooOld) {
  console.error(
    `little-coder requires Node.js >= ${MIN_NODE.join(".")} (you have ${process.versions.node}).\n` +
      `Install a newer Node from https://nodejs.org or via nvm: 'nvm install 22'.`,
  );
  process.exit(1);
}

// ---- 2. Resolve package install root ----
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
setPkgRoot(pkgRoot);

// ---- 3. Resolve the bundled pi CLI entry point ----
// We invoke pi's JS entry directly under the current Node binary instead of
// the `node_modules/.bin/pi` shim. Two reasons:
//   1. On Windows, `.bin/pi.cmd` is an npm-generated batch shim. When it (or
//      anything it transitively invokes) is launched from a path containing
//      spaces — most notably the default Node install location
//      `C:\Program Files\nodejs\` — cmd's whitespace tokenization can split
//      the path at the first space and produce errors like
//      `'C:\Program' is not recognized as an internal or external command`
//      (see issue #23). Spawning `process.execPath` with the resolved cli.js
//      path as an argv element sidesteps cmd entirely — Node's spawn handles
//      Windows argv quoting itself.
//   2. We no longer need a separate `cmd.exe /c …` branch, so the same
//      spawn path works identically on Linux, macOS, and Windows.
const piPkgRoot = join(
  pkgRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
let piEntry;
let piPkgVersion;
// Test/debug hook: LITTLE_CODER_PI_ENTRY overrides the resolved pi entry (a
// stub child script for the hermetic signal-propagation test, or a custom pi
// entry). Bypasses the node_modules resolution entirely.
const piEntryOverride = process.env.LITTLE_CODER_PI_ENTRY;
if (piEntryOverride) {
  piEntry = resolve(piEntryOverride);
  piPkgVersion = ""; // not a real bundled pi; version is unused for a stub
} else {
  try {
    const piPkgJson = JSON.parse(
      readFileSync(join(piPkgRoot, "package.json"), "utf-8"),
    );
    const binRel =
      typeof piPkgJson?.bin === "string" ? piPkgJson.bin : piPkgJson?.bin?.pi;
    if (typeof binRel !== "string")
      throw new Error("pi package.json has no bin.pi entry");
    piEntry = resolve(piPkgRoot, binRel);
    // Captured here (not re-read in step 8) so the bundled pi version comes
    // from the very package.json we resolved piEntry from — no second parse.
    if (typeof piPkgJson?.version === "string")
      piPkgVersion = piPkgJson.version;
  } catch (err) {
    console.error(
      `little-coder: cannot resolve pi cli entry under ${piPkgRoot}.\n` +
        `Underlying error: ${err?.message ?? err}\n` +
        `Try reinstalling: npm install -g github:L3tum/little-coder`,
    );
    process.exit(1);
  }
}
if (!existsSync(piEntry)) {
  console.error(
    `little-coder: cannot find pi at ${piEntry}.\n` +
      `Try reinstalling: npm install -g github:L3tum/little-coder`,
  );
  process.exit(1);
}

// ---- 4. Auto-discover bundled extensions ----
const rootPkgJson = readJson(join(pkgRoot, "package.json")) ?? {};
const extDir = join(pkgRoot, ".pi", "extensions");
const subprocessPreload = join(extDir, "_shared", "subprocess-preload.mjs");
const rawUserArgs = process.argv.slice(2);
const subagentMode = Boolean(
  process.env.LITTLE_CODER_SUBAGENT || process.env.PI_SUBAGENT_DEPTH,
);
const extArgs = discoverBundledExtensionArgs(extDir, {
  subagentMode,
  resolveExtensionEntry,
});
const packageArgs = bundledPackageArgs(rootPkgJson, { subagentMode });
recordPhase("discovery");

// ---- 5. Update check (cache-only on the critical path) ----
// checkForUpdate no longer touches the network: it compares against the
// (possibly stale) local cache, so an offline launch costs 0 ms here. The
// fetch that keeps the cache current runs fire-and-forget and writes the
// cache for the NEXT launch — the update notice reflects the last successful
// online refresh (see update-check.mjs / docs/startup-performance.md).
// The update check needs a valid semver version in the root
// package.json. A missing/malformed version (corrupt root package.json)
// means we skip the check, refresh, and notice entirely rather than
// comparing against a bogus "latest".
const hasVersion = isValidSemver(rootPkgJson?.version);
const currentVersion = hasVersion ? rootPkgJson.version : "0.0.0";
if (hasVersion) {
  // Read the update cache ONCE and share the snapshot with both callers:
  // refreshUpdateCache applies the TTL gate to it (fetch if stale) and
  // checkForUpdate compares it (allowStale). readCacheAllowStale never throws.
  // A single read also means both see the same snapshot (no torn read between
  // two separate file reads).
  let cachedUpdate = null;
  try {
    cachedUpdate = readCacheAllowStale();
  } catch {
    cachedUpdate = null;
  }
  void refreshUpdateCache({ cache: cachedUpdate }); // never rejects
  const exitAfterCheck = await checkForUpdate(currentVersion, {
    cache: cachedUpdate,
    // Mark the end of the (fast) decision so the awaited TTY prompt below is
    // billed to its own "updateprompt" phase, not "updatecheck".
    onDecide: () => recordPhase("updatecheck"),
  });
  if (exitAfterCheck) {
    // Successful update happened; user needs to re-run the new binary.
    process.exit(0);
  }
}
recordPhase("updateprompt");

// ---- 6. Compose pi argv ----
// --no-context-files : disable pi's automatic AGENTS.md / CLAUDE.md loading
// --no-extensions    : skip pi's auto-discovery from cwd; explicit -e flags still load
// --system-prompt    : load <pkgRoot>/AGENTS.md as the base system prompt
// --append-system-prompt : amend the prompt with cwd AGENTS.md when present
//
// Strip our own flags before forwarding to pi so it doesn't reject them.
const userArgs = rawUserArgs.filter((a) => a !== "--no-update-check");
const agentsMd = join(pkgRoot, "AGENTS.md");
const cwdAgentsMd = join(process.cwd(), "AGENTS.md");
const appendCwdAgents = shouldAppendSystemPrompt(agentsMd, cwdAgentsMd);

const piArgs = [
  "--no-context-files",
  "--no-extensions",
  ...(existsSync(agentsMd) ? ["--system-prompt", agentsMd] : []),
  ...(appendCwdAgents ? ["--append-system-prompt", cwdAgentsMd] : []),
  ...extArgs,
  ...packageArgs,
  ...userArgs,
];

// ---- 7. Suppress pi's own version-banner by default ----
// pi is an internal dependency here; users install `little-coder` and shouldn't
// see in-session nags about updating the underlying coding-agent package.
// PI_SKIP_VERSION_CHECK is the surgical pi switch (interactive-mode.js:525)
// that gates the "Update Available" banner without touching pi's other
// network-dependent startup paths. Honor an explicit user value (set to "0" or
// anything else to re-enable the banner; PI_OFFLINE=1 also re-overrides).
if (process.env.PI_SKIP_VERSION_CHECK === undefined) {
  process.env.PI_SKIP_VERSION_CHECK = "1";
}

// ---- 8. Force pi's global quietStartup + pin lastChangelogVersion ----
// Two non-destructive merges into ~/.pi/agent/settings.json (or the dir pointed
// to by PI_CODING_AGENT_DIR):
//
//   1. quietStartup: true
//        Pi's interactive mode otherwise dumps an [Extensions] / [Skills] /
//        [Prompts] inventory on every launch. Pi reads global settings from
//        <agentDir>/settings.json — NOT from our npm-installed package dir —
//        so our shipped .pi/settings.json doesn't reach it. To see the
//        inventory anyway, run `little-coder --verbose`.
//
//   2. lastChangelogVersion: <currently installed pi version>
//        Pi reads its own bundled CHANGELOG.md on startup and renders a
//        "What's New" block for every entry strictly newer than this stored
//        version (interactive-mode.js:getChangelogForDisplay). That makes pi's
//        upstream changelog show up inside little-coder's TUI every time we
//        bump the bundled pi dep — which is jarring because little-coder is
//        the surface, not pi. We pre-stamp this field to the version we just
//        bundled BEFORE pi starts, so pi sees "user already saw this", and
//        the block never renders. Users who genuinely want to read pi's
//        upstream changelog can still do so with `/changelog` inside the TUI.
//
// Existing keys are preserved. We only write when the desired value differs
// from what's already on disk, so this is a no-op on warm launches.
//
// The write goes through updateSettingsFile (the ONE shared writer in
// _shared/settings-write.mjs): atomic (0600 temp + rename) AND under the same
// proper-lockfile lock that updateGlobalSettings takes for /allow and /deny
// (async lock, no busy-wait). The idempotent mutations are applied to a FRESH
// under-lock read, so a concurrent /allow made since our earlier read is not
// clobbered. A malformed existing file is REFUSED by the shared writer (never
// clobbered); the per-write refusal check below names the full path and the
// spawn proceeds.
// Residual race: pi itself can write settings.json without our lock — accepted
// (pi's own writer is the same user; a collision loses at most one stamp, and
// the next launch re-stamps). Best-effort: write failures (read-only HOME,
// lock contention) are logged and never block the spawn; the outer try/catch
// guards the remaining steps.
try {
  const agentDirEnv = process.env.PI_CODING_AGENT_DIR;
  let agentDir;
  if (agentDirEnv && agentDirEnv.trim().length > 0) {
    agentDir =
      agentDirEnv === "~"
        ? homedir()
        : agentDirEnv.startsWith("~/")
          ? homedir() + agentDirEnv.slice(1)
          : agentDirEnv;
  } else {
    agentDir = join(homedir(), ".pi", "agent");
  }
  mkdirSync(agentDir, { recursive: true });
  const globalSettingsPath = join(agentDir, "settings.json");
  // Pre-read: used ONLY to compute the no-op guard (skip a pointless lock +
  // write when the stamps are already current). The actual write re-reads
  // under the lock and applies the idempotent mutations to that fresh doc.
  // A malformed file makes the guard unknown (→ attempt the write); the
  // shared writer re-reads under the lock, REFUSES the malformed file
  // (never clobbers it), and the catch below names the full path. This
  // parse-no-refuse duplication is deliberate: the launcher can only
  // import the shared .mjs writer, and the refusal message must name the
  // user's full path.
  let globalSettings; // undefined = missing file / malformed / non-object
  if (existsSync(globalSettingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(globalSettingsPath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        globalSettings = parsed;
      }
    } catch {
      // corrupted JSON or non-object root: guard unknown, force the write
    }
  }

  // Read the bundled pi version — reuses the package.json parsed in step 3
  // (same file we resolved piEntry from), so no second readFileSync.
  const bundledPiVersion = piPkgVersion;

  const mutated =
    !globalSettings ||
    globalSettings.quietStartup !== true ||
    (bundledPiVersion &&
      globalSettings.lastChangelogVersion !== bundledPiVersion);
  if (mutated) {
    // Async: the shared writer's ELOCKED retry loop must not
    // busy-wait the event loop. Best-effort — a refusal leaves the file
    // untouched and startup continues.
    const result = await updateSettingsFile(globalSettingsPath, (doc) => {
      doc.quietStartup = true;
      if (bundledPiVersion) {
        doc.lastChangelogVersion = bundledPiVersion;
      }
    });
    if (!result.ok) {
      // Write-only refusal: the corrupt/locked file is left untouched and
      // startup continues. The writer's message is basename-only (it serves
      // any settings file), so name the full path here.
      console.error(
        "little-coder: " +
          globalSettingsPath +
          " — " +
          result.error +
          " (file left untouched). Fix it manually.",
      );
    }
  }

  const extensionsDir = join(agentDir, "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  const betterOpenAIConfigPath = join(extensionsDir, "pi-better-openai.json");
  // Pre-read: no-op guard only (skip the write when footer.mode is already
  // off). A malformed file makes the guard unknown (→ attempt the write);
  // the shared writer re-reads under the lock and REFUSES a malformed file
  // (never clobbers it) — same protocol as settings.json.
  let betterOpenAIConfig; // undefined = missing file / malformed / non-object
  if (existsSync(betterOpenAIConfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(betterOpenAIConfigPath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        betterOpenAIConfig = parsed;
      }
    } catch {
      // corrupted JSON or non-object root: guard unknown, force the write
    }
  }
  const footerConfig =
    betterOpenAIConfig?.footer && typeof betterOpenAIConfig.footer === "object"
      ? betterOpenAIConfig.footer
      : {};
  if (!betterOpenAIConfig || footerConfig.mode !== "off") {
    const result = await updateSettingsFile(betterOpenAIConfigPath, (doc) => {
      const footer =
        doc.footer && typeof doc.footer === "object" ? doc.footer : {};
      if (footer.mode !== "off") doc.footer = { ...footer, mode: "off" };
    });
    if (!result.ok) {
      // Write-only refusal: the corrupt/locked file is left untouched and
      // startup continues. The writer's message is basename-only (it serves
      // any settings file), so name the full path here.
      console.error(
        "little-coder: " +
          betterOpenAIConfigPath +
          " — " +
          result.error +
          " (file left untouched). Fix it manually.",
      );
    }
  }
} catch {
  // Best-effort. If we can't write the settings (read-only HOME, etc.) pi
  // falls back to its built-in defaults — the [Extensions] block will show
  // but everything else still works.
}
recordPhase("settings");

// ---- 9. Spawn pi in the user's cwd ----
// `process.execPath` is the same Node binary that's running this launcher, so
// pi inherits the exact runtime that already passed our >= 22.19.0 preflight.
// Passing piEntry as an argv element (not a shell string) avoids any
// shell-injection / space-in-path classes on every platform.
const nodeArgs = existsSync(subprocessPreload)
  ? ["--import", subprocessPreload, piEntry, ...piArgs]
  : [piEntry, ...piArgs];
// One knob drives both sides: with LITTLE_CODER_TIMING=1 the child also gets
// PI_TIMING=1 (pi's own per-extension load timings — module import +
// factory per extension — reported on stderr). Only set if not already
// chosen by the user.
const childEnv =
  LAUNCH_TIMING && !process.env.PI_TIMING
    ? { ...process.env, PI_TIMING: "1" }
    : process.env;
const child = spawn(process.execPath, nodeArgs, {
  stdio: subagentMode ? ["ignore", "pipe", "pipe"] : "inherit",
  cwd: process.cwd(),
  env: childEnv,
});
recordPhase("spawn");
if (LAUNCH_TIMING) {
  const t = performance.now();
  process.stderr.write(
    formatLaunchTiming({
      // Per-phase durations (deltas between successive marks), NOT cumulative
      // elapsed — the doc example (docs/startup-performance.md) shows the
      // phases summing to ≈ total, which is only true per-phase. total is
      // wall clock from t0 (includes the tiny gap between recordPhase("spawn")
      // and this `t` capture).
      discovery: TIMING.discovery - TIMING.t0,
      updatecheck: TIMING.updatecheck - TIMING.discovery,
      updateprompt: TIMING.updateprompt - TIMING.updatecheck,
      settings: TIMING.settings - TIMING.updateprompt,
      spawn: TIMING.spawn - TIMING.settings,
      total: t - TIMING.t0,
    }) + "\n",
  );
}

if (subagentMode) {
  child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
}

const forward = (sig) => () => {
  try {
    child.kill(sig);
  } catch {
    // child already gone
  }
};
// Named refs so the close handler can drop them before re-raising a fatal
// signal. With a listener still attached, re-killing ourselves would be
// swallowed (a registered handler suppresses the default terminate action)
// and the launcher would NOT exit 128+signum.
const forwardInt = forward("SIGINT");
const forwardTerm = forward("SIGTERM");
const forwardHup = forward("SIGHUP");
process.on("SIGINT", forwardInt);
process.on("SIGTERM", forwardTerm);
process.on("SIGHUP", forwardHup);

child.on("error", (err) => {
  console.error("little-coder: failed to start pi:", err.message);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    // The child died by a fatal signal. Drop our own forwarders FIRST so the
    // re-raised signal hits the DEFAULT action (terminate) → exit 128+signum,
    // instead of being swallowed by the still-attached forward handler.
    process.removeListener("SIGINT", forwardInt);
    process.removeListener("SIGTERM", forwardTerm);
    process.removeListener("SIGHUP", forwardHup);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
