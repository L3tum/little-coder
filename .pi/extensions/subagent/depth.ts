/**
 * Subagent delegation-depth resolution.
 *
 * Extracted from the subagent extension entry module so both the subagent tool
 * and the programmatic pipeline can source the SAME effective maxDepth /
 * preventCycles config (env vars, CLI flags, and the runtime `pi.getFlag`
 * value) instead of the pipeline hardcoding its own constants.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";

const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;

export interface DelegationDepthConfig {
  currentDepth: number;
  maxDepth: number;
  canUseSubagentTool: boolean;
  ancestorAgentStack: string[];
  preventCycles: boolean;
}

export function parseNonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

export function parseAgentStack(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (typeof raw !== "string") return null;
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((value) => typeof value === "string")) return null;
  return parsed
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function getMaxDepthFlagFromArgv(argv: string[]): string | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-max-depth") {
      return argv[i + 1] ?? "";
    }
    if (arg.startsWith("--subagent-max-depth=")) {
      return arg.slice("--subagent-max-depth=".length);
    }
  }
  return null;
}

export function getPreventCyclesFlagFromArgv(
  argv: string[],
): string | boolean | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-prevent-cycles") {
      const maybeValue = argv[i + 1];
      if (maybeValue !== undefined && !maybeValue.startsWith("--")) {
        return maybeValue;
      }
      return true;
    }
    if (arg === "--no-subagent-prevent-cycles") return false;
    if (arg.startsWith("--subagent-prevent-cycles=")) {
      return arg.slice("--subagent-prevent-cycles=".length);
    }
  }
  return null;
}

const EXPECTED_NON_NEG_INT = "Expected a non-negative integer.";
const EXPECTED_BOOL = "Expected true/false.";

/** The one warning shape every invalid-config check in this module shares:
 *  `[pi-subagent] Ignoring invalid <source>="<value>". <expected>` — collapsed
 *  into a helper so the 8 call sites stay one-liners. `value === undefined`
 *  drops the `="…"` (the stack check warns on shape, not a printable value). */
function warnIfInvalid(
  source: string,
  value: string | undefined,
  expected: string,
): void {
  console.warn(
    value === undefined
      ? `[pi-subagent] Ignoring invalid ${source} value. ${expected}`
      : `[pi-subagent] Ignoring invalid ${source}="${value}". ${expected}`,
  );
}

export function resolveDelegationDepthConfig(
  pi: ExtensionAPI,
): DelegationDepthConfig {
  const depthRaw = process.env[SUBAGENT_DEPTH_ENV];
  const parsedDepth = parseNonNegativeInt(depthRaw);
  // An empty/whitespace env value means "unset", not an invalid value.
  if (
    depthRaw !== undefined &&
    depthRaw.trim() !== "" &&
    parsedDepth === null
  ) {
    warnIfInvalid(SUBAGENT_DEPTH_ENV, depthRaw, EXPECTED_NON_NEG_INT);
  }
  const currentDepth = parsedDepth ?? 0;

  const stackRaw = process.env[SUBAGENT_STACK_ENV];
  const ancestorAgentStack = parseAgentStack(stackRaw);
  if (stackRaw !== undefined && ancestorAgentStack === null) {
    warnIfInvalid(
      SUBAGENT_STACK_ENV,
      undefined,
      "Expected a JSON array of agent names.",
    );
  }

  const envMaxDepthRaw = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
  if (
    envMaxDepthRaw !== undefined &&
    envMaxDepthRaw.trim() !== "" &&
    envMaxDepth === null
  ) {
    warnIfInvalid(SUBAGENT_MAX_DEPTH_ENV, envMaxDepthRaw, EXPECTED_NON_NEG_INT);
  }

  const argvFlagRaw = getMaxDepthFlagFromArgv(process.argv);
  const argvFlagMaxDepth =
    argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
  if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
    warnIfInvalid("--subagent-max-depth", argvFlagRaw, EXPECTED_NON_NEG_INT);
  }

  const runtimeFlagValue = pi.getFlag("subagent-max-depth");
  const runtimeFlagMaxDepth =
    typeof runtimeFlagValue === "string"
      ? parseNonNegativeInt(runtimeFlagValue)
      : null;
  if (
    argvFlagRaw === null &&
    typeof runtimeFlagValue === "string" &&
    runtimeFlagMaxDepth === null
  ) {
    warnIfInvalid(
      "--subagent-max-depth",
      runtimeFlagValue,
      EXPECTED_NON_NEG_INT,
    );
  }

  const envPreventCyclesRaw = process.env[SUBAGENT_PREVENT_CYCLES_ENV];
  const envPreventCycles = parseBoolean(envPreventCyclesRaw);
  if (
    envPreventCyclesRaw !== undefined &&
    envPreventCyclesRaw.trim() !== "" &&
    envPreventCycles === null
  ) {
    warnIfInvalid(
      SUBAGENT_PREVENT_CYCLES_ENV,
      envPreventCyclesRaw,
      EXPECTED_BOOL,
    );
  }

  const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(process.argv);
  const argvPreventCycles =
    typeof argvPreventCyclesRaw === "boolean"
      ? argvPreventCyclesRaw
      : parseBoolean(argvPreventCyclesRaw);
  if (typeof argvPreventCyclesRaw === "string" && argvPreventCycles === null) {
    warnIfInvalid(
      "--subagent-prevent-cycles",
      argvPreventCyclesRaw,
      EXPECTED_BOOL,
    );
  }

  const runtimePreventCyclesRaw = pi.getFlag("subagent-prevent-cycles");
  const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
  if (
    argvPreventCyclesRaw === null &&
    runtimePreventCyclesRaw !== undefined &&
    runtimePreventCycles === null
  ) {
    warnIfInvalid(
      "--subagent-prevent-cycles",
      String(runtimePreventCyclesRaw),
      EXPECTED_BOOL,
    );
  }

  const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
  const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  const preventCycles =
    argvPreventCycles ??
    runtimePreventCycles ??
    envPreventCycles ??
    DEFAULT_PREVENT_CYCLE_DELEGATION;

  return {
    currentDepth,
    maxDepth,
    canUseSubagentTool: currentDepth < maxDepth,
    ancestorAgentStack: ancestorAgentStack ?? [],
    preventCycles,
  };
}
