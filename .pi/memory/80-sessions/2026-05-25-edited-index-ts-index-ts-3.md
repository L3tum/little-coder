---
title: "Edited index.ts, index.ts"
type: "session"
tags: "session, index.ts, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-25T22:54:53.000Z"
updated_at: "2026-05-25T22:54:53.000Z"
---
Prompt: In Pi, I can open the /settings command and choose the thinking level. Is there a way to control that when running issue-agent?

Outcome: Yes — now it can be controlled.

I added support for:

- Command option:
  - `/issue-agent --repos=... --thinking-level=low`
- Per-issue label:
  - `ai:thinking-level/off`
  - `ai:thinking-level/minimal`
  - `ai:thinking-level/low`
  - `ai:thinking-level/medium`
  - `ai:thinking-level/high`
  - `ai:thinking-level/xhigh`

Per-issue labels override the command default.

Also updated the branding/help text, and `npm run typecheck` passes.

Validation: npm run typecheck
