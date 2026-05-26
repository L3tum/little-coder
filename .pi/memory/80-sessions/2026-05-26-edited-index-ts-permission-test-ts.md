---
title: "Edited index.ts, permission.test.ts"
type: "session"
tags: "session, index.ts, permission.test.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T15:50:55.706Z"
updated_at: "2026-05-26T15:50:55.706Z"
---
Prompt: npx skills is supposed to be in the whitelist for bash and the guard

Outcome: Fixed.

Changes:
- Added `npx skills` to the built-in bash safe prefixes.
- Updated the permission-gate diagnostic guard to allow:
  - `npx skills`
  - `npx skills --help`
  - `npx skills find ...`
  - existing `list/show/info/search` commands

Validation:
- Added tests for `npx skills --help` and `npx skills find code-review`.
- Ran permission-gate tests: 30/30 passed.

Validation: npm test -- --run .pi/extensions/permission-gate/permission.test.ts
