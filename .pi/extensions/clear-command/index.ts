import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Adds a `/clear` command (the name users expect from other coding agents) that
// resets the session as if little-coder had been closed and relaunched.
//
// `ctx.newSession()` drives pi's full session-replacement lifecycle:
//   session_before_switch → session_shutdown → session_start{reason:"new"}
//   → resources_discover{reason:"startup"-equivalent}
// which:
//   - re-renders little-coder's branding header (branding ext hooks session_start),
//   - rebuilds the harness system prompt / AGENTS.md context from scratch,
//   - resets every session_start-scoped extension's module state
//     (quality-monitor counters, evidence store, etc.).
//
// pi already ships `/new` for this; we register `/clear` as an alias so the
// muscle-memory command works, and so the help/branding line can advertise it.
export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a fresh session — clears history and reloads context, like relaunching",
    handler: async (_args, ctx) => {
      // newSession() handles the confirm/cancel flow and the full lifecycle.
      // Returns { cancelled } if the user backed out; nothing else to do here.
      await ctx.newSession();
    },
  });
}
