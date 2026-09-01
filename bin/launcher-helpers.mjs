import { existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Renders the LITTLE_CODER_TIMING=1 launcher phase line:
//   little-coder launch timing: discovery=3ms updatecheck=0ms updateprompt=0ms settings=1ms spawn=5ms total=12ms
// `marks` are PER-PHASE durations in ms (deltas between successive
// recordPhase marks, so the phases sum to ≈ total); `total` is wall
// clock from t0.
export function formatLaunchTiming(marks) {
  // NaN/undefined-safe: a missing or non-finite mark renders as 0ms instead of
  // "NaNms" (e.g. a phase that was skipped before its mark was recorded).
  const ms = (v) => `${Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0}ms`;
  return (
    "little-coder launch timing: " +
    `discovery=${ms(marks.discovery)} ` +
    `updatecheck=${ms(marks.updatecheck)} ` +
    `updateprompt=${ms(marks.updateprompt)} ` +
    `settings=${ms(marks.settings)} ` +
    `spawn=${ms(marks.spawn)} ` +
    `total=${ms(marks.total)}`
  );
}

export function applySubAgentEnv(env) {
  env.LITTLE_CODER_NO_UPDATE_CHECK = "1";
  env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.CI = "1";
  env.LITTLE_CODER_SUBAGENT = "1";
  return env;
}

export function isBrandingExtensionPath(path) {
  return /(?:^|[/\\])\.pi[/\\]extensions[/\\]branding[/\\]index\.ts$/.test(
    path,
  );
}

export function shouldAppendSystemPrompt(systemPromptPath, appendPromptPath) {
  if (!appendPromptPath || !existsSync(appendPromptPath)) return false;
  if (!systemPromptPath || !existsSync(systemPromptPath)) return true;
  try {
    return realpathSync(systemPromptPath) !== realpathSync(appendPromptPath);
  } catch {
    return resolve(systemPromptPath) !== resolve(appendPromptPath);
  }
}

export function discoverBundledExtensionArgs(
  extDir,
  {
    issueAgentSubagent = false,
    subagentMode = false,
    resolveExtensionEntry = (p) => p,
  } = {},
) {
  const extArgs = [];
  if (!existsSync(extDir)) return extArgs;
  for (const name of readdirSync(extDir).sort()) {
    // Defense-in-depth: never treat `_`-prefixed entries (e.g. an accidental
    // `_shared/index.ts`) as loadable extensions — they are shared/support
    // code, not top-level extensions (auto-discovery skips them upstream too).
    if (name.startsWith("_")) continue;
    const subdir = join(extDir, name);
    const idx = join(subdir, "index.ts");
    try {
      if (statSync(subdir).isDirectory() && existsSync(idx)) {
        const resolved = resolveExtensionEntry(idx);
        if (
          (subagentMode || issueAgentSubagent) &&
          isBrandingExtensionPath(resolved)
        )
          continue;
        extArgs.push("--extension", resolved);
      }
    } catch {
      // skip unreadable entries
    }
  }
  return extArgs;
}
