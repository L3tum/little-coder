/**
 * Curated PUBLIC API of the subagent extension, for cross-extension
 * consumers (today: the mode-commands programmatic pipelines in
 * ./../mode-commands/pipeline.js).
 *
 * The two extensions are otherwise kept independent; the mode-commands side
 * imports subagent logic ONLY through this barrel, so the boundary is one
 * reviewable list instead of scattered deep imports. The reverse edge
 * (agents.ts → mode-commands/mode-prompts.ts for prompt text) is deliberate
 * too: prompts are data, and agents.ts is the single source of truth for
 * them.
 *
 * Adding a name here is a deliberate API decision — it means the subagent
 * extension's internal surface now has to stay stable for a second consumer.
 */

// Process spawning + fan-out (pipeline.ts runs each phase as runAgent).
export {
  runAgent,
  mapConcurrent,
  makeFailureResult,
  TASK_INLINE_MAX_BYTES,
  MAX_SUBAGENT_PARALLEL_TASKS,
  DEFAULT_SUBAGENT_CONCURRENCY,
  type RunAgentOptions,
} from "./runner.js";

// Built-in agent catalog (resolvePipelineAgents resolves from these only —
// project/user agents must go through the subagent tool's trust flow).
export { builtInLittleCoderAgents, type AgentConfig } from "./agents.js";

// User settings: per-agent model/thinking overrides + the subagent_level gate.
export {
  applySubagentOverrides,
  getSubagentLevel,
  type SubagentLevel,
} from "./settings.js";

// Delegation depth config (the SAME gate the subagent tool applies).
export {
  resolveDelegationDepthConfig,
  parseNonNegativeInt,
  type DelegationDepthConfig,
} from "./depth.js";

// Phase outcome classification (single source of "did this phase succeed?").
export { toPhaseOutcome, type PhaseOutcome, type SingleResult } from "./types.js";

// Output extraction (the pipeline's live-progress panel derives its
// "currently doing" line from a phase's streaming messages).
export {
  getFinalOutput,
  getDisplayItems,
  type DisplayItem,
} from "./types.js";
