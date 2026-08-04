#!/usr/bin/env bash
# Status snapshot for an in-flight GAIA run.
#
# Usage:
#   benchmarks/gaia_status.sh                          # auto-detect newest run dir
#   benchmarks/gaia_status.sh validation-calibration   # explicit run-name
#   RUN_ID=foo benchmarks/gaia_status.sh
#
# Prints process health, progress (overall and per level), success rate,
# per-task rate, ETA, tool-call breakdown, and aggregated extension
# activity (skill-inject, research-directive, quality-monitor, turn-cap).
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS_DIR="$REPO_ROOT/benchmarks/gaia_runs"

RUN_ID="${1:-${RUN_ID:-}}"
if [ -z "$RUN_ID" ]; then
  RUN_ID=$(find "$RUNS_DIR" -maxdepth 1 -mindepth 1 -type d -printf '%T@ %f\n' 2>/dev/null \
           | grep -vE ' (_pilot_picks\.json)$' \
           | sort -nr | awk 'NR==1{print $2}')
fi
if [ -z "$RUN_ID" ] || [ ! -d "$RUNS_DIR/$RUN_ID" ]; then
  echo "No run dir found (looked in $RUNS_DIR)." >&2
  exit 1
fi

DIR="$RUNS_DIR/$RUN_ID"

PYTHON="${GAIA_PYTHON:-$(command -v python3 || command -v python)}"

"$PYTHON" - "$RUN_ID" "$DIR" <<'PY'
import json, os, sys, time, subprocess, statistics, datetime
from pathlib import Path

run_id, dir_ = sys.argv[1:3]
DIR = Path(dir_)


def sh(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ""


def humanize(s: float) -> str:
    if s <= 0:
        return "-"
    h, rem = divmod(int(s), 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


# ── Manifest ─────────────────────────────────────────────────────────────
manifest = {}
mp = DIR / "manifest.json"
if mp.exists():
    try:
        manifest = json.loads(mp.read_text())
    except Exception:
        pass

total = len(manifest.get("task_ids", []))
model = manifest.get("model", "?")
split = manifest.get("split", "?")
started_at = manifest.get("started_at", "")

# ── Per-task results — read each <task_id>/result.json on disk ───────────
task_dirs = sorted([d for d in DIR.iterdir() if d.is_dir()], key=lambda p: p.stat().st_mtime)
per_task: list[dict] = []
for d in task_dirs:
    rp = d / "result.json"
    if not rp.exists():
        continue
    try:
        per_task.append(json.loads(rp.read_text()))
    except Exception:
        continue

done = len(per_task)
remaining = max(total - done, 0)

n_correct = sum(1 for r in per_task if r.get("correct"))
n_failed = sum(1 for r in per_task if r.get("correct") is False)
n_unscored = done - n_correct - n_failed  # test split has no gold

# ── By level ─────────────────────────────────────────────────────────────
by_level: dict[str, dict] = {}
expected_per_level = {"1": 53, "2": 86, "3": 26}  # validation default
if split == "test":
    expected_per_level = {"1": 93, "2": 159, "3": 49}
for r in per_task:
    lvl = str(r.get("level") or "?")
    s = by_level.setdefault(lvl, {"done": 0, "correct": 0, "failed": 0})
    s["done"] += 1
    if r.get("correct") is True:
        s["correct"] += 1
    elif r.get("correct") is False:
        s["failed"] += 1

# ── Process / wallclock ──────────────────────────────────────────────────
run_pid = sh(f"pgrep -af 'gaia.py.*{run_id}' | awk '{{print $1}}' | head -1")
elapsed_str = sh(f"ps -p {run_pid} -o etime= 2>/dev/null").strip() if run_pid else "(not running)"

elapsed_s = 0
if run_pid and elapsed_str and ":" in elapsed_str:
    parts = elapsed_str.split("-")
    days = int(parts[0]) if len(parts) == 2 else 0
    hms = parts[-1].split(":")
    if len(hms) == 3:
        elapsed_s = days * 86400 + int(hms[0]) * 3600 + int(hms[1]) * 60 + int(hms[2])
    elif len(hms) == 2:
        elapsed_s = days * 86400 + int(hms[0]) * 60 + int(hms[1])

# Use per-task elapsed_s sum as an alternative wallclock estimate (more
# stable across resumes — process etime restarts on each --resume).
sum_task_elapsed = sum((r.get("elapsed_s") or 0) for r in per_task)
rate_s_per_task = (sum_task_elapsed / done) if done else 0
eta_s = rate_s_per_task * remaining
finish_at = (datetime.datetime.now() + datetime.timedelta(seconds=eta_s)).strftime("%H:%M") if eta_s else "-"

# ── Tool-call breakdown ──────────────────────────────────────────────────
tool_name_counts: dict[str, int] = {}
calls_per_task: list[int] = []
for d in task_dirs:
    tcp = d / "tool_calls.jsonl"
    if not tcp.exists():
        continue
    n = 0
    try:
        with tcp.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    tc = json.loads(line)
                except Exception:
                    continue
                name = tc.get("name") or "(unknown)"
                tool_name_counts[name] = tool_name_counts.get(name, 0) + 1
                n += 1
    except Exception:
        continue
    calls_per_task.append(n)

# ── Extension notifications ──────────────────────────────────────────────
notes_per_task: dict[str, list[str]] = {}
for d in task_dirs:
    np = d / "notifications.txt"
    if not np.exists():
        continue
    try:
        notes_per_task[d.name] = [ln.strip() for ln in np.read_text().splitlines() if ln.strip()]
    except Exception:
        continue


def count_pattern(p: str) -> tuple[int, int]:
    tasks = 0
    events = 0
    for ns in notes_per_task.values():
        k = sum(1 for n in ns if p in n)
        if k:
            tasks += 1
        events += k
    return tasks, events


skill_t, skill_n = count_pattern("skill-inject:")
research_t, research_n = count_pattern("research-directive")
quality_t, quality_n = count_pattern("quality-monitor:")
turncap_t, _ = count_pattern("turn-cap:")
finalize_t, finalize_n = count_pattern("finalize-warn:")
budget_t, budget_n = count_pattern("thinking-budget:")
evidence_t, evidence_n = count_pattern("evidence-compact:")
parser_t, parser_n = count_pattern("text-embedded tool")

# Counts of common dumb patterns we want to catch
empty_extracts = 0
for d in task_dirs:
    tcp = d / "tool_calls.jsonl"
    if not tcp.exists():
        continue
    try:
        with tcp.open() as f:
            for line in f:
                try:
                    tc = json.loads(line)
                except Exception:
                    continue
                if tc.get("name") in ("BrowserExtract", "BrowserScroll") and (tc.get("result_text_len") or 0) < 80:
                    empty_extracts += 1
    except Exception:
        pass

# ── In-flight task: most-recently-modified task_dir without result.json
in_flight = None
in_flight_age = None
if total > done and task_dirs:
    for d in sorted(task_dirs, key=lambda p: p.stat().st_mtime, reverse=True):
        if not (d / "result.json").exists():
            in_flight = d.name
            in_flight_age = int(time.time() - d.stat().st_mtime)
            break

# ── Recent failures (last 5)
recent_fails = [r for r in per_task if r.get("correct") is False][-5:]

# ── Output ──────────────────────────────────────────────────────────────
print(f"run_id     : {run_id}")
print(f"split      : {split}    model: {model}")
print(f"started    : {started_at}")
print(f"process    : pid={run_pid or 'DEAD'}  current-elapsed={elapsed_str}  task-time-sum={humanize(sum_task_elapsed)}")
print(f"progress   : {done}/{total} done  ({remaining} remaining)")
if split == "validation":
    pct = (n_correct / done * 100) if done else 0
    print(f"accuracy   : {n_correct}/{done} = {pct:.2f}%   failed={n_failed}   {('⚠ early-sample' if done < 10 else '')}")
elif split == "test":
    print(f"answers    : {done - sum(1 for r in per_task if not (r.get('model_answer') or '').strip())}/{done} non-empty")

print(f"\nby level:")
for lvl in sorted(by_level.keys()):
    s = by_level[lvl]
    expect = expected_per_level.get(lvl, 0)
    if split == "validation":
        acc = (s["correct"] / s["done"] * 100) if s["done"] else 0
        print(f"  L{lvl}: {s['done']}/{expect} done  → {s['correct']} correct ({acc:.1f}%), {s['failed']} failed")
    else:
        print(f"  L{lvl}: {s['done']}/{expect} done")

print(f"\nrate       : {humanize(rate_s_per_task)} / task")
print(f"eta        : {humanize(eta_s)} remaining → finish ~{finish_at}")

if in_flight:
    print(f"\nin-flight  : {in_flight}  (last-touched {in_flight_age}s ago)")

# ── Tool usage ──────────────────────────────────────────────────────────
if calls_per_task:
    avg = statistics.mean(calls_per_task)
    med = statistics.median(calls_per_task)
    print(f"\n── tool calls per task ──")
    print(f"avg={avg:.1f}  median={med:.0f}  min={min(calls_per_task)}  max={max(calls_per_task)}")
if tool_name_counts:
    print(f"\n── tool breakdown ({sum(tool_name_counts.values())} calls across {done} tasks) ──")
    for name, n in sorted(tool_name_counts.items(), key=lambda x: -x[1]):
        print(f"  {name:24s} {n:>5d}")

# ── Extension activity ──────────────────────────────────────────────────
print(f"\n── extension activity (over {done} tasks) ──")
print(f"skill-inject       : {skill_n} fires / {skill_t} tasks")
print(f"research-directive : {research_n} injections / {research_t} tasks")
print(f"quality-monitor    : {quality_n} corrections / {quality_t} tasks")
print(f"thinking-budget    : {budget_n} fires / {budget_t} tasks")
print(f"turn-cap aborts    : {turncap_t} tasks")
print(f"finalize-warn      : {finalize_n} fires / {finalize_t} tasks")
print(f"evidence-compact   : {evidence_n} bridges / {evidence_t} tasks")
print(f"output-parser      : {parser_n} text-tool rescues / {parser_t} tasks")
print(f"empty browser results (likely dead pages): {empty_extracts} calls")

if recent_fails:
    print(f"\n── recent failures (last {len(recent_fails)}) ──")
    for r in recent_fails:
        gold = r.get("gold", "?")
        ans = r.get("model_answer", "")
        ans_trunc = (ans[:60] + "…") if len(ans) > 60 else ans
        print(f"  ✗ L{r.get('level')}  {r['task_id']}  pred={ans_trunc!r} gold={gold!r}")
PY
