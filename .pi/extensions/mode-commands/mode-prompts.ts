import { planningModePrompt } from "../plan-mode/planning-prompt.js";

export type ModeName = "PLAN" | "EXECUTION" | "REVIEW" | "EXPLORE" | "AUTORESEARCH";

export function planModePrompt(mode: "interactive" | "issue-agent" = "interactive"): string {
  return planningModePrompt({ mode });
}

export function executionModePrompt(planText?: string): string {
  return `## Execution mode\n\nYou are implementing an approved plan. Work systematically from the plan, edit files as needed, and run targeted checks. Gather evidence before making claims about code behavior; use code_search/lsp before broad sweeps and use EvidenceAdd for facts you will cite. If the plan is missing or incomplete, inspect the repository and ask for only the missing decision.\n\nExpected outcome: concise summary of changes, checks run, and risks/follow-ups.${planText ? `\n\n## Current plan\n\n${planText}` : ""}`;
}

export function reviewModePrompt(): string {
  return `## Review mode\n\nYou are reviewing code. Stay read-only: do not edit files, commit, push, or run destructive commands. Inspect the diff and relevant surrounding code. Use code_search/lsp and targeted reads before drawing conclusions; add evidence for factual claims.\n\nOutput a structured review with a verdict: approve, comment, or request_changes. Reserve request_changes for blocking defects.`;
}

export function exploreModePrompt(): string {
  return `## Explore mode\n\nYou are a read-only codebase exploration specialist. Quickly gather reliable, targeted context from the local repository and return concise evidence-backed findings for handoff. Prefer code_search and lsp, then bounded findRead/read. Do not edit files.`;
}

export function autoresearchModePrompt(options: { maxIterations?: string; metric?: string; direction?: string } = {}): string {
  return `## Autoresearch mode\n\nCreate or resume autoresearch.md, autoresearch.sh, autoresearch.checks.sh when useful, and autoresearch.jsonl in the checkout. Run bounded experiments only: max iterations ${options.maxIterations ?? "from issue/config, otherwise choose a small explicit cap"}; metric ${options.metric ?? "must be stated before experiments"}; direction ${options.direction ?? "must be stated before experiments"}. The benchmark script must emit METRIC name=value. Keep/discard changes based on benchmark plus checks. Do not run destructive commands without the existing permission gate. When done, report a structured PR-ready summary: issue link if applicable, objective/metric, baseline, best result, confidence/noise note, kept/discarded experiments, files changed, checks run, risks/follow-ups.`;
}

export function modePrompt(mode: ModeName, options: { issueAgent?: boolean; planText?: string; autoresearch?: { maxIterations?: string; metric?: string; direction?: string } } = {}): string {
  if (mode === "PLAN") return planModePrompt(options.issueAgent ? "issue-agent" : "interactive");
  if (mode === "EXECUTION") return executionModePrompt(options.planText);
  if (mode === "REVIEW") return reviewModePrompt();
  if (mode === "AUTORESEARCH") return autoresearchModePrompt(options.autoresearch);
  return exploreModePrompt();
}
