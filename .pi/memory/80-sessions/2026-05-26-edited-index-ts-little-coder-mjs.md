---
title: "Edited index.ts, little-coder.mjs"
type: "session"
tags: "session, index.ts, little-coder.mjs"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T01:41:04.436Z"
updated_at: "2026-05-26T01:41:04.436Z"
---
Prompt: The branding from the sub-agent still captures the terminal.
And the model is not checked. Selecting "openai/gpt-5.5" doesn't stop spawning the sub-agent, but the sub-agent errors out

Outcome: Fixed both issues.

Changes:
- `--issue-agent-subagent` now makes `little-coder.mjs` spawn Pi with piped stdio instead of inherited stdio.
  - stdout is forwarded for JSON events.
  - stderr is buffered and only emitted if the child fails.
  - This prevents branding/TUI output from taking over the terminal.
- Issue-agent now ignores non-JSON stdout lines from sub-agents, so any accidental branding/control output won’t be replayed into the parent chat.
- Fixed `/issue-agent --model openai/gpt-5.5` style parsing.
  - Previously only `--model=openai/gpt-5.5` parsed correctly.
  - Space-separated flags now parse correctly too.
- Hardened model lookup:
  - Strips optional `:thinking-level` suffix

Validation: npm run typecheck
