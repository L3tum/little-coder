---
title: "Edited index.ts"
type: "session"
tags: "session, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T23:30:21.047Z"
updated_at: "2026-05-26T23:30:21.048Z"
---
Prompt: Please fix the uncovered issues.
Of note though: In Forgejo, PRs seem to have labels. The same in Github. Where does your informtion come from that they don't?

Outcome: Fixed the uncovered issues.

Changes made:
- PR label discovery now uses PR labels when present, with a fallback to fetch the matching issue labels if absent.
- PR checkout now fetches both base and head refs, so `origin/<base>...HEAD` review diffs are valid.
- Fork/head-repo PR checkout now fetches from `headRepo` when needed.
- Rework push now targets the PR head repo if different, still as a normal new commit, no force-push.
- `/review` now overrides `ai:error/NO_TOOLCALL`.
- Explicit `/review` also removes `ai:error/NO_TOOLCALL` before retrying.
- Review-cycle label updates now remove all known cycle labels unconditionally, avoiding stale/accumulated cycle labels.
- Missing required life

Validation: npm test -- .pi/extensions/issue-agent/index.test.ts && npm run typecheck; npm test -- .pi/extensions/issue-agent/index.test.ts && npm run typecheck
