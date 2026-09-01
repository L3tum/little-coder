// Extended loop-detector state for consecutive output-token-length stops.
//
// Owns the counter + tier escalation used by token-limit-guard's
// auto-continue: the first few `stopReason: "length"` stops resume the run
// with a targeted nudge, a 4th in a row escalates to a "be concise"
// correction, and a 5th+ backs off (hands back to the pre-existing
// abort/no-op behavior). The counter/tier semantics mirror quality-monitor's
// consecutiveFailures / MAX_CONSECUTIVE_CORRECTIONS pattern — this is the
// "expand the loop detector" mechanism, not a new toggle.
//
// State lives in the CONSUMER (token-limit-guard owns the counter + its
// resets, matching quality-monitor's local consecutiveFailures) — _shared
// stays stateless so per-extension jiti instances can't diverge. No pi
// runtime imports: unit-testable and cheap under jiti.
//
// Ownership split (documented in both extensions): token-limit-guard owns
// length-stop recovery (auto-continue/correction/backoff); quality-monitor
// owns other repeated-failure patterns and already clears its rolling state
// on length stops, so the two never double-steer.

export const LENGTH_STOP_CONTINUE_LIMIT = 3;
export const LENGTH_STOP_CONCISE_AT = 4;

export type LengthStopTier = "continue" | "concise" | "backoff";

/** Pure tier decision for a consecutive-stop count (callers pass count >= 1).
 * The counter and its resets live in the CONSUMER (token-limit-guard),
 * matching quality-monitor's local consecutiveFailures — _shared stays
 * stateless so per-extension jiti instances can't diverge.
 *
 *   1-3 -> "continue" (auto-resume with a targeted nudge)
 *   4   -> "concise"  (steer a "be concise / split the work" correction)
 *   >=5 -> "backoff"  (stop auto-continuing; existing abort/no-op applies)
 */
export function lengthStopTierFor(count: number): LengthStopTier {
  if (count <= LENGTH_STOP_CONTINUE_LIMIT) return "continue";
  // the concise tier is intentional (documented UX decision), keep the
  // 4-stop threshold
  if (count === LENGTH_STOP_CONCISE_AT) return "concise";
  return "backoff";
}

/**
 * Targeted resume nudge — NOT a bare "Continue". Tells the model exactly what
 * happened and how to proceed without restating what it already wrote. From
 * the 2nd stop on, also nudges toward smaller steps (the truncation is
 * repeating, so the same-sized output will keep failing).
 */
export function buildLengthStopContinueNudge(n: number): string {
  const base =
    "Your previous reply was cut off because it reached the maximum output " +
    "token limit. Resume exactly where you stopped — finish the sentence or " +
    "the tool call in progress. Do not restate what you already wrote. Keep " +
    "the reply as short as possible while making progress.";
  if (n >= 2) {
    return base + " Consider splitting the remaining work into smaller steps.";
  }
  return base;
}

/** Concise-work correction for the LENGTH_STOP_CONCISE_AT-th consecutive
 *  length stop. */
export function buildLengthStopConciseCorrection(): string {
  return (
    `STOP: you have hit the maximum output token limit ${LENGTH_STOP_CONCISE_AT} times in a row. ` +
    "Be concise: one small step per turn. Split the work into smaller tool " +
    "calls and smaller edits, and stop well before the output limit instead " +
    "of streaming one long response."
  );
}
