import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { autoresearchModePrompt, executionModePrompt, planModePrompt, reviewModePrompt } from "./mode-prompts.js";

function latestPlan(cwd: string): string | undefined {
  const dirs = [join(cwd, "plans"), cwd];
  let newest: { path: string; mtime: number } | undefined;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/plan.*\.md$|.*\.plan\.md$|.*plan.*\.markdown$/i.test(name)) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isFile() && (!newest || st.mtimeMs > newest.mtime)) newest = { path, mtime: st.mtimeMs };
    }
  }
  return newest ? readFileSync(newest.path, "utf-8") : undefined;
}

let activeModePrompt: string | undefined;

function switchSystemPrompt(ctx: any, prompt: string): void {
  activeModePrompt = prompt;
  ctx.ui?.notify?.("Mode system prompt updated for subsequent turns.", "info");
}

export default function (pi: ExtensionAPI) {
  if (typeof (pi as any).on === "function") {
    pi.on("before_agent_start", async () => {
      if (activeModePrompt) return { systemPrompt: activeModePrompt };
    });
  }
  pi.registerCommand("plan-prompt", {
    description: "Show the legacy planning prompt without taking over /plan",
    handler: async (_args, ctx) => {
      if (process.env.LITTLE_CODER_SUBAGENT || process.env.PI_SUBAGENT_DEPTH) {
        ctx.ui?.notify?.("/plan-prompt is interactive-only and is disabled in subagent mode.", "warning");
        return;
      }
      switchSystemPrompt(ctx, planModePrompt("interactive"));
    },
  });

  pi.registerCommand("execute", {
    description: "Enter execution mode for the latest plan",
    handler: async (_args, ctx) => {
      switchSystemPrompt(ctx, executionModePrompt(latestPlan(ctx.cwd ?? process.cwd())));
    },
  });

  pi.registerCommand("review", {
    description: "Enter read-only review mode",
    handler: async (_args, ctx) => {
      switchSystemPrompt(ctx, reviewModePrompt());
    },
  });

  pi.registerCommand("autoresearch", {
    description: "Enter autoresearch mode",
    handler: async (_args, ctx) => {
      switchSystemPrompt(ctx, autoresearchModePrompt());
    },
  });
}
