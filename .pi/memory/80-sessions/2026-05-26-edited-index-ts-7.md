---
title: "Edited index.ts"
type: "session"
tags: "session, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T01:20:56.263Z"
updated_at: "2026-05-26T01:20:56.263Z"
---
Prompt: It seems like there's still a couple issues. Issue-agent should check if the configured models exist and otherwise just print a warning, rather than spawn a sub-agent.
Also, the spawned sub-agent seems to capture the terminal and also print branding and everything.
You can check out any of the pi-su

Outcome: Fixed both issues.

Changes:
- Model validation now happens before checkout/sub-agent spawn.
  - If the configured planning/execution model doesn’t exist in the parent model registry, issue-agent prints a warning and skips that issue.
  - It no longer switches the parent model just to validate child model availability.
- Sub-agent execution now follows the pi-subagent pattern more closely:
  - Uses `--mode json -p` instead of `--print`.
  - Keeps stdio piped, not terminal-inherited.
  - Sets `PI_OFFLINE=1`.
  - Parses JSON events and forwards assistant/tool updates into the parent chat via `deliverAs: "followUp"`.
  - Avoids raw branding/TUI output unless something writes to stderr.

I check

Validation: npm run typecheck; npm run typecheck
