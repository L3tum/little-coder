---
title: "Edited index.ts"
type: "session"
tags: "session, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-25T21:17:22.669Z"
updated_at: "2026-05-25T21:17:22.670Z"
---
Prompt: The /issue-agent command has no running feedback. There's no circle spinning that shows it's running, there's no indicator showing what it's currently doing, nothing like that. It's very hard to figure out what's actually happening. There should also be the option to "go into" the chat log for a tas

Outcome: Implemented running feedback for `/issue-agent`.

Changes:
- Adds a live animated status indicator via `ctx.ui.setStatus("issue-agent", ...)`.
- Status now shows what it’s doing:
  - starting
  - checking labels/dependencies
  - listing issues
  - queueing an issue
  - agent turn running
  - post-processing
  - idle / next poll
  - stopped
- Adds `/issue-agent-status` command to show current state, active issue, checkout path, and where to inspect the spawned task chat.
- Clarifies that spawned issue-agent turns are currently queued into the same chat via `deliverAs=followUp`, so the chat log is available in normal scrollback / `/tree`.

Validation:
- Ran `npx tsc --noEmit --pretty false` su

Validation: cat package.json | sed -n '1,120p' && npx tsc --noEmit --pretty false; npx tsc --noEmit --pretty false
