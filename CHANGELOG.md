# Changelog

All notable changes to little-coder are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and little-coder's public interface (CLI, providers, tools, skills) follows semver starting at `v0.0.1` post-rename.

## [v1.8.1] — 2026-05-23

### Fixed
- **`glob` no longer exhausts memory on a recursive search from a huge root.** The tool capped *matches* at 500 but never bounded the *walk*: run from a home directory (or any tree with macOS `Library`, caches, or `node_modules`), `fs.glob` recursively descended everything and its internal traversal state grew until the Node **process** ran out of heap — a host-memory crash (`Ineffective mark-compacts near heap limit`), entirely distinct from the model's *context window* (the read-guard / window machinery operates on tool *results* in tokens; this died mid-walk, before any result existed). The walk is now bounded two ways: heavy/irrelevant directories (`node_modules`, `.git`, `dist`, `.cache`, `Library`, `venv`, `target`, …) are **pruned** — never descended — and a hard scan budget (200 000 entries) halts the walk through the one hook `fs.glob` calls per entry (`exclude`), since it exposes no signal/abort. When results are cut short the output says so, so the model narrows its search. New unit-tested `globFiles` / `renderGlobOutcome` helpers (`.pi/extensions/extra-tools/glob.ts`), verified to prune `node_modules` (0 descent) and to halt at the scan budget.

### Notes for upgraders
- For a focused search, pass a `path` (a project subdirectory) instead of globbing from a home directory. Hidden directories continue to be skipped by `fs.glob` as before.

---

## [v1.8.0] — 2026-05-23

little-coder now **auto-detects the llama.cpp server's live context window** at startup and registers the model with it, so a `llama-server -c 131072` shows 128k instead of the declared default — no config edit. This completes [v1.7.0](#v170--2026-05-23): the budget already *followed* the registered window; now the registered window itself comes from the running server.

### Added
- **Live context-window detection for llama.cpp.** On startup `llama-cpp-provider` GETs the server's `/props` endpoint, reads its actual `n_ctx`, and registers the model with that window in place of the static `contextWindow` in `models.json`. The TUI context readout, read-guard's overflow trim, and the skill/knowledge budgets all then track the server's real window — bump `llama-server -c` and little-coder follows, no `models.json` or settings edit. The `/props` URL is derived from the provider baseUrl by stripping `/v1` (llama-server serves it at the root); the value is read from `default_generation_settings.n_ctx`. New tested helpers `propsUrlFor` / `contextWindowFromProps` / `probeContextWindow`, validated end-to-end against a live `-c 131072` server (→ 131072).
  - **Best-effort and safe:** 1.5 s timeout, `llamacpp` provider only, and ANY failure (server down, no `/props`, non-JSON, timeout) silently falls back to the declared window — startup is never blocked or broken.
  - **Env knobs:** `LITTLE_CODER_NO_CTX_PROBE=1` disables the probe (offline / CI); `LITTLE_CODER_LLAMACPP_PROPS_URL` overrides the `/props` URL for non-standard setups; `LITTLE_CODER_CTX_PROBE_TIMEOUT_MS` tunes the timeout.

### Notes for upgraders
- This adds one best-effort HTTP GET to the llama.cpp `/props` endpoint at launch (only for the `llamacpp` provider). If your server/proxy doesn't expose `/props`, behaviour is unchanged — the declared `models.json` `contextWindow` (default 32768) is used. Set `LITTLE_CODER_NO_CTX_PROBE=1` to skip the probe entirely.
- No CLI-flag or public-API changes.

---

## [v1.7.0] — 2026-05-23

little-coder's context budget now follows the model's **live registered context window** instead of a hardcoded 32 768. Whatever window your provider declares for the active model (`contextWindow` in `models.json`, user-overridable) is what the whole harness budgets against — bump the model once and the TUI's context readout, read-guard's overflow trim, and the skill/knowledge-injection budgets all move together. This closes the common report: *"I bumped llama.cpp to 128k but little-coder still says 33k."*

### Changed
- **`context_limit` is no longer a hardcoded per-profile setting.** It's removed from `default_model_profile` and every base per-model profile in `.pi/settings.json`. `benchmark-profiles` now resolves the published `littleCoder.contextLimit` from the active model's `ctx.model.contextWindow` — the same registered window pi displays and `getContextUsage()` / `read-guard` already use. Precedence: an explicit per-profile/benchmark `context_limit` override → the model's registered window → `CONTEXT_FALLBACK` (32 768). New exported, tested `resolveContextLimit()`, plus an end-to-end test that fires `before_agent_start` against the real `settings.json`.
  - Practical effect: to run at 128k, set `contextWindow: 131072` for the model in your `models.json` (or a `~/.config/little-coder/models.json` override). There's no second knob — every budget follows it. Previously you also had to edit the now-removed `context_limit`, and the budgeting extensions silently stayed at 32 768 even after you bumped the server.

### Notes for upgraders
- Behaviour is unchanged if your `models.json` declares `contextWindow: 32768` (the shipped default) — the resolved budget is still 32 768. Only models with a larger declared window see a change.
- The **gaia** benchmark override keeps its explicit `context_limit: 65536` (an explicit override still wins). Real interactive usage was never turn- or context-capped and still isn't.
- No CLI-flag or public-API changes. `littleCoder.contextLimit` is published under the same name; only its source moved from settings to the live model window.

---

## [v1.6.1] — 2026-05-23

A one-line whitelist tweak: `sed` is now an allowed bash command in `auto` permission mode. Stream-editing and line-range printing (`sed -n '1,20p' file`) are routine enough that gating them behind a per-deployment `LITTLE_CODER_BASH_ALLOW` was friction without a safety payoff — `sed` sits naturally alongside the already-allowed text-search tools (`grep`, `rg`, `find`).

### Changed
- **`sed ` added to the built-in `SAFE_PREFIXES`** (`.pi/extensions/permission-gate/index.ts`). As with every prefix on that list, the trailing space is a word boundary, so `sed …` is allowed while `sedfoo` is not. Note this also permits in-place edits (`sed -i`), the same read-write trade-off the list already makes for `cp `/`mv `; `rm` still stays off the list by design.

### Notes for upgraders
- Purely additive. No CLI flag, `models.json`, `.pi/settings.json`, or per-model-profile schema changes. If a deployment had been allowing `sed` via `LITTLE_CODER_BASH_ALLOW`, that entry is now redundant (harmless — the lists are merged).

---

## [v1.6.0] — 2026-05-23

A new harness intervention for small-context models: oversized file reads no longer blow the context window. little-coder targets local models with small windows (`context_limit` is 32768, and the live window is often less), but pi's built-in `read` returns up to ~2000 lines in a single tool result — enough for one read to evict the conversation and derail the run. The harness now catches that read before it lands and replaces it with the file's head plus a "search, don't slurp" directive, surfaced through the same one-voice `harness intervention: …` line as the thinking-budget cap, write-guard redirect, and turn-cap.

### Added
- **`read-guard` extension — trims a Read that would overflow the context window.** On the `tool_result` event, when a successful `read`'s content would push context usage past the window (`ctx.getContextUsage().tokens + estimate(result) > contextWindow`, estimated at the same 3.5 chars/token ratio as the thinking-budget cap), the harness replaces the result with **only the file's first 30 lines** followed by a message that explains the trim and directs the model to use those lines to understand the file's structure, then narrow down — locate what it needs with `grep`/`find` or a targeted `read` (`offset`/`limit`) — rather than re-reading the whole file. The full file is still read from disk (pi already caps that at ~2000 lines), but the oversized text never reaches the model's context because the result content is swapped before it lands. `tool_result` (not `tool_call`) is used precisely because it can deliver both the 30 lines and the explanation in one result — a `tool_call` block can only return a `reason` string, and mutating `input.limit` gives lines but no message. When current usage is unknown (e.g. right after compaction, `tokens` is null), it falls back to trimming any single read that alone exceeds half the window. Image reads and error results are left untouched. New extension at `.pi/extensions/read-guard/`, auto-discovered by the launcher.

### Notes for upgraders
- No CLI flag, `models.json` shape, `.pi/settings.json`, or per-model-profile schema changes. The new extension auto-loads like every other `.pi/extensions/*/index.ts`, and only changes behaviour when a read would otherwise overflow the context window — normal reads pass through untouched. The threshold reads pi's live `getContextUsage()`, so it scales with whatever context window the active model reports.

---

## [v1.5.1] — 2026-05-22

A branding release — no behaviour changes. little-coder now wears the v1.0 brand book: the warm **paper / ink / honey** palette (`#F2EBDC` · `#1A1410` · `#E15A1F`), the `lc▌` block-cursor mark, and IBM Plex Mono. The "ready to type" cursor is the punchline — it ties the CLI heritage into the identity without saying so.

### Changed
- **README hero is now the brand-book terminal banner.** A single self-contained SVG (`assets/banner.svg`, recreating the brand book's "github readme · hero" slide) replaces the old startup screenshot: ink terminal card, `lc▌` monogram in honey, the wordmark + tagline, and the verifiable headline numbers (`qwen3.6-35b-a3b`, terminal-bench 2.0 24.6%, aider polyglot 45.56%). IBM Plex Mono is embedded so it renders in-face on GitHub, with a `ui-monospace` fallback.
- **TUI header adopts the honey "prompt lockup."** The interactive startup header (`.pi/extensions/branding/index.ts`) now renders `> little-coder▌` with a honey prompt caret and block cursor — the brand's variant for terminals and dark surfaces. Honey is emitted as a 24-bit truecolor SGR so it matches `#E15A1F` exactly regardless of the active pi theme.

### Removed
- The stale purple (`#7c3aed`) `docs/assets/startup.svg` mockup (`v0.0.1` / `ollama/qwen3.5`), now superseded by the on-brand banner.

---

## [v1.5.0] — 2026-05-22

A reliability + UX release centered on the harness's intervention machinery. Issue [#8](https://github.com/itayinbarr/little-coder/issues/8) reproduced on 1.4.3 through a *new* mechanism, and chasing it down fixed a cluster of related symptoms: thinking never actually turning off after a budget breach, a spurious "empty response" nag after interrupts, and a noisy stack of warnings around every harness decision. Harness interventions now speak with one voice, and the thinking-budget cap is more generous.

### Fixed
- **Thinking-budget recovery no longer dies on a stale `pi` ([#8](https://github.com/itayinbarr/little-coder/issues/8), second reproduction).** The v1.0.0 fix deferred recovery (`setThinkingLevel("off")` + the commit-to-an-implementation follow-up) to a `turn_end` handler that ran, after a `setImmediate` yield, against the module-scope `pi` (`ExtensionAPI`). But the over-budget `ctx.abort()` makes pi's `agent_end` run auto-retry / auto-compaction (both enabled in `.pi/settings.json`; `agent-session.js:761` "compact before sending — catches aborted responses"), which **replaces the session** — `dispose()` → `ExtensionRunner.invalidate()` (`agent-session.js:516`) marks the captured `pi` stale. The `setImmediate` yield was exactly what let that replacement land *before* the deferred recovery, so the recovery touched a stale `pi` and threw (`"This extension ctx is stale after session replacement or reload"`). Net effect: thinking was never disabled (so the *next* step kept thinking) and the follow-up never reached the model (so the agent appeared to stop). The fix does the entire recovery **synchronously inside `message_update`, before `ctx.abort()`**, while `pi` is still live — no deferred handler, no `setImmediate`, nothing that can run against a stale reference. Thanks to the reporter on #8 for the minimal repro and the stale-`ctx` diagnosis.
- **Thinking stays off across the forced restart turn.** Even with recovery firing, the post-abort run could re-resolve the thinking level back to the profile default. A `forcedOff` latch now re-asserts `"off"` at the start of every turn from a budget breach until your *next* genuine prompt (the `input` event), at which point the level you actually had is restored — so a new task thinks normally and we don't leave thinking globally disabled. State is also cleared on `session_start` (a new session / `/clear` is a clean slate).
- **No more spurious "your previous response was empty" after an interrupt.** `quality-monitor` assessed *every* `turn_end`, including turns the user interrupted with ESC or that the harness aborted (thinking-budget, turn-cap) — which carry partial/empty content and `stopReason: "aborted"`. It then steered an `empty_response` correction onto your *next* prompt. It now skips `stopReason: "aborted"` turns entirely; genuinely-empty *completed* turns are still flagged.
- **Per-model profiles are no longer silently skipped on colon-style model ids.** `benchmark-profiles` prefix-matched model keys literally, so a hyphenated profile key (`llamacpp/qwen3.6-35b-a3b`) never matched a runtime id using a colon (`llamacpp/qwen3.6:35b-a3b`) and every such model fell back to `default_model_profile`. Matching is now separator-insensitive (`:` ≡ `-`).
- **Existing files can no longer be silently overwritten via Write.** pi ships a built-in `write` tool that overwrites existing files (`core/tools/write.js`) and shadowed little-coder's custom guarded `write`, so the whole-file-rewrite guard the benchmark results depend on had stopped firing. The guard now runs on the `tool_call` event — it catches whichever `write` implementation executes, normalizes the path in place, and blocks writes to existing files with a corrected Edit recipe (pi's `edit` takes `edits: [{oldText, newText}]`, not `old_string`/`new_string`).

### Added
- **`/clear` command.** Starts a fresh session as if little-coder were closed and relaunched — re-renders the banner, rebuilds the AGENTS.md/system-prompt context, and resets session-scoped extension state — via `ctx.newSession()`. (pi's built-in equivalent is `/new`; `/clear` is the alias muscle-memory expects.)
- **One-line "harness intervention" UX.** Every moment the scaffolding overrides or redirects the model — thinking-budget cap, write-guard redirect, turn-cap, finalize-warn, quality-monitor corrections, output-parser nudges — now surfaces a single, uniformly-worded line (`harness intervention: …`) instead of each extension's own ad-hoc warning. Helper at `.pi/extensions/_shared/intervention.ts`.
- **pi's bare "Operation aborted" marker is suppressed.** With harness interventions carrying their own line and a user ESC being self-evident, the stacked red marker was noise. pi is a normal dependency (not vendored), so this ships as an idempotent, dependency-free source patch (`scripts/patch-pi.mjs`) applied on `postinstall` **and** re-applied on every launch by the launcher — it self-heals if install scripts were skipped or pi was reinstalled, and **fails safe**: if a future pi changes that code the patch silently no-ops (you'd just see the marker again) rather than breaking install or launch. A test (`scripts/patch-pi.test.mjs`) fails loudly the moment the installed pi no longer matches, so a pi bump is a caught CI signal to refresh one string — never a silent regression.

### Changed
- **Thinking-budget cap raised 2048 → 4096 tokens** across `default_model_profile` and every per-model profile (the `terminal_bench` / `gaia` benchmark overrides keep their tuned values). The hardcoded fallback in the `thinking-budget` extension matches.

### Notes for upgraders
- No CLI flag, `models.json` shape, or per-model-profile *schema* changes. The only `.pi/settings.json` value change is `thinking_budget` (2048 → 4096); if you'd pinned it lower on purpose, re-set it in your own settings.
- The custom `write` tool the `write-guard` extension used to register is gone — writes go through pi's built-in `write`, guarded at the `tool_call` event. If you depended on the old tool's `file_path` arg name in a fork, note pi's built-in uses `path` (both are accepted by the guard).
- The pi source patch targets `@earendil-works/pi-coding-agent` 0.75.x. If you bundle a newer pi and the abort marker reappears, run `npx vitest run scripts/patch-pi.test.mjs` — a failure tells you to refresh the find/replace in `scripts/patch-pi.mjs`.

---

## [v1.4.3] — 2026-05-19

Follow-up to v1.4.2: clean up two cosmetic regressions that the @earendil-works scope migration surfaced.

### Fixed
- **Pi's `What's New` block no longer appears inside little-coder's TUI after a version bump.** Root cause: pi's interactive mode reads its own bundled `CHANGELOG.md` on startup and renders every entry strictly newer than the `lastChangelogVersion` field in `~/.pi/agent/settings.json` (`interactive-mode.js:getChangelogForDisplay`). v1.4.2 jumped the bundled pi from 0.68.1 to 0.75.3, so users who had previously launched any older little-coder saw pi's full 0.68 → 0.75 upstream changelog dumped *underneath* little-coder's own startup banner. That's wrong because little-coder is the surface and pi is the substrate — the chrome above shouldn't suddenly start advertising the substrate's release notes. The launcher (`bin/little-coder.mjs`) now pre-stamps `lastChangelogVersion` to the currently bundled pi version (resolved from `node_modules/@earendil-works/pi-coding-agent/package.json#version`, the same file we already read to find pi's cli.js, so there's no second source of truth) *before* pi starts. Pi then sees "user already saw this changelog" and the block never renders. The merge into `~/.pi/agent/settings.json` is non-destructive — `quietStartup: true` and every other existing key are preserved. Users who genuinely want pi's upstream changelog can still pull it up with `/changelog` inside the TUI.
- **`npm install -g little-coder` no longer prints `node-domexception@1.0.0` deprecation warning.** Root cause: a 5-hop transitive — `@earendil-works/pi-ai` → `@google/genai` → `google-auth-library` → `gaxios` → `node-fetch@3` → `fetch-blob@3` → `node-domexception@1.0.0`. The `node-domexception` package is just a 16-line shim that sets `globalThis.DOMException` when undefined, and native `DOMException` has been built into Node since 18 — so on our `Node >= 22.19` floor, the entire shim is dead code. Replaced it via `package.json#overrides` pointing at a bundled stub at `./vendor/node-domexception/` that exports `module.exports = globalThis.DOMException` directly. The stub ships in the npm tarball (`files` array now includes `vendor/`). Since npm's `overrides` field is honored when little-coder is the install root (which it is for `npm install -g little-coder`), the deprecated upstream package never reaches the user's tree, and npm prints no warning. Functional behavior is identical because the only call site (`fetch-blob/from.js:import DOMException from 'node-domexception'`) sees the same `globalThis.DOMException` it would have gotten from the upstream shim.

### Notes for upgraders
- The bundled stub lives at `vendor/node-domexception/` inside the published package — it's listed under `files` in `package.json`. If you'd added your own `overrides` field that touches `node-domexception` in a hand-rolled fork of little-coder, our entry will take precedence when you publish; in the unlikely case that breaks something for you, override it back in your fork's root `package.json`.
- The `lastChangelogVersion` pre-stamp is one-directional: it writes the *currently bundled* pi version into settings on every launch. If you'd like to see pi's upstream changelog for a future bump, `/changelog` inside the TUI is the unconditional path — it doesn't consult `lastChangelogVersion`.
- No CLI flag, models.json shape, skill-pack, extension API, or per-model profile changes. Little-coder's own startup banner, tagline, and keybind hints (the branding extension at `.pi/extensions/branding/`) are byte-for-byte unchanged from v1.4.2.

---

## [v1.4.2] — 2026-05-19

Bundled-pi maintenance release. Closes [#22](https://github.com/itayinbarr/little-coder/issues/22), [#23](https://github.com/itayinbarr/little-coder/issues/23), [#25](https://github.com/itayinbarr/little-coder/issues/25). The pi runtime moves from `@mariozechner/pi-coding-agent@^0.68.1` to `@earendil-works/pi-coding-agent@^0.75.3` — same author, same project, new npm scope — which makes the deprecation warnings disappear, pulls in pi's recent Windows / undici / cmd-shim fixes, and (because pi 0.75 raised its floor) bumps the supported Node range to ≥ 22.19. No CLI flag, settings, extension API, or skill-pack changes.

### Fixed
- **`npm install -g little-coder` no longer emits `@mariozechner/pi-*` deprecation warnings ([#25](https://github.com/itayinbarr/little-coder/issues/25)).** Upstream pi published the new scope as `@earendil-works/pi-coding-agent` (the `@mariozechner/*` packages remain on npm only to print the migration notice). The little-coder `package.json` dependency entry, all 21 extension import statements under `.pi/extensions/*/index.ts`, the retention-test doc comment, and the README attribution have been migrated. The public `ExtensionAPI`, `Theme`, hook event names (`before_agent_start`, `context`, `before_provider_request`, `tool_call`, `tool_result`, `turn_end`, `session_compact`, `session_start`), `pi.ui.setHeader()` / `pi.ui.setTitle()`, `registerProvider()`, and CLI flags (`--no-context-files`, `--no-extensions`, `--system-prompt`, `--extension`, `--mode rpc`, `--list-models`, `--verbose`, `--offline`) all keep their previous signatures — the rename is purely the npm scope. Full `npm run typecheck` + 152-test vitest suite passes against the new scope.
- **Windows startup no longer fails with `'C:\Program' is not recognized as an internal or external command` ([#23](https://github.com/itayinbarr/little-coder/issues/23)).** Root cause: `bin/little-coder.mjs` was invoking `node_modules/.bin/pi.cmd` via `cmd.exe /c …`. When npm's prefix or Node's install path contained spaces (the default Windows location is `C:\Program Files\nodejs\`), the chain of nested `.cmd` shims could tokenize on the first space and execute `C:\Program` as a command name. The launcher now resolves pi's JS entry by reading `node_modules/@earendil-works/pi-coding-agent/package.json#bin.pi` and spawns `process.execPath` (the same Node that's already running) with that absolute path as an argv element. Node's `child_process.spawn` handles Windows argv quoting itself, so there is no shell tokenization at any layer — and the same spawn line works on Linux, macOS, and Windows (the previous `isWindows ? cmd.exe : piBin` branch is gone). This also picks up pi 0.75.2's own Windows fixes for cross-spawn / npm-family commands.
- **Node version requirement bumped to ≥ 22.19.0 ([#22](https://github.com/itayinbarr/little-coder/issues/22)).** The `glob`-cannot-be-used error users hit on Node 20.x came from the bundled pi runtime depending on `glob@^13`, which itself requires Node ≥ 20.19 / 22 to run correctly. Upstream pi 0.75.0 raised its hard minimum to 22.19.0, so the bundled-pi update forces this floor onto us regardless. The launcher's `MIN_NODE` preflight, `package.json#engines.node`, `install.sh`'s version check, and the README install / troubleshooting prose are all moved together. Easiest fix: `nvm install 22 && nvm use 22`.

### Notes for upgraders
- **You must be on Node ≥ 22.19.0 to upgrade.** If `node --version` is below that, `npm install -g little-coder@1.4.2` will still install but the launcher's preflight will refuse to start pi and print the nvm hint. `npm install -g little-coder@1.4.1` keeps working on Node 20.6+ if you genuinely cannot move yet.
- The model list, `models.json` shape, `.pi/settings.json` keys (`quietStartup`, per-model context/thinking-budget/temperature profiles, benchmark_overrides), and skill-pack are untouched. Existing `LITTLE_CODER_BASH_ALLOW`, `LITTLE_CODER_PERMISSION_MODE`, `LITTLE_CODER_MODELS_FILE`, `LLAMACPP_BASE_URL` / `OLLAMA_BASE_URL` / `LMSTUDIO_BASE_URL` / `*_API_KEY` env vars all keep their meaning.
- If you'd hand-written an extension under your local `.pi/extensions/` that imports `from "@mariozechner/pi-coding-agent"`, change the import to `from "@earendil-works/pi-coding-agent"` and re-run. The old scope's last published version was 0.73.1 — it works against an installed `@earendil-works/pi-coding-agent` only via the legacy `@sinclair/typebox` alias that pi 0.69+ keeps for compatibility.

---

## [v1.4.1] — 2026-05-16

Wire fix for the v1.4.0 startup rebrand. The `[Extensions]` block was still showing for users running from outside the repo root.

### Fixed
- **`quietStartup` is now actually applied for end users.** v1.4.0 set `"quietStartup": true` in our shipped `.pi/settings.json`, but pi reads global settings from `~/.pi/agent/settings.json` (or the dir pointed to by `PI_CODING_AGENT_DIR`) — not from the npm package's internal `.pi/`. So users running little-coder from anywhere outside the repo root still saw pi's full extension/skill/prompt inventory on startup. The launcher (`bin/little-coder.mjs`) now non-destructively merges `quietStartup: true` into the user's actual global pi settings on every launch, preserving any other keys. To see the inventory anyway: `little-coder --verbose`.
- **Terminal title now reasserts on `turn_start` / `turn_end`.** Pi's `updateTerminalTitle()` fires multiple times during a session (init, provider count update, session-name change) and was clobbering our `setTitle("little-coder - <cwd>")` back to `π - <cwd>`. The branding extension now re-applies the title on every turn boundary, so after the first prompt the title stays correct.

### Notes for upgraders
- Existing keys in your `~/.pi/agent/settings.json` are preserved. The launcher only writes `quietStartup` if it isn't already `true`. If you'd previously set `"quietStartup": false` deliberately, you'll see the launcher overwrite it back to `true` — set `--verbose` per-invocation to see the inventory without disabling the global default.
- No CLI flag, skill-pack, or API changes.

---

## [v1.4.0] — 2026-05-16

Startup UI rebrand. The TUI's opening frame now reads as **little-coder**, not as pi. Pi remains the substrate; the chrome above it just stops pretending it's the product.

### Added
- **New `.pi/extensions/branding/` extension.** Calls `pi.ui.setHeader()` and `pi.ui.setTitle()` on every `session_start` event to install a little-coder banner: `little-coder vX.Y.Z` (logo) + `A coding agent tuned for small local models` (tagline, verbatim from the README opening line) + a compact keybinding-hint row. The terminal title goes from `π - <cwd>` to `little-coder - <cwd>`. Implementation pattern follows pi's bundled `examples/extensions/custom-header.ts` — the factory returns a duck-typed Component (`render(width): string[]`), so no deep imports of pi-tui internals are required.
- **Startup screenshot in README.** A real `docs/assets/startup.svg` captured from a live `little-coder` startup, rendered via [charm.sh `freeze`](https://github.com/charmbracelet/freeze). Embedded near the top of the README so the first thing a visitor sees is the actual product, not a description of it.

### Changed
- **`.pi/settings.json` now ships `"quietStartup": true`.** This is what suppresses pi's built-in loaded-resources block — the long list of extension paths, skills, prompts, themes that previously flooded the screen on every launch. Power users who want the inventory back can pass `little-coder --verbose`, which sets pi's `verbose: true` and overrides `quietStartup`.
- **Pi's "Pi can explain its own features..." onboarding string is gone.** The branding extension's `setHeader` replaces pi's built-in header entirely, so the line never renders.

### Notes for upgraders
- No API, settings, or skill-pack breaks. CLI flags unchanged.
- If you'd customized pi's startup output via your own `models.json` / `.pi/settings.json` override, your changes still apply — the only new top-level key in shipped `.pi/settings.json` is `quietStartup`, and pi's override semantics preserve per-key user values.
- To restore the original pi-style startup (the `pi vX.Y.Z` logo and the loaded-resources list), run `little-coder --verbose`. There's no way to disable the branding extension from the user side short of editing the installed package, but the rebrand is purely the startup frame — no functional difference.

---

## [v1.3.0] — 2026-05-16

First functional release of Phase 2 (iterative improvement on real-world coding tasks). Three concrete sharp edges that surfaced while actually using the Mac → Linux LAN setup, plus a quality-of-life cleanup on the pi update banner. Minor version bump because three of the four changes are new behavior, all backwards-compatible.

### Added
- **`cp`, `mv`, `mkdir`, `touch` are now on the built-in bash whitelist.** The permission-gate's `BUILTIN_SAFE_PREFIXES` previously covered only read-only inspection (`ls`, `cat`, `git log`, `find`, `grep`, …), so the model couldn't move or copy a file it just created without flipping `LITTLE_CODER_PERMISSION_MODE=accept-all`. These four were the most common false-positive blocks on day-to-day editing work. Trailing-whitespace word-boundary convention preserved — `cp ` allows `cp a b` but not `cpufetch`. `rm` and `sudo` stay off the list by design; per-deployment escape hatch is still `LITTLE_CODER_BASH_ALLOW`. New positive + negative-boundary assertions in `.pi/extensions/permission-gate/permission.test.ts`.
- **Image input on `llamacpp/qwen3.6-35b-a3b`.** `models.json` now declares `input: ["text", "image"]` for this entry, so pi's TUI no longer rejects clipboard / drag-and-drop screenshots. Pi already ships the full image-conversion / resize / OpenAI-format encoding stack (`@mariozechner/pi-coding-agent/dist/utils/{clipboard-image,image-resize,image-convert,mime}.js`); the gate was purely the capability flag on the model. README's *Option A — llama.cpp* now folds the vision projector into the canonical setup: an extra `hf download unsloth/Qwen3.6-35B-A3B-GGUF mmproj-F16.gguf` line and `--mmproj ~/models/mmproj-F16.gguf` on the `llama-server` command. Skip both lines if you want a text-only deployment.

### Fixed
- **Write tool no longer writes to filesystem root when the model emits `/<filename>`.** Previously the tool's schema described `file_path` as *"Absolute file path"*, so models that had no obvious working-directory context dutifully wrote `/person.md` — landing the file at the filesystem root instead of under cwd. `.pi/extensions/write-guard/index.ts` now runs a deterministic `normalizeWritePath()` before any filesystem call: a path matching `/^\/[^/]+$/` (root + single segment, no intermediate dirs) is rewritten to `<cwd>/<segment>` and the success message says so explicitly; bare filenames / relative paths are resolved against cwd up-front so the returned path is absolute; genuine system writes (`/etc/X`, `/tmp/Y/Z`) are passed through untouched. Tool description updated to give the model the right mental model. New unit-test module `.pi/extensions/write-guard/write-guard.test.ts` covers the five distinct path shapes.

### Changed
- **Pi's "Update Available" banner is suppressed by default.** `bin/little-coder.mjs` now defaults `PI_SKIP_VERSION_CHECK=1` unless you've explicitly set it. little-coder bundles `@mariozechner/pi-coding-agent` as an internal dependency pinned per release, so the in-session nag about updating pi was telling users to do something they shouldn't (and couldn't usefully) do — `npm install -g @mariozechner/pi-coding-agent@latest` doesn't affect the bundled copy. Opt back in with `PI_SKIP_VERSION_CHECK=0` if you want the banner. (The broader `PI_OFFLINE=1` is still your hammer for killing pi's other startup network calls — package-update check, tool auto-fetch, install telemetry.)

### Notes for upgraders
- No CLI flag, settings.json, or skill-pack breaks. Existing `LITTLE_CODER_BASH_ALLOW` overrides continue to compose on top of the (now-wider) built-in list. Existing `models.json` user-override files for the llamacpp provider continue to work unchanged; if you'd hand-rolled an override entry for `qwen3.6-35b-a3b` you'll keep its old `input` value until you redeclare it. Tool descriptions changed on Write, which the model sees as a system-prompt diff — no API surface change for you.

---

## [v1.2.1] — 2026-05-16

Docs-only release marking two milestones: **Terminal-Bench 2.0 leaderboard acceptance** and the **end of the Phase 1 benchmark baseline**. No CLI, settings, or skill-pack changes — the env-var path for remote inference (`LLAMACPP_BASE_URL` / `OLLAMA_BASE_URL` / `LMSTUDIO_BASE_URL` pointing at a non-loopback host) has worked since v1.1.0 / v1.2.0, but it was undocumented for the LAN-server case until now.

### Added
- **README "Serving from another machine on your LAN" section** under *Local model setup → Option C*. Covers all three local providers (llama.cpp `--host 0.0.0.0`, LM Studio's *Serve on local network*, `OLLAMA_HOST=0.0.0.0:11434 ollama serve`), the corresponding `*_BASE_URL` env on the client, a `curl /v1/models` reachability check, and a note on opening port 1234 / 8888 / 11434 in `ufw`. Validated against this repo's own benchmark hardware: `LLAMACPP_BASE_URL=http://<lan-ip>:8888/v1` against `llama-server --host 0.0.0.0` serves Qwen3.6-35B-A3B to a different machine over WiFi at the same per-token throughput as loopback.

### Changed
- **Benchmark table — Terminal-Bench 2.0 rows.** Replaced the *"awaiting maintainer merge"* status (HuggingFace PRs [#158](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/158) and [#163](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/163)) with the accepted leaderboard placements published at [tbench.ai/leaderboard/terminal-bench/2.0](https://www.tbench.ai/leaderboard/terminal-bench/2.0): **Qwen3.6-35B-A3B at 24.6 % ± 3.2 (rank 120)** and **Qwen3.5-9B at 9.2 % ± 2.4 (rank 142)**. The mean shifted slightly from the originally-submitted point estimates (23.82 % → 24.6 %, 9.21 % → 9.2 %) once the leaderboard recomputed across all five trials with a confidence interval; the underlying runs are unchanged.
- **Roadmap reframed.** Phase 1 (build a wide benchmark baseline across short coding exercises, interactive shell tasks, and tool-using research) is now marked **complete**: Aider Polyglot ✓, Terminal-Bench-Core v0.1.1 ✓, Terminal-Bench 2.0 ✓, GAIA validation ✓. Phase 2 opens now: **iterative improvement driven by real-world coding tasks**, not by the benchmark suite. New benchmarks (ProgramBench, SWE-bench Verified, GAIA test-split) are deferred until Phase 2 produces enough scaffolding signal to be worth re-measuring — re-benchmarking before the next round of changes lands would mostly re-measure the same baseline.

### Notes for upgraders
- No CLI flag, settings, or skill-pack breaks. Existing `LMSTUDIO_BASE_URL` / `LLAMACPP_BASE_URL` / `OLLAMA_BASE_URL` users on either loopback or remote hosts keep working with no changes; the only thing that changed is that the remote-host case is now documented.
- No `models.json` or `.pi/settings.json` shape change. Per-model profiles (context limit, thinking budget, temperature) continue to apply regardless of where the inference server lives — they're keyed by `<provider>/<model-id>`, not by host.

---

## [v1.2.0] — 2026-05-10

Issue-cleanup release that also ships built-in LM Studio support. Closes [#17](https://github.com/itayinbarr/little-coder/issues/17) (Windows), [#19](https://github.com/itayinbarr/little-coder/issues/19) (phantom Agent tool), [#21](https://github.com/itayinbarr/little-coder/issues/21) (skill param mismatch).

### Added
- **Built-in `lmstudio/local-model` provider.** [LM Studio](https://lmstudio.ai/) exposes an OpenAI-compatible server on `http://127.0.0.1:1234/v1` by default, and previously the only way to use it was to overload `LLAMACPP_BASE_URL`. Now you can run `little-coder --model lmstudio/local-model` and it routes to whatever model LM Studio currently has loaded — no extra config for the single-model case. New env knobs `LMSTUDIO_BASE_URL` (overrides baseUrl, parity with `LLAMACPP_BASE_URL`/`OLLAMA_BASE_URL`) and `LMSTUDIO_API_KEY` (any value; LM Studio ignores it locally but pi requires the env var to exist). README has a new **Option C — LM Studio** under *Local model setup*. `.pi/settings.json` ships a `lmstudio/local-model` profile so the same context/thinking-budget tuning as the llamacpp profiles applies.

### Fixed
- **Windows launch ([#17](https://github.com/itayinbarr/little-coder/issues/17), thanks @Grogger for [PR #18](https://github.com/itayinbarr/little-coder/pull/18)).** On Windows, `node_modules/.bin/pi` is a `.cmd` shim that Node 20's `spawn()` can't execute directly without `shell: true`, and `shell: true` reintroduces the CVE-2024-27980 / DEP0190 shell-injection class. The launcher now resolves `pi.cmd` on Windows and invokes `cmd.exe /c pi.cmd ...` with args as an array — works on Windows 11, no Linux/macOS regression.
- **Edit skill documentation ([#21](https://github.com/itayinbarr/little-coder/issues/21)).** `skills/tools/edit.md` advertised `old_string` / `new_string`, but pi's Edit tool only accepts `oldText` / `newText` (single-edit form) or `edits: [{oldText, newText}]` (array form). Rewritten to show the canonical array form *and* the single-edit back-compat form. While in there, also corrected `skills/tools/read.md` and `skills/tools/write.md` (`file_path` → `path` — pi aliases both, but the canonical name is now in the docs) and `skills/tools/grep.md` (`include` → `glob`, `max_results` → `limit`; pi does not alias these, so the old skill could genuinely produce tool-call errors on the grep path the same way Edit did).

### Changed
- **Removed phantom `Agent` skill ([#19](https://github.com/itayinbarr/little-coder/issues/19)).** `skills/tools/agent.md` documented an `Agent` tool that little-coder never actually registered — pi ships `examples/extensions/subagent/` as a reference impl, but it was not wired up by default. Deleted the skill card and the `agent` / `delegate` / `spawn` keys from `.pi/extensions/skill-inject/index.ts`'s `INTENT_MAP` so the model is no longer told it has a delegation tool. The `skills/protocols/task_decomposition.md` cheatsheet is untouched — decomposition guidance does not depend on a delegation tool.

### Notes for upgraders
- No CLI flag, settings, or skill-pack breaks. `--model lmstudio/local-model` works out of the box if LM Studio is serving on its default port 1234 with a model loaded.
- If you'd been overloading `LLAMACPP_BASE_URL=http://127.0.0.1:1234/v1` to point at LM Studio, that keeps working — but the cleaner path is now `--model lmstudio/local-model` with no env tweaking.

---

## [v1.1.0] — 2026-05-03

Issue-cleanup release. Three small features and one bug fix, driven by GitHub issues #12 / #13 / #15 / #16.

### Added
- **`models.json` is now the canonical provider registration.** ([#13](https://github.com/itayinbarr/little-coder/issues/13))
  Previously `.pi/extensions/llama-cpp-provider/index.ts` hardcoded the model list and `models.json` was decorative; editing it had no effect. Now the extension loads providers and models from `models.json` at startup and registers them dynamically. **User override file** (first match wins): `$LITTLE_CODER_MODELS_FILE` → `$XDG_CONFIG_HOME/little-coder/models.json` → `~/.config/little-coder/models.json`. Per-provider replace semantics — your override fully replaces a same-keyed provider in the shipped file. Diagnostics for missing/invalid sources surface via `console.error`. The legacy `LLAMACPP_BASE_URL` / `OLLAMA_BASE_URL` env vars still beat both files for those two providers. New unit-test module `.pi/extensions/llama-cpp-provider/config.test.ts` covers merge, env override, and resolution-order semantics. README has a new **Configuring models** section.
- **`LITTLE_CODER_BASH_ALLOW` env var** ([#15](https://github.com/itayinbarr/little-coder/issues/15)) — comma-separated extra prefixes merged with the built-in `permission-gate` whitelist, so deployments can allow extra bash commands without forking. Trailing whitespace is meaningful (acts as a word boundary, matching the built-in convention). README has a new **Permissions** section that also documents the existing `LITTLE_CODER_PERMISSION_MODE=accept-all` escape hatch (which was undocumented before).
- **`bun add -g little-coder` install path documented** ([#12](https://github.com/itayinbarr/little-coder/issues/12)). Node ≥ 20.6 is still required at runtime because of the launcher shebang; users who want a fully node-less setup get a one-line shebang-swap recipe.
- `qwen3.6-27b` re-added to `models.json` so the data-driven extension preserves the four-model lineup (`llamacpp/qwen3.6-27b`, `llamacpp/qwen3.6-35b-a3b`, `llamacpp/qwen3.5-9b`, `ollama/qwen3.5`) that `.pi/settings.json` profiles already reference.

### Fixed
- **Empty-response correction is no longer parked until the next user input.** ([#16](https://github.com/itayinbarr/little-coder/issues/16))
  `quality-monitor` was sending its correction message via `pi.sendUserMessage(..., { deliverAs: "followUp" })`, which queued the message until the user typed something — by which point "your previous response was empty" had nothing to steer. Switched to `deliverAs: "steer"` so the correction injects into the in-flight loop. Same fix applies to the other quality-monitor reasons (`unknown_tool`, `repeated_tool_call`, `malformed_args`, `empty_tool_name`); they all benefit from prompt delivery for the same reason. The `thinking-budget` extension's deliberate use of `followUp` (post-abort retry; see commit `50becc3`) is unchanged.

### Changed
- README architecture diagram: `llama-cpp-provider/` is now described as "data-driven provider registration from models.json (+ user override file)"; `models.json` is now described as "canonical provider registration", reflecting the actual load path.

### Notes for upgraders
- No CLI flag, settings.json, or skill-pack breaks. Existing `.pi/settings.json` `model_profiles` keys (`llamacpp/qwen3.6-27b`, `llamacpp/qwen3.6-35b-a3b`, `llamacpp/qwen3.5-9b`, `ollama/qwen3.5`) all still match.
- If you'd been editing the installed package's `models.json` manually, those edits will keep working — but they're erased on the next `npm install -g little-coder@latest`. Move them to `~/.config/little-coder/models.json` to make them survive upgrades.

---

## [v1.0.3] — 2026-04-28

### Changed
- README and `install.sh` now lead with `little-coder --model llamacpp/qwen3.6-35b-a3b` as the canonical example. That's the configuration little-coder is tuned for: small local model + custom scaffolding. Cloud models (Anthropic, OpenAI) move into the secondary list.

---

## [v1.0.2] — 2026-04-28

### Changed
- README order: **Install**, **Run**, and **Local model setup** now lead the doc (right after "How it relates to pi"), with **Paper / benchmark results** and **Roadmap** moved below. New users hit the install command first instead of scrolling past benchmark tables.

---

## [v1.0.1] — 2026-04-28

### Added
- **Update check on startup.** When a newer `little-coder` is on npm, the launcher tells you and (in interactive mode) offers to update on the spot.
  - **Interactive TTY:** prompt `Update now? [Y/n]` — Enter or `y` runs `npm install -g little-coder@latest` and asks you to re-run; `n` skips for this session.
  - **Non-TTY (CI, scripts, pipes, `--print` pipelines):** prints a one-line stderr notice with the install command, never prompts.
  - **Skipped automatically** for `--help`, `--version`, `--list-models`, `--export`, `--mode rpc`, `--mode json`, when `CI=true`, and for the new `--no-update-check` flag / `LITTLE_CODER_NO_UPDATE_CHECK=1` env opt-out.
  - **Cached** at `${XDG_CACHE_HOME:-~/.cache}/little-coder/version-check.json` with a 12 h TTL — at most one network call per day.
  - **Best-effort:** 2 s fetch timeout, all errors swallowed silently. Update check never blocks the agent if the registry is slow or unreachable.

---

## [v1.0.0] — 2026-04-28

Distribution + stability release. Hi everywhere, bye `./node_modules/.bin/pi`.

### Added
- **One-line install.** `curl -fsSL https://raw.githubusercontent.com/itayinbarr/little-coder/main/install.sh | bash` (or `npm install -g little-coder`). The agent now lives on your PATH; no more cloning the repo just to run it.
- **`bin/little-coder.mjs`** — global launcher that runs from any working directory, loads our `AGENTS.md` via `--system-prompt` and every bundled `.pi/extensions/<name>/index.ts` via `-e`, and forwards user argv to pi unchanged. Spawns pi with `cwd = process.cwd()` so file tools operate on the user's project, not the install path. Forwards SIGINT / SIGTERM / SIGHUP and propagates pi's exit code.
- **`install.sh`** — preflight (Node ≥ 20.6.0 + npm) then `npm install -g little-coder` with friendly EACCES guidance.
- **Idempotency tests** for the thinking-budget extension covering double-burst budget breach, replayed `turn_end`, cross-conversation state reset, and post-abort tick yield.

### Fixed
- **Issue #8 (thinking budget silent stop).** The `thinking-budget` extension's module-scoped state could leak across conversations and re-emitted `turn_end` events, leading to double-aborts; the recovery sequence (`ctx.abort()` → `setThinkingLevel("off")` → `sendUserMessage` follow-up) raced pi's async abort barrier and the follow-up was dropped silently on fast-streaming local backends like Qwen3.6-35B-A3B-UD-Q4_K_M. The patched extension resets state on `agent_start`, gates re-entry with a `recoveryPending` flag, and yields one tick (`setImmediate`) before queuing the follow-up. Configured budget values in `.pi/settings.json` are unchanged.
- **Issue #9 (working in folders other than the cloned repo).** With the global install, `cd` to whichever project you want to operate on in your own shell, then run `little-coder` — the agent's cwd is your shell's cwd. The earlier "`cd` is banned in the bash whitelist" friction is gone because nobody needs to `cd` from inside the agent anymore.

### Changed
- Package is no longer `private` and ships an explicit `files` whitelist: `bin/`, `AGENTS.md`, `skills/`, `.pi/extensions/`, `.pi/settings.json`, `models.json`, `LICENSE`, `NOTICE`, `README.md`, `CHANGELOG.md`. Excluded from the published tarball: `benchmarks/`, `docs/`, `.claude/`, tests, `tsconfig.json`, `vitest.config.ts`.
- `package.json` declares `engines.node >= 20.6.0` and `bin.little-coder`.
- README install section rewritten around the curl one-liner; troubleshooting updated for global install; new "Developing little-coder locally" section for contributors.

### Migration
Existing clones still work — `npm link` from the checkout keeps the legacy flow alive for anyone hacking on extensions. Benchmarks (`benchmarks/`) continue to expect the local checkout layout; they're dev-only and not affected by global install.

---

## [v0.1.27] — 2026-04-28

### GAIA validation-set result — **40.00 %** (66 / 165) on Qwen3.6-35B-A3B

First end-to-end run on GAIA, the agent-research benchmark from Mialon et al. (2023). 165-task validation set, scored locally with the GAIA-faithful scorer in `benchmarks/gaia_scorer.py`.

| Level | Pass | Count | Rate |
|---|---|---|---|
| L1 | 32 | 53 | 60.4 % |
| L2 | 32 | 86 | 37.2 % |
| L3 | 2 | 26 | 7.7 % |
| **Total** | **66** | **165** | **40.00 %** |

Same hardware as the prior runs: Qwen3.6-35B-A3B (UD-Q4_K_M, ~22 GB MoE) via `llama-server`, single RTX 5070 Laptop with 8 GB VRAM, expert weights kept in CPU RAM via `--n-cpu-moe 999`. Fully local, no cloud inference. The leaderboard submission (test split, 301 tasks) will follow as a separate release.

### Added — `benchmarks/gaia.py` (per-task GAIA runner)
Drives `pi --mode rpc` per task via the existing `PiRpc`. Loads the gated `gaia-benchmark/GAIA` parquet directly, stages any per-task attachment file into pi's cwd, and writes a leaderboard-shaped `submission.jsonl` plus per-task `transcript.txt` / `tool_calls.jsonl` / `notifications.txt` / `result.json` for post-hoc analysis. Resumable via `--resume` — long runs that get interrupted pick up from the most recent per-task `result.json`.

GAIA-shaped tool allow-list (`Read`, `Bash`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, the full `Browser*` family, the `Evidence*` family — no `Write` / `Edit`, GAIA tasks aren't authoring code) is wired through `LITTLE_CODER_ALLOWED_TOOLS` and pi's `--tools` filter.

### Added — `benchmarks/gaia_validate_submission.py` (pre-upload validator)
Mirrors the server-side checks in `gaia-benchmark/leaderboard/app.py::add_new_eval`: per-line JSON, `task_id` / `model_answer` keys, no duplicates, exact level counts (93 L1 / 159 L2 / 49 L3 for test, 53 / 86 / 26 for validation). On `--split validation --score`, also runs `gaia_scorer.score()` to compute the local expected number — produces the 66 / 165 figure above.

### Added — `benchmarks/gaia_status.sh` (live run readout)
GAIA-shaped counterpart to `tb_status.sh`. Reads each `<run>/<task_id>/result.json` + per-task `notifications.txt` + `tool_calls.jsonl`. Reports overall and per-level accuracy, per-task rate, ETA, tool-call breakdown, and aggregate extension activity (skill-inject, research-directive, finalize-warn, quality-monitor, turn-cap, etc.).

### Added — `.pi/extensions/finalize-warn`
New extension. Fires once per agent run at turn `(max_turns - 5 + 1)`, sending the model a follow-up user message reminding it to emit `Answer: <value>` before the cap aborts. Pi's `sendUserMessage(..., {deliverAs:"followUp"})` queues for the next user turn, so firing 5 turns before the cap (rather than 1 or 2) leaves the model real headroom after the message lands. Independent extension by design — the abort policy in `turn-cap` and the warn policy stay decoupled.

### Added — research-first directive in `skill-inject`
When the user prompt contains research-shaped keywords (`browse`, `online`, `research(ing)`, `look up`, `wikipedia`, `cite`, `citation`, `fact-check`, `google`, `webpage`, `website`, `search the / search for`, `web search`), `skill-inject` appends a `## Research-first directive` block at the end of the system prompt. The directive tells the agent to gather evidence via Browser + EvidenceAdd before producing a final answer, and to never go straight to Edit/Write or guess from memory. Placed last in the system prompt by design — small models show strong recency bias, and the per-task instruction is what we want freshest in their attention. Detected via a `looksLikeResearchTask()` regex set; benchmark-agnostic.

`skill-inject`'s INTENT_MAP also gained entries for research / browser / evidence keywords (`research`, `wikipedia`, `article`, `citation`, `cite`, `source`, `fact`, `factcheck`, `navigate`, `browse`, `page`, `click`) → BrowserNavigate / BrowserExtract / EvidenceAdd skill cards. Without these entries, on the opening turn of a research task the wrong skill cards (code-edit) could win the skill-token budget by intent-matching against incidental words.

### Added — `requiredTools` per benchmark in `benchmark-profiles`
`.pi/extensions/benchmark-profiles/index.ts` now publishes `requiredTools` on `systemPromptOptions.littleCoder` when `LITTLE_CODER_BENCHMARK` is set. For GAIA: `["BrowserNavigate", "BrowserExtract", "EvidenceAdd"]`. `skill-inject` reads this list and pre-seeds those tool names into its recency window, ensuring those skill cards are eligible for injection on turn 1 even before the agent has used them.

### Fixed — `skill-inject` allow-list filter race
Pi runs `before_agent_start` handlers in extension load order (alphabetical). `skill-inject` fires before `tool-gating`, so `lc.allowedTools` was undefined on the first turn, and skill cards for tools not in the benchmark's allow-list could win the skill-token budget. `skill-inject` now also reads `LITTLE_CODER_ALLOWED_TOOLS` directly as a fallback, so the filter is in effect from turn 1.

### Settings — GAIA `max_turns` 30 → 40
`.pi/settings.json` `little_coder.model_profiles.<model>.benchmark_overrides.gaia.max_turns` raised to 40 (both registered Qwen profiles). Matches the headroom needed for L2/L3 multi-hop research tasks.

### `.gitignore`
`benchmarks/gaia_runs/` added to the ignore list — per-run artifacts (transcripts, tool-call JSONLs, submission files) stay local and never enter git.

### Roadmap
Roadmap item 4 advances from *next* to **validation done — 40.00 %**. Test-split run + leaderboard submission to follow as a separate release.

No changes to existing extensions outside the additions above. Tests: 14 → 14 (no test deltas in the existing suite). All run on a consumer laptop, no cloud inference.

## [v0.1.26] — 2026-04-27

### Submitted — Terminal-Bench 2.0 leaderboard, PR #163 (Qwen3.5-9B at 9.21 %)
The full k=5 run from `tb2-leaderboard-k5-v0.1.24-9b-2026-04-26__20-32-42` has been submitted to the Terminal-Bench 2.0 leaderboard as PR #163 on the official `harborframework/terminal-bench-2-leaderboard` HF dataset.

- **Result**: **9.21 %** (41 / 445) — Qwen3.5-9B (Q4_K_M) via llama.cpp, fully on GPU on a single RTX 5070 Laptop with 8 GB VRAM. No cloud inference. `timeout_multiplier=1.0`, no overrides.
- **PR**: https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/163
- **Status**: bot-validation passed; awaiting maintainer review/merge → auto-import to https://www.tbench.ai/leaderboard/terminal-bench/2.0.
- **Trials**: 89 tasks × 5 trials = 445 total; per-task uniformity verified, single `task_checksum` per task confirmed.
- **Errored trials**: 8 / 445 with `exception_info` populated (Docker compose timeouts, agent timeouts). All have valid `result.json`; counted as failed per the leaderboard's bot rules.
- **Prompt**: v0.1.24 (the prompt-repetition fix that validated 4 / 4 on the `prove-plus-comm` pilot) — same prompt as the upcoming 35B-A3B re-run would use.
- **Companion to** [PR #158](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/158) (Qwen3.6-35B-A3B at 23.82 %, also still awaiting maintainer merge).

The capability gap on TB 2.0 between Qwen3.5-9B (Q4_K_M, ~5 GB) and Qwen3.6-35B-A3B (Q4_K_M, ~22 GB MoE) is **~14.6 pp** — much narrower than the Aider Polyglot baseline gap of ~33 pp. The 9B's per-token speed advantage on this hardware (~2× faster, fully on GPU vs the A3B's CPU-RAM-bound experts) doesn't translate to faster benchmark wall-clock — Docker setup + verifier overhead per trial dominates.

### README updates
- **Benchmark table**: the previously *in progress* v0.1.24 / Qwen3.5-9B row is now finalised — 9.21 % final, linked to PR #163.
- **Roadmap item 3** (Terminal-Bench 2.0): now reflects both submissions (35B-A3B PR #158 and 9B PR #163), both awaiting maintainer merge.

No code change in this release. Tests unchanged.

## [v0.1.25] — 2026-04-27

### Updated — README to reflect v0.1.24 prompt validation + 9B leaderboard run in progress
**v0.1.24's prompt-repetition hypothesis was validated.** The targeted `prove-plus-comm` k = 5 pilot finished **4 / 4** (manually stopped after 4 trials confirmed the signal) — vs the **0 / 1** death-spiral fail on v0.1.22 that triggered the whole investigation. Same task, same model (Qwen3.6-35B-A3B), same harness — only the system prompt's `# Available Tools / ## File & Shell` block + `Be concise. Lead with the answer.` guideline restored. The runaway-Python-loop pattern (~75 duplicate `Search (Nat.add_S_n).` lines) did not reappear in any of the 4 trials.

**Currently running**: a full TB 2.0 leaderboard run on **Qwen3.5-9B** (`tb2-leaderboard-k5-v0.1.24-9b-2026-04-26__20-32-42`) — the smaller dense model, fully on GPU at ~5.3 GB, ~2 × faster per-token than the 35B-A3B's CPU-RAM-bound MoE. Result so far: **~15.5 % at 251 / 445 trials**, ~8 pp behind the 35B-A3B's 23.82 % global. The capability gap is real but smaller than the Polyglot baseline gap (33 pp) suggested. The 9B run will be submitted to the [Terminal-Bench 2.0 leaderboard](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard) on completion as a separate entry from [PR #158](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/158) (the 35B-A3B submission).

### README updates
- **Benchmark table**: added a new row for v0.1.24 / Qwen3.5-9B / TB 2.0 — *in progress*, ~15.5 % at 251 / 445.
- **Roadmap item 3** (Terminal-Bench 2.0): now reflects both the 35B-A3B submission status and the in-progress 9B run.
- Roadmap item 4 (GAIA) is next per plan once the 9B run completes.

No code change in this release. Tests unchanged.

## [v0.1.24] — 2026-04-26

### Experimental — re-add `# Available Tools / ## File & Shell` block to AGENTS.md (hypothesis test)
The v0.1.22 leaderboard run was paused at 49 / 445 trials after `prove-plus-comm` (a Coq commutativity-proof task) flipped from a deterministic 5 / 5 in v0.1.18 to a deterministic 0 / 1 in v0.1.22. Inspecting the failed trial showed the agent went into a runaway-Python-script loop (~75 duplicate `Search (Nat.add_S_n).` lines in a single shell-arg, repeated bash heredoc EOF errors, `quality-monitor: empty_response` correction fired, hit `max_turns`).

My hypothesis: the v0.1.13-restored AGENTS.md included a `# Available Tools / ## File & Shell` section that was *intentionally* duplicative with pi's auto-generated `Available tools:` snippets — the same tool descriptions twice, in different framings. The v0.1.20 dedup removed that section as redundant; the v0.1.22 prompt-architecture removed pi's half too. By v0.1.22, **neither** copy of the tool-description block was present. Hypothesis: for small local models, this duplication was load-bearing for tool-use stability — and its absence is what enabled the runaway loop on `prove-plus-comm`.

This is consistent with Leviathan, Kalman, Matias (2025), [*Prompt Repetition Improves Non-Reasoning LLMs*](https://arxiv.org/abs/2512.14982): "*When not using reasoning, repeating the input prompt improves performance for popular models (Gemini, GPT, Claude, and Deepseek) without increasing the number of generated tokens or latency.*" The Qwen3.6-35B-A3B trials run with `thinking_budget: 3000` per `terminal_bench` profile, but the bulk of each turn is the model's non-reasoning tool-call selection — exactly the regime the paper is describing. The v0.1.13–v0.1.18 prompt's tool-description duplication appears to have been an accidental application of the same effect; deduplicating it stripped a reliability mechanism the leaderboard run was depending on.

This release re-adds the exact `# Available Tools / ## File & Shell` block from the v0.1.13 restore. Pi's base remains disabled (per v0.1.22's `--system-prompt @AGENTS.md --no-context-files` plumbing), so the section now appears once — but as the *full descriptive block*, not the one-liners pi's snippets used to provide.

### Added — concision guideline
One new bullet at the top of `# Guidelines`:

- `Be concise. Lead with the answer.` — restored from the pre-dedup AGENTS.md (was dropped in v0.1.20 as "duplicative with pi's `Be concise in your responses`"; pi's base is now gone, so this rule no longer exists anywhere in the prompt).

### Action: targeted pilot — `prove-plus-comm` only, k = 5
Instead of relaunching the full 445-trial leaderboard run, this version is being validated with a single-task k = 5 pilot on `prove-plus-comm`. Three outcomes possible:

- **5 / 5**: hypothesis strongly supported; promote v0.1.24 prompt to a full leaderboard re-run.
- **2–4 / 5**: hypothesis weakly supported; full run worth doing but with caveats.
- **0–1 / 5**: hypothesis falsified; revert and try something else.

No code change. Tests unchanged.

## [v0.1.23] — 2026-04-26

### Fixed — CHANGELOG inaccuracy in v0.1.22's scope claim
v0.1.22's entry stated the new `--system-prompt` / `--no-context-files` plumbing affects "every benchmark that uses `PiRpc` (Aider Polyglot, TB 1.0, TB 2.0, GAIA)". That overclaimed the reach: the published Aider Polyglot results (45.56 % at v0.0.2, 78.67 % at v0.0.5) were generated on the **pre-pi Python codebase**, before `PiRpc` existed at all. They predate this change and are not retroactively affected. The actual real-world scope is the Terminal-Bench harnesses (TB 1.0 + TB 2.0). Corrected the v0.1.22 entry's wording in the same commit; no behavioral or code change.

## [v0.1.22] — 2026-04-26

### Changed — `AGENTS.md` is now THE system prompt (not appended `# Project Context`)
Until now, every benchmark trial saw pi's hardcoded base prompt — `You are an expert coding assistant operating inside pi…` — followed by a long `Pi documentation (read only when the user asks about pi itself…)` block, *then* AGENTS.md appended underneath as `# Project Context / ## AGENTS.md`. Two identity lines back-to-back ("expert coding assistant" + "you are little-coder") and a docs block irrelevant to TB / Polyglot / GAIA tasks.

`benchmarks/rpc_client.py` (`PiRpc.__init__`) now spawns pi with **`--no-context-files --system-prompt <repo>/AGENTS.md`**, leveraging two pi mechanisms:

- **`--system-prompt <path>`** — pi's `resource-loader.js::resolvePromptInput` resolves an existing path to its file contents and uses that as `customPrompt`, which `system-prompt.js::buildSystemPrompt` then uses *instead of* the built-in base prompt.
- **`--no-context-files`** — disables auto-discovery of AGENTS.md / CLAUDE.md as project-context files, which would otherwise re-append AGENTS.md under the `# Project Context` wrapper a second time.

Result: pi's `You are an expert coding assistant…` opener is gone. The Pi documentation block is gone. AGENTS.md is the single, primary system prompt. The skill-inject `## Tool Usage Guidance` and knowledge-inject `## Algorithm Reference` extension blocks still append per agent-start, and pi's `Current date:` / `Current working directory:` tail still appends — those are useful and benign.

This affects the Terminal-Bench harnesses that use `PiRpc` (TB 1.0 via `benchmarks/tb_adapter`, TB 2.0 via `benchmarks/harbor_adapter`). The published Aider Polyglot results (45.56 % at v0.0.2, 78.67 % at v0.0.5) were on the pre-pi Python codebase and predate `PiRpc` entirely — not affected by this change. GAIA hasn't been run yet. For interactive `pi` use outside the benchmark harness, pi's default behavior is unchanged unless the user passes `--system-prompt AGENTS.md --no-context-files` themselves.

### Action: stopped v0.1.21 run, restarted as v0.1.22
The `tb2-leaderboard-k5-v0.1.21-2026-04-26__15-00-24` run was killed mid-flight (early progress, prompt-architecture change made the run no longer comparable). Archived to `archived-partial-runs/`. A fresh `tb2-leaderboard-k5-v0.1.22-*` run starts immediately on the new prompt-architecture.

No AGENTS.md content change in this release — only the spawn flags change in `rpc_client.py`. Tests unchanged.

## [v0.1.21] — 2026-04-26

### Restored — three operational rules dropped by the v0.1.20 dedup
The v0.1.20 dedup audit classified three items in the v0.1.13-restored AGENTS.md as "covered by pi's base prompt" and dropped them. Closer inspection of pi's *actual* per-tool `promptSnippet` strings (`node_modules/@mariozechner/pi-coding-agent/dist/core/tools/*.js`) showed that classification was wrong — these three rules are **not in pi's base** and were uniquely contributing to the v0.1.18 prompt that produced **23.82 %** on the TB 2.0 leaderboard. Observation: present in the higher-baseline prompt; absent from pi. Restoring them is expected to recover the operational signal lost in the dedup.

Restored:

1. **Edit's `replace_all` fallback.** Pi's edit snippet stops at "exact text replacement" with no failure-mode handling. The Write/Edit Runtime invariant now spells out: "If `old_string` appears multiple times in the file, pass `replace_all: true` or add more surrounding context to make the match unique."
2. **Read with line numbers before editing.** Pi's read snippet is just `Read file contents` — no instruction to *use* line numbers, even though pi's Read tool returns them. The link "line-number-precise reads → exact-match Edit" is little-coder-specific and was load-bearing for the v0.1.18 baseline.
3. **Absolute paths for file operations.** Pi says nothing about path style; "Show file paths clearly" is about *output formatting*, not operational use of absolute paths. Restoring the explicit rule.

Pi's actual tool snippets, for the record:

| tool | pi's `promptSnippet` |
|---|---|
| `read` | `Read file contents` |
| `write` | `Create or overwrite files` (note: **conflicts** with our refuse-on-exist invariant — flagged for a future fix in the provider extension, out of scope here) |
| `edit` | `Make precise file edits with exact text replacement, including multiple disjoint edits in one call` |
| `bash` | `Execute bash commands (ls, grep, find, etc.)` |
| `grep` | `Search file contents for patterns (respects .gitignore)` |
| `find` | `Find files by glob pattern (respects .gitignore)` |

Net length: ~38 lines (v0.1.20 dedup) → **~40 lines** (this restore). The dedup wins from v0.1.20 are kept (no re-introduction of the duplicative `# Available Tools` section, the duplicated "Be concise" / "Show file paths clearly" guidelines, or the conflicting "ask for clarification" line); only the three pi-doesn't-cover rules come back.

### Action: stopped the v0.1.20 run and relaunched as v0.1.21
The `tb2-leaderboard-k5-v0.1.20-2026-04-26__11-57-55` run was killed at trial 21 / 445 (~4.7 % done, accuracy tracking the v0.1.18 baseline at 5/21 = 23.8 %). Per the same rule that v0.1.13 invoked when the prompt changed mid-run — *the leaderboard requires a consistent prompt across all 5 × 89 = 445 trials* — partial-with-old-prompt-plus-new-trials-with-new-prompt would not be submittable. The v0.1.20 partial run is moved to `archived-partial-runs/`. A fresh run starts immediately as `tb2-leaderboard-k5-v0.1.21-*`.

No code, extension, or harness change in this release — only `AGENTS.md`. Tests unchanged.

## [v0.1.20] — 2026-04-26

### Changed — `AGENTS.md` deduplicated against pi's built-in system prompt
Inspecting `node_modules/@mariozechner/pi-coding-agent/dist/core/system-prompt.js:83-99` revealed that pi's built-in system prompt is always present at runtime, with `AGENTS.md` appended underneath as `# Project Context / ## AGENTS.md`. The two stack — they are not alternatives.

The v0.1.13-restored AGENTS.md (the full v0.0.5 SYSTEM_PROMPT_TEMPLATE revival) duplicated several things pi's base already covers, in different wording:

| pi's base says | v0.1.13 AGENTS.md *also* said |
|---|---|
| `Available tools: read / bash / edit / write` + benchmark schemas | A full "Available Tools" section listing Read / Write / Edit / Bash / ShellSession / Glob / Grep / WebFetch / WebSearch + Browser / Evidence |
| `Be concise in your responses` | "Be concise and direct. Lead with the answer." |
| `Show file paths clearly when working with files` | "Always use absolute paths for file operations." |

For small local models, redundant phrasings of the same rule act like distinct constraints — the model can over-fit to one wording or thrash between two. Empirically, the partial archived runs that used the *pre*-v0.1.13 simplified AGENTS.md trended higher on TB 2.0 (k=1: 36.84 % on 19/89 trials; k=5: 28.57 % on 104/445 trials) than the full-restore k=5 leaderboard run (23.82 % on 445/445). Sample sizes for the partial runs are noisy, but the direction is consistent enough to test on a like-for-like full 445-trial run.

This release rewrites `AGENTS.md` as a **delta over pi's base** rather than a re-implementation of it. Kept (little-coder-specific):

- Identity line (`You are little-coder, a coding agent specialized for small local language models.`)
- `# Capabilities & Autonomy` (autonomous-agent framing pi doesn't include)
- `# Runtime invariants` — Write-vs-Edit refusal invariant + Bash / ShellSession timeout guidance + benchmark-tool note (replaces the duplicative "Available Tools" section; keeps only the operational facts pi can't infer)
- `# Approaching complex tasks` and `# Handling ambiguity` (the deliberate-not-deliberation framing)
- `# Workspace discovery` (the spec-file/docs surface-once rule)
- `# Per-turn context augmentation` (load-bearing — explains the `## Tool Usage Guidance` and `## Algorithm Reference` injected blocks; pi cannot describe extensions it doesn't know about)
- `# Guidelines` — only items pi's base doesn't cover: prefer editing existing files, no unnecessary comments / docstrings / error handling, systematic multi-step work, conviction-not-deliberation + thinking-budget cap

Dropped (already covered by pi's base):

- The full Available Tools tool catalog (pi enumerates the available-tools section automatically with one-line snippets per tool)
- "Be concise and direct. Lead with the answer." (pi: `Be concise in your responses`)
- "Always use absolute paths for file operations." (pi: `Show file paths clearly`)
- "When reading files before editing, use line numbers to be precise." (pi: `Show file paths clearly` + the Read tool already returns line-numbered output)
- "If a task is unclear, ask for clarification before proceeding." (covered by the new `# Handling ambiguity` section)

Net length: ~50 lines (full v0.1.13 restore) → **~38 lines** (this dedup) → vs ~11 lines (pre-v0.1.13 simplified). The dedup keeps every behavioral nudge unique to little-coder while cutting redundant framing.

### Action: launching a full k=5 TB 2.0 run on the dedup'd prompt
A fresh `tb2-leaderboard-k5-*` run is launched against `terminal-bench@2.0` immediately after this commit. Result is the like-for-like comparator to the v0.1.18 submission (23.82 %, full v0.0.5 restore prompt) on the *same* dataset / model / scaffold / k. If the dedup wins, it becomes the going-forward default and the leaderboard submission is updated. If the v0.1.18 prompt wins on the full 445, the v0.0.5 restore is vindicated and stays.

No code, extension, or harness change in this release — only `AGENTS.md`. Tests unchanged.

## [v0.1.19] — 2026-04-26

### Updated — README to reflect the TB 2.0 leaderboard result
v0.1.18 recorded the submission in the changelog but left the README's benchmark table and Roadmap section still showing "in progress". This release fills both in:

- Benchmark table row (was `v0.1.9+ — in progress … Result —`) → now points to v0.1.13 (the prompt-fidelity release whose state actually produced the run, per `agent_info.version` in the trial `result.json` files), shows the **23.82 %** headline, and links to PR #158.
- Roadmap section item 3 (was "Terminal-Bench 2.0 — *in progress*") → now `done. 23.82 % … awaiting maintainer merge.`

No behavioral or code change. Tests unchanged.

## [v0.1.18] — 2026-04-26

### Submitted — Terminal-Bench 2.0 leaderboard, PR #158
The full k=5 run from `tb2-leaderboard-k5-2026-04-24__00-34-46` has been submitted to the Terminal-Bench 2.0 leaderboard as PR #158 on the official `harborframework/terminal-bench-2-leaderboard` HF dataset.

- **Result**: **23.82 %** (106 / 445) — Qwen3.6-35B-A3B via llama.cpp on a single RTX 5070 Laptop with 8 GB VRAM. No cloud inference. `timeout_multiplier=1.0`, no overrides.
- **PR**: https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/158
- **Status**: bot-validation passed; awaiting maintainer review/merge → auto-import to leaderboard at https://www.tbench.ai/leaderboard/terminal-bench/2.0.
- **Trials**: 89 tasks × 5 trials = 445 total; per-task uniformity verified, single `task_checksum` per task confirmed.
- **Errored trials**: 15 / 445 with `exception_info` populated (Docker compose image-pull timeouts, `AgentTimeoutError` at 1200/1800 s, `VerifierTimeoutError` at 900 s). All have valid `result.json`; counted as failed per the leaderboard's bot rules.
- **Submission package**: top-level `metadata.yaml` (`agent_url`, `agent_display_name="little-coder"`, `agent_org_display_name="Itay Inbar"`, model entry for `Qwen/Qwen3.6-35B-A3B` / provider `llamacpp`) + the run dir as the job-folder. The dataset's own `.gitignore` (`*.log`) auto-stripped per-trial agent/trial logs from the upload — `result.json` and `config.json` for every trial uploaded cleanly.
- **Agent version captured in trials**: `agent_info.version = "0.1.13"` — the version that was live when the run started (per the v0.1.13 prompt-fidelity restart noted earlier). The submission represents the v0.1.13 state, not later patch versions.

No code change in this release — only the changelog entry, recording the milestone.

## [v0.1.17] — 2026-04-25

### Removed — README pitch paragraph and outdated local whitepaper copy
- README's second paragraph (the "Frontier-coding-agent ergonomics for 5–25 GB models…" pitch) — redundant with the Substack link in the next paragraph and with the more detailed coverage further down (benchmark table, Roadmap, Architecture).
- `docs/whitepaper.md` — outdated local copy, prior version to the published Substack article. The Substack post (linked from the README and from `docs/architecture.md`) is the canonical version.
- Corresponding `whitepaper.md` entry in the README's Architecture file-tree.

No code change. Tests unchanged.

## [v0.1.16] — 2026-04-24

### Added — `browser-extract-retention` extension
New extension at `.pi/extensions/browser-extract-retention/` prunes raw `BrowserExtract` tool-results from conversation history on every turn. Keeps the **2 most-recent** extractions raw (the model may still be deciding what to `EvidenceAdd`), replaces older ones with a compact placeholder:

```
[BrowserExtract tool-result pruned — N chars originally extracted]
URL: https://…
Evidence saved from this extraction: e1 (note1); e2 (note2). Use EvidenceGet <id> to recall any snippet.
```

The placeholder walks message history backward to find the originating `BrowserNavigate` call (so the URL is cited accurately) and cross-references the session's Evidence store to list any saved snippets from that URL. Hooks the `context` event — non-destructive, fires before each LLM call.

**Why this matters.** On a GAIA trial reading several pages, the agent accumulates 20–40 KB of raw chunk text in context while separately distilling the relevant bits via `EvidenceAdd`. The raw text is redundant post-distillation and contaminates reasoning. The extension lets `BrowserExtract` behave like a working buffer that drains as evidence crystallizes — without dropping anything the model can still retrieve via `EvidenceGet`.

Measured on real Wikipedia content (`en.wikipedia.org/wiki/GAIA`, 3 extracts): **28.4 % context reduction (2253 chars saved)** from pruning 1 of 3 extracts at retention = 2. Savings compound linearly with extract count.

### Fixed — latent `page.evaluate` bug in `browser` extension
`.pi/extensions/browser/index.ts` was passing the Readability extraction script to Playwright as a *string* containing `() => { ... }`. Playwright evaluates strings as JavaScript expressions; a function literal evaluates to a function *value*, not an invocation, and serializes to `undefined` across the page/Node boundary. Both the primary and fallback paths had this bug, which meant `BrowserExtract` was silently returning empty text against some pages (and partial text on others, depending on Playwright version / page structure).

Replaced both `page.evaluate("() => {...}")` calls with real function references (`page.evaluate(readablePageText)`, `page.evaluate(fallbackPageText)`) so Playwright auto-invokes and the return value serializes correctly. Verified against real Wikipedia pages (Apollo_11, GAIA, Terminal_Bench) — all three now return > 2 KB of readable text.

### Tests
- `retention.test.ts` — 11 unit tests for `pruneMessages` + `buildPlaceholder` (URL walk-back, rank-from-end, already-pruned idempotency, evidence source matching, retain = 0 edge case, only-touches-BrowserExtract invariant).
- `live-integration.test.ts` — 3 tests running Playwright against live Wikipedia: baseline chunking, 3-extract GAIA-style trial with evidence, context-size measurement.
- Suite now **95 / 95 passing** (was 92 / 92); typecheck clean.

### Not touched
The in-flight TB 2.0 `k = 5` run (`tb2-leaderboard-k5-2026-04-24__00-34-46`, ~163 / 445 trials) continues on v0.1.15 — retention + browser fix apply only to future GAIA work, not to TB trials.

## [v0.1.15] — 2026-04-24

### Added — `llamacpp/qwen3.6-27b` registered for experimentation
Alibaba released Qwen3.6-27B (dense, 27 B params, 262 K ctx) on 2026-04-22 with claims of outperforming its own 397 B MoE flagship on agentic coding benchmarks. Added the model to the provider extension and settings.json so it's a one-flag switch for future experiments:

- `.pi/extensions/llama-cpp-provider/index.ts` — registers `llamacpp/qwen3.6-27b` alongside the existing A3B and 9B entries.
- `.pi/settings.json` — adds a `llamacpp/qwen3.6-27b` profile with the same `benchmark_overrides.terminal_bench` / `benchmark_overrides.gaia` shape as the A3B profile.

**35 B-A3B remains the benchmarking target.** Empirical sweep on 8 GB VRAM: the 27 B dense topped out at **5 tok/s** (Q3_K_XL, `-ngl 26`) — only ~28 % faster than the 4 tok/s Q4 baseline, and ~7 × slower than the 35 B-A3B's 38 tok/s. The MoE architecture of the A3B (35 B total / 3 B active, experts in RAM via `--n-cpu-moe 999`) is what makes a 35 B model viable on a laptop 8 GB GPU; a dense 27 B can't match it without ≥ 24 GB VRAM. The 27 B entry stays registered for users on larger hardware (or for future quant experiments), but all in-flight and upcoming benchmark runs use `llamacpp/qwen3.6-35b-a3b`.

### Operational note (not in git)
The paused TB 2.0 `k=5` run (`tb2-leaderboard-k5-2026-04-24__00-34-46`) was resumed via `harbor job resume` against the A3B server after the model sweep concluded. 158 / 445 trials were already done; resumption picks up at trial 159. No trial data was discarded.

No code change beyond the two file edits above. Tests unchanged.

## [v0.1.14] — 2026-04-24

### Added — Roadmap section in README
Adds a `## Roadmap` section to the README, positioned right after the benchmark-results table, explaining that the near-term focus is **benchmarking to map the impact radius** of the whitepaper's scaffolding — not new features. Sequenced as:

1. Aider Polyglot — done (45.56 % → 78.67 %)
2. Terminal-Bench-Core v0.1.1 — done (40.0 %)
3. Terminal-Bench 2.0 — in progress
4. GAIA — next (stresses the evidence-before-answer protocol on a non-coding benchmark)
5. SWE-bench Verified — after GAIA (longest-horizon multi-file patch test)

**Improvement experiments come after that baseline is in place**, targeting specific failure patterns the data will expose (thinking-budget behavior on long-horizon tasks, `deliberate.py`-style parallel branches on failure, interactive-process shell recovery).

No code or benchmark-harness changes. `benchmarks/tb_runs/` and `benchmarks/harbor_runs/` remain gitignored — the in-flight TB 2.0 run is unaffected.

## [v0.1.13] — 2026-04-24

### Fixed — system prompt fidelity
- **Restored the full v0.0.5 `SYSTEM_PROMPT_TEMPLATE` into `AGENTS.md`.** The port's original AGENTS.md was a ~12-line summary that omitted three load-bearing sections from the Python version: **Capabilities & Autonomy**, **Approaching complex tasks**, and **Handling ambiguity**. Pi's built-in system prompt covers generic coding-agent framing, but the little-coder-specific behavioral nudges — the ones whose wording was validated by the 78.67 % Polyglot run — were not carrying through.
- Sections not carried forward: the Python prompt's Multi-Agent, Memory, MCP, Skill (tool), Task-Management, and Plugin descriptions (those tools aren't shipped in the pi port). The Environment block (`date`, `cwd`, `platform`, `git_info`, `claude_md`) is also dropped because pi populates those in its own built-in prompt.
- Added v0.1.0-era additions the Python prompt didn't have: the Write-vs-Edit runtime invariant note, the per-turn context-augmentation explainer (so the model knows what the `## Tool Usage Guidance` and `## Algorithm Reference` blocks are), and the thinking-budget commit-to-implementation rule.

### Action: restarting the TB 2.0 leaderboard run
The `tb2-leaderboard-k5-*` run kicked off on 2026-04-23 was using the simplified AGENTS.md. Killing and relaunching so every trial uses the restored full prompt. ~12 h of compute is discarded; the submission requires a consistent prompt across all 5 × 89 = 445 trials, so partial-run-with-old-prompt-plus-new-trials-with-new-prompt wouldn't be submittable.

Same class of miss as v0.1.10's `benchmark-profiles` temperature bug: a whitepaper-era mechanism silently diverging from the published numbers. No code, extension, or benchmark-harness changes in this release — the only file that changes runtime behavior is `AGENTS.md`.

## [v0.1.12] — 2026-04-24

### Changed
- README opening now restores a direct pointer to the Substack whitepaper — *[Honey, I Shrunk the Coding Agent](https://open.substack.com/pub/itayinbarr/p/honey-i-shrunk-the-coding-agent)* — in the first two paragraphs, framed as "start there for the *why*; stay here for the *how*". v0.1.11's rewrite had relegated the paper link to the results table only; restoring it above the fold is more appropriate for a repo whose headline result comes from that paper.

No code or behavior change.

## [v0.1.11] — 2026-04-24

### Changed — README rewritten for the post-pi-migration audience
Community feedback after the pi port: new users weren't sure how to set little-coder up now that it's pi-based. This release rewrites the README around that concern, modeled after [pi.dev](https://pi.dev)'s terse, conversational style.

- **New lead**: one-sentence what-it-is + a "How it relates to pi" section that explains little-coder is `pi + 16 extensions + 30 skill markdown files + a Python benchmark harness` — not a fork, not a wrapper, just extensions on a plain `package.json` dependency.
- **Setup section reorganized** into clear steps: what-you'll-need → clone+install → serve a model (llama.cpp / Ollama / cloud) → run → (optional) benchmark. Each step does one thing.
- **New Troubleshooting section** for the failure modes new users actually hit: `pi: command not found`, `ECONNREFUSED 127.0.0.1:8888`, missing API-key env warning, extension load failures, benchmark harness not finding pi.
- **Results table** instead of loose paragraphs — each published benchmark number with its exact tag, model, dataset, and link to the per-benchmark write-up. Paper result (v0.0.2), Polyglot 78.67 % (v0.0.5), Terminal-Bench 1.0 40 % (v0.1.4), Terminal-Bench 2.0 (in progress).
- **Architecture diagram updated** to show both `tb_adapter/` and `harbor_adapter/` (TB 1.0 + 2.0), both pilot + status scripts, and the extension count bumped to 16 (evidence-compact now included).
- Citation / Attribution / License sections unchanged.

No code or behavior change. `benchmarks/tb_runs/` and `benchmarks/harbor_runs/` remain gitignored; in-flight run artifacts from the current TB 2.0 run are not included in this commit.

## [v0.1.10] — 2026-04-23

### Fixed — critical status-script reward-field bug
- **`benchmarks/harbor_status.sh` added** with the *correct* field path for harbor's reward schema.
- Harbor stores the verifier reward at **`verifier_result.rewards.reward`** in each trial's `result.json`. My initial inline status queries were looking at top-level `reward` and `parser_results[0].reward` — both of which are `None` in every harbor run. The result was **every in-flight status check reported 0 % accuracy**, regardless of actual passes.
- Concrete consequence during the 89-task TB 2.0 run: I reported "0 / 11 = 0.0 %" and later "0 / 19 = 0.0 %" when actual numbers were **7 / 19 = 36.8 %**. Passes including `prove-plus-comm`, `pytorch-model-cli` (which failed on TB 1.0 — an outright port win), `merge-diff-arc-agi-task`, and four others were silently labeled failures.
- The running TB 2.0 run itself is unaffected — only my reading of it was wrong. `reward.txt` in each trial dir has always had the correct 0/1 value.

`benchmarks/tb_status.sh` (TB 1.0) is unchanged — TB 1.0's `is_resolved` field lives at the top level and that schema was being read correctly.

## [v0.1.9] — 2026-04-23

### Fixed — version string drift
- `package.json` has been stuck at `"version": "0.1.0"` since the pi-port cut, despite tags advancing through v0.1.8. Bumped to **0.1.9** and will sync on future tags.
- `benchmarks/harbor_adapter/little_coder_agent.py::LittleCoderAgent.version()` hardcoded `"0.1.6"` — meant run metadata would misreport the agent version for any future TB 2.0 submission. Now reads dynamically from `package.json` at import time, so it auto-tracks the bumped package version. Falls back to `"unknown"` if the file can't be read.

No runtime behavior change; corrects the metadata that ends up in `result.json` / leaderboard submissions.

## [v0.1.8] — 2026-04-23

### Fixed
- **`benchmarks/harbor_runs/` is now gitignored.** v0.1.7's commit accidentally included ~50 KB of fix-git pilot output (configs, verifier outputs, reward files). Removed from tracking, added to `.gitignore` alongside the existing `benchmarks/tb_runs/` entry. No user-visible runtime behavior change.

## [v0.1.7] — 2026-04-23

### Fixed
- **`benchmarks/harbor_pilot.sh` flag name.** Used `--task-ids` (TB 1.0 convention) where harbor expects `--include-task-name` for per-task filtering from a registry dataset. v0.1.6 shipped with the wrong flag; this release fixes it.
- **Reproducibility note: v0.1.4 did not actually commit `.pi/settings.json`.** My v0.1.4 commit message claimed `max_turns` bumped from 25 to 40, but I forgot to stage the settings file — only the test that asserts `max_turns == 40` and the Python default (`LittleCoderAgent(max_turns=40)`) went in. The **TB leaderboard 40 % run did in fact use max_turns=40** (my local working file had the change and the running `pi` subprocess read it on launch), so the published result stands — but anyone cloning v0.1.4 and running `vitest` would have hit a test failure on a vanilla checkout. The settings.json change landed correctly in v0.1.6; from v0.1.6 onward the setting is committed-and-reproducible.

### Added — empirical verification of the TB 2.0 adapter
- Ran `benchmarks/harbor_pilot.sh fix-git` against `terminal-bench@2.0` (difficulty=easy, expert time 5 min): **reward 1.0, 1 m 50 s**. First real-task confirmation that:
  - harbor's agent discovery via `--agent-import-path benchmarks.harbor_adapter.little_coder_agent:LittleCoderAgent` works.
  - The async `environment.exec()` ↔ sync PiRpc reader-thread bridge via `asyncio.run_coroutine_threadsafe()` is functional.
  - Cwd tracking through the sentinel `pwd` append preserves stateful-shell semantics across tool calls.
  - pi extensions load cleanly in harbor's container environment.

## [v0.1.6] — 2026-04-23

### Added — Terminal-Bench 2.0 (harbor) adapter
little-coder can now run on the new **`terminal-bench@2.0`** dataset (89 tasks) via [harbor](https://github.com/laude-institute/harbor), the framework that replaced the `tb` CLI for TB 2.0. The TB 1.0 adapter (under `benchmarks/tb_adapter/`) is unchanged — it continues to target `terminal-bench-core@0.1.1` and remains the canonical path for the current leaderboard submission.

- **`benchmarks/harbor_adapter/little_coder_agent.py`** — subclasses `harbor.agents.base.BaseAgent`. Implements `name()`, `version()`, `setup()`, and async `run(instruction, environment, context)`. Reuses `benchmarks/rpc_client.py::PiRpc` verbatim — the only novelty is the ShellSession proxy:
  - TB 1.0 proxied `ShellSession` calls to `TmuxSession.send_keys(...)` (sync, pane-parsing).
  - TB 2.0 proxies to harbor's `BaseEnvironment.exec(...)` (async, stdout/stderr/return_code).
  - A new `_HarborShellProxy` class bridges PiRpc's sync reader-thread callback to the async `env.exec` via `asyncio.run_coroutine_threadsafe()` against the loop stashed in `run()`.
  - Stateful-cwd semantics matched by appending `pwd` to each invocation and tracking the result for the next call's `cd <cwd>` prefix.
- **`benchmarks/harbor_pilot.sh`** — pilot launcher (one or more task ids). Mirrors the shape of `tb_pilot.sh` but calls `harbor run --dataset terminal-bench@2.0 --agent-import-path ... --model ...`.
- README headline lists the TB 2.0 readiness alongside TB 1.0's 40 % result.

### Dataset & install notes (not committed, local-only)
- Install harbor: `uv tool install harbor` (binary ends up at `~/.local/bin/harbor`; version tested: 0.4.0).
- Download TB 2.0 tasks locally for inspection: `harbor dataset download terminal-bench@2.0` — 89 tasks, different layout from TB 1.0 (`task.toml` + `instruction.md` + `environment/` + `tests/` per task; no `.docs/instructions.md`). The download landed at `/home/itay-inbar/Documents/terminal-bench-2.0-tasks/` in my local setup.
- Task set is substantively different from v0.1.1 — no `hello-world`, new families (DNA assembly, compiler verification, kernel debugging, cobol-modernization, feal-cryptanalysis). Pilot-suitable easy candidates will emerge from the first runs.

### Pending before a submission run
- Empirical pilot on 3–5 TB 2.0 tasks to validate the async-exec proxy + cwd tracking under real tasks.
- Leaderboard submission URL / process for TB 2.0 (harbor docs don't yet specify — may differ from the TB 1.0 email-based path).

## [v0.1.5] — 2026-04-23

### Added — Terminal-Bench-Core v0.1.1 result documentation
- **little-coder on Terminal-Bench scored 32 / 80 = 40.0 %** on the full leaderboard-valid `terminal-bench-core@0.1.1` set. Single attempt per task, 6 h 50 min wall clock on an 8 GB RTX 5070 Laptop GPU.
- Run ID `leaderboard-2026-04-23__00-14-03`, executed with [`v0.1.4`](https://github.com/itayinbarr/little-coder/releases/tag/v0.1.4) commit `f4c1b4e`.
- Full write-up with passed/failed task breakdown, turn-cap analysis, extension-activity telemetry, thinking-budget correlation, and v0.2 levers: [`docs/benchmark-terminal-bench-v0.1.1.md`](docs/benchmark-terminal-bench-v0.1.1.md).
- README headline section now lists the TB result alongside the Polyglot headlines.

### Key empirical findings from the run
- The v0.1.4 `max_turns` bump (25 → 40) was empirically correct: cap-hits dropped from ~20 / 80 (projected at 25) to **8 / 80** at 40, and the 72 non-cap tasks passed at **43 %**.
- `skill-inject` fires on 71 / 80 tasks (first runtime-verified evidence that the error-recovery / recency / intent selection is actively engaging per turn — previously silent pre-v0.1.4).
- `thinking-budget` caps fired on 11 tasks — **all 11 failed**. Either selection bias (hard tasks think more, also fail more) or the 3000-token cap is cutting productive reasoning. The v0.2 experiment is to bump TB `thinking_budget` to 5000 and re-run.
- Quality-monitor corrections fired 57 times across 28 tasks, but none of the top-10-most-corrected tasks passed. On TB's long-horizon container debugging, mid-trajectory recovery is harder than on Polyglot.

### Known diagnostic gaps (for v0.2)
- `AgentResult.total_input_tokens` / `total_output_tokens` come through as `0` — the TB adapter doesn't forward pi-ai's usage reports. Cosmetic for leaderboard display but worth fixing.
- 12 failures were `agent_timeout` (harness wall clock), not `unset` (wrong answer) — these are tasks where turn count is fine but each turn is slow.
- `blind-maze-explorer-algorithm.*` (all three variants) failed despite passing the simpler `blind-maze-explorer-5x5` — candidate for a maze-search knowledge entry.

## [v0.1.4] — 2026-04-23

### Added — extension-activity observability
Extensions that were previously silent now emit `ctx.ui.notify` events per decision. The RPC client captures them, the TB adapter persists them per-task, and `tb_status.sh` aggregates them. This closes the diagnostic gap surfaced while the first leaderboard run was in flight — specifically, there was no way to confirm that `skill-inject`'s error-recovery priority was actually firing on failed tool calls.

- `skill-inject` — emits `skill-inject: +N [tool,tool,…]` whenever it injects; captures error-recovery vs recency vs intent selection for later analysis.
- `knowledge-inject` — emits `knowledge-inject: +N [topic,topic,…]` when a knowledge entry scores ≥ threshold and fits the budget.
- Existing `thinking-budget`, `quality-monitor`, `turn-cap`, `evidence-compact`, `output-parser` notify events were already there, now surfaced in the metrics.
- `benchmarks/rpc_client.py::PiRpc.notifications()` — new public method returning accumulated notify events.
- `benchmarks/tb_adapter/little_coder_agent.py` — writes a `=== pi notifications (N) ===` block to each task's `little_coder.log`.
- `benchmarks/tb_status.sh` — new `── metrics ──` section: tool calls per task (avg/median/min/max), turn-cap hits, tool breakdown, per-extension fire counts. Gracefully prints `N/A` for runs launched against pre-0.1.4 code.

### Changed — Terminal-Bench turn-cap: 25 → 40
`benchmark_overrides.terminal_bench.max_turns` raised from **25 to 40** in `.pi/settings.json`, and the default `LittleCoderAgent(max_turns=)` kwarg bumped to match.

Empirical basis: the first 10 tasks of the v0.1.1 leaderboard-valid run hit 25 calls in **5/10 cases** — all five were on failed tasks, strongly suggesting the cap (not the model) was the binding constraint. The 2 passes used 15 and 23 turns, both under 25 and well under 40. The new headroom costs nothing on passes and gives failing trajectories room to recover.

### Does not change
- `gaia` max_turns remains at 30 (different workload, different budget — revisit if GAIA fails similarly).
- Polyglot has no `max_turns` override (Python runs use pi's default, typically ~50).
- Tool schemas, protocol, environment-variable names, other benchmark_overrides fields.

## [v0.1.3] — 2026-04-22

### Added
- `benchmarks/tb_status.sh` — one-shot status dump for an in-flight Terminal-Bench run. Prints process health, elapsed/ETA, completed/remaining counts, current accuracy, per-task pass/fail list, and the currently in-flight container. Auto-detects the newest `leaderboard-*` or `full-*` run dir; accepts an explicit run-id as an argument or `RUN_ID` env var.

## [v0.1.2] — 2026-04-22

### Changed
- **Whitepaper link consolidated to Substack.** Every pointer that used to reference `docs/whitepaper.md` now points at the canonical published version: *[Honey, I Shrunk the Coding Agent](https://open.substack.com/pub/itayinbarr/p/honey-i-shrunk-the-coding-agent)*. The local `docs/whitepaper.md` stays in the repo as a historical artifact (git-based reproduction still works), but README, CHANGELOG `[v0.0.2]`, `docs/architecture.md`, `docs/benchmark-reproduction.md`, and the BibTeX `howpublished` field all direct readers to Substack.

### Community issues from the v0.0.x era — resolved by v0.1.0
The pi port addressed several open issues from the pre-0.1.0 Python codebase:
- [#2](https://github.com/itayinbarr/little-coder/issues/2) *"Unhandled errors when Ollama is not running + crash on accidental shell commands"* (advaitian). Both failure modes are gone in v0.1.0:
  - Provider connection errors (Ollama / llama.cpp unreachable) surface through pi-ai's typed error path and pi's TUI error rendering — no crash, clear message.
  - Accidental shell-command-as-prompt (`ls -alrt`) is sent to the model as ordinary input; pi treats it as a user message rather than executing. The explicit `!command` editor prefix is the opt-in shell channel.
- [#3](https://github.com/itayinbarr/little-coder/issues/3) *"Context handling with llama-server"* (cmhamiche). v0.0.x hardcoded context limits in `local/config.py`; v0.1.0 reads them from `.pi/settings.json`'s `little_coder.model_profiles.<provider>/<model>.context_limit`, which users can freely override (32 K default, 262 K is one settings edit away). Matches whatever `llama-server -c <N>` is serving.
- [#4](https://github.com/itayinbarr/little-coder/issues/4) *"multiple custom providers?"* (mpetruc). `pi.registerProvider()` composes — see `.pi/extensions/llama-cpp-provider/index.ts` in the repo, which registers both `llamacpp/*` and `ollama/*` in one file. Additional providers are added by extra `pi.registerProvider()` calls (or by dropping a `~/.pi/agent/models.json` entry, per pi's docs).

## [v0.1.1] — 2026-04-22

### Changed
- **Strip leftover `little-coder-pi` references.** The 0.1.0 cut had the working-name `little-coder-pi` leaking into a handful of cosmetic places. Everything now reads `little-coder`:
  - `AGENTS.md` H1.
  - `.pi/extensions/checkpoint/`: snapshot directory is now `~/.little-coder/checkpoints/<session>/` (was `~/.little-coder-pi/...`).
  - `.pi/extensions/extra-tools/`: `webfetch` User-Agent is now `little-coder/0.1`.
  - `.pi/extensions/browser/`: Playwright launcher User-Agent reads `Mozilla/5.0 (little-coder research agent)`.
  - `.pi/extensions/hello/`: startup notify message.
  - `benchmarks/tb_adapter/`: module docstring + per-task log filename (`little_coder.log`).
  - `benchmarks/rpc_client.py`, `benchmarks/aider_polyglot.py`: module docstrings.
  - `package-lock.json`: `name` field (package.json was already `little-coder`).
- **Terminal-Bench adapter display name.** `LittleCoderAgent.name()` already returned `little-coder` in 0.1.0 (the leaderboard (agent × model) pair is unaffected), but the adapter class docstring and log filename now match.

### Does not change
- Behavior. 81 TypeScript tests + 4 Python tests still pass, `tsc --noEmit` clean.
- Tool schemas, JSON protocol names, environment-variable names (`LITTLE_CODER_*`), or the whitepaper's mechanism contracts.
- Any in-flight long-running job: the leaderboard TB run launched under 0.1.0 loaded its extension code at startup and continues writing to the old checkpoint path for its lifetime — cosmetic only, checkpoints are best-effort and independent of task results.

## [v0.1.0] — 2026-04-22

### Changed — architecture port to pi
v0.1.0 is a ground-up port of the agent from a hand-rolled Python substrate (CheetahClaws/ClawSpring-derived) onto **pi** ([`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono) v0.68.1). pi provides the agent loop, multi-provider abstraction, TUI, compaction, session tree, and extension model; little-coder rebuilds every small-model mechanism on top of it as first-class pi extensions. The whitepaper's claim about scaffold-model fit is preserved — nothing that the paper or the v0.0.5 78.67 % run depended on is dropped.

**For reproducing the original paper result, check out tag [`v0.0.2`](https://github.com/itayinbarr/little-coder/releases/tag/v0.0.2) (commit `1d62bde`)** — the Python codebase that produced the 45.56 % mean is preserved at that tag. The 78.67 % headline is preserved at [`v0.0.5`](https://github.com/itayinbarr/little-coder/releases/tag/v0.0.5).

### Added — fifteen pi extensions under `.pi/extensions/`
- `llama-cpp-provider` — registers `llamacpp/*` and `ollama/*` as OpenAI-compat providers via `pi.registerProvider()`. `LLAMACPP_BASE_URL` / `OLLAMA_BASE_URL` env overrides.
- `write-guard` — overrides pi's built-in `write` tool with the exact Python `_write` refusal string, directing the model to `edit` on existing files.
- `extra-tools` — registers `glob`, `webfetch`, `websearch` (pi already ships `grep` and `find`).
- `skill-inject` — hooks `before_agent_start`, runs the 3-priority selector (error recovery > recency > intent, `_INTENT_MAP` exact port) and appends a `## Tool Usage Guidance` block within the configured token budget.
- `knowledge-inject` — scores algorithm cheat sheets against the user prompt (word=1.0, bigram=2.0, threshold=2.0); publishes `requires_tools` back onto `systemPromptOptions.littleCoder` so skill-inject can cross-reference.
- `output-parser` — exposes `repairJson` + `parseTextToolCalls` (fenced ``` ```tool ```/`json` ``` blocks, `<tool_call>` tags, bare JSON, trailing-comma/single-quote/missing-brace repair, JSON string newline re-escape). Hooks `turn_end` to detect text-embedded tool calls and nudge the model back onto native calling.
- `quality-monitor` — ports `assess_response` + `build_correction_message`. Detects empty responses, hallucinated tool names, repeated-call loops, and malformed-args sentinels; queues a correction via `pi.sendUserMessage({deliverAs: "followUp"})`, capped at 2 consecutive corrections.
- `thinking-budget` — counts `thinking_delta` chars per turn; at `ceil(chars/3.5) > budget` aborts the turn, flips `thinkingLevel` to `"off"`, and queues a "commit to an implementation" follow-up.
- `permission-gate` — ports `_SAFE_PREFIXES` bash whitelist (ls/cat/git log/status/diff, find, grep, rg, python, etc.). Blocks non-whitelisted bash in `auto`/`manual` mode; `accept-all` passes everything.
- `checkpoint` — first-write-wins file snapshots to `~/.little-coder/checkpoints/<session>/` before Write/Edit.
- `tool-gating` — execution-level enforcement of `LITTLE_CODER_ALLOWED_TOOLS` + publishes the list on `systemPromptOptions.littleCoder.allowedTools` so skill-inject filters its budget to the allowed subset.
- `turn-cap` — hard `max_turns` early-break via `turn_start` counter + `ctx.abort()`.
- `benchmark-profiles` — reads `.pi/settings.json`'s `little_coder.model_profiles` + `benchmark_overrides.{terminal_bench,gaia}` and publishes resolved values on `systemPromptOptions.littleCoder`; also sets `temperature` on the outgoing provider payload via `before_provider_request` (pi-ai defaults otherwise).
- `shell-session` — `ShellSession`/`ShellSessionCwd`/`ShellSessionReset` with two backends: **tmux-proxy** via `extension_ui_request` (the TB adapter routes commands back to the TB `TmuxSession`) and **subprocess** (`child_process.execSync`). Preserves ANSI-strip, 200-line head/tail truncation + duplicate-line collapse, `[exit=N cwd=… timed_out=…]` footer, pager neutralization.
- `browser` — Playwright-powered `BrowserNavigate`/`Click`/`Type`/`Scroll`/`Extract`/`Back`/`History` with per-session lazy `Page`, inlined Readability JS, 2 KB chunked extract with `{cursor, next, has_more}` footer, graceful degradation when Playwright isn't installed.
- `evidence` — `EvidenceAdd`/`Get`/`List` with per-session in-memory store, 1 KB snippet cap, UUID entry IDs.
- `evidence-compact` — on `session_compact` emits the `[Preserved evidence from earlier in the conversation follows.]` bridge follow-up with entry count. The Python version's `_PRESERVE_TOOL_NAMES` set is architecturally unnecessary in the TS port (evidence lives in extension state, not message history).

### Added — Python RPC harnesses (`benchmarks/`)
- `rpc_client.py::PiRpc` — spawns `pi --mode rpc --no-session` with explicit `-e <abs_path>` for every extension (pi's auto-discovery scans only `cwd/.pi/extensions/`, which fails when pi's cwd is an exercise directory). Demuxes events vs responses vs `extension_ui_request` on a reader thread; handles the TB shell-proxy sidecar. Passes pi's `--tools` flag when `allowed_tools` is set so tool *schemas* (not just execution) match the Python `_filtered_schemas()` behavior.
- `aider_polyglot.py` — Polyglot driver with per-language descriptors (Python wired, others copy verbatim from the v0.0.5 tag). Retry enabled by default. Results flushed atomically.
- `tb_adapter/little_coder_agent.py` — Terminal-Bench `BaseAgent` subclass, still Python, spawns `PiRpc(tb_mode=True, tb_shell_handler=...)` and proxies `__LC_TB_SHELL__` requests through a `_TmuxShellProxy` that ports the Python `_exec_tmux` staged-script sentinel-wrapper strategy verbatim.
- `gaia_scorer.py` — unchanged Python scorer.
- `smoke.py` + `test_rpc_client.py` — end-to-end smoke tester and pytest suite for the RPC client.

### Added — documentation
- `AGENTS.md` — pi's project system prompt (replaces Python `context.py`'s SYSTEM_PROMPT_TEMPLATE).
- `models.json` — reference/documentation copy of the provider registration; `.pi/extensions/llama-cpp-provider/` is the canonical source.
- `.pi/settings.json` — per-model profiles including `benchmark_overrides.terminal_bench` (`thinking_budget: 3000, max_turns: 25, temperature: 0.2`) and `benchmark_overrides.gaia` (`thinking_budget: 2000, max_turns: 30, temperature: 0.4, context_limit: 65536`).

### Removed
- The entire Python implementation: top-level `agent.py`, `tools.py`, `context.py`, `compaction.py`, `config.py`, `providers.py`, `theme.py`, `workspace.py`, `cloudsave.py`, `little_coder.py`, `demo.py`, `memory.py`, `skills.py`, `status_line.py`, `subagent.py`, `tool_registry.py`.
- Python subsystems: `local/`, `memory/`, `multi_agent/`, `skill/` (replaced by `skills/`), `mcp/`, `plugin/`, `modular/`, `task/`, `checkpoint/`, `voice/`, `video/`, `demos/`.
- Python tests under `tests/`, build files `pyproject.toml`, `requirements.txt`.
- Deliberately not ported (out of scope for 0.1.0): sub-agent spawn/manage (`multi_agent/`), MCP client (`mcp/`), persistent memory (`memory/`), task tracker (`task/`), plugin system (`plugin/`), voice input, cloud session sync. These were already peripheral to the whitepaper's result path; users who need them can check out `v0.0.5`.
- Deferred (not strictly a removal — a scope-cut for 0.1.0): `deliberate.py`-style parallel reasoning branches on failure. The pi port relies on `quality-monitor`'s correction follow-up path for between-turn recovery.

### Validation
- **TypeScript:** 81 unit tests across 11 files, `tsc --noEmit` clean.
- **Python:** 4 pytest tests covering PiRpc startup, extension enumeration, env propagation.
- **End-to-end on `llamacpp/qwen3.6-35b-a3b`** (same config as v0.0.5):

| Exercise | Difficulty | Port result | Python run1 baseline |
|---|---|---|---|
| affine-cipher | easy | pass_1 / 42.5 s | pass_1 / 120.6 s (−65 %) |
| bottle-song | moderate | pass_1 / 79.6 s | pass_1 / 127.2 s (−37 %) |
| book-store | hard-but-35B-passed | pass_1 / 73.9 s | fail / 734 s |
| pov | hard | fail / 131 s | pass_1 / 401 s |
| variable-length-quantity | hard | pass_1 / 109 s | pass_2 / 432 s (−4× attempt) |
| connect | hard | fail / 326 s | fail / 739 s |
| zipper | hard | **pass_1 / 130 s** | fail / 670 s |
| wordy | hard | pass_1 / 113 s | fail / 370 s |

Net **6 / 8 = 75 %** on a deliberately-hard subset vs Python run1's 4 / 8 = 50 %. Two exercises Python run1 failed (`zipper`, `wordy`) now pass; one (`pov`) remains a regression within stochastic-variance territory on a tree-rerooting edge case.

### Fixed — two regressions caught during validation
- **Temperature was not reaching the model.** `benchmark-profiles` resolved `profile.temperature = 0.3` but nothing set it on the pi-ai payload. Fixed by having `before_provider_request` **return** a new payload with temperature injected (mutating in place is discarded — pi only adopts returned values). The fix turned `zipper` from fail to pass_1.
- **Tool schemas weren't filtered by `_allowed_tools`.** `tool-gating` blocked execution but pi still presented all registered schemas to the model. Fixed by having `PiRpc` pass pi's `--tools` CLI flag when `allowed_tools` is set; execution-level blocking in the extension stays for defense in depth.

## [v0.0.5] — 2026-04-22

### Added
- **Full Aider Polyglot benchmark run on Qwen3.6-35B-A3B.** 225-exercise end-to-end run scoring **177 / 225 = 78.67 %** with `llamacpp/qwen3.6-35b-a3b` (Qwen3.6-35B-A3B UD-Q4_K_M, 22 GB) via llama.cpp on an 8 GB laptop GPU, no network calls. That's **+33.1 pp over the Qwen3.5 9B two-run mean** (45.56 %) and places little-coder well inside the public leaderboard's top-10 band.
- Per-language results: JavaScript 89.8 %, Python 88.2 %, C++ 84.6 %, Java 76.6 %, Go 74.4 %, Rust 53.3 %. Every language improved by at least +23 pp vs the Qwen3.5 9B baseline.
- 63 exercises flipped `fail → pass` vs both historical Qwen3.5 9B runs; only 4 regressed in the same sense (16 : 1 progression-to-regression ratio) — the improvement is systematic, not stochastic.
- Full write-up with per-language tables, retry-recovery analysis, exercise-level stability, persistent cross-language failures, tool-use metrics, and reproduction instructions: [`docs/benchmark-qwen3.6-35b-a3b.md`](docs/benchmark-qwen3.6-35b-a3b.md).
- Raw per-exercise results: [`benchmarks/results_full_polyglot_run3.json`](benchmarks/results_full_polyglot_run3.json).

### Setup notes for reproducing
- Model: `unsloth/Qwen3.6-35B-A3B-GGUF` `UD-Q4_K_M`
- Serving: llama.cpp built from source, CUDA 13.1, `-DCMAKE_CUDA_ARCHITECTURES=120` (Blackwell)
- Launch: `-ngl 99 --n-cpu-moe 999 --flash-attn on --jinja -c 32768 -t 16` — the `--n-cpu-moe 999` flag is the key VRAM trick (keeps expert weights in RAM; only attention + shared-expert occupy VRAM → fits the whole 35B in 8 GB GPU headroom).
- Agent config: default v0.0.4 little-coder profile for `qwen3.6-35b-a3b` in `local/config.py`, small-model optimizations ON, 32 K context, thinking budget 2048 tokens.
- Runtime: ~27 h cumulative wall-clock across the 225 exercises; sustained ~38 tokens/s during generation.

## [v0.0.4] — 2026-04-21

### Fixed
- `/config` REPL command crashed with `TypeError: Object of type function is not JSON serializable` when the in-memory config held any callable value. The display dict now skips callables and keys that start with `_` alongside the existing `api_key` filter. Reported and authored by [@advaitian](https://github.com/advaitian) in [#1](https://github.com/itayinbarr/little-coder/issues/1); applied in [e9d0bf8](https://github.com/itayinbarr/little-coder/commit/e9d0bf8).

## [v0.0.3] — 2026-04-20

### Added
- **llama.cpp provider** (`llamacpp/...`). `llama-server`'s `/v1/chat/completions` endpoint is a drop-in backend alongside Ollama — no new streaming code, it reuses the OpenAI-compatible path. Point at any loaded GGUF via the `llamacpp/<name>` model prefix. Default endpoint `http://localhost:8888/v1`, overridable with `LLAMACPP_BASE_URL` or `config["llamacpp_base_url"]`.
- **Qwen3.6-35B-A3B model profile** in `local/config.py`. The April 2026 Qwen sparse-MoE (35B total / 3B active, 256 experts, native 262K context) is now a first-class supported model.

### Benchmark result for v0.0.3
- On a consumer laptop (RTX 5070 Laptop 8 GB VRAM Blackwell, i9-14900HX, 32 GB RAM) with llama.cpp + `--n-cpu-moe 999`, `Qwen3.6-35B-A3B UD-Q4_K_M` runs at **38.55 tok/s** generation, **77.94 tok/s** prompt processing. This is comparable to dense-9B speeds despite 4× the parameter count, because MoE keeps compute proportional to the 3B active params while experts stream from RAM.
- The `python/book-store` exercise — which failed Qwen3.5 9B in both full polyglot runs reported in v0.0.2 — **passes on the first attempt** in 86.1 s with `llamacpp/qwen3.6-35b-a3b`. The model correctly identifies the non-obvious `(5, 3) → (4, 4)` grouping optimization (two groups of 4 at 20% off beat a group of 5 at 25% off plus a group of 3 at 10% off) that the greedy solution gets wrong.

### Changed
- `providers.py` header comment and provider list updated to include `llamacpp`.
- Built-in prefix auto-detection still recognises `qwen...` as the Alibaba DashScope cloud provider; use the explicit `llamacpp/` prefix to route a local Qwen GGUF to llama.cpp.

### Preserved
- **Ollama remains the default local backend**. No changes to `stream_ollama()`, its thinking-budget-cap mechanism, the Ollama provider entry, the auto-detect prefixes for `llama/mistral/phi/gemma`, the `/api/chat` streaming path, or `OLLAMA_BASE_URL` env handling. Existing `ollama/...` model IDs continue to work unchanged.
- All tool contracts (Read / Write / Edit / Bash / Glob / Grep / Skill / SubAgent) and the Write-vs-Edit invariant are unchanged.

### Setup pointers
- Build llama.cpp from source with CUDA support (on Blackwell set `-DCMAKE_CUDA_ARCHITECTURES=120`). Prebuilt releases may not yet include the Gated DeltaNet operators required by Qwen3.6.
- Launch `llama-server` with `-ngl 99 --n-cpu-moe 999 --flash-attn on --jinja` for the A3B model. The `--n-cpu-moe` flag keeps expert weights in RAM and puts only attention + shared expert on GPU — the trick that lets 35B total params run on 8 GB VRAM.
- See the provider docstring at the top of [`providers.py`](providers.py) for the full model-string grammar.

## [v0.0.2] — 2026-04-19

### Headline result
- `ollama/qwen3.5` (9.7B, 6.6 GB) + little-coder scored **45.56% mean (±0.94pp)** across two complete 225-exercise Aider Polyglot runs on a consumer laptop with no network calls. On the public leaderboard this sits above `gpt-4.5-preview` (44.9%) and `gpt-oss-120b high` (41.8%). A matched-model vanilla Aider baseline reached 19.11%.

### Initial public release
- Skill-augmented agent loop for small local models (gemma3, gemma4, qwen3, qwen3.5, qwen2.5, llama3.2, phi4-mini).
- Ollama provider with thinking-budget cap (stream-level token counting → abort at budget → retry with `think:false`) to prevent reasoning models from hanging on hard problems while preserving their partial reasoning.
- Multi-provider support (anthropic / openai / gemini / kimi / qwen / zhipu / deepseek / minimax / ollama / lmstudio / custom).
- 8 core tools + Write-vs-Edit tool invariant.
- Aider Polyglot benchmark harness (`benchmarks/aider_polyglot.py`) with per-language transforms, atomic resumable results, and per-run status dashboard.
- Full paper: [*Honey, I Shrunk the Coding Agent* on Substack](https://open.substack.com/pub/itayinbarr/p/honey-i-shrunk-the-coding-agent); two-run reproduction report at [`docs/benchmark-reproduction.md`](docs/benchmark-reproduction.md).
