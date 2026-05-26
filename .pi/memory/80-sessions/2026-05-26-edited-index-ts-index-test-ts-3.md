---
title: "Edited index.ts, index.test.ts"
type: "session"
tags: "session, index.ts, index.test.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T23:42:42.428Z"
updated_at: "2026-05-26T23:42:42.428Z"
---
Prompt: Please fix the issues.
PR labels should be authoritative after PR creation, but the issue may receive a label such as "ai:state/PR_PENDING" or similar.
Integration style unit test sounds good.
The /review PR comment should bypass the cooldown.

Outcome: Fixed the reviewed issues.

Changes:
- Added `ai:state/PR_PENDING`.
- After PR creation, PR labels remain authoritative:
  - PR gets `ai:source/AGENT`
  - PR gets `ai:state/REQUESTING_REVIEW`
  - originating issue gets `ai:state/PR_PENDING`
- `/review` PR comments now bypass cooldown.
- PR creation now forces a safe issue API URL for labels when `issue_url` is missing.
- PR head repo no longer falls back to `html_url` for git fetch/push; only clone-capable URLs are used.
- Forgejo approval fallback now only retries `APPROVED` on validation-style `400/422` errors.
- Added integration-style unit test with mocked `fetch` covering:
  - PR creation
  - labels being applied to the PR issue endpoin

Validation: npm test -- .pi/extensions/issue-agent/index.test.ts && npm run typecheck
