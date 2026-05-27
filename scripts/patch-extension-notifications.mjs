import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
    oldText: `Available tools: read, bash, grep, find, ls, write (markdown only), edit (markdown only), \${PLAN_SUBMIT_TOOL}\n\nDo not run destructive bash commands (rm, git push, npm install, etc.) — focus on reading and exploring the codebase. Web fetching (curl, wget) is fine.`,
    newText: `Available tools include code_search, lsp, findRead, read, bash, grep, find, ls, websearch, webfetch, EvidenceAdd, ask_user, write (markdown only), edit (markdown only), \${PLAN_SUBMIT_TOOL}\n\nDo not run destructive bash commands (rm, git push, npm install, etc.) — focus on reading and exploring the codebase. Use websearch/webfetch for external package, API, library, compatibility, or tool-choice research.`,
  },
  {
    name: "plannotator planning workflow tool order",
    path: ["node_modules", "@plannotator", "pi-extension", "index.ts"],
    oldText: `1. **Explore** — Use read, grep, find, ls, and bash to understand the codebase. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.\n2. **Update the plan file** — After each discovery, immediately capture what you learned in the plan. Don't wait until the end. Use write for the initial draft, then edit for all subsequent updates.\n3. **Ask the user** — When you hit an ambiguity or decision you can't resolve from code alone, ask. Then go back to step 1.`,
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
    path: ["node_modules", "@plannotator", "pi-extension", "plannotator-browser.ts"],
    oldText: `function openBrowserForServer(serverUrl: string, ctx: ExtensionContext): void {\n\tconst browserResult = openBrowser(serverUrl);\n\tif (isRemoteSession()) {\n\t\tctx.ui.notify(\`[Plannotator] \${serverUrl}\`, "info");\n\t} else if (!browserResult.opened) {\n\t\tctx.ui.notify(\`Open this URL to review: \${serverUrl}\`, "info");\n\t}\n}`,
    newText: `function openBrowserForServer(serverUrl: string, ctx: ExtensionContext): void {\n\tctx.ui.notify(\`Plannotator listening at: \${serverUrl}\`, "info");\n\tconst browserResult = openBrowser(serverUrl);\n\tif (!browserResult.opened) {\n\t\tctx.ui.notify(\`Open this URL to review: \${serverUrl}\`, "info");\n\t}\n}`,
  },
  {
    name: "pi-insights file URL notification",
    path: ["node_modules", "@observal", "pi-insights", "index.ts"],
    oldText: `\tctx.ui.notify(\`✅ Report saved: \${REPORT_PATH}\`, "success");\n\n\tif (!noOpen) {\n\t\tconst opener = platform() === "darwin" ? "open" : "xdg-open";\n\t\texecFile(opener, [REPORT_PATH]).catch(() => {\n\t\t\tctx.ui.notify(\`Open manually: \${REPORT_PATH}\`, "info");\n\t\t});\n\t}\n}`,
    newText: `\tctx.ui.notify(\`✅ Report saved: \${REPORT_PATH}\`, "success");\n\tctx.ui.notify(\`Pi Insights report URL: file://\${REPORT_PATH}\`, "info");\n\n\tif (!noOpen) {\n\t\tconst opener = platform() === "darwin" ? "open" : "xdg-open";\n\t\texecFile(opener, [REPORT_PATH]).catch(() => {\n\t\t\tctx.ui.notify(\`Open manually: file://\${REPORT_PATH}\`, "info");\n\t\t});\n\t}\n}`,
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
    oldText: String.raw`  if (s.systemPrompt) {
    for (const part of splitSystemPrompt(s.systemPrompt, s.cwd)) {
      items.push({
        kind: 'context',
        id: ` + "`context:${part.id}`" + String.raw`,
        name: part.name,
        source: ` + "`${part.text.length} chars`" + String.raw`,
        description: part.text.slice(0, 240).replace(/\s+/g, ' '),
        chars: part.text.length,
        path: part.path ?? null,
        raw: { systemPrompt: part.text, path: part.path ?? null },
      });
    }
  }
  return items;`,
    newText: String.raw`  if (s.systemPrompt) {
    for (const part of splitSystemPrompt(s.systemPrompt, s.cwd)) {
      items.push({
        kind: 'context',
        id: ` + "`context:${part.id}`" + String.raw`,
        name: part.name,
        source: ` + "`${part.text.length} chars`" + String.raw`,
        description: part.text.slice(0, 240).replace(/\s+/g, ' '),
        chars: part.text.length,
        path: part.path ?? null,
        raw: { label: 'System prompt section (sent as the system message)', systemPrompt: part.text, path: part.path ?? null },
      });
    }
  }
  if (s.systemPromptOptions) {
    const text = JSON.stringify(s.systemPromptOptions, null, 2);
    items.push({ kind: 'context', id: 'context:system-prompt-options', name: 'structured prompt inputs', source: ` + "`${text.length} chars`" + String.raw`, description: 'Structured inputs Pi used to build the system prompt: selected tools, snippets, context files, skills, guidelines.', chars: text.length, path: null, raw: { label: 'Structured system prompt inputs', systemPromptOptions: s.systemPromptOptions } });
  }
  if (s.providerPayload) {
    const text = JSON.stringify(s.providerPayload, null, 2);
    items.push({ kind: 'context', id: 'context:provider-payload', name: 'current provider request payload', source: ` + "`${text.length} chars`" + String.raw`, description: 'Closest view of the current request sent to the model, including messages and active tool schemas when the provider includes them.', chars: text.length, path: null, raw: { label: 'Current provider request payload (actual model context)', providerPayload: s.providerPayload } });
  }
  return items;`,
  },
];

export function applyTextPatch(current, patch) {
  if (current.includes(patch.newText)) return current;
  if (!current.includes(patch.oldText)) {
    throw new Error(`${patch.name}: expected text not found`);
  }
  return current.replace(patch.oldText, patch.newText);
}

export function applyPostinstallPatches(root = process.cwd()) {
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
