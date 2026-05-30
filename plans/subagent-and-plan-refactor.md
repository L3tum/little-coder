# Plan: Subagent Extension, Plan/Execute/Review Commands, ask_user Fix, and Prompt Hardening

## Context

Several related issues need to be addressed together:

1. **Plan command bug**: The `/plan` command exists (added via postinstall patch to `@plannotator/pi-extension`), but user-facing text still references `/plannotator` instead of `/plan`. The planning prompt and `plannotator_submit_plan` tool registration work, but agents in interactive mode may not reliably call `plannotator_submit_plan` because the prompt still mentions "Plannotator" branding.

2. **Subagent code is embedded in issue-agent**: The subprocess spawning logic (`runSubAgent`, `handleSubAgentJsonLine`, `subAgentCommand`, env setup) lives inside `.pi/extensions/issue-agent/index.ts` and `bin/launcher-helpers.mjs`. This should be a standalone reusable extension based on `https://github.com/mjakl/pi-subagent`.

3. **No /execute or /review interactive commands**: These should be general-purpose mode commands (alongside `/plan`) that switch the agent into a specific mode by adjusting the system prompt, available tools, and expected outcome. They are not issue-agent-specific — they are user-facing and work in any session. They produce compatible outcomes with the issue-agent harness (same mode prompt templates are shared).

4. **pi-ask-user not installed/registered**: `pi-ask-user` is in `package.json` dependencies but `node_modules/pi-ask-user` does not exist. It needs to be actually installed and its `ask_user` tool registered in interactive planning mode only (not in subagent/spawn mode).

5. **System prompts need evidence-first and gentle-coding improvements**: The AGENTS.md and planning prompts should encourage evidence-gathering via `code_search`, `lsp`, `websearch`, `webfetch`, and `EvidenceAdd`/`EvidenceList`, discourage intuition-based claims, and employ gentle/collaborative framing per the Gentle-Coding approach.

---

## Approach

### Phase 1: Create the subagent extension (`.pi/extensions/subagent/`)

Vendor the `pi-subagent` project from `https://github.com/mjakl/pi-subagent` into `.pi/extensions/subagent/` with the following adaptations:

1. **Port all source files** from pi-subagent (`index.ts`, `agents.ts`, `runner.ts`, `runner-cli.js`, `runner-events.js`, `render.ts`, `types.ts`) into `.pi/extensions/subagent/`.
2. **Adjust import paths** and the `pi` extension manifest for the vendor layout.
3. **Register project agents programmatically** for PLAN, EXECUTION, REVIEW, and EXPLORE modes:
   - These agents are registered at runtime by the subagent extension (not as `.pi/agents/*.md` files) using `registerAgent()` or equivalent programmatic API.
   - Each programmatic agent uses the same mode prompt templates from `mode-prompts.ts` (shared with mode-commands and issue-agent) as the system prompt body — no duplication.
   - The EXPLORE agent reuses the pi-subagent "explorer" starter content, integrated into the shared prompt system.
   - Agent definitions include YAML-like config (name, description, model override?, thinking level?, tool whitelist?) but are constructed in code, not parsed from markdown files.
   - This avoids prompt duplication: mode-commands, issue-agent, and subagent agent definitions all reference the same `mode-prompts.ts` templates.
4. **Add model override commands**:
   - `/subagent-model <agent> <model>` — set model for a specific agent
   - `/subagent-model-all <model>` — set model for all agents
   - These write to `~/.pi/agent/settings.json` (under a `little_coder.subagent_models` key).
5. **Add subagent-level command**:
   - `/subagent-level <off|minimal|low|medium|high|xhigh>` — controls how much steering is injected into the system prompt to make an agent use subagents.
   - `off` entirely disables the `subagent` tool (it is not registered when level is off).
   - Persisted to `~/.pi/agent/settings.json` (under `little_coder.subagent_level`).
   - Injected via `before_agent_start` hook: when subagent-level is set, append guidance to the system prompt encouraging (or discouraging) delegation to subagents. At `off`, no delegation guidance is injected and the tool is not registered.
   - Analogous to `thinking-level` but for delegation frequency.

### Phase 2: Add general /plan, /execute, /review mode commands

These are **general commands** (not issue-agent or subagent commands) that switch the agent into a specific mode by adjusting the system prompt, available tools, and expected outcome — the same way the issue-agent harness or subagent harness would for that mode.

1. **Create a new extension `.pi/extensions/mode-commands/`** that registers `/plan`, `/execute`, and `/review` as general-purpose commands:
   - `/plan` — enters planning mode: restricts tools to read-only + plan submit, sets system prompt to planning mode (using `planningModePrompt({ mode: "interactive" })`), and expects `plannotator_submit_plan` as the outcome. Only available in interactive (non-subagent) mode.
   - `/execute` — enters execution mode: enables full tool access, sets system prompt to encourage implementing a plan (reads the most recent plan file if present), executes checklists if available. Uses the EXECUTION mode concept shared with issue-agent.
   - `/review` — enters review mode: read-only + evidence gathering, sets system prompt for structured code review, produces a review summary verdict. Uses the REVIEW mode concept shared with issue-agent.
2. Each command works **without needing issue-agent or subagents** — they directly configure the current session's mode. But they produce compatible outcomes so that the same plan can be created via `/plan` and then executed via `/issue-agent --state=EXECUTING` or via `/execute`.
3. **Mode prompt templates** are defined in a shared location (e.g., `.pi/extensions/mode-commands/mode-prompts.ts`) and reused by both these general commands and the issue-agent harness.

### Phase 3: Refactor issue-agent to use subagent extension's runner directly

1. **Remove embedded subagent logic** from `.pi/extensions/issue-agent/index.ts`:
   - Remove `runSubAgent`, `handleSubAgentJsonLine`, `subAgentCommand`, and subprocess JSON parsing.
   - The issue-agent already runs non-interactive in the main process — it should NOT go through the `subagent` tool (which would create an unnecessary agent-to-agent delegation).
2. **Remove `--issue-agent-subagent` special-casing** from `bin/little-coder.mjs` and `bin/launcher-helpers.mjs` (the subagent extension handles this generically).
3. **Replace with direct runner function calls**: The issue-agent calls the subagent extension's `runAgent()` (or equivalent) function directly — the same internal function the `subagent` tool uses. This spawns a subagent process and collects results without the overhead of an intermediate tool call/agent invocation.
   - The subagent extension exports `runAgent` for use by other extensions (not just its own tool handler).
   - The issue-agent passes the constructed prompt, model, thinking level, and env directly to the runner.
4. **The existing `/issue-agent` command** remains as the continuous loop. Internally it uses the same mode prompts defined in Phase 2.
5. **Keep `issueAgentDone`, `issueAgentAsk`, `issueAgentList` tools** (these are issue-agent-specific and remain).

### Phase 4: Fix the `/plan` command and plannotator integration

1. **Update the postinstall patch** in `scripts/patch-extension-notifications.mjs`:
   - Ensure `/plan` command description says "Toggle planning mode" (not "Toggle plannotator planning mode").
   - Ensure all user-facing status messages and notify text reference `/plan` not `/plannotator`.
2. **`plannotator_submit_plan` availability**: This tool is interactive-only. It should NOT be available in subagent or issue-agent modes (those run non-interactive). Update the plannotator patch so that `plannotator_submit_plan` is only registered when NOT in subagent mode. Detect subagent mode via the `LITTLE_CODER_SUBAGENT` or `PI_SUBAGENT_DEPTH` env vars. In subagent/issue-agent mode, the plan outcome is handled by calling the appropriate issue-agent or subagent completion tool (`issueAgentDone`, etc.) instead.

### Phase 5: Install and register `pi-ask-user`

1. **Investigate availability**: `pi-ask-user` is listed in `package.json` but missing from `node_modules`. Determine if it's available via `pi install git:github.com/...` or must be vendored.
2. **Vendor into `.pi/extensions/ask-user/`** if not available on npm, following the same pattern as other vendored extensions.
3. **Update `bundledPackageArgs`** in `bin/little-coder.mjs` to exclude `pi-ask-user` when `LITTLE_CODER_SUBAGENT` env var is set (non-interactive subagent mode should not have `ask_user`).
4. **Add `"pi-ask-user"` to `littleCoder.packages`** in `package.json` (already present — verify it works after install).

### Phase 6: System prompt improvements (evidence-first + gentle coding)

1. **Update `AGENTS.md`**:
   - Add an "Evidence-First" section: require `code_search`, `lsp`, `websearch`, `webfetch` before making claims.
   - Require `EvidenceAdd` for any factual claim.
   - Prohibit "I think", "Probably", "Likely", "I believe", "It seems" — require verified facts or "I don't know".
   - Add gentle/collaborative framing: approach tasks as a partner, it's okay to not know, don't confabulate.
   - Add anti-loop guidance: don't get stuck in validation loops, move on after verification.
2. **Update `.pi/extensions/plan-mode/planning-prompt.ts`**: Strengthen evidence-first and anti-confabulation language, add gentle framing.
3. **Update the postinstall patch** for plannotator's planning prompt to include the same improvements.

---

## New Files

| File | Purpose |
|------|---------|
| `.pi/extensions/subagent/index.ts` | Subagent extension entry point (vendored from pi-subagent) |
| `.pi/extensions/subagent/agents.ts` | Agent discovery (vendored) |
| `.pi/extensions/subagent/runner.ts` | Process runner (vendored) |
| `.pi/extensions/subagent/runner-cli.js` | CLI arg inheritance (vendored) |
| `.pi/extensions/subagent/runner-events.js` | JSON event parsing (vendored) |
| `.pi/extensions/subagent/render.ts` | TUI rendering (vendored) |
| `.pi/extensions/subagent/types.ts` | Shared types (vendored) |
| `.pi/extensions/ask-user/` | Vendored pi-ask-user (if not on npm) |
| `.pi/extensions/mode-commands/index.ts` | General /plan, /execute, /review mode commands |
| `.pi/extensions/mode-commands/mode-prompts.ts` | Shared mode prompt templates (reused by mode-commands and issue-agent) |

## Files to Modify

| File | Changes |
|------|---------|
| `.pi/extensions/issue-agent/index.ts` | Remove `runSubAgent`, `handleSubAgentJsonLine`, `subAgentCommand`; refactor to call subagent extension's `runAgent()` directly + use shared mode prompts from `mode-prompts.ts`; keep `/issue-agent` loop and issue-agent-specific tools |
| `bin/little-coder.mjs` | Remove `--issue-agent-subagent` handling; exclude `pi-ask-user` when subagent env is set |
| `bin/launcher-helpers.mjs` | Remove `applySubAgentEnv` export (no longer needed); in `bundledPackageArgs`, skip `pi-ask-user` package when `LITTLE_CODER_SUBAGENT` env var is set |
| `AGENTS.md` | Add evidence-first, anti-confabulation, and gentle coding sections |
| `.pi/extensions/plan-mode/planning-prompt.ts` | Strengthen evidence-first and gentle coding guidance |
| `scripts/patch-extension-notifications.mjs` | Update `/plan` command patches; make `plannotator_submit_plan` conditional on non-subagent mode |
| `package.json` | Verify `pi-ask-user` reference works (may need git source) |

## Reuse

- `planningModePrompt()` from `.pi/extensions/plan-mode/planning-prompt.ts` — shared between interactive and issue-agent planning
- `EvidenceAdd`, `EvidenceGet`, `EvidenceList` tools from `.pi/extensions/evidence/index.ts` — referenced in guidance
- `_shared/intervention.ts` from `.pi/extensions/_shared/intervention.ts` — pattern for shared helpers
- pi-subagent project — vendored as the subagent extension core (7 source files)
- `launcher-helpers.mjs` — extended for `pi-ask-user` filtering
- mode-prompts.ts templates — single source of truth for PLAN/EXECUTION/REVIEW/EXPLORE prompts, used by mode-commands, subagent programmatic agents, and issue-agent harness

## Steps

### Step 1: Vendor pi-subagent
- [ ] Copy all 7 source files from pi-subagent into `.pi/extensions/subagent/`
- [ ] Adjust import paths for the new location
- [ ] Export `runAgent()` from the subagent extension so other extensions (issue-agent) can call it directly
- [ ] Register PLAN, EXECUTION, REVIEW, EXPLORE agents programmatically using shared mode prompt templates
- [ ] Add `/subagent-model`, `/subagent-model-all`, `/subagent-level` commands
- [ ] Add settings persistence for model overrides and subagent-level to `~/.pi/agent/settings.json`
- [ ] Add `before_agent_start` hook to inject delegation steering based on subagent-level; at `off`, do not register the `subagent` tool

### Step 2: Register agents programmatically in the subagent extension
- [ ] In `.pi/extensions/subagent/index.ts`, register PLAN, EXECUTION, REVIEW, and EXPLORE agents programmatically
- [ ] Each agent uses mode prompt templates from `mode-prompts.ts` as its system prompt body — no duplication with mode-commands or issue-agent
- [ ] Programmatic registration includes: name, description, default model/thinking overrides per agent, tool whitelist
- [ ] EXPLORE agent content is based on the pi-subagent "explorer" starter but integrated into the shared prompt system
- [ ] No `.pi/agents/*.md` files needed — all agent definitions are in code

### Step 3: Create mode-commands extension
- [ ] Create `.pi/extensions/mode-commands/mode-prompts.ts` with shared prompt templates for PLAN, EXECUTION, REVIEW modes
- [ ] Create `.pi/extensions/mode-commands/index.ts` registering `/plan`, `/execute`, `/review` commands
- [ ] `/plan` command: restricts tools (read-only + plannotator_submit_plan), injects planning system prompt, only available in interactive (non-subagent) mode
- [ ] `/execute` command: enables full tools, injects execution system prompt, reads recent plan file if present
- [ ] `/review` command: read-only + evidence tools, injects review system prompt, produces verdict output

### Step 4: Refactor issue-agent
- [ ] Remove `runSubAgent`, `handleSubAgentJsonLine`, `subAgentCommand` from `index.ts`
- [ ] Remove `--issue-agent-subagent` special-casing from launcher files
- [ ] Refactor `queueIssue`/`queueReview`/`queueRework` to call the subagent extension's `runAgent()` function directly (same internal function the `subagent` tool uses, but without the agent-to-agent overhead)
- [ ] Reuse mode prompt templates from `mode-prompts.ts` for issue-agent planning/execution/review prompts
- [ ] Keep `/issue-agent` loop, `issueAgentDone`, `issueAgentAsk`, `issueAgentList`

### Step 5: Fix /plan and plannotator
- [ ] Update postinstall patch for `/plan` command text — all user-facing text says `/plan` not `/plannotator`
- [ ] Make `plannotator_submit_plan` tool conditional: only register when NOT in subagent mode (check `LITTLE_CODER_SUBAGENT` or `PI_SUBAGENT_DEPTH` env vars)
- [ ] Subagent/issue-agent modes use their own completion tools (`issueAgentDone`, etc.) instead of `plannotator_submit_plan`

### Step 6: Handle pi-ask-user
- [ ] Determine if `pi-ask-user` is available via git or must be vendored
- [ ] Vendor or install it
- [ ] Update `bundledPackageArgs`/`little-coder.mjs` to exclude it in subagent mode
- [ ] Verify `ask_user` tool is registered in interactive planning mode only

### Step 7: System prompt improvements
- [ ] Update `AGENTS.md` with evidence-first, anti-confabulation, gentle coding
- [ ] Update `planning-prompt.ts` with same improvements
- [ ] Update plannotator patches in `patch-extension-notifications.mjs`

### Step 8: Update tests
- [ ] Update `issue-agent/index.test.ts` for refactored code
- [ ] Add `subagent/` tests
- [ ] Update plan-mode tests for new prompt content
- [ ] Add tests for new commands

---

## Verification

1. `npm test` — all existing and new tests pass
2. `/plan` command — verify agent enters planning mode, calls `plannotator_submit_plan` at end; verify all user-facing text says `/plan` not `/plannotator`
3. `/execute` command — verify agent enters execution mode with full tools and execution prompt
4. `/review` command — verify agent enters review mode with read-only tools and produces a verdict
5. `/plan` in subagent mode — verify `plannotator_submit_plan` is NOT registered (subagent uses its own completion tools)
6. `/subagent-level off` — verify `subagent` tool is entirely disabled
7. `/subagent-level high` — set it, restart, verify persisted in `~/.pi/agent/settings.json`
8. `/subagent-model plan some/model` — verify persisted and used
9. Interactive mode — verify `ask_user` tool is available in plan mode
10. Subagent mode — verify `ask_user` tool is NOT available in spawned subagent processes
11. Evidence-first — verify agent uses `code_search`/`lsp`/`EvidenceAdd` before making claims
12. Issue-agent loop — verify `/issue-agent` continuous loop still works with refactored direct `runAgent()` calls (no `subagent` tool overhead)
13. No prompt duplication — verify PLAN/EXECUTION/REVIEW prompts are identical between `/plan` command, subagent agent definitions, and issue-agent harness (all reference `mode-prompts.ts`)
