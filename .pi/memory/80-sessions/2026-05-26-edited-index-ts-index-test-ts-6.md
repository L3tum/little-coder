---
title: "Edited index.ts, index.test.ts"
type: "session"
tags: "session, index.ts, index.test.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T23:57:45.123Z"
updated_at: "2026-05-26T23:57:45.123Z"
---
Prompt: Fix the issues please

Outcome: Fixed the issues.

Changes:
- `/review` detection now uses a stable tie-breaker:
  - timestamps use `timestamp * 1000 + index`
  - IDs use `id * 1000 + index`
  - fallback uses array order
- Changed comparison to strictly “last `/review` is after last AI summary” (`>`), preventing repeat loops when timestamps are equal.
- Added tests for equal-timestamp ordering:
  - `/review` then summary with same timestamp → answered
  - summary then `/review` with same timestamp → unanswered
- Hardened partial PR-creation failure:
  - If PR creation succeeds but labelling the PR fails, the originating issue is immediately moved to `PR_PENDING`.
  - A comment is posted with the PR reference and labelling 

Validation: npm test -- .pi/extensions/issue-agent/index.test.ts && npm run typecheck; npm test -- .pi/extensions/issue-agent/index.test.ts && npm run typecheck
