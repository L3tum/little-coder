/**
 * Subagent user-settings store + per-agent model/thinking overrides.
 *
 * Extracted from the subagent extension entry module so that programmatic
 * pipeline callers (mode-commands) can honor the user's configured
 * `little_coder.subagent_models` / `subagent_thinking` overrides without
 * importing a sibling extension's registration entry point.
 *
 * Leaf module: no TUI, no tool schemas, no side effects at import. ALL
 * writes go through the shared locked writer
 * (_shared/settings-write.mjs updateSettingsFile) — the same lock the
 * launcher's quietStartup stamp and the permission-gate /allow writer take
 * (an unlocked full-document read → write on <agentDir>/settings.json raced
 * those writers into lost updates and clobbered a malformed file).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { updateSettingsFile } from "../_shared/settings-write.mjs";
import type { AgentConfig } from "./agents.js";

export type SubagentLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const LEVELS: SubagentLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function settingsPath(): string {
  // Honor PI_CODING_AGENT_DIR (same convention as _shared/little-coder-settings.mjs
  // getAgentDir, bin/little-coder.mjs step 8, and agents.ts getUserAgentsDir):
  // the env var points at the agent DIRECTORY, and the settings file is
  // <agentDir>/settings.json. `~`/`~/x` expand against $HOME.
  const env = process.env.PI_CODING_AGENT_DIR;
  let agentDir: string;
  if (env && env.trim().length > 0) {
    const trimmed = env.trim();
    if (trimmed === "~") {
      agentDir = os.homedir();
    } else if (trimmed.startsWith("~/")) {
      agentDir = path.join(os.homedir(), trimmed.slice(2));
    } else {
      agentDir = path.resolve(trimmed);
    }
  } else {
    agentDir = path.join(os.homedir(), ".pi", "agent");
  }
  return path.join(agentDir, "settings.json");
}

/** Cached settings payload keyed by file mtime to avoid redundant disk reads.
 *  The key includes the resolved path so PI_CODING_AGENT_DIR changes (or
 *  tests that redirect HOME) invalidate the cache. */
let settingsCache: { data: unknown; mtimeMs: number; path: string } | null =
  null;

/** Test helper: drop the mtime-keyed cache so the next read re-reads disk. */
export function __resetSettingsCache(): void {
  settingsCache = null;
}

/**
 * Shape of the `little_coder` namespace in the agent settings file. Validated
 * by the typeof/LEVELS guards in the getters below (a no-op schema on top
 * would only add an import — both branches of readSettings return the raw
 * parsed object).
 */
export interface LittleCoderSettings {
  subagent_thinking?: Record<string, SubagentLevel>;
  subagent_models?: Record<string, string>;
  subagent_level?: SubagentLevel;
  [key: string]: unknown;
}

export interface PiSettings {
  little_coder?: LittleCoderSettings;
  [key: string]: unknown;
}

/** PiSettings with the little_coder namespace guaranteed present. */
export type PiSettingsWithLC = PiSettings & {
  little_coder: LittleCoderSettings;
};

export function readSettings(): PiSettings {
  const sp = settingsPath();
  try {
    const st = fs.statSync(sp);
    if (
      settingsCache &&
      st.mtimeMs === settingsCache.mtimeMs &&
      sp === settingsCache.path
    ) {
      return settingsCache.data as PiSettings;
    }
    const raw: unknown = JSON.parse(fs.readFileSync(sp, "utf-8"));
    // A non-object JSON root (null, a string, an array) is not settings:
    // handing it back would crash `s.little_coder ??= {}` / `.little_coder`
    // downstream, so fall back to an empty object. Anything object-shaped is
    // returned as-is — unknown keys and schema drift are contained by the
    // typeof/LEVELS guards in the getters.
    const data =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as PiSettings)
        : ({} as PiSettings);
    settingsCache = { data, mtimeMs: st.mtimeMs, path: sp };
    return data;
  } catch {
    return {};
  }
}

/** Result of a little-coder settings write (mirrors the shared writer). */
export type SettingsWriteResult = { ok: true } | { ok: false; error: string };

/**
 * Read-modify-write ONE mutation into the `little_coder` namespace through
 * the shared locked writer (updateSettingsFile): the whole read-modify-
 * write runs under the proper-lockfile settings lock and the bytes are
 * written with the shared atomic protocol (0600 temp + rename, O_EXCL |
 * O_NOFOLLOW). A malformed existing settings.json is REFUSED, never
 * clobbered — the pre-migration unlocked writer here read → {} → wrote on
 * any parse failure, which contradicted the shared writer's contract.
 *
 * Never rejects: a failed write (lock exhaustion, malformed file, …) is
 * returned as { ok: false, error } so a /subagent-* command can report it
 * instead of crashing. `mutate` receives the little_coder namespace (a
 * fresh object when the file has none — a non-object stored namespace is
 * normalized away) and modifies it in place.
 */
export async function mutateLittleCoderSettings(
  mutate: (lc: LittleCoderSettings) => void,
): Promise<SettingsWriteResult> {
  const res = await updateSettingsFile(settingsPath(), (doc) => {
    const rawLc = doc.little_coder;
    const lc =
      rawLc !== null && typeof rawLc === "object" && !Array.isArray(rawLc)
        ? (rawLc as LittleCoderSettings)
        : ({} as LittleCoderSettings);
    mutate(lc);
    doc.little_coder = lc;
  });
  // Invalidate cache so the next read picks up fresh data (a skipped no-op
  // write leaves disk unchanged; invalidating is harmless).
  settingsCache = null;
  return res.ok
    ? { ok: true }
    : { ok: false, error: res.error ?? "unknown settings write error" };
}

export function littleCoderSettings(): PiSettingsWithLC {
  const s = readSettings();
  s.little_coder ??= {};
  return s as PiSettingsWithLC;
}

export function getSubagentLevel(): SubagentLevel {
  const raw = readSettings().little_coder?.subagent_level;
  return raw && LEVELS.includes(raw) ? raw : "medium";
}

export async function setSubagentLevel(
  level: SubagentLevel,
): Promise<SettingsWriteResult> {
  return mutateLittleCoderSettings((lc) => {
    lc.subagent_level = level;
  });
}

export async function setSubagentModel(
  agent: string,
  model: string,
): Promise<SettingsWriteResult> {
  return mutateLittleCoderSettings((lc) => {
    lc.subagent_models ??= {};
    lc.subagent_models[agent] = model;
  });
}

export function getSubagentModels(): Record<string, string> {
  const raw = readSettings().little_coder?.subagent_models;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export function subagentModel(
  agent: string,
  models?: Record<string, unknown>,
): string | undefined {
  // Named override wins over the "all" fallback (same precedence as
  // subagentThinking): /subagent-model-all X then /subagent-model writer Y
  // must give writer Y, not X.
  const m = models ?? getSubagentModels();
  return pickModelEntry(m[agent]) ?? pickModelEntry(m.all);
}

function pickModelEntry(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function pickThinkingEntry(value: unknown): SubagentLevel | undefined {
  return typeof value === "string" && LEVELS.includes(value as SubagentLevel)
    ? (value as SubagentLevel)
    : undefined;
}

export async function setSubagentThinking(
  agent: string,
  thinking: SubagentLevel,
): Promise<SettingsWriteResult> {
  return mutateLittleCoderSettings((lc) => {
    lc.subagent_thinking ??= {};
    lc.subagent_thinking[agent] = thinking;
  });
}

export function getSubagentThinkingSettings(): Record<string, SubagentLevel> {
  const raw = readSettings().little_coder?.subagent_thinking;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, SubagentLevel] =>
        typeof entry[1] === "string" &&
        LEVELS.includes(entry[1] as SubagentLevel),
    ),
  );
}

export function subagentThinking(
  agent: string,
  thinking?: Record<string, unknown>,
): SubagentLevel | undefined {
  const s = thinking ?? getSubagentThinkingSettings();
  return pickThinkingEntry(s[agent]) ?? pickThinkingEntry(s.all);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Apply the user's per-agent model/thinking overrides (from the
 * `little_coder.subagent_models` / `subagent_thinking` settings) to a list of
 * agent configs, returning new objects. Single entry point both the subagent
 * tool and the programmatic pipeline use to honor configured overrides
 * without leaking the raw per-agent lookups.
 *
 * Reads the settings file ONCE for the whole list (callers may pass an
 * already-read PiSettings as `settings`): readSettings() stats the file on
 * every call (the mtime cache skips the read, not the stat), and a 7-agent
 * pipeline fan-out would otherwise pay a blocking stat per agent. The pick
 * logic is the SAME subagentModel/subagentThinking precedence the
 * single-agent command paths (/subagent-model, /subagent-thinking) use, so
 * the two surfaces cannot drift.
 */
export function applySubagentOverrides(
  agents: AgentConfig[],
  settings: PiSettings = readSettings(),
): AgentConfig[] {
  const models = asRecord(settings.little_coder?.subagent_models);
  const thinking = asRecord(settings.little_coder?.subagent_thinking);
  return agents.map((a) => ({
    ...a,
    model: subagentModel(a.name, models) ?? a.model,
    thinking: subagentThinking(a.name, thinking) ?? a.thinking,
  }));
}
