---
title: "Edited launcher-helpers.mjs, little-coder.mjs, index.ts"
type: "session"
tags: "session, launcher-helpers.mjs, little-coder.mjs, index.ts, index.ts, index.test.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T11:29:35.444Z"
updated_at: "2026-05-26T11:29:35.444Z"
---
Prompt: Implement the plan

Outcome: Implemented.

Changes made:
- Sub-agent launcher mode now sets `LITTLE_CODER_SUBAGENT=1` plus quiet/offline env.
- Bundled `.pi/extensions/branding` is excluded in `--issue-agent-subagent` mode.
- Branding extension also has a defensive no-op guard when `LITTLE_CODER_SUBAGENT=1`.
- Parent/sub-agent process completion now waits on `close` instead of `exit`.
- `issue-agent` sub-agent stderr is buffered and only emitted on failure.
- Duplicate assistant JSON snapshots are deduplicated before piping to parent chat.
- Sub-agent env is passed through from `runSubAgent`.
- Added testable launcher helpers.
- Added automated tests for:
  - successful sub-agent plan completion;
  - repeated assistant 

Validation: npm test; npm test && npm run typecheck
