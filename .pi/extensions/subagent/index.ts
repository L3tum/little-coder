/**
 * Pi Subagent Extension
 *
 * Delegates tasks to specialized subagents, each running as an isolated `pi`
 * process.
 *
 * Supports two invocation shapes:
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *
 * And two context modes:
 *   - spawn (default): child gets only the task prompt.
 *   - fork: child gets a forked snapshot of current session context + task prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AgentConfig,
  discoverAgents,
  discoverAgentsWithStarter,
} from "./agents.js";
import {
  resolveDelegationDepthConfig,
  parseNonNegativeInt,
  parseBoolean,
  parseAgentStack,
  getMaxDepthFlagFromArgv,
  getPreventCyclesFlagFromArgv,
} from "./depth.js";
import {
  applySubagentOverrides,
  readSettings,
  mutateLittleCoderSettings,
  __resetSettingsCache,
  getSubagentLevel,
  setSubagentLevel,
  getSubagentModels,
  subagentModel,
  setSubagentModel,
  getSubagentThinkingSettings,
  subagentThinking,
  setSubagentThinking,
  LEVELS,
  type SettingsWriteResult,
  type SubagentLevel,
} from "./settings.js";
import { type RenderTheme, renderCall, renderResult } from "./render.js";
import { getResultSummaryText } from "./runner-events.js";
import {
  mapConcurrent,
  runAgent,
  writeForkSessionToTempFile,
  MAX_SUBAGENT_PARALLEL_TASKS,
  DEFAULT_SUBAGENT_CONCURRENCY,
} from "./runner.js";
import {
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  DEFAULT_DELEGATION_MODE,
  emptyUsage,
  isResultError,
  isResultSuccess,
} from "./types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
// (fan-out ceilings now live in runner.ts — MAX_SUBAGENT_PARALLEL_TASKS /
// DEFAULT_SUBAGENT_CONCURRENCY — so the programmatic pipelines share the same
// ceiling instead of redeclaring it.)
const PARALLEL_HEARTBEAT_MS = 1000;
function steeringForLevel(level: SubagentLevel): string {
  const guidance: Record<SubagentLevel, string> = {
    off: "",
    minimal:
      "\nOnly delegate to subagents when the task is clearly well-scoped and independent.",
    low: "\nDelegate to subagents for clearly independent, well-scoped tasks when it saves effort.",
    medium:
      "\nDelegate to subagents for independent subtasks where parallelism or isolation helps.",
    high: "\nDelegate to subagents proactively where possible; prefer parallel delegation for independent work.",
    xhigh:
      "\nDelegate aggressively — run independent work in parallel subagents whenever feasible.",
    max: "\nMaximize delegation — always delegate to subagents when the task can be isolated, and prefer parallel execution.",
  };
  return guidance[level];
}

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
  agent: Type.String({
    description: "Name of an available agent (must match exactly)",
  }),
  task: Type.String({
    description:
      "Task description for this delegated run. In spawn mode include all required context; in fork mode the subagent also sees your current session context.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for this agent's process" }),
  ),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name for single mode. Must match an available agent name exactly.",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "Task description for single mode. In spawn mode it must be self-contained; in fork mode the subagent also receives your current session context.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description:
        "For parallel mode: array of {agent, task} objects. Each task runs in an isolated process concurrently. Do NOT set agent/task when using this.",
    }),
  ),
  mode: Type.Optional(
    Type.String({
      description:
        "Context mode for delegated runs. 'spawn' (default) sends only the task prompt (best for isolated, reproducible runs with lower token/cost and less context leakage). 'fork' adds a snapshot of current session context plus task prompt (best for follow-up work, but usually higher token/cost and may include sensitive context).",
      default: DEFAULT_DELEGATION_MODE,
    }),
  ),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description:
        "Whether to prompt the user before running project-local agents. Default: true.",
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the agent process (single mode only)",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

function trustedProjectAgentsKey(projectAgentsDir: string): string {
  return path.resolve(projectAgentsDir);
}

export function getTrustedProjectAgentDirs(settings: any): string[] {
  const raw = settings?.little_coder?.trusted_project_agent_dirs;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

export function areProjectAgentsTrusted(
  settings: any,
  projectAgentsDir: string | null,
): boolean {
  if (!projectAgentsDir) return false;
  return getTrustedProjectAgentDirs(settings).includes(
    trustedProjectAgentsKey(projectAgentsDir),
  );
}

async function trustProjectAgents(projectAgentsDir: string): Promise<void> {
  // Same shared locked writer as the /subagent-* commands: trust entries are
  // just another little_coder field, so they take the same lost-update
  // protection. No command ctx here to report into — a failed write is
  // logged (the session still works for this run; trust just isn't
  // persisted).
  const r = await mutateLittleCoderSettings((lc) => {
    const trusted = new Set(getTrustedProjectAgentDirs(readSettings()));
    trusted.add(trustedProjectAgentsKey(projectAgentsDir));
    lc.trusted_project_agent_dirs = Array.from(trusted).sort();
  });
  if (!r.ok)
    console.warn(`[pi-subagent] Could not persist agent trust: ${r.error}`);
}

export function agentsForPrompt(
  agents: AgentConfig[],
  projectAgentsTrusted: boolean,
): AgentConfig[] {
  if (projectAgentsTrusted) return agents;
  return agents.map((agent) =>
    agent.source === "project"
      ? {
          ...agent,
          description:
            "Project-local agent (trust this repository to reveal its description).",
        }
      : agent,
  );
}

function parseDelegationMode(raw: unknown): DelegationMode | null {
  if (raw === undefined) return DEFAULT_DELEGATION_MODE;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "spawn" || normalized === "fork") {
    return normalized;
  }
  return null;
}

function buildForkSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;

  const branchEntries = sessionManager.getBranch();
  const lines = [JSON.stringify(header)];
  for (const entry of branchEntries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
}

function makeDetailsFactory(
  projectAgentsDir: string | null,
  delegationMode: DelegationMode,
) {
  return (mode: "single" | "parallel") =>
    (results: SingleResult[]): SubagentDetails => ({
      mode,
      delegationMode,
      projectAgentsDir,
      results,
    });
}

function formatAgentNames(agents: AgentConfig[]): string {
  return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

function getCycleViolations(
  requestedNames: Set<string>,
  ancestorAgentStack: string[],
): string[] {
  if (requestedNames.size === 0 || ancestorAgentStack.length === 0) return [];
  const stackSet = new Set(ancestorAgentStack);
  return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

/** Get project-local agents referenced by the current request. */
function getRequestedProjectAgents(
  agents: AgentConfig[],
  requestedNames: Set<string>,
): AgentConfig[] {
  return Array.from(requestedNames)
    .map((name) => agents.find((a) => a.name === name))
    .filter((a): a is AgentConfig => a?.source === "project");
}

/**
 * Prompt the user to confirm project-local agents if needed.
 * Returns false if the user declines.
 */
export function buildParallelToolResult(
  results: SingleResult[],
  makeDetails: ReturnType<typeof makeDetailsFactory>,
) {
  const successCount = results.filter((r) => isResultSuccess(r)).length;
  const summaries = results.map(
    (r) =>
      `[${r.agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r)}`,
  );
  const hasFailures = results.some((r) => isResultError(r));
  return {
    content: [
      {
        type: "text" as const,
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
      },
    ],
    details: makeDetails("parallel")(results),
    ...(hasFailures ? { isError: true } : {}),
  };
}

async function confirmProjectAgentsIfNeeded(
  projectAgents: AgentConfig[],
  projectAgentsDir: string | null,
  ctx: { ui: { confirm: (title: string, body: string) => Promise<boolean> } },
): Promise<boolean> {
  if (projectAgents.length === 0) return true;
  if (areProjectAgentsTrusted(readSettings(), projectAgentsDir)) return true;

  const names = projectAgents.map((a) => a.name).join(", ");
  const dir = projectAgentsDir ?? "(unknown)";
  const approved = await ctx.ui.confirm(
    "Trust project-local agents?",
    `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories. This choice will be saved.`,
  );
  if (approved && projectAgentsDir) await trustProjectAgents(projectAgentsDir);
  return approved;
}

/** Report a little-coder settings write result to the command ctx:
 *  success message on ok, an error notify on failure (a settings write must
 *  never crash a /subagent-* command). */
function notifySettingsResult(
  ctx: {
    ui?: {
      notify?: (message: string, level?: "info" | "warning" | "error") => void;
    };
  },
  r: SettingsWriteResult,
  successMessage: string,
): void {
  if (r.ok) {
    ctx.ui?.notify?.(successMessage, "info");
  } else {
    ctx.ui?.notify?.(`Could not update settings: ${r.error}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerFlag("subagent-max-depth", {
    description: "Maximum allowed subagent delegation depth (default: 3).",
    type: "string",
  });
  pi.registerFlag("subagent-prevent-cycles", {
    description:
      "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });

  pi.registerCommand("subagent-level", {
    description:
      "Show or set subagent steering level: /subagent-level [off|minimal|low|medium|high|xhigh]",
    handler: async (args, ctx) => {
      const level = String(args ?? "").trim() as SubagentLevel;
      if (!level) {
        ctx.ui?.notify?.(`Subagent level is ${getSubagentLevel()}.`, "info");
        return;
      }
      if (!LEVELS.includes(level)) {
        ctx.ui?.notify?.(
          `Usage: /subagent-level ${LEVELS.join("|")}`,
          "warning",
        );
        return;
      }
      notifySettingsResult(
        ctx,
        await setSubagentLevel(level),
        `Subagent level set to ${level}. Restart the session for tool registration changes to apply.`,
      );
    },
  });
  pi.registerCommand("subagent-model", {
    description:
      "Show or set model for one subagent: /subagent-model [agent [model]]",
    handler: async (args, ctx) => {
      const [agent, ...rest] = String(args ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const model = rest.join(" ");
      if (!agent) {
        const entries = Object.entries(getSubagentModels());
        const summary =
          entries.length > 0
            ? entries.map(([name, value]) => `${name}: ${value}`).join("\n")
            : "No subagent models configured.";
        ctx.ui?.notify?.(summary, "info");
        return;
      }
      if (!model) {
        ctx.ui?.notify?.(
          `Subagent model for ${agent} is ${subagentModel(agent) ?? "not configured"}.`,
          "info",
        );
        return;
      }
      notifySettingsResult(
        ctx,
        await setSubagentModel(agent, model),
        `Subagent model for ${agent} set to ${model}.`,
      );
    },
  });
  pi.registerCommand("subagent-model-all", {
    description: "Set model for all subagents: /subagent-model-all <model>",
    handler: async (args, ctx) => {
      const model = String(args ?? "").trim();
      if (!model) {
        ctx.ui?.notify?.("Usage: /subagent-model-all <model>", "warning");
        return;
      }
      notifySettingsResult(
        ctx,
        await setSubagentModel("all", model),
        `Subagent model for all agents set to ${model}.`,
      );
    },
  });
  pi.registerCommand("subagent-thinking", {
    description:
      "Show or set thinking level for one subagent: /subagent-thinking [agent [off|minimal|low|medium|high|xhigh]]",
    handler: async (args, ctx) => {
      const [agent, thinking] = String(args ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (!agent) {
        const entries = Object.entries(getSubagentThinkingSettings());
        const summary =
          entries.length > 0
            ? entries.map(([name, value]) => `${name}: ${value}`).join("\n")
            : "No subagent thinking levels configured.";
        ctx.ui?.notify?.(summary, "info");
        return;
      }
      if (!thinking) {
        ctx.ui?.notify?.(
          `Subagent thinking level for ${agent} is ${subagentThinking(agent) ?? "not configured"}.`,
          "info",
        );
        return;
      }
      if (!LEVELS.includes(thinking as SubagentLevel)) {
        ctx.ui?.notify?.(
          `Usage: /subagent-thinking <agent> ${LEVELS.join("|")}`,
          "warning",
        );
        return;
      }
      notifySettingsResult(
        ctx,
        await setSubagentThinking(agent, thinking as SubagentLevel),
        `Subagent thinking level for ${agent} set to ${thinking}.`,
      );
    },
  });
  pi.registerCommand("subagent-thinking-all", {
    description:
      "Set thinking level for all subagents: /subagent-thinking-all <off|minimal|low|medium|high|xhigh>",
    handler: async (args, ctx) => {
      const thinking = String(args ?? "").trim();
      if (!LEVELS.includes(thinking as SubagentLevel)) {
        ctx.ui?.notify?.(
          `Usage: /subagent-thinking-all ${LEVELS.join("|")}`,
          "warning",
        );
        return;
      }
      notifySettingsResult(
        ctx,
        await setSubagentThinking("all", thinking as SubagentLevel),
        `Subagent thinking level for all agents set to ${thinking}.`,
      );
    },
  });

  const depthConfig = resolveDelegationDepthConfig(pi);
  const configuredLevel = getSubagentLevel();
  const canUseSubagentTool =
    configuredLevel !== "off" && depthConfig.canUseSubagentTool;
  const { currentDepth, maxDepth, ancestorAgentStack, preventCycles } =
    depthConfig;

  let discoveredAgents: AgentConfig[] = [];
  let discoveredProjectAgentsDir: string | null = null;
  let projectAgentsTrustedForPrompt = false;

  // Auto-discover agents on session start
  pi.on("session_start", async (_event, ctx) => {
    if (!canUseSubagentTool) return;

    const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
    const discovery = starterDiscovery.discovery;
    discoveredProjectAgentsDir = discovery.projectAgentsDir;
    const hasProjectAgents = discovery.agents.some(
      (agent) => agent.source === "project",
    );
    projectAgentsTrustedForPrompt = areProjectAgentsTrusted(
      readSettings(),
      discoveredProjectAgentsDir,
    );
    if (hasProjectAgents && !projectAgentsTrustedForPrompt && ctx.hasUI) {
      const projectAgents = discovery.agents.filter(
        (agent) => agent.source === "project",
      );
      projectAgentsTrustedForPrompt = await confirmProjectAgentsIfNeeded(
        projectAgents,
        discoveredProjectAgentsDir,
        ctx,
      );
    }
    discoveredAgents = applySubagentOverrides(discovery.agents);

    if (ctx.hasUI) {
      if (starterDiscovery.createdAgentPath) {
        ctx.ui.notify(
          `Created starter subagent "explorer" at:\n${starterDiscovery.createdAgentPath}\n\nEdit this file or add more agents in the same directory to customize delegation.`,
          "info",
        );
      } else if (starterDiscovery.error && discoveredAgents.length === 0) {
        ctx.ui.notify(`No subagents found. ${starterDiscovery.error}`, "info");
      } else if (discoveredAgents.length > 0) {
        const list = discoveredAgents
          .map((a) => `  - ${a.name} (${a.source})`)
          .join("\n");
        ctx.ui.notify(
          `Found ${discoveredAgents.length} subagent(s):\n${list}`,
          "info",
        );
      }
    }
  });

  // Inform the agent about available subagent tools without bloating the prompt
  pi.on("before_agent_start", async (event) => {
    if (!canUseSubagentTool) return;
    if (discoveredAgents.length === 0) return;

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Subagent tools

- **\`subagents\`** — call this tool to list all available subagents (names, descriptions, sources).
- **\`subagent\`** — delegate work to a subagent by name. Use single mode for one task or parallel mode for independent tasks. Context modes: \`spawn\` (isolated) or \`fork\` (inherits session context).
${steeringForLevel(configuredLevel)}
`,
    };
  });

  // Register the subagent tool
  if (canUseSubagentTool) {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: [
        "Delegate work to specialized subagents running in isolated pi processes.",
        "",
        "IMPORTANT: Use exactly ONE invocation shape:",
        "  Single mode:   set `agent` and `task` (both required together).",
        "  Parallel mode: set `tasks` array (do NOT also set `agent`/`task`).",
        "",
        "Optional context mode switch:",
        '  mode: "spawn" (default) -> child gets only your task prompt.',
        "                             Best for isolated/reproducible work; lower token/cost and less context leakage.",
        '  mode: "fork"            -> child gets current session context + your task prompt.',
        "                             Best for follow-up work that depends on prior context; higher token/cost and may include sensitive context.",
        "",
        'Example single:   { agent: "writer", task: "Rewrite README.md", mode: "spawn" }',
        'Example parallel: { tasks: [{ agent: "writer", task: "..." }, { agent: "tester", task: "..." }], mode: "fork" }',
      ].join("\n"),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
        const discovery = starterDiscovery.discovery;
        const agents = applySubagentOverrides(discovery.agents);

        const delegationMode = parseDelegationMode(params.mode);
        if (!delegationMode) {
          const fallbackDetails = makeDetailsFactory(
            discovery.projectAgentsDir,
            DEFAULT_DELEGATION_MODE,
          );
          return {
            content: [
              {
                type: "text",
                text: `Invalid mode \"${String(params.mode)}\". Expected \"spawn\" or \"fork\".\nAvailable agents: ${formatAgentNames(agents)}`,
              },
            ],
            details: fallbackDetails("single")([]),
            isError: true,
          };
        }

        const makeDetails = makeDetailsFactory(
          discovery.projectAgentsDir,
          delegationMode,
        );

        let forkSessionSnapshotJsonl: string | undefined;
        if (delegationMode === "fork") {
          forkSessionSnapshotJsonl =
            buildForkSessionSnapshotJsonl(ctx.sessionManager) ?? undefined;
          if (!forkSessionSnapshotJsonl) {
            return {
              content: [
                {
                  type: "text",
                  text: 'Cannot use mode="fork": failed to snapshot current session context.',
                },
              ],
              details: makeDetails("single")([]),
              isError: true,
            };
          }
        }

        // Validate: exactly one invocation shape must be specified
        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        if (Number(hasTasks) + Number(hasSingle) !== 1) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid parameters. Provide exactly one invocation shape.\nAvailable agents: ${formatAgentNames(agents)}`,
              },
            ],
            details: makeDetails("single")([]),
          };
        }

        // Security: guard project-local agents before running
        const requested = new Set<string>();
        if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
        if (params.agent) requested.add(params.agent);

        if (preventCycles) {
          const cycleViolations = getCycleViolations(
            requested,
            ancestorAgentStack,
          );
          if (cycleViolations.length > 0) {
            const stackText =
              ancestorAgentStack.length > 0
                ? ancestorAgentStack.join(" -> ")
                : "(root)";
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.
Current stack: ${stackText}

This guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
                },
              ],
              details: makeDetails(hasTasks ? "parallel" : "single")([]),
              isError: true,
            };
          }
        }

        const requestedProjectAgents = getRequestedProjectAgents(
          agents,
          requested,
        );
        const projectAgentsTrusted = areProjectAgentsTrusted(
          readSettings(),
          discovery.projectAgentsDir,
        );
        const shouldConfirmProjectAgents =
          !projectAgentsTrusted && (params.confirmProjectAgents ?? true);
        if (requestedProjectAgents.length > 0 && shouldConfirmProjectAgents) {
          if (ctx.hasUI) {
            const approved = await confirmProjectAgentsIfNeeded(
              requestedProjectAgents,
              discovery.projectAgentsDir,
              ctx,
            );
            if (!approved) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Canceled: project-local agents not approved.",
                  },
                ],
                details: makeDetails(hasTasks ? "parallel" : "single")([]),
              };
            }
          } else {
            const names = requestedProjectAgents.map((a) => a.name).join(", ");
            const dir = discovery.projectAgentsDir ?? "(unknown)";
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: project-local agent confirmation is required in non-UI mode.\nAgents: ${names}\nSource: ${dir}\n\nRe-run with confirmProjectAgents: false only if this repository is trusted.`,
                },
              ],
              details: makeDetails(hasTasks ? "parallel" : "single")([]),
              isError: true,
            };
          }
        }

        // ── Parallel mode ──
        if (params.tasks && params.tasks.length > 0) {
          return executeParallel(
            params.tasks,
            delegationMode,
            forkSessionSnapshotJsonl,
            agents,
            ctx.cwd,
            signal,
            onUpdate,
            makeDetails,
          );
        }

        // ── Single mode ──
        if (params.agent && params.task) {
          return executeSingle(
            params.agent,
            params.task,
            params.cwd,
            delegationMode,
            forkSessionSnapshotJsonl,
            agents,
            ctx.cwd,
            signal,
            onUpdate,
            makeDetails,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Available agents: ${formatAgentNames(agents)}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      },

      renderCall: (args, theme, renderContext) =>
        renderCall(args, theme as RenderTheme, renderContext),
      renderResult: (result, options, theme, renderContext) =>
        renderResult(
          result,
          options.expanded,
          theme as RenderTheme,
          renderContext,
        ),
    });

    // Register the subagents tool (lists available subagents)
    pi.registerTool({
      name: "subagents",
      label: "Subagents",
      description: "List all available subagents.",
      promptSnippet: "subagents(): list available subagents.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const discovery = discoverAgents(ctx.cwd, "both");
        return {
          content: [
            { type: "text", text: __formatSubagentsList(discovery.agents) },
          ],
          details: {},
        };
      },
    });
  }

  async function executeSingle(
    agentName: string,
    task: string,
    taskCwd: string | undefined,
    delegationMode: DelegationMode,
    forkSessionSnapshotJsonl: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    const result = await runAgent({
      cwd: defaultCwd,
      agents,
      agentName,
      task,
      taskCwd: taskCwd,
      delegationMode,
      forkSessionSnapshotJsonl,
      parentDepth: currentDepth,
      parentAgentStack: ancestorAgentStack,
      maxDepth,
      preventCycles,
      signal,
      onUpdate,
      makeDetails: makeDetails("single"),
    });

    if (isResultError(result)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${result.stopReason || "failed"}: ${getResultSummaryText(result)}`,
          },
        ],
        details: makeDetails("single")([result]),
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: getResultSummaryText(result),
        },
      ],
      details: makeDetails("single")([result]),
    };
  }

  async function executeParallel(
    tasks: Array<{ agent: string; task: string; cwd?: string }>,
    delegationMode: DelegationMode,
    forkSessionSnapshotJsonl: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    if (tasks.length > MAX_SUBAGENT_PARALLEL_TASKS) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_SUBAGENT_PARALLEL_TASKS}.`,
          },
        ],
        details: makeDetails("parallel")([]),
      };
    }

    // Initialize placeholder results for streaming
    const allResults: SingleResult[] = tasks.map((t) => ({
      agent: t.agent,
      agentSource: "unknown" as const,
      task: t.task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
    }));

    const emitProgress = () => {
      if (!onUpdate) return;
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      onUpdate({
        content: [
          {
            type: "text",
            text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
          },
        ],
        details: makeDetails("parallel")([...allResults]),
      });
    };

    let heartbeat: NodeJS.Timeout | undefined;
    if (onUpdate) {
      emitProgress();
      heartbeat = setInterval(() => {
        if (allResults.some((r) => r.exitCode === -1)) emitProgress();
      }, PARALLEL_HEARTBEAT_MS);
    }

    let results: SingleResult[];
    // Fork mode writes the full parent session snapshot to a temp file. In a
    // parallel fan-out every task shares the SAME snapshot, so write it ONCE
    // and hand every child the shared file instead of N identical copies of
    // the whole session on disk. runAgent leaves a shared file to the caller,
    // so we clean it up here in finally.
    let sharedForkFile: { dir: string; filePath: string } | undefined;
    try {
      results = await mapConcurrent(
        tasks,
        DEFAULT_SUBAGENT_CONCURRENCY,
        async (t, index) => {
          if (
            sharedForkFile === undefined &&
            delegationMode === "fork" &&
            forkSessionSnapshotJsonl
          ) {
            try {
              sharedForkFile = writeForkSessionToTempFile(
                t.agent,
                forkSessionSnapshotJsonl,
              );
            } catch {
              // Write failed (ENOSPC etc.) — fall back to per-task writes;
              // runAgent's own prep failure returns a failure result.
            }
          }
          const result = await runAgent({
            cwd: defaultCwd,
            agents,
            agentName: t.agent,
            task: t.task,
            taskCwd: t.cwd,
            delegationMode,
            forkSessionSnapshotJsonl,
            forkSessionSnapshotFile: sharedForkFile,
            parentDepth: currentDepth,
            parentAgentStack: ancestorAgentStack,
            maxDepth,
            preventCycles,
            signal,
            onUpdate: (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitProgress();
              }
            },
            makeDetails: makeDetails("parallel"),
          });
          allResults[index] = result;
          emitProgress();
          return result;
        },
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (sharedForkFile) {
        try {
          fs.rmSync(sharedForkFile.dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }

    return buildParallelToolResult(results, makeDetails);
  }
}

function __formatSubagentsList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "No subagents available.";
  const lines = [`Available subagents (${agents.length}):`];
  for (const a of agents) {
    lines.push(`- **${a.name}** (${a.source}) — ${a.description}`);
  }
  return lines.join("\n");
}

export const __subagentTest = {
  parseDelegationMode,
  buildForkSessionSnapshotJsonl,
  parseNonNegativeInt,
  parseBoolean,
  parseAgentStack,
  getMaxDepthFlagFromArgv,
  getPreventCyclesFlagFromArgv,
  getCycleViolations,
  readSettings,
  mutateLittleCoderSettings,
  applySubagentOverrides,
  __resetSettingsCache,
  formatSubagentsList: __formatSubagentsList,
};
