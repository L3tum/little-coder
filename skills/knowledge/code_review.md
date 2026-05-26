---
name: code-review
type: domain-knowledge
topic: Code Review
token_cost: 150
keywords: [code review, review, reviews, reviewing, pr review, pull request, pull request review, merge request, diff, reviewer, feedback, request changes, approve, approval, blocker, nit, testability, maintainability]
requires_tools: [read, code_search, lsp]
user-invocable: false
---
Use this when reviewing code changes, pull requests, merge requests, diffs, or when establishing review practices.

Default review posture:
1. Gather context: read the PR/issue intent, changed files, tests, and existing patterns before commenting.
2. Prioritize findings: 🔴 Blocker (must fix) → 🟡 Major → 🟢 Minor/nit → 💡 Suggestion. Do not block on style that linters/formatters should handle.
3. Focus on correctness, security, testability, maintainability, performance, error handling, API/design fit, and whether the change actually solves the stated problem.
4. Review the code, not the person. Ask questions and explain why: “What happens if X is empty?” beats “This is wrong.”
5. Keep feedback actionable: include the exact risk, a concrete fix or alternative, and whether it is blocking.
6. Balance feedback: mention strong choices as well as problems; offer to pair on complex changes.

Checklist:
- Logic: edge cases, null/empty inputs, off-by-one errors, races, async failure paths.
- Security: input validation, authorization, injection, XSS, secrets, PII leakage.
- Tests: happy path, edge/error cases, deterministic behavior, behavior over implementation details.
- Maintainability: clear names, single responsibility, duplication, magic values, architectural consistency.
- Performance: N+1 queries, avoidable O(n²), unbounded memory, blocking hot paths.

Review format:
- Summary of what was reviewed.
- Strengths.
- Findings grouped by severity, each with rationale and proposed fix.
- Questions or non-blocking suggestions.
- Verdict: approve, comment, or request changes.

Avoid: perfectionism, scope creep, bike shedding, rubber stamping, delayed reviews, and comments that only say “fix this” without context.
