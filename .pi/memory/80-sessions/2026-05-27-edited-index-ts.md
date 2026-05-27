---
title: "Edited index.ts"
type: "session"
tags: "session, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-27T00:01:59.960Z"
updated_at: "2026-05-27T00:01:59.960Z"
---
Prompt: There should be a memory-doctor command to see if, for example, QMD is loaded.
Also, the memory files should have a UUID name as otherwise they may conflict with each other

Outcome: Implemented.

Changes:
- Added `/memory-doctor` command.
  - Shows memory dir.
  - Shows whether QMD is loaded or fallback is used.
  - Shows queue count, accepted memory count, and per-directory counts.
- Changed accepted memory filenames to UUIDs, e.g.:
  - `.pi/memory/80-sessions/3f8c...-....md`
  - This avoids title/date filename collisions.

Validation:
- `npm run typecheck` passes.

Validation: npm run typecheck
