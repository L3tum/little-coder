# Architecture Guide

little-coder is a launcher and extension bundle for the `pi` coding-agent runtime. The historical pre-pi Python design is preserved in Git history and release tags; this document describes the current TypeScript/pi architecture.

## Runtime flow

1. `bin/little-coder.mjs` is the CLI entry point.
2. It validates Node.js `>=22.19.0`, resolves the bundled `@earendil-works/pi-coding-agent` CLI, and builds an explicit pi argv.
3. It disables pi's automatic cwd extension/context discovery with `--no-extensions` and `--no-context-files`.
4. It loads the bundled `AGENTS.md`, appends a cwd `AGENTS.md` when it is a different file, discovers bundled `.pi/extensions/*/index.ts`, and loads pi-extension packages declared in `package.json` under `littleCoder.packages`.
5. It writes best-effort global pi settings under `~/.pi/agent` or `PI_CODING_AGENT_DIR` to suppress upstream startup noise.
6. It spawns pi with `process.execPath` and argv arrays rather than shell strings.

Subagent runs are detected with `LITTLE_CODER_SUBAGENT` or `PI_SUBAGENT_DEPTH`. In subagent mode, branding is skipped and stdio is piped so callers can capture output.

## Launcher helpers

`bin/launcher-helpers.mjs` contains the testable launcher primitives:

- `applySubAgentEnv(env)` sets quiet/offline subagent environment variables.
- `discoverBundledExtensionArgs(extDir, options)` enumerates bundled extensions and skips branding in subagent mode.
- `shouldAppendSystemPrompt(base, append)` avoids loading the same prompt twice, including symlink-equivalent paths.

## Extension model

Extensions live under `.pi/extensions/<name>/index.ts` and export a pi setup function. Most extensions register event handlers on the `ExtensionAPI`, add slash commands, or provide tools.

Important extension groups:

- **Prompt/context shaping**: `skill-inject`, `knowledge-inject`, `memory-context`, `thinking-budget`, `tool-gating`.
- **Safety and permissions**: `write-guard`, `read-guard`, `permission-gate`, `security`, `filter-read`.
- **Developer tools**: `extra-tools`, `lsp`, `codebase-memory-direct`, `evidence`, `evidence-compact`, `browser`, `browser-extract-retention`, `edit-custom`, `bash-cwd`.
- **Agent workflows**: `issue-agent`, `subagent`, `plan-mode`, `mode-commands`, `clear-command`.
- **UI/monitoring**: `powerline-footer-unified`, `usage-dashboard`, `quality-monitor`, `finalize-warn`, `inspect`, `branding`, `checkpoint`, `benchmark-profiles`, `llama-cpp-provider`.

Shared utilities that are used by multiple extensions belong under `.pi/extensions/_shared` or a focused extension-local module.

## Issue-agent and subagents

`issue-agent` coordinates GitHub/Forgejo issue work:

- discovers labeled issues and PRs,
- checks model availability before spawning work,
- checks out worktrees under the configured workdir,
- runs a subagent through `.pi/extensions/subagent/runner.ts`,
- posts plans, execution summaries, PR reviews, and state-label transitions.

The issue-agent uses labels as its durable state machine. Global in-process variables are used only for the currently running queue loop and active work item.

## Benchmarks

Benchmark integration lives under `benchmarks/`.

- Python adapters spawn pi in RPC mode.
- `benchmarks/test_rpc_client.py` is an optional Python/pytest smoke suite for RPC startup and extension propagation.
- Benchmark-specific profile overrides are stored in `.pi/settings.json` and implemented by `benchmark-profiles`.

## Postinstall patches

`scripts/patch-extension-notifications.mjs` patches selected third-party extension files under `node_modules` after install. This is intentionally covered by tests because upstream package updates can invalidate exact text replacements.

When dependencies are updated, run:

```sh
npm test
npm run typecheck
```

and inspect patch test failures before publishing.

## Validation checklist

Before release or broad refactors:

```sh
npm test
npm run typecheck
node bin/little-coder.mjs --help
```

The optional Python benchmark smoke tests require `pytest`:

```sh
python3 -m pytest benchmarks/test_rpc_client.py -q
```
