---
title: "Edited index.ts"
type: "session"
tags: "session, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T01:05:32.325Z"
updated_at: "2026-05-26T01:05:32.326Z"
---
Prompt: Sub-agent spawning doesn't seem to work. Are you sure this is the best way anyway?
Error: issue-agent sub-agent failed for #6: spawn little-coder ENOENT

Outcome: Fixed the `spawn little-coder ENOENT` issue.

What changed:
- No longer relies on `little-coder` being on `PATH`.
- Resolves the bundled launcher from the extension location:
  - `.pi/extensions/issue-agent/index.ts` → package root → `bin/little-coder.mjs`
- Spawns it via `process.execPath`, e.g. `node bin/little-coder.mjs ...`, which is more reliable.
- Still supports override with `ISSUE_AGENT_LITTLE_CODER_BIN` if needed.
- Keeps sub-agent output piped back as `deliverAs: "followUp"` messages.

Validation:
- `npm run typecheck` passes.

On “is this the best way?”: for the requirement that each issue runs with the checked-out project’s own `AGENTS.md`/system prompt, a separate child `little

Validation: npm run typecheck
