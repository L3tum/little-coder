import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// File-stub patches: replace entire file contents (no oldText matching needed).
// These fix .ts source files shipped in node_modules that have missing dev deps,
// causing tsc errors. TypeScript's skipLibCheck only applies to .d.ts files.
const FILE_STUBS = [
  {
    name: "tsc stub: claude-agent-sdk (missing @anthropic-ai/claude-agent-sdk types)",
    path: [
      "node_modules",
      "@plannotator",
      "pi-extension",
      "generated",
      "ai",
      "providers",
      "claude-agent-sdk.ts",
    ],
    content: `export const query = {} as any;\nexport const ClaudeAgentSDK = {} as any;\nexport default {} as any;\n`,
  },
  {
    name: "tsc stub: opencode-sdk (missing @opencode-ai/sdk types)",
    path: [
      "node_modules",
      "@plannotator",
      "pi-extension",
      "generated",
      "ai",
      "providers",
      "opencode-sdk.ts",
    ],
    content: `export const OpencodeClient = {} as any;\nexport default {} as any;\n`,
  },
  {
    name: "tsc stub: html-to-markdown (missing turndown types)",
    path: [
      "node_modules",
      "@plannotator",
      "pi-extension",
      "generated",
      "html-to-markdown.ts",
    ],
    content: `export const TurndownService = class {} as any;\nexport const htmlToMarkdown = function () {} as any;\nexport default {} as any;\n`,
  },
];

export const PATCHES = [
  {
    name: "plannotator /plan canonical command shim",
    path: ["node_modules", "@plannotator", "pi-extension", "index.ts"],
    oldText: `\tpi.registerCommand("plannotator", {\n\t\tdescription: "Toggle plannotator planning mode",\n\t\thandler: async (_args, ctx) => {\n\t\t\tawait togglePlanMode(ctx);\n\t\t},\n\t});`,
    newText: `\tconst planCommandHandler = async (_args: string, ctx: ExtensionContext): Promise<void> => {\n\t\tawait togglePlanMode(ctx);\n\t};\n\n\tpi.registerCommand("plan", {\n\t\tdescription: "Toggle planning mode",\n\t\thandler: planCommandHandler,\n\t});\n\n\tpi.registerCommand("plannotator", {\n\t\tdescription: "Compatibility alias for /plan",\n\t\thandler: planCommandHandler,\n\t});`,
  },
  {
    name: "plannotator planning prompt guidance",
    path: ["node_modules", "@plannotator", "pi-extension", "index.ts"],
    oldText: `Do not run destructive commands (rm, git push, npm install, etc.) — focus on reading and exploring the codebase. Web fetching is fine.`,
    newText: `Available tools include code_search, lsp, findRead, read, bash, grep, find, ls, websearch, webfetch, EvidenceAdd, ask_user, write (markdown only), edit (markdown only), \${PLAN_SUBMIT_TOOL}\n\nDo not run destructive commands (rm, git push, npm install, etc.) — focus on reading and exploring the codebase. Use websearch/webfetch for external package, API, library, compatibility, or tool-choice research.`,
  },
  {
    name: "plannotator planning workflow tool order",
    path: ["node_modules", "@plannotator", "pi-extension", "index.ts"],
    oldText: `1. **Explore** — Use the available reading, searching, and command tools to understand the codebase. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.\n2. **Update the plan file** — After each discovery, immediately capture what you learned in the plan. Don't wait until the end. Use the available file tools to create the initial draft and make targeted updates.\n3. **Ask the user** — When you hit an ambiguity or decision you can't resolve from code alone, ask. Then go back to step 1.`,
    newText: `1. **Explore** — Prefer code_search for symbols/relationships/semantic search, then lsp for definitions/references/types/diagnostics, then bounded findRead, then targeted read. Avoid broad grep/find/read sweeps unless code-aware tools cannot answer the question. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.\n2. **Research and record evidence** — Use EvidenceAdd for any factual claim the final plan will cite. Use websearch/webfetch for external package, API, library, compatibility, or tool-choice research. Do not rely on memory for external facts that affect the plan.\n3. **Update the plan file** — After each discovery, immediately capture what you learned in the plan. Don't wait until the end. Use write for the initial draft, then edit for all subsequent updates.\n4. **Ask the user** — After code/web research, use ask_user for unresolved user decisions when available; otherwise ask plain end-of-turn questions. Then go back to step 1.`,
  },
  {
    name: "plannotator planning ask_user guidance",
    path: ["node_modules", "@plannotator", "pi-extension", "index.ts"],
    oldText: `### Asking Good Questions\n\n- Never ask what you could find out by reading the code.\n- Batch related questions together.\n- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge-case priorities.\n- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none.`,
    newText: `### Asking Good Questions\n\n- Never ask what you could find out by reading the code or researching relevant external sources.\n- Prefer ask_user for unresolved decisions when it is available; fallback to clear plain-text end-of-turn questions if not.\n- Batch related questions together and include enough context for the user to answer.\n- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge-case priorities.\n- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none.`,
  },
  {
    name: "plannotator browser URL notification",
    path: [
      "node_modules",
      "@plannotator",
      "pi-extension",
      "plannotator-browser.ts",
    ],
    oldText: `async function openBrowserForServer(serverUrl: string, ctx: ExtensionContext): Promise<void> {\n\tconst browserResult = await openBrowser(serverUrl);\n\tif (isRemoteSession()) {\n\t\tctx.ui.notify(\`[Plannotator] \${serverUrl}\`, "info");\n\t} else if (!browserResult.opened) {\n\t\tctx.ui.notify(\`Open this URL to review: \${serverUrl}\`, "info");\n\t}\n}`,
    newText: `async function openBrowserForServer(serverUrl: string, ctx: ExtensionContext): Promise<void> {\n\tctx.ui.notify(\`Plannotator listening at: \${serverUrl}\`, "info");\n\tconst browserResult = await openBrowser(serverUrl);\n\tif (!browserResult.opened) {\n\t\tctx.ui.notify(\`Open this URL to review: \${serverUrl}\`, "info");\n\t}\n}`,
  },
  {
    name: "pi-inspect clearer group labels",
    path: ["node_modules", "pi-inspect", "public", "app.js"],
    oldText: `const KIND_LABEL = { context: 'Context', tool: 'Tools', command: 'Commands', prompt: 'Prompts', skill: 'Skills' };`,
    newText: `const KIND_LABEL = { context: 'Prompt/context sent to model', tool: 'Tool definitions (provider schemas)', command: 'Commands', prompt: 'Prompts', skill: 'Skills' };`,
  },
  {
    name: "pi-inspect structured and provider context rows",
    path: ["node_modules", "pi-inspect", "public", "app.js"],
    oldText:
      String.raw`  if (s.systemPrompt) {
    for (const part of splitSystemPrompt(s.systemPrompt, s.cwd)) {
      items.push({
        kind: 'context',
        id: ` +
      "`context:${part.id}`" +
      String.raw`,
        name: part.name,
        source: ` +
      "`${part.text.length} chars`" +
      String.raw`,
        description: part.text.slice(0, 240).replace(/\s+/g, ' '),
        chars: part.text.length,
        path: part.path ?? null,
        raw: { systemPrompt: part.text, path: part.path ?? null },
      });
    }
  }
  return items;`,
    newText:
      String.raw`  if (s.systemPrompt) {
    for (const part of splitSystemPrompt(s.systemPrompt, s.cwd)) {
      items.push({
        kind: 'context',
        id: ` +
      "`context:${part.id}`" +
      String.raw`,
        name: part.name,
        source: ` +
      "`${part.text.length} chars`" +
      String.raw`,
        description: part.text.slice(0, 240).replace(/\s+/g, ' '),
        chars: part.text.length,
        path: part.path ?? null,
        raw: { label: 'System prompt section (sent as the system message)', systemPrompt: part.text, path: part.path ?? null },
      });
    }
  }
  if (s.systemPromptOptions) {
    const text = JSON.stringify(s.systemPromptOptions, null, 2);
    items.push({ kind: 'context', id: 'context:system-prompt-options', name: 'structured prompt inputs', source: ` +
      "`${text.length} chars`" +
      String.raw`, description: 'Structured inputs Pi used to build the system prompt: selected tools, snippets, context files, skills, guidelines.', chars: text.length, path: null, raw: { label: 'Structured system prompt inputs', systemPromptOptions: s.systemPromptOptions } });
  }
  if (Array.isArray(s.sessionEntries)) {
    const text = JSON.stringify(s.sessionEntries, null, 2);
    const count = s.sessionEntries.length;
    items.push({ kind: 'context', id: 'context:session-entries', name: 'current session transcript', source: ` +
      "`${count} entries · ${text.length} chars`" +
      String.raw`, description: 'Persisted conversation entries for this session, including user/assistant/tool/custom entries recorded so far.', chars: text.length, path: null, raw: { label: 'Current session transcript (persisted session entries)', sessionEntries: s.sessionEntries } });
  }
  if (s.providerPayload) {
    const text = JSON.stringify(s.providerPayload, null, 2);
    items.push({ kind: 'context', id: 'context:provider-payload', name: 'current provider request payload', source: ` +
      "`${text.length} chars`" +
      String.raw`, description: 'Closest view of the current request sent to the model, including messages and active tool schemas when the provider includes them.', chars: text.length, path: null, raw: { label: 'Current provider request payload (actual model context)', providerPayload: s.providerPayload } });
  }
  return items;`,
  },
  {
    name: "pi-vcc: defensive budget check + deferred invisible continue",
    path: [
      "node_modules",
      "@monotykamary",
      "pi-vcc",
      "src",
      "hooks",
      "before-compact.ts",
    ],
    alreadyAppliedText: [
      "Defer continue with setImmediate to avoid nested _runAgentPrompt",
    ],
    oldText: `      // Queue through Pi's native follow-up path so a concurrent user prompt
      // wins cleanly instead of racing a low-level Agent.prompt([]) call.
      triggerInvisibleContinue(pi);
    } catch {
      // Non-critical — if context inspection fails, don't block compaction
    }
  });
};`,
    newText: `      // Defer continue with setImmediate to avoid nested _runAgentPrompt.
      // The session_compact handler runs synchronously inside the compaction
      // flow; triggering sendMessage synchronously creates a nested agent loop
      // that fails with the same over-context error. setImmediate defers past
      // the current event handler so the outer call stack has unwound.
      //
      // Also check budget: if context is still too full after compaction,
      // a retry would just overflow again. Skip the continue in that case.
      setImmediate(() => {
        // Safety: session may have ended during the defer window
        if (ctx.isIdle() && !completion.willRetry) return;

        // Budget check: ensure context is small enough for the model to produce output
        const usage = ctx.getContextUsage?.();
        if (usage?.tokens != null) {
          const contextWindow = (ctx as any).model?.contextWindow ?? 0;
          const maxTokens = (ctx as any).model?.maxTokens ?? 0;
          const overhead = contextWindow > 0
            ? Math.min(32768, Math.floor(contextWindow * 0.2)) : 32768;
          const safeBudget = contextWindow - maxTokens - overhead;
          if (usage.tokens > safeBudget) {
            try {
              ctx.ui?.notify?.(
                \`pi-vcc: skipping continue — context (\${formatTokens(usage.tokens)} tok) exceeds safe budget (\${formatTokens(safeBudget)} tok)\`,
                "warning",
              );
            } catch {}
            return;
          }
        }

        triggerInvisibleContinue(pi);
      });
    } catch {
      // Non-critical — if context inspection fails, don't block compaction
    }
  });
};`,
  },
  {
    name: "pi-vcc: proactive trigger guards against double/triple compaction",
    path: [
      "node_modules",
      "@monotykamary",
      "pi-vcc",
      "src",
      "hooks",
      "proactive-threshold.ts",
    ],
    alreadyAppliedText: [
      "skipping compaction — no new messages since the last compaction",
    ],
    oldText: `/**
 * Check if a configured threshold has been crossed and trigger compaction
 * if so. Safe to call from multiple event handlers — cooldown prevents
 * double-triggering.
 */
const checkAndTrigger = (ctx: ProactiveContext, source: string) => {
  const settings = loadSettings();
  const threshold = getModelThreshold(settings, ctx.model);

  // No threshold → nothing to do (pi-core's global threshold owns it)
  if (!threshold) return;

  const contextWindow = ctx.model?.contextWindow ?? 0;
  const effectiveThreshold = resolveTriggerTokens(threshold, contextWindow);
  if (effectiveThreshold == null) return;

  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens === null) return;

  // This threshold's compaction trigger point.

  // Only trigger if context EXCEEDS the threshold.
  if (usage.tokens <= effectiveThreshold) return;

  // Cooldown guard — prevent double-trigger within 3s of last compaction.
  if (isCoolingDown()) return;

  try {
    const pct = Math.round((usage.tokens / contextWindow) * 100);
    ctx?.ui?.notify?.(\n      \`pi-vcc: [\${source}] Context at \${pct}% exceeds threshold (\${formatTokens(effectiveThreshold)} tok). Compacting...\`,\n      "info",\n    );
  } catch {}

  // Set cooldown IMMEDIATELY (before ctx.compact() runs) to prevent
  // pi-core's own _checkCompaction from also triggering compaction
  // on the same turn.
  setCooldown();

  // Mark that this compaction was triggered by us, so session_before_compact
  // doesn't cancel it if tokensBefore differs from getContextUsage().
  proactiveTriggerActive = true;

  ctx.compact?.();
};

/** Force compaction for Codex responses that report an output limit as an error. */
const triggerCodexOutputLimitCompaction = (ctx: ProactiveContext) => {
  if (isCoolingDown()) return;

  try {
    ctx?.ui?.notify?.(
      "pi-vcc: Codex reached its maximum output token limit. Compacting...",
      "info",
    );
  } catch {}

  setCooldown();
  proactiveTriggerActive = true;
  ctx.compact?.({ customInstructions: CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION });
};

/** Force compaction when Codex omits the model identity from an overflow error. */
const triggerCodexContextOverflowCompaction = (ctx: ProactiveContext) => {
  if (isCoolingDown()) return;

  try {
    ctx?.ui?.notify?.(
      "pi-vcc: Codex input exceeded the context window. Compacting...",
      "info",
    );
  } catch {}

  setCooldown();
  proactiveTriggerActive = true;
  ctx.compact?.({ customInstructions: CODEX_CONTEXT_OVERFLOW_COMPACT_INSTRUCTION });
};`,
    newText: `/**
 * Trigger a compaction through the manual path, guarding against the
 * \"Already compacted\" no-op.
 *
 * The manual compact() throws when the last branch entry is already a
 * compaction (nothing new to summarize). That happens when a compaction
 * just completed and this trigger fires again before any new message was
 * appended — e.g. agent_end right after an auto/proactive compaction, or a
 * Codex output-limit/overflow error that lands on the same boundary.
 * Skipping the call (and swallowing the benign error as a backstop) keeps
 * the session from printing a scary \"Compaction failed: Already
 * compacted\" error right after a successful compaction.
 */
const requestCompaction = (ctx: ProactiveContext, customInstructions?: string) => {
  const branch = (ctx as any)?.sessionManager?.getBranch?.();
  if (Array.isArray(branch) && branch.length > 0) {
    const last = branch[branch.length - 1];
    if (last?.type === "compaction") {
      try {
        ctx?.ui?.notify?.(
          "pi-vcc: skipping compaction — no new messages since the last compaction.",
          "info",
        );
      } catch {}
      return;
    }
  }
  ctx.compact?.({
    customInstructions,
    onError: (err: Error) => {
      const msg = err?.message ?? String(err);
      if (
        msg === "Already compacted" ||
        msg === "Nothing to compact (session too small)" ||
        msg === "Compaction cancelled"
      ) {
        return; // benign no-op — don't surface a failed-compaction error line
      }
      try {
        ctx?.ui?.notify?.(\`Compaction failed: \${msg}\`, "error");
      } catch {}
    },
  });
};

/**
 * Check if a configured threshold has been crossed and trigger compaction
 * if so. Safe to call from multiple event handlers — cooldown prevents
 * double-triggering.
 */
const checkAndTrigger = (ctx: ProactiveContext, source: string) => {
  const settings = loadSettings();
  const threshold = getModelThreshold(settings, ctx.model);

  // No threshold → nothing to do (pi-core's global threshold owns it)
  if (!threshold) return;

  const contextWindow = ctx.model?.contextWindow ?? 0;
  const effectiveThreshold = resolveTriggerTokens(threshold, contextWindow);
  if (effectiveThreshold == null) return;

  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens === null) return;

  // This threshold's compaction trigger point.

  // Only trigger if context EXCEEDS the threshold.
  if (usage.tokens <= effectiveThreshold) return;

  // Cooldown guard — prevent double-trigger within 3s of last compaction.
  if (isCoolingDown()) return;

  try {
    const pct = Math.round((usage.tokens / contextWindow) * 100);
    ctx?.ui?.notify?.(\n      \`pi-vcc: [\${source}] Context at \${pct}% exceeds threshold (\${formatTokens(effectiveThreshold)} tok). Compacting...\`,\n      "info",\n    );
  } catch {}

  // Set cooldown IMMEDIATELY (before ctx.compact() runs) to prevent
  // pi-core's own _checkCompaction from also triggering compaction
  // on the same turn.
  setCooldown();

  // Mark that this compaction was triggered by us, so session_before_compact
  // doesn't cancel it if tokensBefore differs from getContextUsage().
  proactiveTriggerActive = true;

  requestCompaction(ctx);
};

/** Force compaction for Codex responses that report an output limit as an error. */
const triggerCodexOutputLimitCompaction = (ctx: ProactiveContext) => {
  if (isCoolingDown()) return;

  try {
    ctx?.ui?.notify?.(
      "pi-vcc: Codex reached its maximum output token limit. Compacting...",
      "info",
    );
  } catch {}

  setCooldown();
  proactiveTriggerActive = true;
  requestCompaction(ctx, CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION);
};

/** Force compaction when Codex omits the model identity from an overflow error. */
const triggerCodexContextOverflowCompaction = (ctx: ProactiveContext) => {
  if (isCoolingDown()) return;

  try {
    ctx?.ui?.notify?.(
      "pi-vcc: Codex input exceeded the context window. Compacting...",
      "info",
    );
  } catch {}

  setCooldown();
  proactiveTriggerActive = true;
  requestCompaction(ctx, CODEX_CONTEXT_OVERFLOW_COMPACT_INSTRUCTION);
};`,
  },
  {
    name: "pi-vcc: proactive hook imports for pi-core threshold mirror",
    path: [
      "node_modules",
      "@monotykamary",
      "pi-vcc",
      "src",
      "hooks",
      "proactive-threshold.ts",
    ],
    alreadyAppliedText: ['import { readFileSync } from "fs";'],
    oldText: `import { loadSettings, getModelThreshold, isPiCoreCompactionEnabled, resolveTriggerTokens } from "../core/settings";`,
    newText: `import { loadSettings, getModelThreshold, isPiCoreCompactionEnabled, resolveTriggerTokens } from "../core/settings";
import { readFileSync } from "fs";
import { join } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";`,
  },
  {
    name: "pi-vcc: proactive threshold mirrors pi-core reserveTokens",
    path: [
      "node_modules",
      "@monotykamary",
      "pi-vcc",
      "src",
      "hooks",
      "proactive-threshold.ts",
    ],
    alreadyAppliedText: ["const readPiCoreReserveTokens"],
    oldText: `const hasCurrentModelIdentity = (message: unknown, model: any): boolean => {`,
    newText: `/**
 * Mirror pi-core's compaction.reserveTokens (settings-manager default
 * 16384, project overrides global). Used to detect when pi-core's own
 * _checkCompaction will fire on the same agent_end so we don't race it.
 */
const readPiCoreReserveTokens = (projectCwd?: string): number => {
  const readReserve = (path: string): number | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      const value = (parsed as any)?.compaction?.reserveTokens;
      return typeof value === "number" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  if (projectCwd) {
    const projectValue = readReserve(join(projectCwd, CONFIG_DIR_NAME, "settings.json"));
    if (typeof projectValue === "number") return projectValue;
  }
  const globalValue = readReserve(join(getAgentDir(), "settings.json"));
  if (typeof globalValue === "number") return globalValue;
  return 16384;
};

const hasCurrentModelIdentity = (message: unknown, model: any): boolean => {`,
  },
  {
    name: "pi-vcc: proactive trigger defers to pi-core threshold compaction",
    path: [
      "node_modules",
      "@monotykamary",
      "pi-vcc",
      "src",
      "hooks",
      "proactive-threshold.ts",
    ],
    alreadyAppliedText: ["pi-core runs its own threshold check"],
    oldText: `  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens === null) return;

  // This threshold's compaction trigger point.

  // Only trigger if context EXCEEDS the threshold.
  if (usage.tokens <= effectiveThreshold) return;

  // Cooldown guard — prevent double-trigger within 3s of last compaction.
  if (isCoolingDown()) return;

  try {
    const pct = Math.round((usage.tokens / contextWindow) * 100);
    ctx?.ui?.notify?.(
      \`pi-vcc: [\${source}] Context at \${pct}% exceeds threshold (\${formatTokens(effectiveThreshold)} tok). Compacting...\`,
      "info",
    );
  } catch {}`,
    newText: `  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens === null) return;

  const cwd = (ctx as any)?.sessionManager?.getCwd?.();

  // When this is the agent_end hook, pi-core runs its own threshold check
  // (compaction.reserveTokens) AFTER the extension event settles, in
  // _handlePostAgentRun. If pi-core will compact anyway, don't start a
  // redundant manual compact: the manual path suspends at abort(), pi-core
  // would append its compaction entry first, and the manual compact would
  // then resume into "Already compacted" — surfacing an error right after a
  // successful compaction. pi-core's compaction still gets the pi-vcc
  // summary (before-compact hook with overrideDefaultCompaction), so letting
  // it win loses nothing.
  if (source === "auto" && isPiCoreCompactionEnabled(cwd) && contextWindow > 0) {
    const piCoreReserveTokens = readPiCoreReserveTokens(cwd);
    if (usage.tokens > contextWindow - piCoreReserveTokens) {
      return; // pi-core compacts on this agent_end; avoid the duplicate trigger
    }
  }

  // This threshold's compaction trigger point.

  // Only trigger if context EXCEEDS the threshold.
  if (usage.tokens <= effectiveThreshold) return;

  // Cooldown guard — prevent double-trigger within 3s of last compaction.
  if (isCoolingDown()) return;

  try {
    const pct = Math.round((usage.tokens / contextWindow) * 100);
    ctx?.ui?.notify?.(
      \`pi-vcc: [\${source}] Context at \${pct}% exceeds threshold (\${formatTokens(effectiveThreshold)} tok). Compacting...\`,
      "info",
    );
  } catch {}`,
  },
  {
    name: "pi-vcc: make deferred invisible continue resilient to stale ctx",
    path: [
      "node_modules",
      "@monotykamary",
      "pi-vcc",
      "src",
      "hooks",
      "before-compact.ts",
    ],
    alreadyAppliedText: [
      "stale (session replaced/reloaded between scheduling and this callback)",
    ],
    oldText: `      // Defer continue with setImmediate to avoid nested _runAgentPrompt.
      // The session_compact handler runs synchronously inside the compaction
      // flow; triggering sendMessage synchronously creates a nested agent loop
      // that fails with the same over-context error. setImmediate defers past
      // the current event handler so the outer call stack has unwound.
      //
      // Also check budget: if context is still too full after compaction,
      // a retry would just overflow again. Skip the continue in that case.
      setImmediate(() => {
        // Safety: session may have ended during the defer window
        if (ctx.isIdle() && !completion.willRetry) return;

        // Budget check: ensure context is small enough for the model to produce output
        const usage = ctx.getContextUsage?.();
        if (usage?.tokens != null) {
          const contextWindow = (ctx as any).model?.contextWindow ?? 0;
          const maxTokens = (ctx as any).model?.maxTokens ?? 0;
          const overhead = contextWindow > 0
            ? Math.min(32768, Math.floor(contextWindow * 0.2)) : 32768;
          const safeBudget = contextWindow - maxTokens - overhead;
          if (usage.tokens > safeBudget) {
            try {
              ctx.ui?.notify?.(
                \`pi-vcc: skipping continue — context (\${formatTokens(usage.tokens)} tok) exceeds safe budget (\${formatTokens(safeBudget)} tok)\`,
                "warning",
              );
            } catch {}
            return;
          }
        }

        triggerInvisibleContinue(pi);
      });`,
    newText: `      // Defer continue with setImmediate to avoid nested _runAgentPrompt.
      // The session_compact handler runs synchronously inside the compaction
      // flow; triggering sendMessage synchronously creates a nested agent loop
      // that fails with the same over-context error. setImmediate defers past
      // the current event handler so the outer call stack has unwound.
      //
      // Also check budget: if context is still too full after compaction,
      // a retry would just overflow again. Skip the continue in that case.
      setImmediate(() => {
        try {
          // Safety: session may have ended during the defer window
          if (ctx.isIdle() && !completion.willRetry) return;

          // Budget check: ensure context is small enough for the model to produce output
          const usage = ctx.getContextUsage?.();
          if (usage?.tokens != null) {
            const contextWindow = (ctx as any).model?.contextWindow ?? 0;
            const maxTokens = (ctx as any).model?.maxTokens ?? 0;
            const overhead = contextWindow > 0
              ? Math.min(32768, Math.floor(contextWindow * 0.2)) : 32768;
            const safeBudget = contextWindow - maxTokens - overhead;
            if (usage.tokens > safeBudget) {
              try {
                ctx.ui?.notify?.(
                \`pi-vcc: skipping continue — context (\${formatTokens(usage.tokens)} tok) exceeds safe budget (\${formatTokens(safeBudget)} tok)\`,
                "warning",
              );
              } catch {}
              return;
            }
          }

          triggerInvisibleContinue(pi);
        } catch {
          // The extension ctx can become stale (session replaced/reloaded via
          // newSession/fork/switchSession/reload between scheduling and this
          // callback), which makes every ctx.* accessor throw "This extension
          // ctx is stale...". The post-compaction resume is best-effort —
          // swallow and move on instead of crashing with an uncaught error.
        }
      });`,
  },
  {
    name: "plannotator preserve user model after plan approval",
    path: ["node_modules", "@plannotator", "pi-extension", "index.ts"],
    oldText: `\tasync function applyPhaseConfig(ctx: ExtensionContext, opts: { restoreSavedState?: boolean } = {}): Promise<void> {\n\t\tconst profile = getPhaseProfile();\n\t\tif (opts.restoreSavedState !== false && savedState) {\n\t\t\tawait restoreSavedState(ctx);\n\t\t}\n\n\t\tif (phase === "planning" || phase === "executing") {`,
    newText: `\tasync function applyPhaseConfig(ctx: ExtensionContext, opts: { restoreSavedState?: boolean } = {}): Promise<void> {\n\t\tconst profile = getPhaseProfile();\n\t\t// little-coder: capture the user's model before phase profile overrides.\n\t\t// When restoreSavedState is true (plan approved), preserve the original model.\n\t\tlet littleCoderPreApplyModel: { provider: string; id: string } | null = null;\n\t\tif (opts.restoreSavedState !== false && savedState?.model) {\n\t\t\tlittleCoderPreApplyModel = { provider: savedState.model.provider, id: savedState.model.id };\n\t\t}\n\t\tif (opts.restoreSavedState !== false && savedState) {\n\t\t\tawait restoreSavedState(ctx);\n\t\t}\n\n\t\tif (phase === "planning" || phase === "executing") {`,
    alreadyAppliedText: ["littleCoderPreApplyModel"],
  },
];

export function isPatchApplied(current, patch) {
  if (current.includes(patch.newText)) return true;
  return (
    Array.isArray(patch.alreadyAppliedText) &&
    patch.alreadyAppliedText.every((text) => current.includes(text))
  );
}

export function applyTextPatch(current, patch) {
  if (isPatchApplied(current, patch)) return current;
  if (!current.includes(patch.oldText)) {
    throw new Error(`${patch.name}: expected text not found`);
  }
  return current.replace(patch.oldText, patch.newText);
}

export function applyPostinstallPatches(root = process.cwd()) {
  // Apply full file stubs (e.g. tsc type stubs for generated files)
  for (const stub of FILE_STUBS) {
    const file = join(root, ...stub.path);
    if (!existsSync(file)) continue;
    const current = readFileSync(file, "utf8");
    if (current === stub.content) continue; // already patched
    writeFileSync(file, stub.content);
  }

  // Apply text patches
  for (const patch of PATCHES) {
    const file = join(root, ...patch.path);
    if (!existsSync(file)) continue;
    const current = readFileSync(file, "utf8");
    let next;
    try {
      next = applyTextPatch(current, patch);
    } catch (e) {
      console.warn(`postinstall patch skipped: ${e.message}`);
      continue;
    }
    if (next !== current) writeFileSync(file, next);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  applyPostinstallPatches();
}
