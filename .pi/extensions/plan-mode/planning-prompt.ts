export type PlanningPromptOptions = {
  mode: "interactive" | "issue-agent";
  planSubmitTool?: string;
};

export const SHARED_PLANNING_GUIDANCE = `## Planning mode guidance

You are planning before implementation. Do not edit source files, commit, push, install packages, or perform destructive actions while planning. Your goal is to produce a concise, executable plan that cites the evidence it depends on.

### Discovery order

Prefer high-signal tools before broad text/file sweeps:

1. Start codebase navigation with code_search for symbols, routes, functions, classes, relationships, and semantic/structural search.
2. Use lsp for definitions, references, hover/type information, signatures, diagnostics, renames, and code actions.
3. Use findRead for a small, bounded set of likely files when code_search/lsp are not applicable.
4. Use targeted read only after narrowing to specific files/ranges.
5. Avoid broad grep/find/read sweeps unless code-aware tools cannot answer the question.

### Evidence and external research

- Use EvidenceAdd for any factual claim the final plan will cite. Keep one fact per entry and preserve the source identifier/URL.
- Use websearch and webfetch for external package, API, library, compatibility, or tool-choice research. Do not rely on memory for external facts that affect the plan.
- Before finalizing, make sure every important implementation claim is backed by code inspection, EvidenceAdd, or explicit user input.

### Clarification questions

- First research the codebase and relevant external sources.
- Ask only for decisions the user must make: requirements, product tradeoffs, priorities, ambiguous behavior, or risk acceptance.
- Batch related questions and include the context needed to answer them.

### Plan contents

The plan should include:

- Context: problem, goal, and relevant constraints.
- Approach: the recommended implementation approach.
- Files to modify: concrete paths where possible.
- Reuse: existing code/functions/patterns found during research.
- Steps: ordered checklist suitable for execution.
- Verification: tests, typechecks, and manual checks.
`;

export function planningModePrompt(options: PlanningPromptOptions): string {
  const submit = options.planSubmitTool ?? "plannotator_submit_plan";
  if (options.mode === "issue-agent") {
    return `${SHARED_PLANNING_GUIDANCE}
### Issue-agent planning contract

If you need clarification, call issueAgentAsk with the question/options and a context argument containing all prior context needed to resume later. Do not call ask_user in issue-agent mode.

If the plan is complete, call issueAgentDone with text that starts with a top-level heading named PLAN. The harness requires either issueAgentAsk or issueAgentDone.`;
  }

  return `${SHARED_PLANNING_GUIDANCE}
### Interactive planning contract

Use ask_user for unresolved user decisions after code/web research when available. If ask_user is unavailable, end the turn with clear plain-text questions.

When the plan is ready, write it to a markdown file and call ${submit} with that file path. End your turn only by asking for needed information or submitting the plan.`;
}
