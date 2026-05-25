---
title: "Edited index.ts"
type: "session"
tags: "session, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T01:32:17.213Z"
updated_at: "2026-05-26T01:32:17.213Z"
---
Prompt: It seems like starting a sub-agent still captures the terminal and overwrites everything with branding etc.

Outcome: Fixed. Root cause was that issue-agent was spawning the `little-coder` launcher, which is designed for interactive use and internally spawns Pi with inherited stdio. That made it too easy for the child to behave like a real terminal session.

Changes:
- Sub-agent now bypasses `bin/little-coder.mjs`.
- It spawns Pi’s CLI entry directly via `process.execPath`.
- It reconstructs little-coder’s required args itself:
  - bundled system prompt
  - checked-out project `AGENTS.md`
  - bundled `.pi/extensions`
  - bundled package resources
- Keeps child in `--mode json --no-session -p`.
- Forces non-interactive/offline env:
  - `PI_OFFLINE=1`
  - `PI_SKIP_VERSION_CHECK=1`
  - `LITTLE_CODER_NO_UPDATE_

Validation: npm run typecheck
