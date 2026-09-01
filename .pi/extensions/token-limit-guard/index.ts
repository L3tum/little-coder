import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { harnessIntervention } from "../_shared/intervention.ts";
import {
  LENGTH_STOP_CONCISE_AT,
  LENGTH_STOP_CONTINUE_LIMIT,
  buildLengthStopConciseCorrection,
  buildLengthStopContinueNudge,
  lengthStopTierFor,
} from "../_shared/length-stop-loop.ts";
import {
  resolveLittleCoderSettings,
  resolveKey,
  getAgentDir,
  pkgSettingsRoot,
} from "../_shared/little-coder-settings.mjs";
import { isProjectTrustedFailClosed } from "../_shared/project-trust.mjs";
import { fileFreshnessKey } from "../_shared/freshness.mjs";
import { join } from "node:path";

// Dynamic import to check if compaction is enabled — avoids hard dependency
// on pi-vcc. When pi-vcc is not installed, compaction is always disabled.
let isPiCoreCompactionEnabled: ((cwd?: string) => boolean) | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vccSettings = require("@monotykamary/pi-vcc/src/core/settings");
  isPiCoreCompactionEnabled = vccSettings.isPiCoreCompactionEnabled;
} catch {
  // pi-vcc not installed — compaction always disabled (existing behavior)
}

// Test seam: overrides the pi-vcc compaction check (which cannot be
// require()'d under vitest). Production callers never use this.
let compactionCheckerOverride: ((cwd?: string) => boolean) | undefined;
export function _setCompactionCheckerForTests(
  fn: ((cwd?: string) => boolean) | undefined,
): void {
  compactionCheckerOverride = fn;
}
const isCompactionEnabled = (cwd?: string) =>
  (compactionCheckerOverride ?? isPiCoreCompactionEnabled)?.(cwd ?? "") ??
  false;

// Detects token limit errors and prevents pointless auto-retry.
//
// When a model hits its max output token limit, Pi's built-in retry logic
// (retry.enabled + maxRetries) will re-run the same request, which will
// just hit the same limit again. This extension intercepts those errors and
// is the single owner of token-limit turns (the `tokenLimitHandled` flag is
// what tells compatibility / quality-monitor to stand down).
//
// Recovery model (auto-continue ON by default): a `length` stop used to end
// the run and force the user to type "Continue". Now the first few stops
// queue a targeted resume nudge via pi.sendUserMessage(deliverAs: "steer")
// — the only public continue primitive — and the run picks up automatically.
// The consecutive-stop counter (module state here; pure tier logic in
// _shared/length-stop-loop.ts) escalates: 3 nudges → 1 "be concise"
// correction → backoff (existing abort/no-op behavior) so a pathological
// model cannot loop forever.
//
// Off switch (safety valve, not a tuning knob):
//   little_coder.token_limit_auto_continue: false   (settings files) or
//   LITTLE_CODER_TOKEN_LIMIT_AUTO_CONTINUE=0        (env)
// restores the pre-auto-continue behavior: the intervention (plus the
// abort, when compaction is disabled) fires on EVERY token-limit turn
// (handled-once-per-turn, reset by turn_start) — not once per session.
// Likewise the backoff-at-5 abort only applies when compaction is disabled:
// compaction defaults ENABLED in production (pi-vcc's
// isPiCoreCompactionEnabled returns true by default), so with it on pi-vcc
// recovers via compaction instead of the turn aborting.
//
// Ownership split: THIS extension owns length-stop recovery; quality-monitor
// owns other repeated-failure patterns and already clears its rolling state
// on length stops (it never double-steers). Note pi-core itself already
// re-issues tool calls from a truncated message
// (failToolCallsFromTruncatedMessage) — for tool-call truncations the model
// sees both that and our nudge, which is harmless; the counter incrementing
// on those stops is what fast-tracks the concise correction.
//
// Also exports `isTokenLimitError()` for use by other extensions that
// handle error turns (e.g. compatibility, quality-monitor).
//
// Steer-failure semantics (documented limitation): the try/catch around
// pi.sendUserMessage (via steer() below) covers the ONE throw the extension
// can observe — the SYNCHRONOUS stale-ctx assert (pi's ExtensionAPI
// sendUserMessage throws when the session was replaced after this handler
// was captured; dist/core/extensions/loader.js assertActive). An
// ASYNCHRONOUS failure of the steer is NOT rejected to the extension: pi's
// ExtensionAPI binding converts it into a host-side "Extension error" banner
// (runner.emitError; agent-session.js) and no extension-visible error event
// exists. Such a failure therefore ends the run idle — no retry, no
// compaction trigger, no abort — and the user must continue manually.
// That is intentionally NOT handled in-extension (there is nothing to
// catch); the abort fallback below runs only for the synchronous stale-ctx
// case.

const TOKEN_LIMIT_PATTERNS = [
  /maximum\s+(output\s+)?token\s+limit/i,
  /max_tokens/i,
  /exceeded\s+.*token/i,
  /token\s+.*exceeded/i,
];

// Structural subset of the pi extension context (avoids a pi type import in
// this module, keeping it loadable standalone). Only the members this guard
// touches are named — abort() and sessionManager.getCwd(). The real pi
// ExtensionContext satisfies this structurally (width subtyping). No index
// signature: one would make the concrete ExtensionContext unassignable.
type SteerCtx = {
  abort?: () => void;
  sessionManager?: { getCwd?: () => string | undefined };
};

/**
 * Check whether the given error message indicates a token limit breach.
 */
export function isTokenLimitError(message: string | undefined | null): boolean {
  if (!message) return false;
  return TOKEN_LIMIT_PATTERNS.some((p) => p.test(message));
}

/** Check whether a turn_end event represents a token limit error. */
function isTokenLimitTurn(event: any): boolean {
  const message = event?.message;
  if (!message) return false;
  if (message.stopReason === "length") return true;
  if (message.stopReason !== "error") return false;
  // Check the errorMessage field if present
  if (isTokenLimitError(message.errorMessage)) return true;
  // Check any text content for the error pattern
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block?.type === "text" && isTokenLimitError(block.text)) return true;
    }
  }
  return false;
}

// Module-scoped flag to ensure only one extension handles the error.
// The token-limit-guard should fire first and set this flag.
//
// Reset PER TURN (turn_start), not only on session_start — an auto-continue
// sequence is a series of token-limit turns, and every one of them must be
// handled exactly once. (The old session-start-only reset meant only the
// first token-limit event per session was handled.)
let tokenLimitHandled = false;

// Consecutive length-stop counter — owned here (not in _shared), matching
// quality-monitor's local consecutiveFailures convention.
let consecutiveLengthStops = 0;

// Session-lifetime length-stop counter. session_compact resets the
// consecutive streak, so a length-stop -> compact -> length-stop loop would
// otherwise auto-continue forever; this counter resets only on session_start
// and caps total auto-continues per session.
export const MAX_TOTAL_LENGTH_STOPS = 10;
let totalLengthStops = 0;
// De-spam flag for the session-lifetime cap: the cap intervention fires ONCE
// per session (reset in session_start ONLY — never in session_compact, the
// lifetime-counter pattern; a compaction reset would re-notify on stop 11
// and break the arithmetic).
let backoffNotified = false;

// (P1) Memo for isAutoContinueEnabled: across consecutive token-limit turns
// (the auto-continue loop re-enters this path on every stop) the settings +
// trust files are re-read + re-resolved every stop — wasted work when nothing
// changed. The memo is keyed on cwd + the freshness of those files (see
// autoContinueKey), so a settings/trust edit invalidates it. failOpenNotified
// de-spams the fail-open console.error to once per turn (reset in turn_start).
let autoContinueMemo: { key: string | null; value: boolean | null } = {
  key: null,
  value: null,
};
let failOpenNotified = false;

// Auto-continue is ON by default. `false` in the merged little_coder
// settings or the env var restore the pre-change behavior exactly.
//
// Trust-gating (mirrors bash_allow): a per-REPO value in
// <cwd>/.pi/settings.json is honored ONLY when the project is trusted —
// an untrusted repo cannot disable the safety net; in that case only the
// per-user (global) and package-shipped values apply. The env switch stays
// absolute (the user's own environment always wins).
// Freshness key over the files that gate the auto-continue decision: the
// project/global/pkg settings (resolveLittleCoderSettings) and trust.json
// (the project-trust gate, only consulted when a cwd is present). Any change
// to them changes the key, so the memo re-resolves; unchanged across
// consecutive turns => memo hit (no re-read).
function autoContinueKey(cwd?: string): string {
  let k = `auto-continue|${cwd ?? ""}|`;
  if (cwd) k += `${fileFreshnessKey(join(cwd, ".pi", "settings.json"))}|`;
  k += `${fileFreshnessKey(join(getAgentDir(), "settings.json"))}|`;
  k += `${fileFreshnessKey(join(pkgSettingsRoot(), ".pi", "settings.json"))}|`;
  if (cwd) k += `${fileFreshnessKey(join(getAgentDir(), "trust.json"))}`;
  return k;
}

function isAutoContinueEnabled(cwd?: string): boolean {
  // (P1) Freshness-keyed memo (see autoContinueKey). NOT cleared on
  // turn_start — each auto-continue stop is its own turn, so a per-turn clear
  // would defeat the cache; the freshness key is what invalidates it when a
  // settings/trust edit lands. The env switch is a launch-time constant, so
  // folding it into the memoized value is safe.
  const key = autoContinueKey(cwd);
  if (autoContinueMemo.key === key && autoContinueMemo.value !== null) {
    return autoContinueMemo.value;
  }
  let value: boolean;
  try {
    if (process.env.LITTLE_CODER_TOKEN_LIMIT_AUTO_CONTINUE === "0") {
      value = false;
    } else {
      const r = resolveLittleCoderSettings(cwd);
      // No cwd means no project scope at all → treated as untrusted (the
      // project value is absent either way).
      const trusted = cwd
        ? isProjectTrustedFailClosed(cwd, r.defaultProjectTrust)
        : false;
      const v = resolveKey(r, "token_limit_auto_continue", trusted);
      value = v !== false;
    }
  } catch (err) {
    // Deliberate fail-open — to the DEFAULT (ON), never to OFF: a
    // settings-read failure must not silently disable the output-limit
    // safety net. The trust gates elsewhere fail closed; this is the one
    // intentional fail-open, and it opens toward the safe default. It is
    // loud on purpose so a persistently unreadable settings file is not
    // invisible — but rate-limited to once per turn (the auto-continue loop
    // re-enters this path on every stop).
    if (!failOpenNotified) {
      console.error(
        `token-limit-guard: settings read failed, auto-continue stays ON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      failOpenNotified = true;
    }
    value = true;
  }
  autoContinueMemo = { key, value };
  return value;
}

export default function (pi: ExtensionAPI) {
  // Queue a steer message; on a SYNCHRONOUS throw (stale ctx — session
  // switch/fork after this handler was captured — pi's ExtensionAPI
  // sendUserMessage assertActive-throws before returning) log to stderr and
  // fall back to the pre-auto-continue outcome: abort, but only when
  // compaction is disabled (with compaction on, pi-vcc recovers on
  // agent_end, so aborting would kill a run that was going to be saved).
  // An async steer failure is not catchable here (see the module doc — it
  // surfaces as a host "Extension error" and is intentionally not handled
  // in-extension).
  const steer = (ctx: SteerCtx, label: string, message: string): void => {
    try {
      pi.sendUserMessage(message, { deliverAs: "steer" });
    } catch (err) {
      console.error(
        `token-limit-guard: ${label} steer failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      abortIfNoCompaction(cwdOf(ctx), ctx);
    }
  };

  // The pre-auto-continue fallback outcome: abort to stop Pi's auto-retry
  // from re-running the same request, unless compaction is enabled (pi-vcc
  // recovers on agent_end — firing AFTER turn_end — so aborting here would
  // kill the run compaction was going to save).
  const abortIfNoCompaction = (cwd: string | undefined, ctx: SteerCtx): void => {
    if (isCompactionEnabled(cwd)) return;
    // The error has already been surfaced by the provider; we just prevent
    // the noisy duplicate retries and steering messages.
    try {
      ctx.abort?.();
    } catch {
      // Stale ctx / unsupported — the error already printed, so this is
      // best-effort.
    }
  };

  const cwdOf = (ctx: SteerCtx): string | undefined =>
    ctx?.sessionManager?.getCwd?.();

  pi.on("session_start", async () => {
    tokenLimitHandled = false;
    consecutiveLengthStops = 0;
    totalLengthStops = 0;
    backoffNotified = false;
    // Mid-session settings edits apply on the next turn/operation (the settings resolver re-reads fresh on every call — no cache to clear).
  });

  // Post-compaction resumes can legitimately length-stop again (fresh long
  // answer in a compacted context) — mirror quality-monitor's compaction
  // grace and give them the full nudge budget again.
  // NOTE: only the STREAK resets here — totalLengthStops deliberately keeps
  // counting (the session-lifetime ceiling, see MAX_TOTAL_LENGTH_STOPS).
  pi.on("session_compact", async () => {
    consecutiveLengthStops = 0;
  });

  pi.on("turn_start", async () => {
    tokenLimitHandled = false;
    // (P1) De-spam the fail-open to once per turn. (The auto-continue memo is
    // freshness-keyed, not turn-scoped, so it is intentionally NOT cleared
    // here — a per-turn clear would defeat the cross-stop cache hit.)
    failOpenNotified = false;
  });

  pi.on("turn_end", async (event, ctx) => {
    // If another handler already handled this, skip.
    if (tokenLimitHandled) return;

    if (!isTokenLimitTurn(event)) {
      // A healthy turn breaks the consecutive-length-stop streak.
      consecutiveLengthStops = 0;
      return;
    }

    // Mark as handled so other extensions (compatibility, quality-monitor)
    // know to skip their steer/correction logic for this turn.
    tokenLimitHandled = true;
    const cwd = ctx.sessionManager?.getCwd?.();

    if (!isAutoContinueEnabled(cwd)) {
      // Pre-auto-continue behavior, verbatim.
      // If compaction is enabled (pi-vcc installed with compaction on),
      // pi-vcc will handle recovery on agent_end (which fires AFTER
      // turn_end). Don't abort — let the compaction-driven recovery proceed.
      if (isCompactionEnabled(cwd)) {
        harnessIntervention(
          ctx,
          "the model hit its maximum output token limit — compaction will recover from this.",
        );
        return;
      }
      harnessIntervention(
        ctx,
        "the model hit its maximum output token limit — this turn will not be retried (retrying the same request would hit the same limit).",
      );
      // Abort to prevent Pi's auto-retry from re-running the same request.
      // The error has already been surfaced by the provider; we just prevent
      // the noisy duplicate retries and steering messages.
      abortIfNoCompaction(cwd, ctx);
      return;
    }

    // Auto-continue path: bounded by the extended loop detector.
    consecutiveLengthStops += 1;
    totalLengthStops += 1;
    const n = consecutiveLengthStops;
    // Session-lifetime ceiling: without it, length-stop -> compact ->
    // length-stop loops reset the streak on every compaction and
    // auto-continue forever. At/over the cap, fall through to the
    // pre-auto-continue outcome (pi-vcc recovers via compaction when
    // enabled; abort otherwise) and stop steering.
    if (totalLengthStops >= MAX_TOTAL_LENGTH_STOPS) {
      // The cap is terminal for the session — the intervention fires ONCE
      // (backoffNotified, session_start-reset); abortIfNoCompaction below
      // stays unconditional.
      if (!backoffNotified) {
        harnessIntervention(
          ctx,
          `the model hit its maximum output token limit ${totalLengthStops} times this session — stopping auto-continue. Try smaller steps or set "max_tokens": 0 in the model profile (local servers only).`,
        );
        backoffNotified = true;
      }
      abortIfNoCompaction(cwd, ctx);
      return;
    }
    const tier = lengthStopTierFor(n);
    switch (tier) {
      case "continue":
        harnessIntervention(
          ctx,
          `the model hit its maximum output token limit — auto-continuing (stop ${n}/${LENGTH_STOP_CONTINUE_LIMIT}).`,
        );
        // No ctx.abort() here: aborting would kill the run the queued steer
        // is about to resume.
        // this steer is COMPLEMENTARY to pi-vcc's agent_end compaction
        // recovery (compaction is ON by default) — there is deliberately no
        // isCompactionEnabled guard here, or auto-continue would be dead in
        // the default configuration.
        steer(ctx, "continue", buildLengthStopContinueNudge(n));
        break;
      case "concise":
        harnessIntervention(
          ctx,
          `the model hit its maximum output token limit ${LENGTH_STOP_CONCISE_AT} times in a row — steering it to be more concise.`,
        );
        // as in the continue tier above — the steer nudge complements
        // pi-vcc's compaction recovery (on by default); no guard here.
        steer(ctx, "concise", buildLengthStopConciseCorrection());
        break;
      case "backoff":
        harnessIntervention(
          ctx,
          `the model hit its maximum output token limit ${n} times in a row — stopping auto-continue. Try smaller steps or set "max_tokens": 0 in the model profile (local servers only).`,
        );
        // Hand back to the existing branch behavior: with compaction enabled
        // pi-vcc recovers on agent_end; otherwise abort to stop any retry.
        abortIfNoCompaction(cwd, ctx);
        break;
    }
  });
}
