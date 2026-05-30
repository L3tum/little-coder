---
title: "Observation about mode-prompts.ts, index.ts, agents.ts"
type: "observation"
tags: "observation, mode-prompts.ts, index.ts, agents.ts, index.ts, runner.ts"
confidence: "high"
source: "memory-context deterministic turn_end; auto-promoted after 3 matches"
created_at: "2026-05-30T01:08:07.152Z"
updated_at: "2026-05-30T09:53:22.086Z"
---
## Summary
Implemented the plan’s main refactor pieces. Summary: - Added vendored `.pi/extensions/subagent/` based on `pi-subagent`. - Added programmatic PLAN / EXECUTION / REVIEW / EXPLORE subagents using shared mode prompts. - Added `/subagent-level`, `/subagent-model`, `/subagent-model-all`. - Added `.pi/extensions/mode-commands/` with `/plan`, `/execute`, `/review`. - Added shared `.pi/extensions/mode-commands/mode-prompts.ts`. - Refactored issue-agent prompts to use shared mode prompts. - Refactored issue-agent subagent execution to use the subagent runner directly in normal operation, while preserving the old test override path. - Updated launcher behavior to treat `LITTLE_CODER_SUBAGENT` / `PI_S

## Evidence
- Prompt: Implement the plan as defined in @plans/subagent-and-plan-refactor.md
- Confidence: high

## Validation
- npm test -- --runInBand
- npm test
- npm test
- npm run typecheck
- npm run typecheck
- npm test

## Files
Edited:
- /home/tom/workspace/little-coder/.pi/extensions/mode-commands/mode-prompts.ts
- /home/tom/workspace/little-coder/.pi/extensions/mode-commands/index.ts
- /home/tom/workspace/little-coder/.pi/extensions/subagent/agents.ts
- /home/tom/workspace/little-coder/.pi/extensions/subagent/index.ts
- /home/tom/workspace/little-coder/.pi/extensions/subagent/runner.ts
- /home/tom/workspace/little-coder/.pi/extensions/issue-agent/index.ts
- /home/tom/workspace/little-coder/bin/launcher-helpers.mjs
- /home/tom/workspace/little-coder/bin/little-coder.mjs
- /home/tom/workspace/little-coder/AGENTS.md
- /home/tom/workspace/little-coder/.pi/extensions/plan-mode/planning-prompt.ts
- /home/tom/workspace/little-coder/.pi/extensions/subagent/runner-events.d.ts
- /home/tom/workspace/little-coder/.pi/extensions/subagent/runner-cli.d.ts

Read:
- /home/tom/workspace/little-coder/plans/subagent-and-plan-refactor.md
- /home/tom/workspace/little-coder
- /home/tom/workspace/little-coder/.pi/extensions/issue-agent/index.ts
- /home/tom/workspace/little-coder/.pi/extensions/extra-tools/index.ts
- /home/tom/workspace/little-coder/.pi/extensions/plan-mode/planning-prompt.ts
- /home/tom/workspace/little-coder/.pi/extensions/subagent/index.ts
- /home/tom/workspace/little-coder/bin/launcher-helpers.mjs
- /home/tom/workspace/little-coder/bin/little-coder.mjs
- /home/tom/workspace/little-coder/scripts/patch-extension-notifications.mjs
- /home/tom/workspace/litt
