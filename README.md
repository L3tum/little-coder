# little-coder

**A coding agent tuned for small local models, built on top of [pi](https://pi.dev).**

![little-coder startup view](docs/assets/startup.svg)

The research story behind all this — why scaffold–model fit matters, how a 9.7 B Qwen beat frontier entries on Aider Polyglot, and what the load-bearing mechanisms actually do — is written up on Substack: **[*Honey, I Shrunk the Coding Agent*](https://open.substack.com/pub/itayinbarr/p/honey-i-shrunk-the-coding-agent)**. Start there if you want the "why"; stay here for the "how".

## How it relates to pi

[pi](https://pi.dev) is the minimal substrate — agent loop, multi-provider API, TUI, session tree, compaction, extension model. Four built-in tools (read / write / edit / bash) and a ~1000-token system prompt.

little-coder is **pi + 20 extensions + 30 skill markdown files + a Python benchmark harness**. It doesn't fork pi or shadow its CLI — pi is a plain dependency in `package.json`, and everything little-coder-specific lives under `.pi/extensions/`, `skills/`, and `benchmarks/`. You can mix little-coder with pi packages from anyone else, add your own extensions, or disable ours per-project via `.pi/settings.json`.

If you've never used pi, it's useful to skim [pi.dev](https://pi.dev) first — the rest of this doc assumes pi's model of `--agent-import-path`, `--mode rpc`, and `.pi/extensions/` auto-discovery.

## Install

One-line install (Node.js 22.19+ required):

```bash
curl -fsSL https://raw.githubusercontent.com/itayinbarr/little-coder/main/install.sh | bash
```

Or with npm directly:

```bash
npm install -g little-coder
```

Or with [bun](https://bun.sh):

```bash
bun add -g little-coder
```

That's the whole install. No clone, no `npm install` in a workspace, no PATH fiddling. `little-coder` is now on your PATH and works from any directory.

> **Note for `bun add -g` users.** The launcher (`bin/little-coder.mjs`) is a Node.js script with `#!/usr/bin/env node` at the top, so Node ≥ 22.19 still has to be on your PATH for the binary to start — bun is fine for installing/updating the package, but the runtime is Node. If you want a fully node-less setup, replace the shebang in `$(bun pm bin -g)/little-coder` with `#!/usr/bin/env bun`.

## Run

```bash
cd ~/your-project
little-coder --model llamacpp/qwen3.6-35b-a3b
```

This is the canonical setup little-coder is tuned for: a local llama.cpp server hosting Qwen3.6-35B-A3B. See **[Local model setup (optional)](#local-model-setup-optional)** below for how to serve it.

Cloud models work the same way:

```bash
little-coder --model anthropic/claude-haiku-4-5
little-coder --model openai/gpt-4o-mini "What does this codebase do?"
little-coder --model ollama/qwen3.5             # local Ollama
little-coder --model lmstudio/local-model       # local LM Studio (whatever model you have loaded)
little-coder --list-models                      # see everything pi knows about
```

The agent uses the directory you launched it from as its working directory — `read` / `write` / `edit` / `bash` operate on your project, not on little-coder's install path.

In the TUI you can use `/tools` to list loaded tools and `/skills` to list available skills. The agent can also call `tools`, `skills`, and `enableBrowserTools` directly.

For local providers (llama.cpp, Ollama, LM Studio) pi expects *some* value in the API-key env even though local servers ignore it:

```bash
export LLAMACPP_API_KEY=noop
export OLLAMA_API_KEY=noop
export LMSTUDIO_API_KEY=noop
```

`LLAMACPP_BASE_URL`, `OLLAMA_BASE_URL`, and `LMSTUDIO_BASE_URL` override the defaults (`http://127.0.0.1:8888/v1`, `http://127.0.0.1:11434/v1`, `http://127.0.0.1:1234/v1`).

For cloud providers, set the standard env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) and pi will discover it.

## Local model setup (optional)

Skip this section if you're using a cloud model.

**Option A — llama.cpp** (fastest for local; supports Qwen3.6-35B-A3B MoE):

```bash
# One-time: build llama.cpp with CUDA (sm_XXX = your GPU arch; Blackwell = 120)
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120 -DLLAMA_CURL=ON
cmake --build build --config Release -j

# Fetch the model GGUF and the matching vision projector.
# The mmproj (~900 MB) is what lets the model see attached screenshots.
pip install -U "huggingface_hub[cli]"
hf download unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-Q4_K_M.gguf --local-dir ~/models
hf download unsloth/Qwen3.6-35B-A3B-GGUF mmproj-F16.gguf            --local-dir ~/models

# Serve it (MoE trick: experts in RAM, attention on GPU → 22 GB model on 8 GB VRAM)
build/bin/llama-server -m ~/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf \
   --mmproj ~/models/mmproj-F16.gguf \
   --host 127.0.0.1 --port 8888 --jinja \
   -c 16384 -ngl 99 --n-cpu-moe 999 --flash-attn on
```

If you only need text and want to skip the projector download, drop the second `hf download` line and the `--mmproj` flag — little-coder still works text-only, but the TUI's image attachment will be rejected by the server with a 4xx.

**Option B — Ollama** (simpler, but slower on MoE):

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3.5        # 9.7B — the paper's model
# or: ollama pull qwen3.6-35b-a3b
```

**Option C — LM Studio** (GUI; OpenAI-compatible server on port 1234):

1. Install [LM Studio](https://lmstudio.ai/) and download a model (e.g. Qwen3.6 35B A3B GGUF).
2. Open the **Developer** / **Local Server** tab, load the model, and click **Start Server** (default `http://127.0.0.1:1234`).
3. Run little-coder:
   ```bash
   export LMSTUDIO_API_KEY=noop
   little-coder --model lmstudio/local-model
   ```
   The shipped `lmstudio/local-model` id routes to whatever model LM Studio currently has loaded — no extra config needed for the single-model case. If you serve on a non-default port, set `LMSTUDIO_BASE_URL=http://127.0.0.1:<port>/v1`. To target a specific model when you have several loaded, add an entry to `~/.config/little-coder/models.json` (see **Configuring models** below).

**Serving from another machine on your LAN.** Each provider's `*_BASE_URL` env var accepts any host, not just `127.0.0.1`, so you can run inference on a beefier box and connect from a laptop or another device on the same WiFi.

On the **server** (the box with the GPU):

- *llama.cpp*: start `llama-server` with `--host 0.0.0.0` (or your specific LAN interface) instead of `127.0.0.1`. Everything else from Option A unchanged.
- *LM Studio*: in the Server tab, enable **Serve on local network** so it binds `0.0.0.0:1234` instead of `127.0.0.1:1234`.
- *Ollama*: `OLLAMA_HOST=0.0.0.0:11434 ollama serve` (or set `OLLAMA_HOST=0.0.0.0` in the user systemd unit).
- If `ufw` / `firewalld` is active, allow your LAN subnet to the relevant port (e.g. `sudo ufw allow from 192.168.0.0/16 to any port 8888 proto tcp`).
- Find the LAN IP with `hostname -I` (Linux) or `ipconfig getifaddr en0` (macOS).

On the **client** (the machine running little-coder):

```bash
# Pick the env vars matching whichever provider is running on the server
export LLAMACPP_API_KEY=noop
export LLAMACPP_BASE_URL=http://<server-lan-ip>:8888/v1

# Sanity check reachability before launching the agent
curl -s http://<server-lan-ip>:8888/v1/models | head

little-coder --model llamacpp/qwen3.6-35b-a3b
```

The streaming chat-completions adapter works over a local network the same way it does over loopback — no client code change, no proxy needed. The per-model profile in `.pi/settings.json` (context/thinking-budget/temperature) still applies because it's keyed by `<provider>/<model-id>`, which the client picks regardless of where the server lives.

All small-model-specific extensions auto-disable for large/cloud models so they don't interfere.

---

## Configuring models

The shipped model list lives in **`models.json`** at the package root. The `llama-cpp-provider` extension reads it at startup and registers each provider via pi's `registerProvider()`. Editing this file in your global install **does** take effect — but it's overwritten on `npm install -g little-coder@latest`, so for anything you want to keep, use a user override file instead.

User override resolution (first match wins):

1. `$LITTLE_CODER_MODELS_FILE` — explicit path, useful for ad-hoc tests.
2. `$XDG_CONFIG_HOME/little-coder/models.json`
3. `~/.config/little-coder/models.json`

Merge semantics: each top-level provider key in your override file **fully replaces** the same key in the shipped `models.json`. Providers only in your file are added; providers only in the shipped file are kept. (We don't deep-merge per-model fields — you redeclare the whole provider entry, which avoids "your override silently inherited new fields from a future package release" surprises.)

Example — switch the llama.cpp port and bump `qwen3.6-35b-a3b` to a 150K context, leave ollama untouched:

```json
{
  "providers": {
    "llamacpp": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "apiKey": "LLAMACPP_API_KEY",
      "models": [
        {
          "id": "qwen3.6-35b-a3b",
          "name": "Qwen3.6-35B-A3B (local llama.cpp, 150K)",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 150000,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Then verify with `little-coder --list-models` — you should see your overridden entry.

`LLAMACPP_BASE_URL`, `OLLAMA_BASE_URL`, and `LMSTUDIO_BASE_URL` env vars still beat both files for those three providers.

`.pi/settings.json` is a separate concern: it controls per-model **profiles** (context_limit, thinking_budget, temperature, benchmark_overrides) referenced by the `<provider>/<id>` key. Profiles don't register or describe models — they only tune how little-coder runs against models that are already registered.

---

## Permissions

little-coder gates `Bash` tool calls against a built-in safe-prefix whitelist (`ls`, `cat`, `head`, `tail`, `git log/status/diff`, `find`, `grep`, `cp`, `mv`, `mkdir`, `touch`, etc.) before pi's own confirmation flow ever sees them. `rm` and `sudo` are intentionally not on the list — add them via `LITTLE_CODER_BASH_ALLOW` per deployment if you really need them.

Two env vars control the gate:

| Env var | Values | Effect |
|---|---|---|
| `LITTLE_CODER_PERMISSION_MODE` | `auto` *(default)* / `accept-all` / `manual` | `auto`: block any bash command not on the whitelist. `accept-all`: skip the gate entirely, every bash call passes (the benchmark runner sets this). `manual`: same as `auto` but with a different rejection message. |
| `LITTLE_CODER_BASH_ALLOW` | comma-separated prefixes | Extra allow-prefixes merged with the built-in list. **Trailing whitespace is meaningful**: `"make "` allows `make test` but not `makefoo`; `"make"` allows both. |

Examples:

```bash
# Add 'make' (with word-boundary) and 'docker compose ps' on top of the defaults
export LITTLE_CODER_BASH_ALLOW="make ,docker compose ps"

# Skip the gate entirely (use this only inside controlled environments)
export LITTLE_CODER_PERMISSION_MODE=accept-all
```

Write/Edit confirmations are pi's responsibility; little-coder doesn't intercept those.

---

## Paper / benchmark results

| Release | Model | Benchmark | Result |
|---|---|---|---|
| [**v0.0.2**](https://github.com/itayinbarr/little-coder/releases/tag/v0.0.2) (commit `1d62bde`) — the paper | Qwen3.5-9B via Ollama | Aider Polyglot (225 exercises) | **45.56 %** mean of two runs; matched-model vanilla Aider baseline 19.11 %. Paper: [*Honey, I Shrunk the Coding Agent* on Substack](https://open.substack.com/pub/itayinbarr/p/honey-i-shrunk-the-coding-agent). |
| [**v0.0.5**](https://github.com/itayinbarr/little-coder/releases/tag/v0.0.5) — pre-pi Python | Qwen3.6-35B-A3B via llama.cpp | Aider Polyglot | **78.67 %**. [Full narrative](docs/benchmark-qwen3.6-35b-a3b.md). |
| [**v0.1.4**](https://github.com/itayinbarr/little-coder/releases/tag/v0.1.4) — on pi | Qwen3.6-35B-A3B via llama.cpp | Terminal-Bench-Core v0.1.1 (80 tasks) | **40.0 %** in 6 h 50 min. [Write-up](docs/benchmark-terminal-bench-v0.1.1.md). |
| [**v0.1.13**](https://github.com/itayinbarr/little-coder/releases/tag/v0.1.13) — on pi, TB 2.0 leaderboard | Qwen3.6-35B-A3B via llama.cpp | Terminal-Bench 2.0 (89 tasks × 5 trials = 445) | **24.6 % ± 3.2** — accepted to the [Terminal-Bench 2.0 leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.0) (rank 120). |
| [**v0.1.24**](https://github.com/itayinbarr/little-coder/releases/tag/v0.1.24) — on pi, TB 2.0 leaderboard, smaller model | Qwen3.5-9B (Q4_K_M) via llama.cpp (5.3 GB on GPU, 2× faster per-token than the 35B-A3B) | Terminal-Bench 2.0 (89 tasks × 5 trials = 445) | **9.2 % ± 2.4** — accepted to the [Terminal-Bench 2.0 leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.0) (rank 142). |
| [**v0.1.27**](https://github.com/itayinbarr/little-coder/releases/tag/v0.1.27) — on pi, GAIA validation | Qwen3.6-35B-A3B via llama.cpp | GAIA validation set (165 tasks) | **40.00 %** (66 / 165). L1 60.4 % / L2 37.2 % / L3 7.7 %. Test-split run pending. |

All runs used a consumer laptop: i9-14900HX, 32 GB RAM, **8 GB VRAM** on RTX 5070 Laptop (Blackwell). No cloud inference at any point.

---

## Roadmap

**Phase 1 — wide benchmark baseline: complete.** The paper established that scaffold–model fit moves a 9.7 B model from 19 % to 45 % on Aider Polyglot, and the goal of Phase 1 was to find out how wide that impact radius is. We now have a four-benchmark baseline on a single laptop-class GPU:

1. **Aider Polyglot** — 45.56 % (paper, Qwen3.5-9B) and 78.67 % (v0.0.5, Qwen3.6-35B-A3B).
2. **Terminal-Bench-Core v0.1.1** — 40.0 % (v0.1.4).
3. **Terminal-Bench 2.0** — accepted to the [official leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.0): Qwen3.6-35B-A3B at **24.6 % ± 3.2** (rank 120) and Qwen3.5-9B at **9.2 % ± 2.4** (rank 142). The v0.1.24 prompt-repetition fix (re-add tool descriptions + concision guideline, validated by a 4 / 4 pilot on the previously-regressing `prove-plus-comm` task) was the prompt for both submissions.
4. **GAIA** — validation set at v0.1.27: **40.00 %** (66 / 165) on Qwen3.6-35B-A3B. Per-level L1 60.4 % / L2 37.2 % / L3 7.7 %.

That spans short coding exercises (Polyglot), interactive shell-bound tasks (Terminal-Bench), and tool-using research (GAIA), all on the same scaffold. The data needed to choose what to fix next is now in hand.

**Phase 2 — iterative improvement on real-world tasks: starting now.** The motivating question shifts from *how wide is the impact radius?* to *which scaffolding changes compound on long-horizon real work?* The signal we have already points at concrete things to try — thinking-budget / quality-monitor behavior on long-horizon tasks, deliberate.py-style parallel branches on failure, better shell-session recovery for interactive-process traps, evidence-handling on multi-document GAIA L3 tasks — but the priority order comes from real-world use, not from a benchmark suite. Expect smaller, more frequent releases driven by what little-coder actually struggles with on day-to-day coding work.

**Future benchmarks (deferred).** New benchmarks like **ProgramBench**, SWE-bench Verified (multi-file real-world patches), and a GAIA test-split run come back into scope after Phase 2 has produced enough scaffolding signal to make a fresh measurement worth running. Re-benchmarking before the next round of changes lands would mostly re-measure the same baseline.

---

## Troubleshooting

**`little-coder: command not found`** — npm's global bin directory isn't on your PATH. Run `npm config get prefix` to see where it installed; add `<prefix>/bin` to your PATH. Or reinstall with `sudo` if your prefix needs root.

**`ECONNREFUSED 127.0.0.1:8888`** — llama.cpp isn't running. Start `llama-server` first, or switch `--model` to an Ollama/cloud ID.

**LAN client times out (no `RST`, just hangs)** — the inference box's firewall is dropping the SYN. The usual cause is `ufw` with a default-deny policy that allow-lists only SSH / a few dev ports. From the server: `sudo ufw status verbose` to confirm; `sudo ufw allow from <your-lan-subnet>/24 to any port 8888 proto tcp` to fix (scoped to the LAN so you're not exposing the box). Docker-published ports bypass `ufw` via `PREROUTING` NAT, which is why a Docker container can be reachable while a plain `llama-server` on the same host isn't.

**Image attachment is accepted but the request returns 4xx** — your llama-server is running without a vision projector. Re-launch it with `--mmproj ~/models/mmproj-F16.gguf` (or another mmproj variant from the same GGUF repo). The `--list-models` `images` column reflects what the client *will attempt to send*, not what the server can answer; the projector is what gives the model eyes.

**No API key env var warning** — pi expects *some* key even for local providers. Export `LLAMACPP_API_KEY=noop` (or `OLLAMA_API_KEY=noop`) before launching.

**No pi "Update Available" banner** — that's intentional. little-coder defaults `PI_SKIP_VERSION_CHECK=1` so the bundled pi runtime doesn't nag about updating itself; little-coder pins pi to a known-good version per release. If you actually want the banner back, `export PI_SKIP_VERSION_CHECK=0` before launching.

**Extension load failures on startup** — run `little-coder --list-models --verbose`; extension errors surface there. If the install looks corrupt: `npm uninstall -g little-coder && npm install -g little-coder`.

**Node version too old** — little-coder needs Node ≥ 22.19.0 (matching the minimum of the bundled `@earendil-works/pi-coding-agent` v0.75+). Check with `node --version`. Easiest fix: `nvm install 22 && nvm use 22`.

---

## Developing little-coder locally

If you want to hack on the extensions or skills:

```bash
git clone https://github.com/itayinbarr/little-coder.git
cd little-coder
npm install
npm link            # makes the local checkout available as `little-coder`
little-coder --model llamacpp/qwen3.6-35b-a3b
```

To unlink: `npm unlink -g little-coder`.

The benchmarks harness (`benchmarks/`) is dev-only and not shipped with the npm package. Run it from a clone with `python3 benchmarks/aider_polyglot.py …` etc.

---

## Architecture

```
little-coder/
├── .pi/
│   ├── settings.json               # per-model profiles + benchmark_overrides (terminal_bench, gaia)
│   └── extensions/                 # 21 TypeScript extensions, auto-discovered by pi
│       ├── branding/               # little-coder startup header + terminal title (replaces pi's built-in)
│       ├── llama-cpp-provider/     # data-driven provider registration from models.json — ships llamacpp, ollama, lmstudio (+ user override file)
│       ├── write-guard/            # Write refuses on existing files; rewrites root-bare /foo.md paths to cwd
│       ├── extra-tools/            # glob, webfetch, websearch (pi ships grep/find)
│       ├── skill-inject/           # per-turn tool-skill selection (error > recency > intent)
│       ├── knowledge-inject/       # algorithm cheat-sheet scoring (word=1.0, bigram=2.0, threshold=2.0)
│       ├── output-parser/          # repair malformed ```tool, <tool_call>, bare JSON
│       ├── quality-monitor/        # empty / hallucinated / loop detection + correction follow-up
│       ├── thinking-budget/        # cap thinking tokens per turn, retry with thinking off
│       ├── permission-gate/        # bash whitelist (ls, cat, git log/status/diff, etc.)
│       ├── checkpoint/             # snapshot files before Write/Edit
│       ├── tool-gating/            # enforces _allowed_tools at exec + schema levels
│       ├── turn-cap/               # max_turns abort (Polyglot unbounded, TB 40, GAIA 30)
│       ├── benchmark-profiles/     # reads settings.json → systemPromptOptions + sets temperature
│       ├── shell-session/          # ShellSession[Cwd|Reset] — tmux-proxy + subprocess backends
│       ├── browser/                # Playwright BrowserNavigate/Click/Type/Scroll/Extract/Back/History
│       ├── evidence/               # EvidenceAdd/Get/List — per-session store, 1 KB snippet cap
│       └── evidence-compact/       # preserves evidence across pi's auto-compaction
├── skills/                         # 30 markdown files the extensions inject on demand
│   ├── tools/*.md                  #   14 tool-usage cards
│   ├── knowledge/*.md              #   13 algorithm cheat sheets
│   └── protocols/*.md              #    3 research/cite/decomposition workflows
├── benchmarks/
│   ├── rpc_client.py               # PiRpc — spawns `pi --mode rpc`, demuxes events + UI requests
│   ├── aider_polyglot.py           # Polyglot driver with per-language transforms
│   ├── tb_adapter/                 # Terminal-Bench 1.0 BaseAgent (tmux-proxy)
│   ├── harbor_adapter/             # Terminal-Bench 2.0 BaseAgent (async env.exec proxy)
│   ├── tb_pilot.sh / harbor_pilot.sh
│   ├── tb_status.sh / harbor_status.sh
│   └── test_rpc_client.py
├── AGENTS.md                       # project system prompt (pi discovers it automatically)
├── models.json                     # canonical provider registration (loaded by llama-cpp-provider; user override at $XDG_CONFIG_HOME/little-coder/models.json)
└── docs/
    ├── benchmark-*.md              # per-benchmark narratives
    └── architecture.md             # v0.0.5-era Python architecture (historical)
```

**Key invariant.** pi is a minimal base by design. Every little-coder mechanism ships as a pi extension that hooks pi's lifecycle events (`before_agent_start`, `context`, `before_provider_request`, `tool_call`, `tool_result`, `turn_end`, `session_compact`). Extensions are independent and can be enabled/disabled per deployment via `.pi/settings.json`. If you don't want one, delete its directory or disable it in settings; if you want to add another, drop it next to the existing ones.

---

## Reproducing the paper (v0.0.2)

```bash
git clone https://github.com/itayinbarr/little-coder.git
cd little-coder
git checkout v0.0.2
# Follow that version's README for its Python setup (pip install -e .)
```

The paper ran `ollama/qwen3.5` through the Python little-coder at commit **`1d62bde`** (tag [`v0.0.2`](https://github.com/itayinbarr/little-coder/releases/tag/v0.0.2)). The 45.56 % mean figure is the average of two full 225-exercise runs on that exact codebase. For the 78.67 % headline, check out tag [`v0.0.5`](https://github.com/itayinbarr/little-coder/releases/tag/v0.0.5) — both are pre-pi Python and follow the pre-pi setup.

---

## Citation

```bibtex
@misc{inbar2026littlecoder,
  title        = {little-coder: A Coding Agent Optimized for Small Local Language Models},
  subtitle     = {Architectural Adaptation Lets a 9.7B Model Outperform Frontier Models on Aider Polyglot},
  author       = {Inbar, Itay},
  year         = {2026},
  month        = apr,
  howpublished = {\url{https://open.substack.com/pub/itayinbarr/p/honey-i-shrunk-the-coding-agent}},
  note         = {White paper}
}
```

---

## Attribution

little-coder v0.0.x was a derivative work of [CheetahClaws / ClawSpring](https://github.com/SafeRL-Lab/clawspring) by SafeRL-Lab, Apache 2.0. That upstream provided the Python agent substrate, tool system, multi-provider support, and REPL.

little-coder v0.1.0+ replaces that substrate with **[pi](https://pi.dev)** by Mario Zechner — Apache 2.0 / MIT. The npm package was renamed from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent` in upstream's 0.74 release; little-coder v1.4.2+ ships with the new package. pi provides the agent loop, provider abstraction, TUI, and extension model. little-coder rebuilds its small-model adaptations on top of pi as extensions.

All little-coder-specific mechanisms — Write-vs-Edit invariant, skill / knowledge injection, thinking-budget cap, output-parser, quality-monitor, per-model profiles, per-benchmark overrides, ShellSession / Browser / Evidence tool families, evidence-aware compaction — are preserved across versions.

---

## License

Apache 2.0 — see [LICENSE](LICENSE) for details. NOTICE tracks upstream attribution.
