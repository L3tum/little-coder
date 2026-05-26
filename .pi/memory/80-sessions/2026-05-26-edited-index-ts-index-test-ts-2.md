---
title: "Edited index.ts, index.test.ts"
type: "session"
tags: "session, index.ts, index.test.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T23:36:46.622Z"
updated_at: "2026-05-26T23:36:46.622Z"
---
Prompt: Fix the issues please

Outcome: Fixed the reviewed issues.

Changes:
- After execution opens and labels the PR, the originating issue now moves to `ai:state/REQUESTING_REVIEW`, so it won’t remain runnable as `EXECUTING`.
- Review event submission now uses `APPROVE` for both GitHub and Forgejo, with a Forgejo fallback retry using `APPROVED` if approval submission is rejected.
- Required marker validation now distinguishes:
  - `plan`: must contain a `PLAN` heading
  - `done`: any `issueAgentDone` text
  - `verdict`: must start with `verdict: approve|comment|request_changes`
- Added tests for plan marker validation and updated review event expectations.

Verification passed:
- `npm test -- .pi/extensions/issue-agent/index.te

Validation: npm test -- .pi/extensions/issue-agent/index.test.ts && npm run typecheck
