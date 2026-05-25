---
title: "Edited index.ts, little-coder.mjs"
type: "session"
tags: "session, index.ts, little-coder.mjs"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T01:47:59.707Z"
updated_at: "2026-05-26T01:47:59.708Z"
---
Prompt: After spawning a sub-agent, issue-agent cannot be stopped anymore. Also, errors don't seem to get piped. Selecting a bogus model still only errors out in the sub-agent, but that error is now not even printed anymore, and the sub-agent still runs since pi/little-coder doesn't seem to stop on bogus mo

Outcome: Fixed the new issues.

Changes:
- `/issue-agent-stop`, Ctrl-C, SIGINT/SIGTERM now terminate the active sub-agent process.
- Stop-requested sub-agent termination no longer labels the issue as harness-error.
- `little-coder --issue-agent-subagent` now pipes Pi stderr through immediately, so sub-agent errors are visible to issue-agent.
- Sub-agent JSON parsing now forwards assistant error/aborted messages.
- Configured model validation now happens at `/issue-agent` startup for CLI-configured models.
- Model lookup is stricter for `provider/id`; it no longer falls back to fuzzy/ambiguous matches for slash-qualified names like `openai/gpt-5.5`.
- Invalid configured models now prevent issue-agent 

Validation: npm run typecheck
