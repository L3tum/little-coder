---
title: "Edited index.ts"
type: "session"
tags: "session, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T00:17:47.689Z"
updated_at: "2026-05-26T00:17:47.690Z"
---
Prompt: The labels should be created on startup unless dry-run is set

Outcome: Adjusted.

Now label creation on startup is skipped entirely when `--dry-run` is set.

On non-dry-run startup, it creates the standard Forgejo labels, including:
- state labels
- thinking-level labels
- common priority labels `ai:priority/0` through `ai:priority/5`
- configured planning/execution/fallback model labels from command args
- issue-agent managed blocked labels

`npm run typecheck` passes.

Validation: npm run typecheck
