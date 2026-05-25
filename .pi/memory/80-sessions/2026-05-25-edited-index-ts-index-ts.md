---
title: "Edited index.ts, index.ts"
type: "session"
tags: "session, index.ts, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-25T22:50:46.672Z"
updated_at: "2026-05-25T22:50:46.673Z"
---
Prompt: In forgejo new labels apparently have to be created before they can be used, and you can also make mutually exclusive labels by prefixing them with [scope]/[label]. So for example ai:state/PLANNING would be mutually exclusive with ai:state/WAITING_FOR_FEEDBACK. I think it would make sense to switch 

Outcome: Implemented.

Changes:
- Switched issue-agent state labels to Forgejo-style scoped labels:
  - `ai:state/PLANNING`
  - `ai:state/WAITING_FOR_FEEDBACK`
  - `ai:state/EXECUTING`
  - `ai:state/WAITING_FOR_REVIEW`
- Kept backward-compatible parsing for old `ai:state:...` labels.
- Added Forgejo label creation before labels are applied.
- `/issue-agent` now proactively ensures standard Forgejo labels exist on startup.
- Updated managed blocked/provider labels to scoped-style names like:
  - `ai:blocked/usage-limit`
  - `ai:provider-status/429`
  - `ai:retry-after/...`
- Updated the branding message to mention that `/issue-agent` creates Forgejo labels and to show the new scoped label syntax.
- Ty

Validation: cat package.json | head -80 && grep -R "tsc" -n package.json .pi/extensions/issue-agent 2>/dev/null | head; npm run typecheck
