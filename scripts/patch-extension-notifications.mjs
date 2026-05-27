import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PATCHES = [
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
