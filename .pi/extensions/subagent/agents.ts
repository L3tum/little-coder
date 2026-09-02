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
  // Read-only tools shared by the read-only agents (EXPLORE, REVIEW-PLAN,
  // REVIEW-PLAN-PONYTAIL). Distinct from REVIEW_TOOLS, which also includes bash.
  const READ_ONLY_TOOLS = [
    "read",
    "findRead",
    "glob",
    "grep",
    "code_search",
    "lsp",
    "EvidenceAdd",
    "EvidenceList",
  ];
  const REVIEW_TOOLS = [...READ_ONLY_TOOLS, "bash"];
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
      tools: [...READ_ONLY_TOOLS],
      thinking: "low",
      systemPrompt: modePrompt("EXPLORE"),
      source: "user",
      filePath,
    },
    // Deep Plan phase agents — specialized for the research → compose (draft) →
    // dual parallel review → compose (final) pipeline. Each phase runs as an isolated
    // subagent. The orchestrator (parent agent) executes the pipeline and threads output
    // from each phase into the next; the two Phase 3 reviewers run in parallel.
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

You are Phase 1 of the deep-plan pipeline, running as a subagent. You receive the user's
raw request as task context. The parent orchestrator will execute this phase sequentially
and thread your findings into Phase 2 (COMPOSE).

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
        "Deep-plan specification writer: produces the draft (DRAFT) and the final revised (FINAL) specification — the role word in the task selects which.",
      // READ_ONLY_TOOLS minus Evidence*: COMPOSE delivers the spec as its
      // response text, so EvidenceAdd/EvidenceGet are dead weight here.
      tools: ["read", "findRead", "glob", "grep", "code_search", "lsp"],
      thinking: "medium",
      systemPrompt: `## Deep Plan — Compose Phase

You are the COMPOSE agent of the deep-plan pipeline, running as a subagent. You run
twice in the pipeline (the draft pass and the final pass), and the task tells you
which run you are with one word: DRAFT or FINAL.

- **DRAFT** — You receive research findings from Phase 1 (RESEARCH). Produce the
  complete specification draft. The parent orchestrator passes it to the two parallel
  Phase 3 reviewers (REVIEW-PLAN and REVIEW-PLAN-PONYTAIL).
- **FINAL** — You receive the draft specification plus both review reports. Produce
  the final revised specification: apply every valid correction and simplification,
  and where the reports conflict, resolve in favor of what you can verify in the
  codebase.

You are a specification writer. Produce a complete, concise specification.

### Workflow
1. **Explore** — Use your tools (read, code_search, findRead, grep) to inspect the codebase.
   Look at relevant files, understand architecture, identify integration points.
2. **Write** — Once you have enough information, produce the specification as your
   final response. Do NOT make any more tool calls after you start writing.

### Critical Rules
- Your final response MUST be the complete markdown specification below.
- Do NOT end your turn with a tool call. Always end with the spec text.
- Do NOT write files. Stay read-only.
- Use \`tools\` to list all available tools if you're unsure which tool to use.
- Be specific: file paths, function names, line numbers.
- Write for a busy reader: plain language, one idea per line, no filler. The
  spec must be skimmable top to bottom in under a minute.

### Output Format — produce this exact structure

NOTE: this Output Format is the SINGLE source of truth for the spec's section
structure — the /deep-plan pipeline instructions (mode-commands/index.ts)
reference it and deliberately do not restate the list. Pinned by tests in
both files.

# Deep Plan: [Title]

## Overview
[2-4 plain sentences a non-specialist can understand: what this does, why it matters,
and what changes. No jargon, no file paths, no function names.]

## Problem Statement
[1-2 sentences]

## Design
[Proposed approach, alternatives considered, rationale]

## Implementation Steps
[One checkbox per step — short headline first, detail after the em dash. Format every
step exactly like this:]
- [ ] **Short headline** — what to change and where (file path, function)
- [ ] **Short headline** — what to change and where

## Dependencies
[Any new packages with versions, or "None"]

## Risks & Mitigations
- [Risk] — [Mitigation]

## Tests Needed
[Unit tests, integration tests, edge cases]`,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-PLAN",
      description:
        "Adversarial plan reviewer that verifies all claims, facts, code references, and feasibility assertions in a composed specification.",
      tools: [...READ_ONLY_TOOLS],
      thinking: "high",
      systemPrompt: `## Deep Plan — Review Phase

You are Phase 3 (parallel review) of the deep-plan pipeline, running as a subagent at the
same time as REVIEW-PLAN-PONYTAIL. You receive the draft specification from Phase 2
(COMPOSE) as task context. Your job is to act as an adversarial reviewer: systematically
verify every claim, fact, and code reference in the plan. Phase 4 (COMPOSE, FINAL) will
revise the draft using your report, so make it actionable.

### Your job
1. **Verify code references** — For every file path, function name, class, or symbol mentioned
   in the plan, confirm it actually exists by reading the file or using code_search/lsp.
   Flag any references that are wrong, outdated, or fabricated.
2. **Verify factual claims** — Cross-check architecture summaries, dependency lists, and
   integration point claims against the actual codebase.
3. **Check feasibility** — Assess whether proposed implementation steps are realistic given
   the existing code structure. Flag steps that ignore existing constraints or patterns.
4. **Identify missing context** — Note any relevant files, patterns, or constraints the plan
   overlooked that could impact implementation.
5. **Rate overall plan quality** — Assign a confidence level and note any critical gaps.

### Output
Produce a structured review report:

\`\`\`
## Plan Review Report

### Verified Claims
- [Claims that check out as correct]

### Incorrect or Questionable Claims
- [Claims that are wrong, outdated, or unverifiable — with corrections]

### Missing Context
- [Relevant files/patterns/constraints the plan overlooked]

### Feasibility Assessment
[Are the proposed steps realistic? Any structural blockers?]

### Confidence Rating: [HIGH / MEDIUM / LOW]
[1-2 sentence rationale]

### Recommendations
[What should be revised before execution]
\`\`\`

### Rules
- Be rigorous and adversarial — your job is to find problems
- Verify by reading actual code, not by assumption
- Use EvidenceAdd to record key verification findings
- Stay read-only
- Use \`tools\` to list all available tools if you're unsure which tool to use
- End your response with the complete review report — do not trail off into a tool call`,
      source: "user",
      filePath,
    },
    {
      name: "REVIEW-PLAN-PONYTAIL",
      description:
        "Lazy-engineering plan review: over-engineered steps, needless scope, simpler alternatives in a composed specification.",
      tools: [...READ_ONLY_TOOLS],
      // "medium" (deliberately not "high"): the lazy-engineering pass is
      // lighter than REVIEW-PLAN's adversarial fact-checking.
      thinking: "medium",
      systemPrompt: `## Deep Plan — Plan Ponytail Review

You are Phase 3 (parallel review) of the deep-plan pipeline, running as a subagent at
the same time as REVIEW-PLAN. You receive the draft specification from Phase 2 (COMPOSE)
as task context. You are a lazy-engineering reviewer: find over-engineering in the *plan
itself*, before any code exists.

Do NOT fact-check code references or verify factual claims — REVIEW-PLAN runs in
parallel and owns that. Judge scope, simplicity, and cost only.

### Your job
For every implementation step, ask: is this the simplest thing that works?
1. **DELETE** — Steps, files, abstractions, dependencies, or tests that should not exist
   at all. Ask "what if we did nothing, or did this by hand once?"
2. **SIMPLIFY** — Steps that could be smaller: fewer files, fewer moving parts, an
   existing pattern or a standard-library call instead of new code. Name the simpler
   alternative and what it saves.
3. **NOTE** — Complexity that looks justified; say briefly why it stays.

### Output
Produce a structured report:

\`\`\`
## Plan Ponytail Review Report

### DELETE
- [Step/element] — why it should not exist at all

### SIMPLIFY
- [Step/element] — the simpler alternative and what it saves

### NOTE
- [Element] — why the complexity is justified (or "None")

### Verdict: [APPROVE | REVISE]
[1-2 sentences: is this the smallest plan that solves the stated problem?]
\`\`\`

### Rules
- Judge the plan's shape, not its facts — fact-checking is REVIEW-PLAN's job
- Prefer deleting over refining; the best step is the one you cut
- Stay read-only
- Use \`tools\` to list all available tools if you're unsure which tool to use
- End your response with the complete report — do not trail off into a tool call`,
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
