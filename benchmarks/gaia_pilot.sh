#!/usr/bin/env bash
# Pilot wrapper for benchmarks/gaia.py — runs a deliberately picked
# easy/hard task set against the validation split so we can iterate the
# browser tools and skill scaffolding before kicking off a full run.
#
# Usage:
#   benchmarks/gaia_pilot.sh                       # default pilot set
#   benchmarks/gaia_pilot.sh <task_id> [<task_id>] # custom set
#
# Env:
#   GAIA_MODEL    — model id (default: llamacpp/qwen3.6-35b-a3b)
#   GAIA_TIMEOUT  — per-task timeout seconds (default: 900)
set -euo pipefail

MODEL="${GAIA_MODEL:-llamacpp/qwen3.6-35b-a3b}"
TIMEOUT="${GAIA_TIMEOUT:-900}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Default pilot set is filled in by the runner after we inspect the
# validation set the first time. To override, pass task_ids on the CLI.
DEFAULT_TASKS=(
  # picked by inspect_validation.py — see benchmarks/gaia_runs/_pilot_picks.json
)

if [[ $# -gt 0 ]]; then
  TASKS=("$@")
else
  if [[ ${#DEFAULT_TASKS[@]} -eq 0 ]]; then
    echo "No DEFAULT_TASKS set. Pass task_ids on the CLI, or run:"
    echo "  python benchmarks/gaia.py --split validation --all --limit 4"
    exit 1
  fi
  TASKS=("${DEFAULT_TASKS[@]}")
fi

export LLAMACPP_API_KEY="${LLAMACPP_API_KEY:-noop}"
export OLLAMA_API_KEY="${OLLAMA_API_KEY:-noop}"

PYTHON="${GAIA_PYTHON:-$(command -v python3 || command -v python)}"

cd "$REPO_ROOT"
exec "$PYTHON" benchmarks/gaia.py \
  --split validation \
  --task-ids "${TASKS[@]}" \
  --timeout "$TIMEOUT" \
  --model "$MODEL" \
  --run-name "pilot-$(date +%Y-%m-%d__%H-%M-%S)"
