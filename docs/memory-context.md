# Memory context

The `memory-context` extension stores local, reviewable memories under `.pi/memory/` and injects only relevant active memories into future turns.

## Lifecycle

1. **Candidate creation**: after a tool-using turn, the extension builds a candidate only when files were edited or tests ran.
2. **Review/scoring**: candidates must pass salience review. Low-confidence, generic, duplicate, unsafe, or low-salience candidates are rejected.
3. **Queue**: accepted short-term candidates are written to `.pi/memory/queue.json` for review.
4. **Promotion**: `/memory-review accept ...` writes long-term Markdown notes. Frequently matching queued candidates can auto-promote after repeated specific matches.
5. **Retrieval**: active, non-expired notes are ranked by lexical relevance, salience, confidence, category, use count, recency, and generic-title penalties.
6. **Maintenance**: prune, supersede, and rejection commands keep memory quality visible.

## Salience

Salience is a 0-10 usefulness score. Candidates need at least 6/10 and medium confidence to queue. Good memories are durable, specific, actionable, novel, and evidence-backed.

Good examples:

- A project convention that changes future edits.
- A root cause or gotcha confirmed by source/tests.
- A reusable runbook or command.
- A durable user preference.

Bad examples:

- `Updated index.ts`.
- `Ran npm test`.
- Generic session summaries.
- Boilerplate follow-up notes.

## Active-day expiration

Action/session memories can expire by **active memory days**, not wall-clock time. If a project is not worked on for a month, memories do not age out just because calendar time passed.

Current defaults:

- action/session salience `< 6`: `active-days:30` (`MEMORY_CONTEXT_LOW_TTL_ACTIVE_DAYS` override)
- action/session salience `6-7`: `active-days:90` (`MEMORY_CONTEXT_MEDIUM_TTL_ACTIVE_DAYS` override)
- action/session salience `>= 8`: no expiration
- decisions, observations, runbooks, and context: no default expiration

`last_used_at` is stored as `active-day:N`, and `use_count` increments when a memory is retrieved.

## Commands

- `/memory-review` — show queued candidates with salience and review reason.
- `/memory-review explain 1|1,3|2-4` — explain current review outcome, duplicate status, fingerprint, and supersession impact.
- `/memory-review accept all|1,3|2-4` — promote selected queued candidates.
- `/memory-review accept --force 1|1,3|2-4` — promote selected candidates even if they duplicate active accepted memory; safety and salience checks still apply.
- `/memory-review deny all|1,3|2-4` — remove selected queued candidates.
- `/memory-rejections` — show recently rejected candidates and reasons.
- `/memory-rejections clear` — clear the local rejection log.
- `/memory-search <query>` — search active memories.
- `/memory-list` — list accepted memories.
- `/memory-list --status active|expired|superseded|all` — filter accepted memories by status.
- `/memory-prune --dry-run` — preview stale queue entries and prunable accepted memories.
- `/memory-prune --dry-run --category action|session|40-actions|80-sessions` — preview pruning for one category.
- `/memory-prune` — expire prunable accepted memories and remove stale queue entries.
- `/memory-supersede <new> <old>` — manually mark an older memory superseded by a newer one. Use `/memory-list` indexes or paths.
- `/memory-doctor` — show memory health, salience, prune counts, rejection counts, and generic-title offenders.
- `/memory-doctor --verbose` — include lowest-salience active memories.
- `/memory-dedupe --dry-run` / `/memory-dedupe` — preview/remove exact duplicate accepted memories.

## Local runtime files

These are local and ignored by git:

- `.pi/memory/queue.json`
- `.pi/memory/rejections.json`
- `.pi/memory/state.json`

Accepted Markdown memories remain inspectable and reviewable under `.pi/memory/*/`.
