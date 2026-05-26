import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function replaceOnce(file, oldText, newText) {
  if (!existsSync(file)) return;
  const current = readFileSync(file, "utf8");
  if (current.includes(newText)) return;
  if (!current.includes(oldText)) return;
  writeFileSync(file, current.replace(oldText, newText));
}

replaceOnce(
  join(root, "node_modules", "@plannotator", "pi-extension", "plannotator-browser.ts"),
  `function openBrowserForServer(serverUrl: string, ctx: ExtensionContext): void {\n\tconst browserResult = openBrowser(serverUrl);\n\tif (isRemoteSession()) {\n\t\tctx.ui.notify(\`[Plannotator] \${serverUrl}\`, "info");\n\t} else if (!browserResult.opened) {\n\t\tctx.ui.notify(\`Open this URL to review: \${serverUrl}\`, "info");\n\t}\n}`,
  `function openBrowserForServer(serverUrl: string, ctx: ExtensionContext): void {\n\tctx.ui.notify(\`Plannotator listening at: \${serverUrl}\`, "info");\n\tconst browserResult = openBrowser(serverUrl);\n\tif (!browserResult.opened) {\n\t\tctx.ui.notify(\`Open this URL to review: \${serverUrl}\`, "info");\n\t}\n}`,
);

replaceOnce(
  join(root, "node_modules", "@observal", "pi-insights", "index.ts"),
  `\tctx.ui.notify(\`✅ Report saved: \${REPORT_PATH}\`, "success");\n\n\tif (!noOpen) {\n\t\tconst opener = platform() === "darwin" ? "open" : "xdg-open";\n\t\texecFile(opener, [REPORT_PATH]).catch(() => {\n\t\t\tctx.ui.notify(\`Open manually: \${REPORT_PATH}\`, "info");\n\t\t});\n\t}\n}`,
  `\tctx.ui.notify(\`✅ Report saved: \${REPORT_PATH}\`, "success");\n\tctx.ui.notify(\`Pi Insights report URL: file://\${REPORT_PATH}\`, "info");\n\n\tif (!noOpen) {\n\t\tconst opener = platform() === "darwin" ? "open" : "xdg-open";\n\t\texecFile(opener, [REPORT_PATH]).catch(() => {\n\t\t\tctx.ui.notify(\`Open manually: file://\${REPORT_PATH}\`, "info");\n\t\t});\n\t}\n}`,
);
