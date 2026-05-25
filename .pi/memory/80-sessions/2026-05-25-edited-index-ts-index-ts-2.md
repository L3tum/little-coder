---
title: "Edited index.ts, index.ts"
type: "session"
tags: "session, index.ts, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-25T22:51:41.237Z"
updated_at: "2026-05-25T22:51:41.238Z"
---
Prompt: What about the other labels like priority and model?

Outcome: Good catch.

Now:
- `ai:priority/N`
- `ai:planning-model/x`
- `ai:execution-model/y`
- `ai:fallback-*-model/x`

are supported, while the old `ai:priority:N` / `ai:planning-model:x` forms still parse for compatibility.

I also updated the fallback-model parser and branding message.

One caveat: `/issue-agent` can auto-create labels it knows it will apply, like state/block/provider labels. It can’t auto-create arbitrary user-chosen priority/model labels before they exist unless those values are provided/configured somewhere.

Validation: npm run typecheck
