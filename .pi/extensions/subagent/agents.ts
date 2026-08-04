/**
 * Agent discovery and configuration.
 *
 * Agents are Markdown files with YAML frontmatter that define name, description,
 * optional model/tools, and a system prompt body.
 *
 * Lookup locations:
 *   - User agents:    ~/.pi/agent/agents/*.md by default, or
 *                     $PI_CODING_AGENT_DIR/agents/*.md when the env var is set
 *   - Project agents: .pi/agents/*.md  (walks up from cwd)
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  modePrompt,
  themedReviewPrompts,
  themedProjectReviewPrompts,
} from "../mode-commands/mode-prompts.js";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

export interface StarterAgentDiscoveryResult {
  discovery: AgentDiscoveryResult;
  createdAgentPath: string | null;
  error?: string;
}

export const STARTER_AGENT_NAME = "explorer";
export const STARTER_AGENT_FILE_NAME = "explorer.md";

export function builtInLittleCoderAgents(): AgentConfig[] {
  const filePath = "little-coder:programmatic";
  const REVIEW_TOOLS = [
    "read",
    "findRead",
    "glob",
    "grep",
    "code_search",
    "lsp",
    "bash",
    "EvidenceAdd",
    "EvidenceList",
  ];
  return [
    {
      name: "PLAN",
      description:
        "Planning specialist that produces evidence-backed executable plans.",
      tools: [
        "read",
        "findRead",
        "glob",
        "grep",
        "code_search",
        "lsp",
        "websearch",
        "webfetch",
        "EvidenceAdd",
        "EvidenceList",
      ],
      thinking: "high",
      systemPrompt: modePrompt("PLAN"),
      source: "user",
      filePath,
    },
    {
      name: "EXECUTION",
      description:
        "Implementation specialist for executing approved plans and running checks.",
      thinking: "medium",
      systemPrompt: modePrompt("EXECUTION"),
      source: "user",
      filePath,
    },
    {
      name: "REVIEW",
      description:
        "Read-only reviewer that inspects diffs and returns a verdict.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: modePrompt("REVIEW"),
      source: "user",
      filePath,
    },
    {
      name: "EXPLORE",
      description:
        "Read-only codebase exploration specialist for evidence-backed handoffs.",
      tools: [
        "read",
        "findRead",
        "glob",
        "grep",
        "code_search",
        "lsp",
        "EvidenceAdd",
        "EvidenceList",
      ],
      thinking: "low",
      systemPrompt: modePrompt("EXPLORE"),
      source: "user",
      filePath,
    },
    // Deep Plan phase agents — specialized for the refine → research → compose pipeline.
    // Each phase runs as an isolated subagent. The orchestrator (parent agent) executes
    // the pipeline sequentially and threads output from each phase into the next.
    {
      name: "REFINE",
      description:
        "Clarifies requests and produces structured requirements documents.",
      tools: ["read", "findRead", "glob", "grep", "code_search", "lsp"],
      thinking: "medium",
      systemPrompt: `## Deep Plan — Refine Phase

You are Phase 1 of the deep-plan pipeline, running as a subagent. The parent orchestrator
will execute this phase sequentially, capture your output, and thread it into Phase 2 (RESEARCH).

Clarify the user's request and produce a structured requirements document.

### Your job
1. Restate the problem in 1-2 clear sentences
2. Extract and enumerate key requirements
3. Identify ambiguities that need resolution
4. Define scope boundaries (what's in scope vs out of scope)

### Rules
- Be concise but precise — your output feeds directly into the RESEARCH subagent
- Do not implement anything — this is analysis only
- Use tools (read, grep, code_search) only if needed to understand context
- Use \`tools\` to list all available tools if you're unsure which tool to use
- End your response with the complete refined requirements — do not trail off into a tool call`,
      source: "user",
      filePath,
    },
    {
      name: "RESEARCH",
      description:
        "Explores codebases and gathers concrete evidence for plans.",
      tools: [
        "read",
        "findRead",
        "glob",
        "grep",
        "code_search",
        "lsp",
        "websearch",
        "webfetch",
        "EvidenceAdd",
        "EvidenceList",
      ],
      thinking: "medium",
      systemPrompt: `## Deep Plan — Research Phase

You are Phase 2 of the deep-plan pipeline, running as a subagent. You receive refined
requirements from Phase 1 (REFINE) as task context. The parent orchestrator will execute
this phase sequentially and thread your findings into Phase 3 (COMPOSE).

Explore the codebase to gather concrete evidence for the plan.

### Your job
1. Use code_search to find relevant symbols, functions, and patterns
2. Use lsp for definitions and references
3. Use findRead for targeted file inspection
4. Use websearch/webfetch for external APIs or packages if needed
5. Record all factual claims with EvidenceAdd

### Output
- Architecture summary: relevant files and their roles
- Existing patterns to follow or avoid
- External dependencies needed (with versions)
- Key integration points
- Potential conflicts or blockers

### Rules
- Read actual code, do not guess — your output feeds the COMPOSE subagent
- Be specific: file paths, function names, line numbers
- Stay read-only
- Use \`tools\` to list all available tools if you're unsure which tool to use
- End your response with the complete research findings — do not trail off into a tool call`,
      source: "user",
      filePath,
    },
    {
      name: "COMPOSE",
      description:
        "Produces complete specifications from requirements and research findings.",
      tools: ["read", "findRead", "glob", "grep", "code_search", "lsp"],
      thinking: "medium",
      systemPrompt: `## Deep Plan — Compose Phase

You are Phase 3 (final phase) of the deep-plan pipeline, running as a subagent. You receive
refined requirements from Phase 1 (REFINE) and research findings from Phase 2 (RESEARCH)
as task context. The parent orchestrator will capture your output as the final specification.

You are a specification writer. Produce a complete, detailed specification from the refined
requirements and research findings provided in the task.

### Workflow
1. **Explore** — Use your tools (read, code_search, findRead, grep) to inspect the codebase.
   Look at relevant files, understand architecture, identify integration points.
2. **Write** — Once you have enough information, produce the specification as your
   FINAL response. Do NOT make any more tool calls after you start writing.

### Critical Rules
- Your FINAL message MUST be the complete markdown specification below.
- Do NOT end your turn with a tool call. Always end with the spec text.
- Do NOT write files. Stay read-only.
- Use \`tools\` to list all available tools if you're unsure which tool to use.
- Be specific: file paths, function names, line numbers.

### Output Format — produce this exact structure

# Deep Plan: [Title]

## Problem Statement
[1-2 sentences]

## Context
[Relevant existing code, architecture, patterns found]

## Design
[Proposed approach, alternatives considered, rationale]

## Implementation Steps
[Ordered, specific, with file paths and function names]
1. [Step 1] — file: \`path/to/file.ts\`, function: \`foo()\`
2. [Step 2] — ...

## Dependencies
[Any new packages with versions, or "None"]

## Risks & Mitigations
- [Risk] — [Mitigation]

## Tests Needed
[Unit tests, integration tests, edge cases]`,
      source: "user",
      filePath,
    },
    // Themed review agents — specialized subagents for focused code review.
    {
      name: "REVIEW-SECURITY",
      description:
        "Security-focused code review: vulnerabilities, injection, auth, data exposure, secrets.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedReviewPrompts.security,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-ARCHITECTURE",
      description:
        "Architecture review: patterns, coupling, separation of concerns, scalability.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedReviewPrompts.architecture,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-TESTS",
      description:
        "Test review: coverage gaps, flaky tests, test quality, missing scenarios.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedReviewPrompts.tests,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-BUGS",
      description:
        "Bug hunting: logic errors, edge cases, race conditions, null handling.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedReviewPrompts.bugs,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-PERFORMANCE",
      description:
        "Performance review: bottlenecks, inefficient algorithms, memory usage.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedReviewPrompts.performance,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-LINTING",
      description:
        "Linting & style review: code quality, formatting, type safety, documentation.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedReviewPrompts.linting,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-PONYTAIL",
      description:
        "Lazy engineering review: over-engineering, boilerplate, unnecessary complexity, simpler alternatives.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedReviewPrompts.ponytail,
      source: "user",
      filePath,
    },
    // Themed project-wide review agents — specialized subagents for focused
    // code review across the entire codebase (not just the latest diff).
    {
      name: "REVIEW-PROJECT-SECURITY",
      description:
        "Security-focused project audit: vulnerabilities across the entire codebase.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedProjectReviewPrompts.security,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-PROJECT-ARCHITECTURE",
      description:
        "Architecture project audit: patterns, coupling, separation of concerns, scalability across the full codebase.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedProjectReviewPrompts.architecture,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-PROJECT-TESTS",
      description:
        "Test project audit: coverage gaps, flaky tests, test quality, missing scenarios across the full codebase.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedProjectReviewPrompts.tests,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-PROJECT-BUGS",
      description:
        "Bug hunting project audit: logic errors, edge cases, race conditions, null handling across the full codebase.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedProjectReviewPrompts.bugs,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-PROJECT-PERFORMANCE",
      description:
        "Performance project audit: bottlenecks, inefficient algorithms, memory usage across the full codebase.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedProjectReviewPrompts.performance,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-PROJECT-LINTING",
      description:
        "Linting & style project audit: code quality, formatting, type safety, documentation across the full codebase.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedProjectReviewPrompts.linting,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-PROJECT-PONYTAIL",
      description:
        "Lazy engineering project audit: over-engineering, boilerplate, unnecessary complexity across the full codebase.",
      tools: REVIEW_TOOLS,
      thinking: "medium",
      systemPrompt: themedProjectReviewPrompts.ponytail,
      source: "user",
      filePath,
    },
  ];
}

const STARTER_AGENT_MARKDOWN = `---
name: explorer
description: Read-only codebase exploration specialist for focused searches, repository reconnaissance, and evidence-backed summaries. Use when you need fast context from files without edits.
tools: read, grep, find, ls
---

You are a codebase exploration specialist. Your job is to quickly gather reliable,
targeted context from the local repository and return it in a form another agent
can use without repeating the same search.

## Operating mode

- Work read-only.
- Never create, edit, delete, or commit files.
- Do not make changes to the environment or repository state.
- Prefer fast discovery first, then selective reading.
- Keep scope tight to the task; do not broaden the investigation unless needed.

## Search strategy

1. Start broad: find likely files, symbols, call sites, configs, tests, and docs.
2. Narrow down: read only the most relevant files or sections.
3. Stop when you have enough evidence; avoid exhaustive exploration unless asked.

## Output rules

- Return file paths as absolute paths when possible.
- Include line ranges whenever you rely on file contents.
- Be factual and precise.
- Distinguish facts supported by inspected files from inferences.
- If something is not found, say what you checked.

Keep the response concise, structured, and optimized for agent handoff.
`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function getUserAgentsDir(): string {
  const configDir =
    process.env["PI_CODING_AGENT_DIR"]?.trim() ||
    path.join(os.homedir(), ".pi", "agent");
  return path.join(configDir, "agents");
}

/** Walk up from `cwd` looking for a `.pi/agents` directory. */
function findNearestProjectAgentsDir(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parse a single agent markdown file into an AgentConfig. Returns null on skip. */
function parseAgentFile(
  filePath: string,
  source: "user" | "project",
): AgentConfig | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[pi-subagent] Skipping invalid agent file "${filePath}": ${message}`,
    );
    return null;
  }

  const frontmatter = parsed.frontmatter ?? {};
  const body = parsed.body ?? "";

  const name =
    typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description =
    typeof frontmatter.description === "string"
      ? frontmatter.description.trim()
      : "";
  if (!name || !description) return null;

  let tools: string[] | undefined;
  if (typeof frontmatter.tools === "string") {
    const parsedTools = frontmatter.tools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (parsedTools.length > 0) tools = parsedTools;
  } else if (Array.isArray(frontmatter.tools)) {
    const parsedTools = frontmatter.tools
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean);
    if (parsedTools.length > 0) tools = parsedTools;
  } else if (frontmatter.tools !== undefined) {
    console.warn(
      `[pi-subagent] Ignoring invalid tools field in "${filePath}". Expected a comma-separated string or string array.`,
    );
  }

  return {
    name,
    description,
    tools,
    model:
      typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    thinking:
      typeof frontmatter.thinking === "string"
        ? frontmatter.thinking
        : undefined,
    systemPrompt: body,
    source,
    filePath,
  };
}

/** Load all agent definitions from a directory. */
function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const agent = parseAgentFile(path.join(dir, entry.name), source);
    if (agent) agents.push(agent);
  }
  return agents;
}

function mergeAgents(...groups: AgentConfig[][]): AgentConfig[] {
  const agentMap = new Map<string, AgentConfig>();
  for (const group of groups) {
    for (const agent of group) agentMap.set(agent.name, agent);
  }
  return Array.from(agentMap.values());
}

function getStarterAgentFileName(attempt: number): string {
  if (attempt === 0) return STARTER_AGENT_FILE_NAME;
  if (attempt === 1) return "explorer-starter.md";
  return `explorer-starter-${attempt}.md`;
}

function isFileExistsError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EEXIST"
  );
}

function writeStarterAgentFile(filePath: string): void {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, STARTER_AGENT_MARKDOWN, { encoding: "utf-8" });
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all available agents according to the requested scope.
 *
 * Precedence is: user < project.
 */
export function discoverAgents(
  cwd: string,
  scope: AgentScope,
): AgentDiscoveryResult {
  const userAgentsDir = getUserAgentsDir();
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents =
    scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
  const projectAgents =
    scope === "user" || !projectAgentsDir
      ? []
      : loadAgentsFromDir(projectAgentsDir, "project");

  const builtIns = builtInLittleCoderAgents();
  if (scope === "user") {
    return { agents: mergeAgents(builtIns, userAgents), projectAgentsDir };
  }
  if (scope === "project") {
    return { agents: mergeAgents(builtIns, projectAgents), projectAgentsDir };
  }
  return {
    agents: mergeAgents(builtIns, userAgents, projectAgents),
    projectAgentsDir,
  };
}

/**
 * Discover user/project agents, creating a starter user agent when none exist.
 *
 * This intentionally has no marker file: if a user deletes every agent, the
 * starter will be recreated on the next discovery that needs runnable agents.
 * Existing files are never overwritten.
 */
export function discoverAgentsWithStarter(
  cwd: string,
): StarterAgentDiscoveryResult {
  const initial = discoverAgents(cwd, "both");
  if (initial.agents.length > 0) {
    return { discovery: initial, createdAgentPath: null };
  }

  const userAgentsDir = getUserAgentsDir();

  try {
    fs.mkdirSync(userAgentsDir, { recursive: true });

    for (let attempt = 0; attempt < 100; attempt++) {
      const latest = attempt === 0 ? initial : discoverAgents(cwd, "both");
      if (latest.agents.length > 0) {
        return { discovery: latest, createdAgentPath: null };
      }

      const filePath = path.join(
        userAgentsDir,
        getStarterAgentFileName(attempt),
      );
      try {
        writeStarterAgentFile(filePath);
        return {
          discovery: discoverAgents(cwd, "both"),
          createdAgentPath: filePath,
        };
      } catch (err) {
        if (isFileExistsError(err)) continue;
        throw err;
      }
    }

    return {
      discovery: initial,
      createdAgentPath: null,
      error: `Could not find an unused starter agent filename in ${userAgentsDir}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      discovery: initial,
      createdAgentPath: null,
      error: `Could not create starter agent in ${userAgentsDir}: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Validation — check that all built-in agents have required fields
// ---------------------------------------------------------------------------

export function validateBuiltInAgents(): void {
  const agents = builtInLittleCoderAgents();
  for (const agent of agents) {
    if (!agent.name) throw new Error("Built-in agent missing name");
    if (!agent.description)
      throw new Error(`Built-in agent "${agent.name}" missing description`);
    if (!agent.systemPrompt)
      throw new Error(`Built-in agent "${agent.name}" missing systemPrompt`);
    if (agent.source !== "user")
      throw new Error(
        `Built-in agent "${agent.name}" has unexpected source: ${agent.source}`,
      );
  }
}
