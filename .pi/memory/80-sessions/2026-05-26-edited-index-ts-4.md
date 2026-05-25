---
title: "Edited index.ts"
type: "session"
tags: "session, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T00:38:17.245Z"
updated_at: "2026-05-26T00:38:17.247Z"
---
Prompt: There's a couple enhancements necessary for issue-agent:
- After working on a task/issue, the footer setStatus/setState? reporting is overwritten by another status
- The plan posted is just the entire agent chat log. Instead it should specifically just post the PLAN or create a PR for the execution 

Outcome: Implemented the issue-agent enhancements in `.pi/extensions/issue-agent/index.ts`.

Changes:
- Footer/status reporting is now mirrored into a persistent below-editor widget, so other status updates won’t hide issue-agent progress as easily.
- Planning now posts only an extracted `PLAN`, not the full agent transcript.
- Planning and execution prompts are now mode-specific; the harness controls state transitions.
- Issue work now runs in an isolated sub-agent launched in the checked-out project directory via `little-coder --print --no-session`, so that project’s `AGENTS.md`/system prompt context is loaded independently.
- Sub-agent output is piped back into the harness chat as `issue-agent` st

Validation: npm run typecheck
