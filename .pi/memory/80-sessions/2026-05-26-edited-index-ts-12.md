---
title: "Edited index.ts"
type: "session"
tags: "session, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T22:54:11.516Z"
updated_at: "2026-05-26T22:54:11.516Z"
---
Prompt: Skills under @skills/ should be explicitly loadable through the /skill:[skill] command

Outcome: Implemented.

Changes:
- Loads `skills/` at extension startup.
- Registers each skill as an explicit slash command:
  - `/skill:code-review`
  - `/skill:bfs-state-space`
  - `/skill:hatch-pet`
  - etc.
- Added `/skill <name>` fallback with completions.
- Explicitly loaded skills are injected as steer context for the next response.
- `/skills` still lists all available skills.

Validation:
- `npx vitest run .pi/extensions/skill-inject` passed: 14/14 tests.
- `npx tsc --noEmit --pretty false` completed without errors.

Validation: cat package.json | sed -n '1,120p' && npx vitest run .pi/extensions/skill-inject --runInBand; npx vitest run .pi/extensions/skill-inject; ls && npx tsc --noEmit --pretty false
