import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  autoresearchModePrompt,
  executionModePrompt,
  planModePrompt,
  ThemedReviewKey,
} from "./mode-prompts.js";

function latestPlan(cwd: string): string | undefined {
  const dirs = [join(cwd, "plans"), cwd];
  let newest: { path: string; mtime: number } | undefined;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/plan.*\.md$|.*\.plan\.md$|.*plan.*\.markdown$/i.test(name))
        continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isFile() && (!newest || st.mtimeMs > newest.mtime))
        newest = { path, mtime: st.mtimeMs };
    }
  }
  return newest ? readFileSync(newest.path, "utf-8") : undefined;
}

let activeModePrompt: string | undefined;

function switchSystemPrompt(ctx: any, prompt: string): void {
  activeModePrompt = prompt;
  ctx.ui?.notify?.("Mode system prompt updated for subsequent turns.", "info");
}

export default function (pi: ExtensionAPI) {
  if (typeof (pi as any).on === "function") {
    pi.on("before_agent_start", async () => {
      if (activeModePrompt) return { systemPrompt: activeModePrompt };
    });
  }
  pi.registerCommand("plan-prompt", {
    description: "Show the legacy planning prompt without taking over /plan",
    handler: async (_args, ctx) => {
      if (process.env.LITTLE_CODER_SUBAGENT || process.env.PI_SUBAGENT_DEPTH) {
        ctx.ui?.notify?.(
          "/plan-prompt is interactive-only and is disabled in subagent mode.",
          "warning",
        );
        return;
      }
      switchSystemPrompt(ctx, planModePrompt("interactive"));
    },
  });

  pi.registerCommand("execute", {
    description: "Enter execution mode for the latest plan",
    handler: async (_args, ctx) => {
      switchSystemPrompt(
        ctx,
        executionModePrompt(latestPlan(ctx.cwd ?? process.cwd())),
      );
    },
  });

  pi.registerCommand("review", {
    description:
      "Run themed code review with security, architecture, tests, bugs, and performance subagents",
    handler: async (_args, ctx) => {
      if (process.env.LITTLE_CODER_SUBAGENT || process.env.PI_SUBAGENT_DEPTH) {
        ctx.ui?.notify?.(
          "/review is interactive-only and is disabled in subagent mode.",
          "warning",
        );
        return;
      }

      const themes: ThemedReviewKey[] = [
        "security",
        "architecture",
        "tests",
        "bugs",
        "performance",
        "linting",
        "ponytail",
      ];
      const themeAgents: Record<ThemedReviewKey, string> = {
        security: "REVIEW-SECURITY",
        architecture: "REVIEW-ARCHITECTURE",
        tests: "REVIEW-TESTS",
        bugs: "REVIEW-BUGS",
        performance: "REVIEW-PERFORMANCE",
        linting: "REVIEW-LINTING",
        ponytail: "REVIEW-PONYTAIL",
      };

      ctx.ui?.notify?.(
        "Starting themed code review (7 focused reviews)...",
        "info",
      );

      // Build a structured request that tells the main agent to run each themed
      // subagent sequentially. The subagent tool is the mechanism that actually
      // spawns the isolated review processes.
      const agentTasks = themes
        .map((theme, i) => {
          const agentName = themeAgents[theme];
          return `Step ${i + 1}: Run subagent ${agentName} with task:\n"Review the current repository changes. Use git diff to see what changed, then examine relevant files. Focus specifically on ${theme} concerns and return a structured report with findings sorted by severity."`;
        })
        .join("\n\n");

      const reviewPrompt = `## Themed Code Review Pipeline

Run the following 7 themed review subagents **sequentially** (wait for each to complete before starting the next):

${agentTasks}

### After all themed reviews complete:
1. Combine all findings into a single synthesis
2. Deduplicate overlapping issues across themes
3. Cross-reference related findings
4. Render a unified verdict: **approve**, **comment**, or **request_changes**

### Output format — render as raw Markdown, NOT inside a code block

\`\`\`
## Review Verdict: [approve | comment | request_changes]

### Critical Findings
- [CRITICAL severity items]

### High Priority
- [HIGH severity items, deduplicated]

### Medium/Low Priority
- [Remaining items grouped by category]

### Summary
[2-3 sentence overall assessment]

### Recommendation
[What to do next]
\`\`\`

Important: Output the Markdown above as plain rendered text. Do NOT wrap
the entire response in a code block (triple backticks). The user will read
this directly.`;

      // Switch to overall review mode with the pipeline instructions
      switchSystemPrompt(ctx, reviewPrompt);

      // Trigger the review pipeline
      pi.sendUserMessage(
        "Execute the themed review pipeline: run all 7 subagents sequentially, collect findings, and produce a synthesized report with verdict.",
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("deep-plan", {
    description:
      "Run a deep planning pipeline: refine → research → compose, then deliver spec for review",
    handler: async (args, ctx) => {
      if (process.env.LITTLE_CODER_SUBAGENT || process.env.PI_SUBAGENT_DEPTH) {
        ctx.ui?.notify?.(
          "/deep-plan is interactive-only and is disabled in subagent mode.",
          "warning",
        );
        return;
      }

      const prompt = args?.trim();
      if (!prompt) {
        ctx.ui?.notify?.(
          "Usage: /deep-plan <description of the change or feature to plan>",
          "warning",
        );
        return;
      }

      ctx.ui?.notify?.(
        `Starting deep plan: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"`,
        "info",
      );

      const deepPlanPrompt = `## Deep Plan Pipeline

You are orchestrating a 3-phase deep planning pipeline executed in subagents.
Each phase runs as an isolated subagent process. You execute them **sequentially**,
capturing output from each phase and threading it into the next.

### Pipeline architecture
- **REFINE** (Phase 1) — Clarifies the request, extracts requirements, defines scope.
  Runs as a subagent. You pass its output into Phase 2.
- **RESEARCH** (Phase 2) — Explores the codebase, gathers evidence, records findings.
  Runs as a subagent. You pass its output into Phase 3.
- **COMPOSE** (Phase 3) — Produces the final markdown specification.
  Runs as a subagent. Its output becomes the deliverable.

### Phase 1: REFINE
Run subagent REFINE with task:
"Refine this request: '${prompt}'. Clarify requirements, extract key goals,
identify ambiguities, and define scope boundaries."

### Phase 2: RESEARCH
Run subagent RESEARCH with task:
"Research the codebase for this request: '${prompt}'. Use the refined
requirements from Phase 1 as context. Explore relevant files, understand
architecture, identify integration points, and record all factual findings."

### Phase 3: COMPOSE
Run subagent COMPOSE with task:
"Compose a detailed specification for this request: '${prompt}'. Use the
refined requirements from Phase 1 and research findings from Phase 2.
Produce a complete markdown specification with problem statement, context,
design, implementation steps, dependencies, risks, and tests needed."

### After all phases complete:
1. Extract the specification produced by the COMPOSE subagent
2. Write the specification to a markdown file in the \`plans/\` directory with name \`deep-plan-${Date.now()}.md\`
3. Call \`plannotator_submit_plan\` with the plan file path to enter interactive review mode

### Important Rules
- Execute each phase as a subagent call — wait for each subagent to complete
  before invoking the next phase
- Thread the full output from each subagent into the next phase's task context
- The COMPOSE phase subagent output must be a complete markdown specification with
  headings and body content
- Do NOT skip any phase`;

      // Enter plannotator's planning phase so plannotator_submit_plan is
      // registered. If the plannotator extension is not active this is a
      // harmless no-op — the agent will still work, just without the
      // interactive review gate.
      try {
        const { PLANNOTATOR_REQUEST_CHANNEL, PLANNOTATOR_TIMEOUT_MS } =
          await import("@plannotator/pi-extension/plannotator-events");
        const requestId = `deep-plan-${Date.now()}`;
        await new Promise<void>((resolve) => {
          pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
            requestId,
            action: "plan-mode",
            payload: { mode: "enter" },
            respond(_resp: unknown) {
              void _resp;
              resolve();
            },
          });
          // Fallback timeout in case no listener exists
          setTimeout(resolve, PLANNOTATOR_TIMEOUT_MS);
        });
      } catch {
        // Plannotator not installed or not active — continue without it
      }

      // Switch to deep plan mode with the pipeline instructions
      switchSystemPrompt(ctx, deepPlanPrompt);

      // Trigger the deep plan pipeline
      pi.sendUserMessage(
        `Execute the deep plan pipeline for: "${prompt}". ` +
          `Run REFINE → RESEARCH → COMPOSE as sequential subagent calls, ` +
          `threading output from each phase into the next, ` +
          `write the spec to plans/deep-plan-<timestamp>.md, ` +
          `then call plannotator_submit_plan.`,
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("autoresearch", {
    description: "Enter autoresearch mode",
    handler: async (_args, ctx) => {
      switchSystemPrompt(ctx, autoresearchModePrompt());
    },
  });
}
