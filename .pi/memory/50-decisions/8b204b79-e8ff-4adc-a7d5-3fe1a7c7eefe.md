---
title: "Decision from index.ts, patch-extension-notifications.test.mjs, patch-extension-notifications.mjs"
type: "decision"
tags: "decision, index.ts, patch-extension-notifications.test.mjs, patch-extension-notifications.mjs"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-27T00:23:04.789Z"
updated_at: "2026-05-27T00:23:04.790Z"
---
Prompt: Please fix the issues.
It should show the current, not the most-recent.
Storing full payloads is acceptable.
The patch postinstall issue can be avoided by making a test that applies all tests, which would fail on update if the text is changed

Outcome: Fixed the reviewed issues.

Changes:
- Made inspect payload state per-session instead of global.
- Reset session capture state on `session_start`.
- Cleared provider payload at each new `before_agent_start`, so stale previous-turn payloads don’t appear as current.
- Updated provider hook to avoid awaiting expensive snapshot work on the model-request hot path.
- Renamed dashboard row from “last provider request payload” to “current provider request payload”.
- Refactored postinstall patches into exported `PATCHES` / `applyTextPatch`.
- Added `scripts/patch-extension-notifications.test.mjs` to verify all postinstall patches are applied and still match expected upstream text.
- Postinstall now 

Validation: npm test -- --runInBand; npm test && npm run typecheck; npm test && npm run typecheck
