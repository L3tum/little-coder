# Harness-native memory context plan

## Goal

Add a conservative local memory layer that complements `code_search` instead of replacing it. The layer should remember durable repo/session learnings, prefetch codebase facts when the user is asking about the codebase, and stay compatible with autonomous workflows such as `issue-agent` and `pi-autoresearch`.

## Non-goals

- Do not vendor `pi-memctx` wholesale.
- Do not add a hosted vector database or opaque memory service.
- Do not inject large memory dumps into every turn.
- Do not persist generic coding advice, secrets, transient chatter, or unverified guesses.
- Do not let autonomous loops run unbounded without explicit iteration/time/cost limits.

## Storage

Use Markdown under the workspace so it is inspectable and reviewable:

```text
.pi/memory/
  20-context/
  40-actions/
  50-decisions/
  60-observations/
  70-runbooks/
  80-sessions/
  queue.json
```

Each note should have small frontmatter: `type`, `title`, `created_at`, `updated_at`, `source`, `confidence`, `tags`.

## Retrieval backend

Install and prefer the optional `qmd` dependency for memory retrieval because `pi-memctx` reports it as the fast path and falls back to grep only when unavailable.

- Add `@tobilu/qmd` as an optional/dev dependency or provision it during harness setup.
- Detect `QMD_PATH` / `MEMORY_QMD_BIN` first, then local `node_modules/.bin/qmd`, then `qmd` on `PATH`, then grep fallback.
- Keep a per-pack/per-workspace qmd collection name so indexes do not bleed across repositories.
- Expose retrieval mode in status output: `qmd`, `grep fallback`, or `disabled`.
- Retrieval must remain functional without qmd; qmd is an acceleration path, not a correctness dependency.

## Before-turn retrieval and code_search prefetch

Add a `memory-context` extension with a `before_agent_start` hook.

1. Classify the prompt with cheap heuristics:
   - Codebase intent: mentions files, functions, symbols, architecture, tests, errors, refactors, issue implementation, or repo-specific nouns.
   - Issue-agent intent: active issue context, prompts that mention issue work, bug fixing, PR body, implementation, or labels.
2. Search `.pi/memory` using lexical scoring.
3. If codebase intent is likely, run a bounded `code_search` prefetch internally:
   - query: normalized user prompt plus issue title/body snippet when available
   - project: current workspace project alias
   - limit: 3-5
   - timeout/failure budget: fail closed and continue without injection
4. Inject a compact block only when useful:
   - `## Local Memory Context`: up to 5 durable facts/runbooks
   - `## Codebase Prefetch`: up to 5 symbol/file hits with paths and line ranges
   - guidance: use injected context as hints; inspect source when editing or when memory may be stale

## After-turn learning

Add an `agent_end` hook.

1. Collect compact turn evidence:
   - user prompt
   - final assistant answer
   - tool names used
   - files edited/read
   - tests run and outcomes when visible
   - issue-agent metadata if present
2. Generate memory candidates with a hybrid approach:
   - deterministic candidates for edits, successful tests, tool failures, issue completion, and newly discovered commands
   - optional LLM JSON curator for richer context/decision/runbook/session candidates
3. Apply safety filters:
   - secret/token/password/private-key/customer-data regexes
   - max size per candidate
   - require evidence fields for durable claims
4. Persistence policy:
   - default `MEMORY_LEARNING=suggest`: write to `.pi/memory/queue.json`
   - `auto`: save only high-confidence deterministic candidates and queue the rest
   - `off`: no learning

## Issue-agent integration

Memory should treat issue-agent sessions as first-class sources.

- Before starting issue work, use the issue title/body/comments as retrieval terms.
- Prefer injecting relevant runbooks, prior similar issue actions, known flaky tests, and code_search prefetch hits.
- After completion, save an `action` note with:
  - issue id/repo/url
  - files changed
  - tests run
  - final summary / PR body excerpt
  - follow-ups or caveats
- If issue-agent marks a task done, link the learned action to the issue metadata and avoid duplicate session snapshots.

## Autoresearch integration

`pi-autoresearch` and `issue-agent` are both long-running autonomy surfaces. Treat them as related orchestration modes: they should produce structured artifacts, survive context resets, and feed durable memory.

Target behavior:

1. An issue can be labeled `autoresearch` or `ai:autoresearch`.
2. `issue-agent` detects that label and starts an autoresearch-backed issue flow instead of a normal implementation flow.
3. The issue-agent interaction loads/enables `pi-autoresearch` tooling for that run.
4. The agent creates or resumes the autoresearch files in the checked-out worktree:
   - `autoresearch.md`: objective, metric, scope, tried ideas, current best result
   - `autoresearch.sh`: benchmark command that emits `METRIC name=value`
   - `autoresearch.checks.sh`: correctness backpressure checks when available
   - `autoresearch.jsonl`: append-only run log
5. The loop runs bounded experiments:
   - max iterations from issue label/config/comment
   - explicit metric direction and baseline
   - keep/discard commits based on benchmark plus checks
   - no destructive commands without the existing permission gate
6. On completion, issue-agent posts the result as a PR in the normal way, with a structured body containing:
   - issue link
   - objective and metric
   - baseline, best result, confidence/noise note when available
   - kept experiments / discarded notable attempts
   - files changed
   - checks run
   - residual risks and follow-ups
7. Memory saves the autoresearch outcome as an `action` note and, when reusable, a `runbook` or `observation` note.

Suggested issue labels/config:

```text
ai:autoresearch
autoresearch:max-iterations=20
autoresearch:metric=total_ms
autoresearch:direction=lower
```

Memory integration points:

- Before the loop, inject prior benchmark runbooks, similar optimization attempts, and code_search prefetch hits for files in scope.
- During the loop, do not inject every run into context; rely on `autoresearch.md` and `autoresearch.jsonl` as source-of-truth artifacts.
- After each kept experiment, queue a compact learning candidate only if it generalizes beyond the current branch.
- At finalization, save one linked action note for the issue/PR plus any durable runbook/decision notes.

## Rollout

1. Implement Markdown queue and manual review command (`/memory-review`).
2. Add qmd detection/install guidance and grep fallback.
3. Add before-turn lexical/qmd memory retrieval with strict token cap.
4. Add bounded code_search prefetch for codebase-intent prompts.
5. Add deterministic after-turn candidates.
6. Add optional LLM curator behind config.
7. Add issue-agent metadata hooks and action notes.
8. Add autoresearch issue-label flow and PR summary handoff.
9. Benchmark against baseline on repo Q&A, issue-agent tasks, and bounded autoresearch issues.
