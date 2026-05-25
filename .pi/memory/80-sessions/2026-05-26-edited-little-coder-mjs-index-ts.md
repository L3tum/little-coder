---
title: "Edited little-coder.mjs, index.ts"
type: "session"
tags: "session, little-coder.mjs, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T01:35:13.304Z"
updated_at: "2026-05-26T01:35:13.304Z"
---
Prompt: Also the model check should ideally happen *before* spawning the sub-agent and right now it doesn't seem to.
Rather than re-creating little-coder.mjs, just add an arg to little-coder.mjs with the necessary changes

Outcome: Implemented the requested changes.

What changed:
- Added `--issue-agent-subagent` to `bin/little-coder.mjs`.
  - It enables non-interactive child behavior:
    - `LITTLE_CODER_NO_UPDATE_CHECK=1`
    - `PI_OFFLINE=1`
    - `PI_SKIP_VERSION_CHECK=1`
    - `CI=1`
  - The flag is stripped before forwarding args to Pi.
- Reverted issue-agent away from re-creating launcher behavior.
  - It now spawns `node bin/little-coder.mjs --issue-agent-subagent ...`
  - The launcher remains responsible for system prompt, project `AGENTS.md`, bundled extensions, and package resources.
- Strengthened model lookup before checkout/sub-agent spawn.
  - Uses `registry.find(provider, id)` when applicable.
  - Falls

Validation: npm run typecheck
