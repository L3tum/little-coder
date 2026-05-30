# Memory context quality improvement plan

## Goal

Reduce low-impact saved memories and make retrieved memory more useful by treating memory as a managed lifecycle: write, review, promote, retrieve, update, and expire. The immediate fixes are to stop queueing generic edit/test summaries and to remove the hardcoded `Follow-up` section that currently repeats in every candidate.

## Current problems to fix

- `turn_end` queues a candidate whenever files were edited or tests were run, even when no durable knowledge was learned.
- Candidate confidence reflects edit/test activity more than memory usefulness.
- `formatCandidateBody()` always emits the same `## Follow-up` text.
- Auto-promotion is based on repeated lexical matches, not on importance or actionability.
- Retrieval treats many memory categories similarly, so low-value action/session notes can crowd out decisions, observations, and runbooks.
- Deduplication only catches exact normalized duplicates; it does not handle stale or superseded memories.

## Design principles

- Store only memories that are durable, specific, actionable, novel, and evidence-backed.
- Prefer semantic/procedural memories over raw episodic turn summaries.
- Keep raw activity logs short-lived unless they consolidate into a decision, observation, runbook, or durable context note.
- Make memory quality observable with local commands and tests.
- Keep the implementation filesystem-based and reviewable; do not introduce a hosted memory service or vector database for this iteration.

## Implementation status

Completed so far:

- Phase 1: deterministic salience scoring, novelty fingerprinting, duplicate rejection, and hard rejects for generic candidates.
- Phase 2: conditional Follow-up generation; removed fixed boilerplate Follow-up.
- Phase 3: lifecycle frontmatter (`salience`, `status`, `use_count`, `last_used_at`, `expires_at`, `supersedes`). Expiration uses active project memory days, not wall-clock days.
- Phase 4: composite retrieval scoring with category, salience, confidence, use-count, recency, generic-title penalties, and weak incidental-match suppression.
- Phase 5: `/memory-prune`, `/memory-rejections`, `/memory-review explain`, `/memory-review accept --force`, enhanced `/memory-review`, enhanced `/memory-doctor`, and ignored local runtime files.
- Phase 6: explicit supersession detection plus `/memory-supersede` manual correction.
- Phase 7 partial: unit tests for formatting, scoring, ranking, read/no-write/write/prune eval cases, active-day expiration, novelty, duplicate handling, and supersession.

Still pending:

- Command-level integration tests for `/memory-supersede`. Hook integration now covers `before_agent_start`, `tool_call`, and `turn_end` queue/no-queue behavior with a fake pi event API. Command integration covers `/memory-review accept` and `/memory-prune --dry-run --category`. Filesystem integration tests cover configurable memory roots, queue scaffolding, and accepted Markdown writes.
- Broader contradiction detection beyond direct modal conflicts.
- More nuanced category-specific prune policies if real usage shows the current active-day TTLs are too coarse. Current tests cover unused low-salience action pruning and stale queue detection.
- User-facing guide added at `docs/memory-context.md`.

## Phase 1: Stop obvious low-value writes

### Implementation

1. Add a deterministic candidate-quality scorer before `queueCandidate()`.
2. Score each candidate on:
   - durability: future sessions can use it;
   - specificity: mentions concrete files, commands, APIs, repo behavior, user preference, or a confirmed gotcha;
   - actionability: would change a future agent decision;
   - novelty: not already represented in accepted memory or queue;
   - evidence: backed by tests, inspected source, user instruction, or explicit outcome;
   - scope: identifies whether it applies to project, file, command, issue-agent, memory-system, or user preference.
3. Reject candidates below the threshold instead of adding them to `queue.json`.
4. Add hard rejects for generic candidates whose title/body only says things like:
   - `Updated index.ts`
   - `Validated project behavior`
   - `Captured durable context`
   - `Ran npm test`
   - `Review for durability before accepting as long-term memory`

### Acceptance criteria

- A turn that edits a file but produces no durable observation does not add a memory candidate.
- A turn that only runs tests does not add a candidate unless the test command itself is a newly discovered reusable command or validates a durable fix.
- Existing high-value memories such as explicit decisions, repo gotchas, and reusable runbooks still queue successfully.

## Phase 2: Replace the fixed Follow-up section

### Implementation

1. Remove the unconditional `## Follow-up` block from `formatCandidateBody()`.
2. Add a helper such as `candidateFollowUp(args)` that returns zero or more concrete follow-up bullets.
3. Include `## Follow-up` only when there is a real unresolved action.
4. Suggested rules:
   - no tests run on an implementation candidate: `Run targeted tests before promoting this memory.`
   - low confidence candidate: `Verify this against source before accepting.`
   - decision candidate without docs touched: `Consider documenting this decision in project docs if it is policy-level.`
   - high confidence and no unresolved work: omit the section.

### Acceptance criteria

- New candidates no longer all contain the same follow-up text.
- High-confidence candidates with validation omit Follow-up unless there is a specific unresolved task.
- Tests cover candidates with and without follow-up sections.

## Phase 3: Add memory metadata for lifecycle management

### Implementation

Extend accepted-memory frontmatter with optional fields:

```yaml
salience: 0
status: active
use_count: 0
last_used_at: ""
supersedes: ""
expires_at: ""
```

Rules:

- `status` can be `active`, `superseded`, `expired`, or `rejected`.
- `salience` comes from the quality scorer.
- Low-salience action/session memories get an `expires_at` active-day TTL instead of a wall-clock date.
- Decisions, observations, and runbooks do not expire by default.
- Retrieval ignores non-active memories unless explicitly requested.

### Acceptance criteria

- Newly accepted memories include `salience` and `status`.
- Retrieval excludes `superseded` and `expired` notes.
- Existing memories without the new fields continue to load as active with unknown salience.

## Phase 4: Improve retrieval ranking

### Implementation

Replace pure lexical ranking with a composite score:

```text
score =
  lexical relevance
  + salience boost
  + confidence boost
  + category boost
  + recency/use_count boost
  - staleness penalty
  - generic-title penalty
  - low-value-category penalty
```

Category priorities:

1. `50-decisions`
2. `70-runbooks`
3. `60-observations`
4. `20-context`
5. `40-actions`
6. `80-sessions`

Update `last_used_at` and `use_count` for injected memories after retrieval.

### Acceptance criteria

- For prompts about implementation choices, decisions outrank action/session summaries with similar terms.
- For prompts asking how to perform a repeated task, runbooks outrank old session notes.
- Generic action memories are not injected unless they are the only relevant memory and pass the minimum score.

## Phase 5: Add prune, review, and diagnostics commands

### Implementation

Add or extend commands:

- `/memory-prune --dry-run`: lists expired or low-salience candidates/memories that would be removed or marked expired.
- `/memory-prune`: marks expired accepted memories as `expired` and removes stale queue entries.
- `/memory-review`: show salience, rejection reason, and concrete follow-up if present.
- `/memory-doctor`: include counts by status, average salience, expired notes, queue reject counts, and top generic-title offenders.

### Acceptance criteria

- Users can see why a candidate was queued or rejected.
- Users can remove stale low-value memories without manually editing files.
- Diagnostics make memory bloat visible.

## Phase 6: Handle stale and superseded memories

### Implementation

1. Add a contradiction/supersession check before accepting or auto-promoting a candidate.
2. Check for accepted memories with overlapping tags, paths, and title terms.
3. If the new memory explicitly replaces an old convention, write `supersedes` on the new note and mark the old note `status: superseded`.
4. Add `/memory-supersede <new> <old>` for manual correction.

### Acceptance criteria

- A new decision can supersede an old decision without both being injected as active guidance.
- Retrieval does not inject superseded memories.
- Manual supersession works without deleting historical notes.

## Phase 7: Add local memory evals

### Implementation

Create tests for four behaviors:

1. **Write eval:** high-value decision/observation/runbook creates a candidate.
2. **No-write eval:** trivial file edits, generic test runs, and boilerplate summaries do not create candidates.
3. **Update eval:** changed convention marks older conflicting memory as superseded.
4. **Read eval:** prompts retrieve the right memory category and avoid irrelevant low-value memories.

Test fixtures should include examples of:

- generic action summary;
- durable repo gotcha;
- explicit user preference;
- superseded decision;
- reusable command/runbook.

### Acceptance criteria

- Tests fail if the fixed Follow-up text returns globally.
- Tests fail if generic edit/test summaries are queued.
- Tests fail if superseded memories are injected.
- Tests fail if low-value action/session notes outrank relevant decisions/runbooks.

## Suggested implementation order

1. Phase 2: remove/fix the hardcoded Follow-up section.
2. Phase 1: add candidate-quality scorer and hard rejects.
3. Phase 7 partial: add no-write/write tests for the new scorer and Follow-up behavior.
4. Phase 3: add metadata fields while preserving compatibility.
5. Phase 4: improve retrieval ranking.
6. Phase 5: add prune/diagnostic command improvements.
7. Phase 6: add supersession once the metadata and retrieval behavior are stable.
8. Phase 7 full: complete update/read evals.

## Initial code touch points

- `.pi/extensions/memory-context/index.ts`
  - `formatCandidateBody()`
  - `queueCandidate()`
  - `validateCandidate()`
  - `writeAcceptedMemory()`
  - `parseFrontmatter()` / `allNotes()`
  - `lexicalSearch()` / ranking helpers
  - `/memory-review`, `/memory-doctor`, `/memory-dedupe`
  - `turn_end` candidate construction

## Open questions

- What salience threshold should be used initially? Current implementation uses 6/10.
- Should rejected candidates be silently dropped, or should a debug log keep recent rejection reasons? Current implementation keeps a rolling local `.pi/memory/rejections.json` ignored by git.
- Should auto-promotion remain enabled after scoring is added? Current implementation keeps it, with validation through the salience filter and specific-match checks.
- Should action/session memories be written at all? Current implementation queues them only if they pass salience scoring and gives lower-salience action/session notes active-day expiration.
