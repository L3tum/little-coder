import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function applySubAgentEnv(env) {
  env.LITTLE_CODER_NO_UPDATE_CHECK = "1";
  env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.CI = "1";
  env.LITTLE_CODER_SUBAGENT = "1";
  return env;
}

export function isBrandingExtensionPath(path) {
  return /(?:^|[/\\])\.pi[/\\]extensions[/\\]branding[/\\]index\.ts$/.test(path);
}

export function discoverBundledExtensionArgs(extDir, { issueAgentSubagent = false, resolveExtensionEntry = (p) => p } = {}) {
  const extArgs = [];
  if (!existsSync(extDir)) return extArgs;
  for (const name of readdirSync(extDir).sort()) {
    const subdir = join(extDir, name);
    const idx = join(subdir, "index.ts");
    try {
      if (statSync(subdir).isDirectory() && existsSync(idx)) {
        const resolved = resolveExtensionEntry(idx);
        if (issueAgentSubagent && isBrandingExtensionPath(resolved)) continue;
        extArgs.push("--extension", resolved);
      }
    } catch {
      // skip unreadable entries
    }
  }
  return extArgs;
}
