/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` processes and streams results back via callbacks.
 */

import { spawn } from "node:child_process";
import { startSubprocess } from "../_shared/subprocess.js";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// AgentToolResult is re-exported by pi-agent-core which is not always installed.
// Define the minimal shape we need locally.
type AgentToolResult<TDetails = unknown> = {
  content: Array<{ type: "text"; text: string }>;
  details?: TDetails;
  isError?: boolean;
  usage?: Record<string, number>;
};
import type { AgentConfig } from "./agents.js";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine } from "./runner-events.js";
import {
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  emptyUsage,
  getFinalOutput,
  isResultError,
  normalizeCompletedResult,
} from "./types.js";
// Same retryable/overflow classification pi's own agent loop uses
// (pi-coding-agent imports the same symbols from this entry point), so a
// subagent-level retry means "transient" exactly the same way an in-session
// retry does. pi-ai is a direct dependency, and pi-coding-agent (which we
// already import) depends on it, so it is always resolvable.
import {
  isContextOverflow,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai/compat";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 2000;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const PI_OFFLINE_ENV = "PI_OFFLINE";
// Inline the task as a single argv element only while it is comfortably under
// the OS per-argument limit (Linux MAX_ARG_STRLEN is 128 KiB; macOS ARG_MAX is
// 256 KiB across all args+env). Larger tasks — the pipeline synthesis and final
// composition embed full prior outputs verbatim — are written to a 0600 temp
// file and referenced with @file so spawn cannot throw E2BIG and the task (which
// may carry repository content) is not exposed on the process command line.
export const TASK_INLINE_MAX_BYTES = 64 * 1024;
// Cross-reference: this is the SAME magnitude as mode-commands/pipeline.ts
// PHASE_THREAD_MAX_BYTES on purpose — a full-budget threaded phase output is
// exactly what decides whether the NEXT phase's task routes inline or through
// the @file temp-file path above. Change one, reconsider the other.

// Shared fan-out ceilings. The subagent tool caps parallel tasks at
// MAX_SUBAGENT_PARALLEL_TASKS and runs at most MAX_SUBAGENT_CONCURRENCY of
// them at once; the programmatic pipelines (mode-commands) reuse the same
// concurrency so the two surfaces cannot drift to different ceilings. Each
// slot is a FULL pi process (~300-500 MB RSS).
export const MAX_SUBAGENT_PARALLEL_TASKS = 8;
export const DEFAULT_SUBAGENT_CONCURRENCY = 4;
// Transient-remote-error retry budget: a child whose final LLM call hit a
// transient provider/transport failure (rate limit, 5xx, dropped connection,
// stream cut short) is respawned up to this many times TOTAL. Backoff is
// per-retry (index = retry number - 1).
export const SUBAGENT_MAX_ATTEMPTS = 3;
export const SUBAGENT_RETRY_BACKOFF_MS = [5_000, 15_000];

/** Maps signal names to their POSIX numbers for exit code computation. */
const SIGNAL_MAP: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGKILL: 9,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGBREAK: 21,
  SIGBUS: 10,
  SIGINFO: 29,
  SIGIO: 29,
  SIGIOT: 6,
  SIGLOST: 29,
  SIGPOLL: 29,
  SIGPROF: 27,
  SIGPWR: 30,
  SIGSTKFLT: 16,
  SIGSYS: 12,
  SIGUNUSED: 31,
  SIGURG: 23,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGVTALRM: 26,
  SIGWINCH: 28,
  SIGXCPU: 24,
  SIGXFSZ: 25,
};

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Build the canonical failure SingleResult. Single source of shape for every
 * "runAgent returns an error" path (unknown agent, missing fork snapshot,
 * file-prep failure) and for pipeline callers that synthesize a result after
 * a runAgent throw — so the optional fields (model, stopReason, errorMessage)
 * are set consistently in one place.
 */
export function makeFailureResult(
  agentName: string,
  agentSource: SingleResult["agentSource"],
  task: string,
  message: string,
  model?: string,
): SingleResult {
  return {
    agent: agentName,
    agentSource,
    task,
    exitCode: 1,
    messages: [],
    stderr: message,
    usage: emptyUsage(),
    model,
    stopReason: "error",
    errorMessage: message,
  };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Derive the spawn command from the current process context so child invocations
 * work on Unix and Windows without going through a shell wrapper.
 */
function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

export function writeForkSessionToTempFile(
  agentName: string,
  sessionJsonl: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `fork-${safeName}.jsonl`);
  fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

/**
 * Write a large task to a 0600 temp file so it can be passed to the child via
 * an `@file` reference instead of as one oversized argv element. Content is the
 * full `Task: ...` string, so the inlined prompt matches the inline path apart
 * from the `<file>` wrapper the CLI adds around the read content.
 */
export function writeTaskToTempFile(
  agentName: string,
  task: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const rand = randomBytes(4).toString("hex");
  const filePath = path.join(tmpDir, `task-${safeName}-${rand}.md`);
  try {
    fs.writeFileSync(filePath, `Task: ${task}`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (err) {
    // The dir was created but the file write failed (ENOSPC/etc.). The
    // caller can't clean it up (we never return it), so the creator must.
    // Rethrow so runAgent's prep catch still reports the failure.
    cleanupTempDir(tmpDir);
    throw err;
  }
  return { dir: tmpDir, filePath };
}

/**
 * Decide how the task reaches the child: inline `Task: <task>` argv element
 * while under TASK_INLINE_MAX_BYTES, otherwise a 0600 temp file referenced as
 * `@<file>`. Extracted as a pure-ish function so the routing decision is
 * unit-testable without spawning; `dir` is the temp dir to clean up (null for
 * the inline path).
 */
export function resolveTaskArg(
  agentName: string,
  task: string,
): { dir: string | null; arg: string } {
  // Measure in UTF-8 BYTES, not code units: multibyte tasks (CJK, emoji) can
  // be up to 4x longer in bytes than in JS string length, and the E2BIG/argv
  // budget is a byte budget. Buffer.byteLength measures without encoding the
  // string, so there is no fast-path to avoid. A code-unit check would inline
  // a 60K-char CJK task (180 KB bytes) and hit E2BIG anyway.
  if (Buffer.byteLength(task, "utf8") > TASK_INLINE_MAX_BYTES) {
    const tmp = writeTaskToTempFile(agentName, task);
    return { dir: tmp.dir, arg: `@${tmp.filePath}` };
  }
  return { dir: null, arg: `Task: ${task}` };
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

function buildPiArgs(
  agent: AgentConfig,
  systemPromptPath: string | null,
  taskArg: string,
  delegationMode: DelegationMode,
  forkSessionPath: string | null,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ...inheritedCliArgs.extensionArgs,
    ...inheritedCliArgs.alwaysProxy,
    "-p",
  ];

  if (delegationMode === "spawn") {
    args.push("--no-session");
  } else if (forkSessionPath) {
    args.push("--session", forkSessionPath);
  }

  const model = agent.model ?? inheritedCliArgs.fallbackModel;
  if (model) args.push("--model", model);

  const thinking = agent.thinking ?? inheritedCliArgs.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  } else if (agent.tools === undefined) {
    if (inheritedCliArgs.fallbackTools !== undefined) {
      args.push("--tools", inheritedCliArgs.fallbackTools);
    } else if (inheritedCliArgs.fallbackNoTools) {
      args.push("--no-tools");
    }
  }

  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  args.push(taskArg);
  return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Fallback working directory when the task doesn't specify one. */
  cwd: string;
  /** All available agent configs. */
  agents: AgentConfig[];
  /** Name of the agent to run. */
  agentName: string;
  /** Task description. */
  task: string;
  /** Optional override working directory. */
  taskCwd?: string;
  /** Context mode: spawn (fresh) or fork (session snapshot + task). */
  delegationMode: DelegationMode;
  /** Serialized parent session snapshot used when delegationMode is "fork". */
  forkSessionSnapshotJsonl?: string;
  /**
   * Pre-written fork session snapshot file, shared across a parallel fan-out
   * (one write of the full session instead of one per task). When set,
   * runAgent uses it as-is and does NOT clean it up — the caller owns the
   * temp dir and must remove it after all tasks finish.
   */
  forkSessionSnapshotFile?: { dir: string; filePath: string };
  /** Override the agent's system prompt for this run. */
  systemPromptOverride?: string;
  /** Current delegation depth of the caller process. */
  parentDepth: number;
  /** Delegation stack from the caller process (ancestor agent names). */
  parentAgentStack: string[];
  /** Maximum allowed delegation depth to propagate to child processes. */
  maxDepth: number;
  /** Whether cycle prevention should be enforced in child processes. */
  preventCycles: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>;
  /** Factory to wrap results into SubagentDetails. */
  makeDetails: (results: SingleResult[]) => SubagentDetails;
}

// ---------------------------------------------------------------------------
// Transient-remote-error retry
// ---------------------------------------------------------------------------

/**
 * Whether a finished subagent run failed on a TRANSIENT remote/provider error
 * worth respawning for.
 *
 * Reuses pi-ai's own classifiers so "transient" means exactly what pi's
 * in-session retries mean: overloaded/rate-limit/5xx/connection-drop/stream
 * cut short. Deliberately NOT retryable (fail fast, a fresh spawn cannot
 * fix them):
 *  - context overflow (e.g. "400 status code (no body)" from Cerebras/
 *    llama.cpp servers) — a re-spawn overflows again at the same point;
 *  - quota/billing exhaustion (pi's NON_RETRYABLE_PROVIDER_LIMIT list);
 *  - anything that is not stopReason "error" — aborts, timeouts, spawn
 *    failures, prep failures, unknown agents.
 */
export function isTransientRemoteFailure(result: SingleResult): boolean {
  if (result.exitCode === -1) return false; // never even spawned
  if (result.stopReason !== "error") return false;
  const text =
    (typeof result.errorMessage === "string" && result.errorMessage.trim()) ||
    (typeof result.stderr === "string" && result.stderr.trim()) ||
    "";
  if (!text) return false;
  // isRetryableAssistantError/isContextOverflow only read stopReason and
  // errorMessage off the AssistantMessage they are given.
  const probe = {
    stopReason: "error",
    errorMessage: text,
  } as Parameters<typeof isRetryableAssistantError>[0];
  if (isContextOverflow(probe, 0)) return false;
  return isRetryableAssistantError(probe);
}

/** Sleep up to `ms`; resolves `false` immediately if `signal` aborts first. */
export function sleepAbortable(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `produce()` and, while it keeps failing on a transient remote error,
 * back off and retry up to `maxAttempts` total spawns. Aborting the signal
 * during a backoff stops retrying and returns the current (failed) result.
 * The FIRST non-transient outcome — success or hard failure — is returned
 * unchanged. Returns how many attempts were made so callers can annotate
 * exhausted retries.
 */
export async function withTransientRetry(
  produce: () => Promise<SingleResult>,
  signal?: AbortSignal,
  maxAttempts: number = SUBAGENT_MAX_ATTEMPTS,
  backoffMs: number[] = SUBAGENT_RETRY_BACKOFF_MS,
): Promise<{ result: SingleResult; attempts: number }> {
  let result = await produce();
  let attempts = 1;
  while (
    attempts < maxAttempts &&
    !signal?.aborted &&
    isTransientRemoteFailure(result)
  ) {
    const backoff = backoffMs[attempts - 1] ?? backoffMs[backoffMs.length - 1];
    const completed = await sleepAbortable(backoff, signal);
    if (!completed) break;
    attempts += 1;
    result = await produce();
  }
  return { result, attempts };
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 *
 * Transient remote/provider failures (rate limit, 5xx, dropped connection,
 * stream cut short — see isTransientRemoteFailure) are retried up to
 * SUBAGENT_MAX_ATTEMPTS total spawns with backoff (SUBAGENT_RETRY_BACKOFF_MS);
 * an exhausted budget is annotated into the returned error text. Context
 * overflow, quota exhaustion, aborts, timeouts, and spawn/prep failures are
 * never retried.
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agents,
    agentName,
    task,
    taskCwd,
    delegationMode,
    forkSessionSnapshotJsonl,
    forkSessionSnapshotFile,
    systemPromptOverride,
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    signal,
    onUpdate,
    makeDetails,
    env,
  } = opts;

  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return makeFailureResult(
      agentName,
      "unknown",
      task,
      `Unknown agent: "${agentName}". Available agents: ${available}.`,
    );
  }

  if (
    delegationMode === "fork" &&
    (!forkSessionSnapshotJsonl || !forkSessionSnapshotJsonl.trim())
  ) {
    return makeFailureResult(
      agentName,
      agent.source,
      task,
      "Cannot run in fork mode: missing parent session snapshot context.",
      agent.model,
    );
  }

  // Write support files (system prompt, fork session snapshot, oversized task)
  // to temp files. A failure here (ENOSPC etc.) must NOT throw out of
  // runAgent — the documented contract is "returns a SingleResult even on
  // failure". The catch below cleans up any temp dir already created in this
  // sequence (this early return never reaches the outer try/finally that
  // cleans up after the spawn).
  let promptTmpDir: string | null = null;
  let promptTmpPath: string | null = null;
  let forkSessionTmpDir: string | null = null;
  let forkSessionTmpPath: string | null = null;
  let taskTmpDir: string | null = null;
  let taskArg: string;
  // Set when the fork snapshot file is shared with other concurrent tasks —
  // runAgent must not delete a file another in-flight task is reading.
  let forkSessionShared = false;
  try {
    const effectivePrompt = systemPromptOverride ?? agent.systemPrompt;
    if (effectivePrompt.trim()) {
      const tmp = writePromptToTempFile(agent.name, effectivePrompt);
      promptTmpDir = tmp.dir;
      promptTmpPath = tmp.filePath;
    }

    if (delegationMode === "fork" && forkSessionSnapshotJsonl) {
      if (forkSessionSnapshotFile) {
        // Caller-written shared snapshot (parallel fan-out): use as-is.
        forkSessionShared = true;
        forkSessionTmpDir = forkSessionSnapshotFile.dir;
        forkSessionTmpPath = forkSessionSnapshotFile.filePath;
      } else {
        const tmp = writeForkSessionToTempFile(
          agent.name,
          forkSessionSnapshotJsonl,
        );
        forkSessionTmpDir = tmp.dir;
        forkSessionTmpPath = tmp.filePath;
      }
    }

    // Route very large tasks through a temp file + @file reference (see
    // TASK_INLINE_MAX_BYTES) so they never become a single oversized argv
    // element.
    const resolvedTask = resolveTaskArg(agent.name, task);
    taskTmpDir = resolvedTask.dir;
    taskArg = resolvedTask.arg;
  } catch (err) {
    // Clean up anything this sequence already created (the caller-owned
    // shared fork snapshot is NOT one of them) — the early return below never
    // enters the outer try/finally that runs after the spawn.
    cleanupTempDir(promptTmpDir);
    if (!forkSessionShared) cleanupTempDir(forkSessionTmpDir);
    cleanupTempDir(taskTmpDir);
    return makeFailureResult(
      agent.name,
      agent.source,
      task,
      `Failed to prepare subagent files: ${
        err instanceof Error ? err.message : String(err)
      }`,
      agent.model,
    );
  }

  // One spawn attempt: fresh result object, its own event collection, and
  // its own live-update closure. Retried by withTransientRetry below.
  const runSingleAttempt = async (): Promise<SingleResult> => {
    const attemptResult: SingleResult = {
      agent: agentName,
      agentSource: agent.source,
      task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      model: agent.model,
    };

    const emitUpdate = () => {
      if (!onUpdate) return;
      onUpdate({
        content: [
          {
            type: "text",
            text: getFinalOutput(attemptResult.messages) || "(running...)",
          },
        ],
        details: makeDetails([attemptResult]),
      });
    };

    const piArgs = buildPiArgs(
      agent,
      promptTmpPath,
      taskArg,
      delegationMode,
      forkSessionTmpPath,
    );
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const nextDepth = Math.max(0, Math.floor(parentDepth)) + 1;
      const propagatedMaxDepth = Math.max(0, Math.floor(maxDepth));
      const propagatedStack = [...parentAgentStack, agentName];
      const { command, prefixArgs } = resolvePiSpawn();
      const proc = startSubprocess(command, [...prefixArgs, ...piArgs], {
        name: `subagent:${agentName}`,
        cwd: taskCwd ?? cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [SUBAGENT_DEPTH_ENV]: String(nextDepth),
          [SUBAGENT_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
          [SUBAGENT_STACK_ENV]: JSON.stringify(propagatedStack),
          [SUBAGENT_PREVENT_CYCLES_ENV]: preventCycles ? "1" : "0",
          [PI_OFFLINE_ENV]: "1",
          LITTLE_CODER_SUBAGENT: "1",
          ...env,
        },
      }).child;

      proc.stdin!.on("error", () => {
        /* ignore broken pipe on fast exits */
      });
      proc.stdin!.end();

      let buffer = "";
      let didClose = false;
      let settled = false;
      let abortHandler: (() => void) | undefined;
      let semanticCompletionTimer: NodeJS.Timeout | undefined;

      const clearSemanticCompletionTimer = () => {
        if (semanticCompletionTimer) {
          clearTimeout(semanticCompletionTimer);
          semanticCompletionTimer = undefined;
        }
      };

      const terminateChild = () => {
        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn(
              "taskkill",
              ["/T", "/F", "/PID", String(proc.pid)],
              {
                stdio: "ignore",
              },
            );
            killer.unref();
          }
          return;
        }

        proc.kill("SIGTERM");
        const sigkillTimer = setTimeout(() => {
          if (!didClose) proc.kill("SIGKILL");
        }, SIGKILL_TIMEOUT_MS);
        sigkillTimer.unref();
      };

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearSemanticCompletionTimer();
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
        resolve(code);
      };

      const flushLine = (line: string) => {
        if (processPiJsonLine(line, attemptResult)) emitUpdate();
        maybeFinishFromAgentEnd();
      };

      const flushBufferedLines = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) flushLine(line);
        }
      };

      const maybeFinishFromAgentEnd = () => {
        if (!attemptResult.sawAgentEnd || didClose || settled) return;
        clearSemanticCompletionTimer();
        semanticCompletionTimer = setTimeout(() => {
          if (didClose || settled || !attemptResult.sawAgentEnd) return;
          if (buffer.trim()) {
            flushBufferedLines(buffer);
            buffer = "";
          }
          proc.stdout!.removeListener("data", onStdoutData);
          proc.stderr!.removeListener("data", onStderrData);
          finish(0);
          terminateChild();
        }, AGENT_END_GRACE_MS);
        semanticCompletionTimer.unref();
      };

      const onStdoutData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) flushLine(line);
      };

      const onStderrData = (chunk: Buffer) => {
        attemptResult.stderr += chunk.toString();
      };

      proc.stdout!.on("data", onStdoutData);
      proc.stderr!.on("data", onStderrData);

      proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        didClose = true;
        if (buffer.trim()) flushBufferedLines(buffer);
        if (signal) {
          const signalNumber = SIGNAL_MAP[signal] ?? 0;
          attemptResult.stderr +=
            (attemptResult.stderr.trim() ? "\n" : "") +
            `Process killed by signal ${signal}.`;
          finish(128 + signalNumber);
        } else {
          finish(code ?? 0);
        }
      });

      proc.on("error", (err) => {
        attemptResult.stderr +=
          (attemptResult.stderr.trim() ? "\n" : "") + err.message;
        finish(1);
      });

      // Abort handling
      if (signal) {
        abortHandler = () => {
          if (didClose || settled) return;
          wasAborted = true;
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    attemptResult.exitCode = exitCode;
    return normalizeCompletedResult(attemptResult, wasAborted);
  };

  try {
    const { result, attempts } = await withTransientRetry(
      runSingleAttempt,
      signal,
    );
    if (attempts > 1 && isResultError(result)) {
      // Make it visible to the parent model that the failure survived the
      // full retry budget (otherwise the error text reads like a one-shot).
      const note = `after ${attempts} attempts`;
      if (
        typeof result.errorMessage === "string" &&
        result.errorMessage.trim()
      ) {
        result.errorMessage = `${result.errorMessage} (${note})`;
      } else if (typeof result.stderr === "string" && result.stderr.trim()) {
        result.stderr = `${result.stderr} (${note})`;
      }
    }
    return result;
  } finally {
    cleanupTempDir(promptTmpDir);
    if (!forkSessionShared) cleanupTempDir(forkSessionTmpDir);
    cleanupTempDir(taskTmpDir);
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 *
 * Rejection handling: each worker catches its item's rejection and records the
 * FIRST one instead of letting it escape as an unhandled rejection. On the
 * first failure the pool STOPS SCHEDULING new items (fail-fast on the
 * work-stealing loop) — a rejecting item no longer cascades into spawning
 * every remaining worker (a full pi process each, ~300–500 MB) before the
 * error surfaces. Items ALREADY in flight (≤ `concurrency` of them) keep
 * running to completion, and after ALL in-flight workers settle the first
 * recorded error is rethrown — so a failing item can never orphan siblings
 * into unhandled-rejection territory (which crashes the process under Node's
 * default handler) while still surfacing the failure to the caller.
 */
export async function mapConcurrent<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  // A non-finite concurrency (NaN from a bad caller) would make `limit` NaN
  // and `Array.from({ length: NaN })` spawn ZERO workers, resolving with a
  // sparse array of holes — silently doing nothing. Clamp to 1 instead.
  const safeConcurrency = Number.isFinite(concurrency)
    ? Math.trunc(concurrency)
    : 1;
  const limit = Math.max(1, Math.min(safeConcurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  // Once set, workers stop pulling (spawning) new items — only the already
  // in-flight ones (≤ limit) are allowed to settle.
  let scheduling = true;

  const worker = async () => {
    while (true) {
      if (!scheduling) return; // fail-fast: don't spawn more work
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (firstError === undefined) firstError = err;
        scheduling = false; // signal siblings to stop scheduling
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  if (firstError !== undefined) throw firstError;
  return results;
}
