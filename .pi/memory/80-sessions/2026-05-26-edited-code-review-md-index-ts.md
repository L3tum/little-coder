---
title: "Edited code_review.md, index.ts"
type: "session"
tags: "session, code_review.md, index.ts"
confidence: "high"
source: "memory-context deterministic turn_end"
created_at: "2026-05-26T15:48:55.229Z"
updated_at: "2026-05-26T15:48:55.229Z"
---
Prompt: Please merge the two review skills into one and add that to the @skills/ directory in this harness. Add keywords to @.pi/extensions/skill-inject/ to auto-inject the the skill based on prompt asking for review

Outcome: Implemented.

Changes:
- Added merged review skill:
  - `skills/knowledge/code_review.md`
  - Combines the “code review excellence” and “code review quality” guidance into one concise auto-injectable skill.
- Updated auto-injection logic:
  - `.pi/extensions/skill-inject/index.ts`
  - Added review-specific prompt triggers for code reviews, PR reviews, merge request reviews, requesting changes, and approving PRs.
  - Boosts the merged review skill when prompts ask for review even if the exact keyword score would otherwise be too low.

Validation:
- Ran targeted tests:
  - `npm test -- --run .pi/extensions/skill-inject/selector.test.ts`
  - Passed: 9/9 tests.

Validation: cat package.json | head -80 && npm test -- --run .pi/extensions/skill-inject/selector.test.ts
