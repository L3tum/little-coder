import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { harnessIntervention } from "../_shared/intervention.ts";

// Port of agent.py's max_turns early-break. Counts turn_start events per
// agent_start span; when the count exceeds LITTLE_CODER_MAX_TURNS (or the
// per-benchmark override injected via systemPromptOptions), calls ctx.abort()
// to halt the loop. Resets on agent_start.

let turnsThisRun = 0;
let capForRun = 0;

function envCap(): number {
  const raw = process.env.LITTLE_CODER_MAX_TURNS;
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    turnsThisRun = 0;
    const opts: any = (event as any).systemPromptOptions ?? {};
    const lcCap = Number(opts?.littleCoder?.maxTurns);
    capForRun = Number.isFinite(lcCap) && lcCap > 0 ? lcCap : envCap();
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (capForRun <= 0) return;
    turnsThisRun++;
    if (turnsThisRun > capForRun) {
      harnessIntervention(
        ctx,
        `the model hit the turn limit (${capForRun}) — stopping the run.`,
      );
      ctx.abort();
    }
  });
}
