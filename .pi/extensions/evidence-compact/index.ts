import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSessionStore } from "../evidence/index.ts";

// Port of compaction.py's Evidence-preservation contract.
//
// In the Python version, Evidence entries lived as tool-result content
// inside the message array, so compaction had to explicitly skip them
// (via _PRESERVE_TOOL_NAMES) and re-emit them with a bridge message. The
// TypeScript port stores Evidence in extension-state (evidence/index.ts
// `stores` map), so it survives message-array compaction automatically.
//
// This extension preserves the BEHAVIORAL contract: after compaction, the
// model sees an assistant-side bridge reminding it that its evidence is
// still addressable via EvidenceList/EvidenceGet. The exact bridge string
// matches the Python version so replay stays deterministic.

const BRIDGE_TEMPLATE = (n: number): string =>
  `[Preserved evidence from earlier in the conversation follows.] ` +
  `${n} evidence entr${n === 1 ? "y remains" : "ies remain"} available via ` +
  `EvidenceList and EvidenceGet.`;

export default function (pi: ExtensionAPI) {
  pi.on("session_compact", async (_event, ctx) => {
    try {
      const store = getSessionStore();
      if (store.length === 0) return;
      ctx.ui?.notify?.(
        `evidence-compact: ${store.length} evidence entries preserved across compaction`,
        "info",
      );
      await pi.sendUserMessage(BRIDGE_TEMPLATE(store.length), { deliverAs: "followUp" });
    } catch (err) {
      try {
        ctx.ui?.notify?.(
          `evidence-compact: bridge notification failed (${err instanceof Error ? err.message : String(err)}); evidence is still preserved`,
          "warning",
        );
      } catch {}
    }
  });
}
