# Enhancements Roadmap Plan

## Context

The requested work spans little-coder's extension stack, bundled skills, prompt text, telemetry/dashboard UX, session search, reflection-driven skill creation, planning-command cleanup, and Python sandboxing.

Verified repository facts so far:
- `package.json` already depends on `@observal/pi-insights`, `@plannotator/pi-extension`, `pi-ask-user`, and optional `@tobilu/qmd`.
- Existing first-party extensions include `skill-inject`, `memory-context`, `mode-commands`, `plan-mode`, `extra-tools`, `browser`, `permission-gate`, `usage-dashboard`, `inspect`, and `branding`.
- `AGENTS.md` contains the long global agent prompt that should be compressed.
- `skill-inject` currently parses `keywords` frontmatter but still uses a hard-coded `INTENT_MAP` for tool prediction. Tool/protocol skills mostly lack `keywords`; knowledge skills already have them.
- The `/skills` command/tool currently lists names, token costs, and keywords, but not descriptions.
- Two `/plan` providers exist: `.pi/extensions/mode-commands/index.ts` registers a prompt-only `/plan`, while `scripts/patch-extension-notifications.mjs` patches `@plannotator/pi-extension` to register the real planning-mode `/plan`.
- `memory-context` injects memory automatically, exposes `/memory-*` commands, writes `.pi/memory`, and is referenced by `branding` startup text.
- `usage-dashboard` already parses Pi session JSONL cost/tokens/tool data for an inline `/usage` TUI.
- `inspect` already implements a local web server command pattern, snapshot capture, static dashboard launch, port probing, and browser/PWA opening.
- `permission-gate` currently whitelists `python ` and `python3 ` by prefix, so arbitrary Python can bypass command-level permission checks.

User decisions captured:
- Vendor `@observal/pi-insights` directly despite AGPL-3.0-only licensing; preserve license/NOTICE details.
- Sandbox **all** Python execution without asking for approval.
- Reflection-generated skills should default to user-level `~/.pi/skills`; `skill-inject` should load user-level and repo skills. Add `/promote-user-skill [skill]` to copy user skills into repo `skills/` with duplicate checks.

## Approach

Implement this as a set of small, testable extension changes rather than one monolithic rewrite:

1. **Stabilize existing UX and prompt behavior first**: fix duplicate `/plan`, compress prompts, improve tool descriptions/output, and update `/skills` display.
2. **Rework skill injection around skill metadata and roots**: add missing `keywords`/`description` frontmatter, load both repo `skills/` and user `~/.pi/skills`, score tool/reference skills from frontmatter, and add per-session cooldown state so automatic injection does not repeat recent skills.
3. **Add session intelligence as reusable infrastructure**: create a session-transcript parser/index shared by breadcrumbs, reflection, and cost dashboards.
4. **Replace memory with reflection-generated skills**: remove automatic memory injection and `/memory-*`, then add `/reflect` commands that review bounded session history, propose user-level skill files, and require user yes/no/edit approval before writing to `~/.pi/skills`.
5. **Vendor and unify dashboards**: vendor `pi-insights`, port useful cost-dashboard concepts from `agent-cost-dashboard`, and unify cost, inspect, breadcrumbs, skills, reflection, commands, and tools into the TUI.
6. **Sandbox Python execution**: stop treating arbitrary Python as safe; route all Python execution through a sandbox path without prompting for approval, with tests that prove Python cannot trivially bypass `permission-gate`.

## Files to modify

Critical paths expected to change:
- `AGENTS.md`
- `package.json`
- `package-lock.json`
- `scripts/patch-extension-notifications.mjs`
- `.pi/extensions/skill-inject/index.ts`
- `.pi/extensions/skill-inject/frontmatter.ts`
- `.pi/extensions/skill-inject/*.test.ts`
- `.pi/extensions/mode-commands/index.ts`
- `.pi/extensions/mode-commands/mode-prompts.ts`
- `.pi/extensions/plan-mode/*.ts`
- `.pi/extensions/extra-tools/index.ts`
- `.pi/extensions/browser/index.ts`
- `.pi/extensions/permission-gate/index.ts`
- `.pi/extensions/permission-gate/*.test.ts`
- `.pi/extensions/usage-dashboard/index.ts`
- `.pi/extensions/branding/index.ts`
- `.pi/extensions/memory-context/**` (remove or replace with migration stub)
- New shared session parser/index module, likely `.pi/extensions/_shared/session-history.ts`
- New breadcrumbs extension, likely `.pi/extensions/breadcrumbs/`
- New reflection extension, likely `.pi/extensions/reflect-skills/`
- New vendored insights/cost extension, likely `.pi/extensions/pi-insights/`
- `skills/**/*.md` frontmatter updates
- New skill files from `mattpocock/skills`, likely `skills/engineering/improve-codebase-architecture/`
- `NOTICE` / license docs if vendored code is included

## Reuse

Existing code and external references to reuse:
- `.pi/extensions/skill-inject/frontmatter.ts` and `loadSkills()` already parse skill markdown/frontmatter; extend them rather than replacing the loader.
- `.pi/extensions/skill-inject/index.ts` already has budgets, `/skills`, `/skill`, explicit `/skill:<name>`, recency, last-failed-tool recovery, and UI notifications; extend it to load user and repo skill roots with deterministic precedence.
- `.pi/extensions/usage-dashboard/index.ts` already parses `~/.pi/agent/sessions/**/*.jsonl` for provider/model/cost/token/tool stats.
- `.pi/extensions/powerline-footer-unified/index.ts` already derives the project session directory and extracts recent user prompts from JSONL.
- `.pi/extensions/inspect/index.ts` already has reusable local-dashboard patterns: port probing, subprocess/server lifecycle, snapshots, browser/PWA opening, and request watching.
- `.pi/extensions/browser/index.ts` already registers `enableBrowserTools`; only the description/prompt snippet needs tuning.
- `.pi/extensions/permission-gate/index.ts` already centralizes bash allowlisting and external file access policy.
- `@tobilu/qmd` is installed as an optional dependency; its README documents BM25, semantic search, hybrid query, JSON output, and SDK usage.
- External `mrexodia/agent-cost-dashboard` is MIT-licensed and provides cost-dashboard ideas: global stats, daily spend charts, model/tool/project/session views, Pi/OMP/Claude/Codex parsing, subagent grouping, and transcript export.
- External `jo-inc/pi-reflect` is MIT-licensed and provides transcript collection, reflection history/config commands, and safe/surgical edit concepts.
- External `briggsd/pi-reflect-ext` provides a skill-management-oriented reflection design with safe skill path confinement and background review prompts.
- External `mattpocock/skills` is MIT-licensed and contains `skills/engineering/improve-codebase-architecture/SKILL.md` plus support files (`LANGUAGE.md`, `DEEPENING.md`, etc.).

## Steps

### Phase 1 — Prompt, command, and small tool fixes

- [ ] Remove the prompt-only `/plan` registration from `.pi/extensions/mode-commands/index.ts`; keep real planning mode owned by Plannotator's patched `/plan` and optionally add a non-conflicting `/plan-prompt` only if still useful.
- [ ] Update tests around `scripts/patch-extension-notifications.mjs` and add a command-registration test so only the real `/plan` is exposed.
- [ ] Compress `AGENTS.md` by removing repeated tool-efficiency/evidence wording, keeping only invariants, autonomy, tool-selection order, ambiguity handling, and skill discovery.
- [ ] Compress `.pi/extensions/mode-commands/mode-prompts.ts` to short mode prompts with clear constraints and outputs.
- [ ] Update `.pi/extensions/browser/index.ts` so `enableBrowserTools` says to prefer `webfetch`/`websearch` for non-interactive web retrieval and only enable Browser* tools for interactive navigation/click/type/extract workflows.
- [ ] Update `.pi/extensions/extra-tools/index.ts` `findRead` output to prefix the effective invocation: `pattern`, `path`, `maxFiles`, `maxCharacters`, and `ignoreDefaultExcludes`, including no-match/error paths.
- [ ] Update `skills/tools/find_read.md` and `skills/tools/skills.md` to describe the new output and skill descriptions.

### Phase 2 — Skill metadata and injection cooldown

- [ ] Add `keywords` and concise `description` frontmatter to every bundled tool/protocol skill and to `skills/hatch-pet/SKILL.md`; add descriptions to knowledge skills where missing.
- [ ] Import `mattpocock/skills/skills/engineering/improve-codebase-architecture/` into `skills/engineering/improve-codebase-architecture/`, preserving support files and adding little-coder frontmatter fields (`type`, `token_cost`, `keywords`, and any needed `requires_tools`).
- [ ] Extend skill discovery to load both repo `skills/` and user `~/.pi/skills`. Repo skills should remain packaged/canonical; user skills should be mutable and higher priority for explicit `/skill` by exact name. If both roots contain the same skill name, list both origins in `/skills` and make automatic injection choose the higher-priority origin deterministically.
- [ ] Add `/promote-user-skill [skill]`:
  - without an argument, list user skills that are not already present in repo `skills/` by same name/content;
  - with an argument, copy the selected user skill directory into repo `skills/user/<skill-name>/` by default, unless a known repo category mapping is explicitly supported for that skill type;
  - detect duplicate names, identical content, and near-duplicate descriptions/keywords before writing;
  - skip identical duplicates, warn on conflicting same-name skills, and require an explicit conflict resolution path such as `--force`/rename guidance rather than overwriting silently.
- [ ] Replace hard-coded tool intent prediction with frontmatter-driven scoring for tool skills. Keep non-keyword priority sources only where they are behavioral rather than semantic: explicit `/skill`, required tools from selected references, last failed tool, and recent tool-call recovery.
- [ ] Export/test pure selection helpers instead of duplicating `INTENT_MAP` logic in tests.
- [ ] Add automatic-injection cooldown state per session:
  - explicit `/skill` always bypasses cooldown;
  - last-failed-tool recovery may bypass once after a failure;
  - other automatic tool/reference skills are suppressed if injected in the previous turn and by default become eligible again after 3 completed user turns;
  - skipped skills are listed in the `skill-inject` notification as `suppressed recent [...]`.
- [ ] Add long-conversation warning throttled by session: notify once when either context usage is above ~75% or the session has at least ~16 user turns, then at most every 6 turns. Wording should suggest `/compact` or starting a fresh session, not alarm the user.
- [ ] Update `/skills`, `/skill` completions, and the `skills` tool output to include each skill description (frontmatter description or a short first-line fallback), not just name/token/keywords.

### Phase 3 — Shared session history and breadcrumbs tools

- [ ] Create `.pi/extensions/_shared/session-history.ts` to discover Pi session JSONL files using `PI_CODING_AGENT_DIR || ~/.pi/agent`, parse session headers/messages/tool events safely, normalize project/cwd/session id/date, and produce bounded outlines.
- [ ] Add lexical search over session outlines/messages using BM25-ish scoring that boosts user prompts, file paths, tool names, and current project matches.
- [ ] Add optional semantic search adapter using `@tobilu/qmd` when available; fall back to lexical with a clear mode note when QMD cannot initialize.
- [ ] Add `breadcrumbs_search` tool: returns only outlines/snippets, not full transcripts. Defaults: current project first, limit 5, snippets <= 300 chars, no tool-output bodies.
- [ ] Add `breadcrumbs_read` tool: requires a session id/path from search, returns bounded chunks with `cursor`, `maxTurns` default 8/max 20, `maxCharacters` default 8000/hard cap 16000, and `includeToolOutput` default false.
- [ ] Add tests for parser robustness, lexical ranking, QMD fallback, outline-only search, and read guards.

### Phase 4 — Reflection replaces memory

- [ ] Remove `memory-context` from active extension loading and delete its tests/source once replacement commands exist; do not leave automatic memory injection in place.
- [ ] Update `branding` startup text to remove memory counts and `/memory-*` hints; replace with `/reflect`, `/reflect-review`, `/breadcrumbs`, and `/skills` hints.
- [ ] Add `.pi/extensions/reflect-skills/` with commands patterned after the current `/memory-*` ergonomics but skill-oriented:
  - `/reflect` — review recent session history and propose one or more skill changes;
  - `/reflect-review` — show queued proposals;
  - `/reflect-accept`, `/reflect-deny`, or `/reflect-review accept|deny` — apply/discard proposals;
  - `/reflect-history` and `/reflect-doctor` — audit runs and dependencies.
- [ ] Reflection should use bounded session history from the shared parser/breadcrumbs index, not raw unbounded transcripts.
- [ ] Reflection prompt should propose user-level skill files with required frontmatter: `name`, `description`, `type`, `token_cost`, `keywords`, and optional `requires_tools`.
- [ ] Reflection approval loop must be user-mediated: for each proposal ask yes/no/edit; an edit response is treated as guidance, regenerates/adapts the skill, and presents it again.
- [ ] Write accepted skills to `~/.pi/skills/<skill-name>/SKILL.md` by default so `skill-inject` loads them on the next reload; use path confinement and slug validation from the external reflection designs.
- [ ] Add a one-time migration/notice for existing `.pi/memory` users explaining that memory was superseded and is no longer injected. Do not auto-convert old memories into skills without approval.
- [ ] Document the promotion flow: user-level skills are experimental/local; `/promote-user-skill` copies stable skills into repo `skills/` after duplicate checks so they can be packaged with little-coder.

### Phase 5 — Vendor insights/cost dashboard

- [ ] Vendor `@observal/pi-insights` into `.pi/extensions/pi-insights/`, preserving its AGPL license headers and adding license/NOTICE entries as an explicit user-approved vendoring decision.
- [ ] Remove the `@observal/pi-insights` package entry from `littleCoder.packages` and dependencies only after the vendored extension is active; remove obsolete postinstall patches against `node_modules/@observal/pi-insights`.
- [ ] Port selected `agent-cost-dashboard` concepts into the vendored TypeScript extension rather than shelling out to Python: daily spending chart, model breakdown, tool usage, project/session browser, top costly sessions, subagent grouping, and transcript export links.
- [ ] Reuse `usage-dashboard` parsing logic where possible; move shared cost/session aggregation to a helper so `/usage`, `/insights`, and breadcrumbs do not each parse sessions differently.

### Phase 6 — Python sandbox first draft

- [ ] Remove broad `python ` and `python3 ` from `BUILTIN_SAFE_PREFIXES` in `permission-gate`; no Python execution should be auto-approved by prefix.
- [ ] Add Python-command detection for `python`, `python3`, venv Python paths, `uv run python`, `python -m ...`, `python -c`, stdin/heredoc scripts, and direct `.py` execution when invoked through bash.
- [ ] Route every detected Python execution through a sandbox path without asking the user for approval. Prefer mutating the `bash` tool input in `tool_call` to invoke a generated sandbox wrapper; if a command cannot be rewritten safely, block with a clear sandbox-unavailable reason rather than asking or running unsandboxed.
- [ ] First-draft sandbox design:
  - On Linux, prefer an OS sandbox if available (`bubblewrap`/similar): read-only bind the workspace unless write access to a controlled temp/work output dir is explicitly needed, tmpfs `/tmp`, no network where supported, minimal env, timeout, output cap.
  - If no OS sandbox is available, run only in the most restrictive fallback available and block with a clear message if containment cannot be provided; do not ask for approval and do not silently run unsandboxed.
  - Use TypeBox/Zod-style validation in TypeScript for command specs; do not rely on Pydantic as the security boundary. Pydantic can validate a helper manifest if a Python helper is later introduced, but validation is not containment.
  - Optionally add a restricted AST helper only for tiny data-transformation snippets, clearly documented as convenience rather than a security sandbox.
- [ ] Include test-running commands such as `python -m pytest` in the sandbox route. They should not require approval, but they also should not run outside the sandbox.
- [ ] Add tests proving `python -c 'import os; os.system(...)'`, heredoc Python, arbitrary Python scripts, `python -m pytest`, and venv Python paths are sandboxed or blocked when sandboxing is unavailable, never silently allowed unsandboxed.

### Phase 7 — Cleanup and docs

- [ ] Update README/CHANGELOG if these commands/features are documented there.
- [ ] Remove stale memory docs/references and update startup hints.
- [ ] Update package metadata and lockfile for any new vendored extensions or dependencies.

## Verification

Automated checks:
- `npm test`
- `npm run typecheck`
- Focused Vitest suites:
  - `skill-inject` frontmatter/scoring/cooldown/listing/user-root/promotion tests
  - `mode-commands` command-registration tests
  - `extra-tools` `findRead` output tests
  - `browser` description snapshot/registration tests if existing patterns allow
  - `permission-gate` Python allow/block tests
  - new `breadcrumbs` parser/search/read-guard tests
  - new `reflect-skills` proposal/path/frontmatter/approval tests
  - cost aggregation tests shared by `/usage` and `/insights`

Manual checks:
- Start a local session and confirm `/plan` enters Plannotator planning mode, with no prompt-only `/plan:1` duplicate.
- Run `/skills` and the `skills` tool; descriptions and origins should appear for repo and user-level skills.
- Trigger `findRead` and verify the returned text includes effective `pattern`, `maxFiles`, and `maxCharacters`.
- Run a multi-turn sequence where the same skill would match repeatedly; confirm immediate reinjection is suppressed, explicit `/skill` still works, and long-session warning is throttled.
- Run `breadcrumbs_search` and `breadcrumbs_read`; search should return outlines only, read should enforce chunk guards.
- Run `/reflect`; verify proposals require yes/no/edit approval and accepted skills land under `~/.pi/skills` with keywords.
- Run `/promote-user-skill` with no args and with a selected skill; verify promotable listing, duplicate checks, and repo `skills/` output.
- Confirm old `/memory-*` commands are gone or replaced by clear reflection equivalents and that `.pi/memory` is not injected.
- Run `/usage` and `/insights`; compare aggregate costs/session counts against a small fixture or known session set.
- Try Python bypass examples and verify they are sandboxed, or blocked if sandboxing is unavailable, without asking for approval.

## Resolved decisions

- Directly vendor AGPL `@observal/pi-insights` with license/NOTICE preservation.
- Sandbox all Python execution; do not use approval as the escape hatch.
- Reflection writes to user-level `~/.pi/skills` by default; repo `skills/` receives skills only via `/promote-user-skill` after duplicate checks.

