---
title: "Edited index.ts, index.test.ts"
type: "session"
tags: "session, index.ts, index.test.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T23:55:54.776Z"
updated_at: "2026-05-26T23:55:54.776Z"
---
Prompt: Fix the issues please

Outcome: Fixed the reviewed issues.

Changes:
- `/review` ordering now uses one consistent ordering strategy across relevant comments:
  - all valid timestamps → timestamps
  - else all numeric IDs → IDs
  - else array order
- Added the mixed timestamp/missing timestamp test case.
- `listPullRequests()` now always repairs PR `apiUrl` to the issue endpoint when `issue_url` is missing, even if labels are already present in the PR row.
- Added a mocked test for discovered PR rows with labels but no `issue_url`.
- After setting the review cycle remotely, local `pr.labels` are updated to avoid stale cycle labels in later same-flow logic.

Verification passed:
- `npm test -- .pi/extensions/issue-agent/inde

Validation: npm test -- .pi/extensions/issue-agent/index.test.ts && npm run typecheck
