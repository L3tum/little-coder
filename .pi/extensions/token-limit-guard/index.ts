import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { harnessIntervention } from "../_shared/intervention.ts";

// Detects token limit errors and prevents pointless auto-retry.
//
// When a model hits its max output token limit, Pi's built-in retry logic
// (retry.enabled + maxRetries) will re-run the same request, which will
// just hit the same limit again. This extension intercepts those errors,
// surfaces a single clean message, and aborts the turn to prevent retry.
//
// Also exports `isTokenLimitError()` for use by other extensions that
// handle error turns (e.g. compatibility, quality-monitor).

const TOKEN_LIMIT_PATTERNS = [
  /maximum\s+(output\s+)?token\s+limit/i,
  /max_tokens/i,
  /exceeded\s+.*token/i,
  /token\s+.*exceeded/i,
];

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
let tokenLimitHandled = false;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    tokenLimitHandled = false;
  });

  pi.on("turn_end", async (event, ctx) => {
    // If another handler already handled this, skip.
    if (tokenLimitHandled) return;

    if (!isTokenLimitTurn(event)) return;

    // Mark as handled so other extensions (compatibility, quality-monitor)
    // know to skip their steer/correction logic for this turn.
    tokenLimitHandled = true;

    harnessIntervention(
      ctx,
      "the model hit its maximum output token limit — this turn will not be retried (retrying the same request would hit the same limit).",
    );

    // Abort to prevent Pi's auto-retry from re-running the same request.
    // The error has already been surfaced by the provider; we just prevent
    // the noisy duplicate retries and steering messages.
    try {
      ctx.abort();
    } catch {
      // Stale ctx / unsupported — the error already printed, so this is best-effort.
    }
  });
}
