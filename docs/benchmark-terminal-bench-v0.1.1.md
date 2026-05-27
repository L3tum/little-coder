# little-coder on Terminal-Bench-Core v0.1.1

**Headline:** `llamacpp/qwen3.6-35b-a3b` + little-coder → **32 / 80 = 40.0 %** on the full leaderboard-valid [Terminal-Bench-Core v0.1.1](https://www.tbench.ai/docs/submitting-to-leaderboard) task set, single attempt per task, 6 h 50 min wall clock on an 8 GB laptop GPU (RTX 5070 Laptop, Blackwell).

This write-up documents the run, the empirical signals that drove the v0.1.4 retuning (`max_turns` 25 → 40), and the current diagnostic gaps.

---

## Setup

| | |
|---|---|
| little-coder version | [`v0.1.4`](https://github.com/itayinbarr/little-coder/releases/tag/v0.1.4) (commit `f4c1b4e`) |
| Agent | `little-coder` (pi-coding-agent 0.68.1 + 16 TS extensions) |
| Model | `llamacpp/qwen3.6-35b-a3b` — Qwen3.6-35B-A3B UD-Q4_K_M (22 GB) |
| Serving | `llama-server -ngl 99 --n-cpu-moe 999 --flash-attn on --jinja -c 32768` |
| Hardware | i9-14900HX, 32 GB RAM, RTX 5070 Laptop 8 GB (sm_120), CUDA 13.1 |
| Dataset | `terminal-bench-core@0.1.1` (80 tasks, commit `91e1045`) |
| Harness | `terminal-bench` 0.2.18, `--n-concurrent 1`, `--n-attempts 1`, default timeouts |
| Agent-internal turn cap | 40 per task (v0.1.4 default; see "turn-cap tuning" below) |
| Thinking budget | 3000 tokens / turn (matches `benchmark_overrides.terminal_bench`) |
| Temperature | 0.2 |
| Run id | `leaderboard-2026-04-23__00-14-03` |
| Started / ended | 2026-04-23 00:14 / 07:05 local |

Launch command:

```bash
sg docker -c "tb run \
  --dataset-name terminal-bench-core \
  --dataset-version 0.1.1 \
  --agent-import-path benchmarks.tb_adapter.little_coder_agent:LittleCoderAgent \
  --output-path ./benchmarks/tb_runs \
  --n-concurrent 1"
```

---

## Result

```
Resolved Trials   : 32
Unresolved Trials : 48
Accuracy          : 40.00 %
Wall time         : 6 h 50 min
```

### Passed tasks (32)

| Category | Tasks |
|---|---|
| Env / package conflicts | `conda-env-conflict-resolution`, `fix-pandas-version`, `incompatible-python-fasttext`, `incompatible-python-fasttext.base_with_hint`, `modernize-fortran-build` |
| ML / PyTorch | `cartpole-rl-training`, `eval-mteb`, `eval-mteb.hard`, `pytorch-model-cli.easy` |
| Data wrangling | `count-dataset-tokens`, `csv-to-parquet`, `grid-pattern-transform`, `heterogeneous-dates`, `processing-pipeline`, `solana-data` |
| Crypto / security | `crack-7z-hash`, `crack-7z-hash.easy`, `extract-safely`, `openssl-selfsigned-cert`, `sanitize-git-repo` |
| Cloud / web | `create-bucket`, `simple-sheets-put`, `simple-web-scraper` |
| Git / dev workflow | `git-workflow-hack`, `tmux-advanced-workflow` |
| File / permissions | `fix-permissions`, `hello-world` |
| Theorem / maze | `blind-maze-explorer-5x5`, `prove-plus-comm` |
| SWE-bench ports | `swe-bench-astropy-1`, `swe-bench-fsspec`, `swe-bench-langcodes` |

### Failed tasks (48)

Systems / low-level (QEMU, kernel, TCC): `build-initramfs-qemu`, `build-linux-kernel-qemu`, `build-tcc-qemu`, `qemu-alpine-ssh`, `qemu-startup`, `run-pdp11-code`, `oom`

Maze / RL (algorithm variants): `blind-maze-explorer-algorithm`, `blind-maze-explorer-algorithm.easy`, `blind-maze-explorer-algorithm.hard`

Interactive / pane-hijacking: `play-zork`, `vim-terminal-task`, `jupyter-notebook-server`, `nginx-request-logging`

Network / service: `configure-git-webserver`, `cron-broken-network`, `fibonacci-server`, `get-bitcoin-nodes`, `intrusion-detection`, `security-vulhub-minio`

Git flows: `fix-git`, `git-multibranch`, `sanitize-git-repo.hard`

SWE-bench hard: `swe-bench-astropy-2`

Large-file / data pipeline: `decommissioning-service-with-sensitive-data`, `download-youtube`, `extract-moves-from-video`, `reshard-c4-data`, `train-fasttext`, `raman-fitting`, `raman-fitting.easy`, `organization-json-generator`

Other: `chess-best-move`, `crack-7z-hash.hard`, `gpt2-codegolf`, `hf-model-inference`, `new-encrypt-command`, `password-recovery`, `path-tracing`, `path-tracing-reverse`, `polyglot-c-py`, `polyglot-rust-c`, `pytorch-model-cli`, `pytorch-model-cli.hard`, `sqlite-db-truncate`, `sqlite-with-gcov`, `super-benchmark-upet`, `write-compressor`

### Failure-mode breakdown (from `results.json`)

| Failure mode | Count |
|---|---|
| `unset` (genuine wrong answer — scoring tests failed) | 35 |
| `agent_timeout` (harness wall-clock exceeded) | 12 |
| `parse_error` | 1 |

---

## Turn-cap tuning: 25 → 40 is empirically the right call

Before v0.1.4, `benchmark_overrides.terminal_bench.max_turns = 25`. The first 10 tasks of the prior run showed **5 / 10 at cap**, all of them failures. Bumped to 40 for the run above. Observed result:

```
tasks at cap (≥ 40 calls)  :  8 / 80   (↓ from ~20/80 at cap=25)
  → of which passed        :  1
  → of which failed        :  7
tasks NOT at cap           : 72 / 80
  → pass rate              : 43 %
```

88 % of cap-hits still fail — those 8 are genuinely hard tasks where the model is chasing dead ends. But the bump cleared the ~12 tasks that *would* have hit 25 but finish under 40.

### Turn distribution

```
passes   (n = 32):  avg 15.0 turns   median 12   max 40
failures (n = 48):  avg 20.1 turns   median 17   max 40
```

Passes are fast (median 12 turns); failures cluster near the cap. The modal pass uses ~12 turns of back-and-forth — consistent with small-but-focused agent loops that don't over-explore.

---

## Extension activity (v0.1.4 observability)

Fires captured via `ctx.ui.notify` → PiRpc → per-task adapter log:

| Extension | Fires | Tasks | Signal |
|---|---|---|---|
| `skill-inject` | 71 | 71 / 80 | Near-ubiquitous — the error-recovery / recency / intent selection fires on almost every task, per-turn. |
| `knowledge-inject` | 45 | 45 / 80 | More than half of tasks score ≥ 2.0 on at least one algorithm cheat sheet — GAIA / ML / theorem topics especially. |
| `thinking-budget` | 11 | 11 / 80 | **All 11 tasks that hit the 3000-token thinking budget failed.** See discussion below. |
| `quality-monitor` | 57 | 28 / 80 | 28 tasks produced at least one empty / looped / hallucinated response. `gpt2-codegolf` alone accounted for 24 corrections. |
| `turn-cap` | — | 9 / 80 | Notify-reported cap aborts; off by one vs call-count cap hits (8) due to notify-emission timing. |
| `output-parser` (text-tool rescue) | 0 | 0 / 80 | Qwen3.6-35B-A3B uses native tool calling cleanly — no fenced-block fallback needed. |
| `evidence-compact` | 0 | 0 / 80 | TB's shell-only toolset means no Evidence use; extension correctly dormant. |

### 🚩 The thinking-budget signal

Every task where the model ran its reasoning past 3000 tokens FAILED. Two candidate explanations:

1. **Selection bias.** Deliberation budget is reached on genuinely hard tasks; the same tasks are the ones the model would fail anyway. In this reading, raising the budget helps zero tasks.
2. **Budget-cutting harms.** Forcing the model to "commit to an implementation" after 3000 thinking tokens cuts off reasoning that would have led somewhere. In this reading, `thinking_budget: 5000` or `6000` would flip some fraction of the 11.

The correlation alone can't distinguish (1) from (2). The obvious v0.2 experiment: bump `benchmark_overrides.terminal_bench.thinking_budget` to 5000 and re-run. If ≥ 3 of the 11 flip, (2) is real; if 0 flip, it's (1) and the lever is dead.

### Quality-monitor isn't saving TB tasks

```
top-10 tasks by quality-monitor correction count  →  0 passed
```

Corrections help the model recover from a bad turn (empty, looped, malformed) but the same state-machine pathology that triggers a correction often persists. On Polyglot (smaller, more constrained tasks) this mechanism pays off; on TB's long-horizon container-debugging format, corrections arrive too late. Not an infra bug — a model-scale issue.

---

## Diagnostic gaps (to fix for v0.2 submission)

1. **Token counts unset.** `AgentResult.total_input_tokens` / `total_output_tokens` come through as `0` because the TB adapter doesn't populate them. Fix: expose a token accumulator on `PiRpc` (pi-ai already reports per-request usage) and plumb through. Cosmetic only for leaderboard display but frontier submissions report this.
2. **Harness agent-timeout vs our `max_turns`.** 12 tasks failed with `agent_timeout` rather than "ran out of turns". Those are tasks where 40 turns *is* fine, but each turn is slow enough that wall clock beats us. Unclear whether this correlates with specific tool patterns (big file reads, installs) — worth a per-task analysis.
3. **`blind-maze-explorer-algorithm` failed all three variants** (easy, hard, base) despite passing the much simpler `blind-maze-explorer-5x5`. Systematic issue with the larger-state maze search — candidate for algorithm-specific knowledge entry in `skills/knowledge/`.
4. **`gpt2-codegolf` 24 corrections** — classic quality-monitor pathology; the same bad state recurs. Worth logging the exact correction reasons (`empty_response` / `repeated_tool_call` / `unknown_tool`) per task to see the shape.

---

## Reproduction

```bash
git clone https://github.com/itayinbarr/little-coder.git
cd little-coder
git checkout v0.1.4
npm install

# Serve Qwen3.6-35B-A3B via llama.cpp (see README.md quick-start)
# Ensure llama-server is reachable at http://127.0.0.1:8888/v1

# Launch
sg docker -c "tb run \
  --dataset-name terminal-bench-core \
  --dataset-version 0.1.1 \
  --agent-import-path benchmarks.tb_adapter.little_coder_agent:LittleCoderAgent \
  --output-path ./benchmarks/tb_runs \
  --n-concurrent 1"

# Monitor
benchmarks/tb_status.sh
```

The raw `results.json` plus per-task trajectory directories (`agent-logs/`, `sessions/agent.cast`, `commands.txt`, `panes/`) are preserved under `benchmarks/tb_runs/leaderboard-2026-04-23__00-14-03/` for anyone wanting to audit specific trials.

---

## Leaderboard submission

Submitted to `mikeam@cs.stanford.edu` and `alex@laude.org` on 2026-04-23. Agent name `little-coder`, model `llamacpp/qwen3.6-35b-a3b`, dataset `terminal-bench-core@0.1.1`.
