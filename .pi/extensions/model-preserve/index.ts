import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Preserves the user's active model across plannotator plan mode transitions.
//
// Problem: When entering /plan mode, plannotator saves the current model.
// When the plan is approved, plannotator's applyPhaseConfig restores the saved
// model, but then the phase profile's model setting can override it. Additionally,
// if the saved model reference isn't found in the registry, the restoration
// silently fails and the model defaults to the first model in the registry.
//
// Fix: This extension captures the active model before plannotator enters
// planning phase, and restores it after plan approval. It uses a higher-priority
// hook that runs after plannotator's own model restoration.

// Model reference captured before plan mode.
let prePlanModel: { provider: string; id: string } | null = null;

// Track whether we're in plan mode (plannotator phase is "planning").
let inPlanningPhase = false;

// Single startup check for pi API availability — avoids per-call overhead
let apiAvailabilityChecked = false;

function checkApiAvailability(pi: ExtensionAPI): void {
  if (apiAvailabilityChecked) return;
  apiAvailabilityChecked = true;
  const missing: string[] = [];
  if (typeof (pi as any).getCurrentModel !== "function") {
    missing.push("getCurrentModel");
  }
  if (typeof (pi as any).getModelRegistry !== "function") {
    missing.push("getModelRegistry");
  }
  if (typeof (pi as any).setModel !== "function") {
    missing.push("setModel");
  }
  if (missing.length > 0) {
    console.warn(
      `[model-preserve] pi APIs unavailable: ${missing.join(", ")}. Model preservation across plan mode requires a newer pi version.`,
    );
  }
}

export default function (pi: ExtensionAPI) {
  checkApiAvailability(pi);

  // Capture the active model when plannotator enters planning phase.
  // We detect this by checking if the plannotator system prompt is active.
  pi.on("before_agent_start", async (event) => {
    const systemPrompt = (event as any)?.systemPrompt ?? "";
    const opts = (event as any)?.systemPromptOptions ?? {};

    // Detect plannotator entering planning phase
    if (
      typeof systemPrompt === "string" &&
      systemPrompt.includes("PLANNING PHASE") &&
      !inPlanningPhase
    ) {
      inPlanningPhase = true;
      // Capture current model before plannotator potentially changes it
      try {
        const currentModel = (pi as any).getCurrentModel?.();
        if (currentModel?.provider && currentModel?.id) {
          prePlanModel = {
            provider: currentModel.provider,
            id: currentModel.id,
          };
        }
      } catch {
        // getCurrentModel may not be available in all pi versions
      }
    }

    // Detect plannotator transitioning to executing phase (plan approved)
    if (
      typeof systemPrompt === "string" &&
      systemPrompt.includes("EXECUTING PLAN") &&
      inPlanningPhase
    ) {
      // Plan was approved, we're now in executing phase.
      // Try to restore the pre-plan model.
      if (prePlanModel) {
        try {
          const modelRegistry =
            opts?.modelRegistry ?? (pi as any).getModelRegistry?.();
          if (modelRegistry) {
            const model = modelRegistry.find(
              prePlanModel.provider,
              prePlanModel.id,
            );
            if (model) {
              await (pi as any).setModel?.(model);
            }
          } else {
            // Fallback: try to set the model by provider/id
            await (pi as any).setModel?.({
              provider: prePlanModel.provider,
              id: prePlanModel.id,
            });
          }
        } catch {
          // Silently fail — model restoration is best-effort
        }
      }
      inPlanningPhase = false;
      prePlanModel = null;
    }
  });

  // Also capture on session start as a fallback
  pi.on("session_start", async () => {
    inPlanningPhase = false;
    prePlanModel = null;
  });

  // Listen for plannotator events if available
  pi.on("tool_call", async (event) => {
    // Detect plannotator_submit_plan being called — capture model before submission
    if (event.toolName === "plannotator_submit_plan") {
      try {
        const currentModel = (pi as any).getCurrentModel?.();
        if (currentModel?.provider && currentModel?.id) {
          prePlanModel = {
            provider: currentModel.provider,
            id: currentModel.id,
          };
        }
      } catch {
        // Silently ignore
      }
    }
  });
}
