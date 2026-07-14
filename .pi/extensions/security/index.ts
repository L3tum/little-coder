// Source: https://github.com/michalvavra/agents/blob/main/agents/pi/extensions/security.ts
// Integrated for little-coder; keep this source marker for future updates.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

/**
 * Comprehensive security hook:
 * - Blocks dangerous bash commands (rm -rf, sudo, chmod 777, etc.)
 * - Protects sensitive paths from writes (.env, node_modules, .git, keys)
 */
export default function (pi: ExtensionAPI) {
  const dangerousCommands = [
    { pattern: /\brm\s+(-[^\s]*r|--recursive)/, desc: "recursive delete" },
    { pattern: /\bsudo\b/, desc: "sudo command" },
    { pattern: /\b(chmod|chown)\b.*777/, desc: "dangerous permissions" },
    { pattern: /\bmkfs\b/, desc: "filesystem format" },
    { pattern: /\bdd\b.*\bof=\/dev\//, desc: "raw device write" },
    { pattern: />\s*\/dev\/sd[a-z]/, desc: "raw device overwrite" },
    { pattern: /\bkill\s+-9\s+-1\b/, desc: "kill all processes" },
    { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, desc: "fork bomb" },
    { pattern: /\bgit\s+clean\s+[^;&|]*-[^;&|]*[df]/, desc: "destructive git clean" },
    { pattern: /\bgit\s+reset\s+--hard\b/, desc: "destructive git reset" },
    { pattern: /\bgit\s+push\b[^;&|]*\s(?:--force|-f)\b/, desc: "force push" },
  ];

  const protectedPaths = [
    { pattern: /(^|\/)\.env($|\.(?!example$))/, desc: "environment file" },
    { pattern: /(^|\/)\.dev\.vars($|\.[^/]+$)/, desc: "dev vars file" },
    { pattern: /(^|\/)node_modules\//, desc: "node_modules" },
    { pattern: /^\.git\/|\/\.git\//, desc: "git directory" },
    { pattern: /\.pem$|\.key$/, desc: "private key file" },
    { pattern: /(^|\/)id_rsa$|(^|\/)id_ed25519$|(^|\/)id_ecdsa$/, desc: "SSH key" },
    { pattern: /(^|\/)\.ssh\//, desc: ".ssh directory" },
    { pattern: /(^|\/)secrets?\.(json|ya?ml|toml)$/i, desc: "secrets file" },
    { pattern: /(^|\/)credentials/i, desc: "credentials file" },
  ];

  const softProtectedPaths = [
    { pattern: /package-lock\.json$/, desc: "package-lock.json" },
    { pattern: /yarn\.lock$/, desc: "yarn.lock" },
    { pattern: /pnpm-lock\.yaml$/, desc: "pnpm-lock.yaml" },
  ];

  const protectedShellPath = String.raw`(?:\.\/)?(?:[^\s;&|<>]*\/)?(?:\.env(?:\.(?!example\b)[^\s;&|<>]+)?|\.dev\.vars(?:\.[^\s;&|<>]+)?|[^\s;&|<>]+\.(?:pem|key))`;
  const dangerousBashWrites = [
    new RegExp(String.raw`(?:>|>>|1>|2>|&>|tee\s+(?:-[a-zA-Z]+\s+)*)\s*${protectedShellPath}`),
    new RegExp(String.raw`\b(?:cp|mv)\b[^;&|]*\s${protectedShellPath}(?:\s|$)`),
    new RegExp(String.raw`\bcat\b[^;&|]*(?:>|>>)\s*${protectedShellPath}`),
  ];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const command = event.input.command as string;
      for (const { pattern, desc } of dangerousCommands) {
        if (pattern.test(command)) {
          if (!ctx.hasUI) return { block: true, reason: `Blocked ${desc} (no UI to confirm)` };
          const ok = await ctx.ui.confirm(`Dangerous command: ${desc}`, command);
          if (!ok) return { block: true, reason: `Blocked ${desc} by user` };
          break;
        }
      }
      for (const pattern of dangerousBashWrites) {
        if (pattern.test(command)) {
          if (ctx.hasUI) ctx.ui.notify("Blocked bash write to protected path", "warning");
          return { block: true, reason: "Bash command writes to protected path" };
        }
      }
      return undefined;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = event.input.path as string;
      const normalizedPath = path.normalize(filePath);
      for (const { pattern, desc } of protectedPaths) {
        if (pattern.test(normalizedPath)) {
          if (ctx.hasUI) ctx.ui.notify(`Blocked write to ${desc}: ${filePath}`, "warning");
          return { block: true, reason: `Protected path: ${desc}` };
        }
      }
      for (const { pattern, desc } of softProtectedPaths) {
        if (pattern.test(normalizedPath)) {
          if (!ctx.hasUI) return { block: true, reason: `Protected path (no UI): ${desc}` };
          const ok = await ctx.ui.confirm(`Modifying ${desc}`, `Are you sure you want to modify ${filePath}?`);
          if (!ok) return { block: true, reason: `User blocked write to ${desc}` };
          break;
        }
      }
    }
    return undefined;
  });
}
