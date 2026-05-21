import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Replace pi's built-in startup header + terminal title with little-coder
// branding. The interactive TUI's "pi vX.Y.Z" logo, the "Pi can explain its
// own features..." onboarding line, and the "π - <cwd>" terminal title all
// come from pi's APP_NAME / built-in header; this extension swaps them for
// little-coder's own identity using the public ExtensionUIContext hooks.
//
// Pairs with `.pi/settings.json` setting `"quietStartup": true`, which
// suppresses pi's built-in header AND the loaded-resources dump (the long
// list of extension paths, skills, prompts, themes that used to flood the
// screen on launch). Power users can still run `little-coder --verbose` to
// override quietStartup and see the resource list.
//
// Implementation pattern follows the bundled pi example at
// `node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-header.ts` —
// the factory returns a duck-typed Component (`render(width): string[]` +
// `invalidate()`), so no deep imports from pi-tui are needed.

const TAGLINE = "A coding agent tuned for small local models";

function readVersion(): string {
  // .pi/extensions/branding/index.ts → up 3 → package root (where package.json lives).
  // The same path math works in the local checkout (loaded via tsx) and in the
  // installed npm package layout (node_modules/little-coder/.pi/extensions/branding/).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (typeof pkg?.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    // best-effort; fall through
  }
  return "0.0.0";
}

const VERSION = readVersion();

function buildHeader(theme: Theme): string[] {
  const logo =
    theme.bold(theme.fg("accent", "little-coder")) +
    theme.fg("dim", ` v${VERSION}`);
  const tagline = theme.fg("muted", TAGLINE);
  const dim = (s: string) => theme.fg("dim", s);
  const sep = theme.fg("muted", " · ");
  const extensionLine1 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/caveman full"),
    theme.fg("muted", " for terse mode"),
    sep,
    theme.fg("text", "/plannotator"),
    theme.fg("muted", " or "),
    theme.fg("text", "--plan"),
    theme.fg("muted", " for plan review"),
  ].join("");
  const extensionLine2 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "todo"),
    theme.fg("muted", " / "),
    theme.fg("text", "/todos"),
    theme.fg("muted", " to track steps"),
    sep,
    theme.fg("text", "Alt+S"),
    theme.fg("muted", " to stash editor text"),
  ].join("");
  const extensionLine3 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/workspace-permissions"),
    theme.fg("muted", " for out-of-workspace file access policy"),
  ].join("");
  const hints = [
    `${dim("esc")} interrupt`,
    `${dim("ctrl-l/ctrl-c")} clear/exit`,
    `${dim("/")} commands`,
    `${dim("!")} bash`,
    `${dim("ctrl-r")} more`,
  ].join(sep);
  return ["", logo, tagline, extensionLine1, extensionLine2, extensionLine3, "", hints, ""];
}

function applyHeader(ctx: { ui: { setHeader: Function; setTitle: Function }; cwd: string }): void {
  ctx.ui.setHeader((_tui: unknown, theme: Theme) => ({
    render(_width: number): string[] {
      return buildHeader(theme);
    },
    invalidate() {},
  }));
  setTitleForCwd(ctx.ui.setTitle.bind(ctx.ui), ctx.cwd);
}

function setTitleForCwd(setTitle: (t: string) => void, cwd: string): void {
  setTitle(`little-coder - ${basename(cwd)}`);
}

export default function (pi: ExtensionAPI) {
  // session_start fires on initial load AND on every session switch.
  // Pi's updateTerminalTitle() runs in init() *after* session_start, so our
  // setTitle here gets clobbered back to "π - <cwd>". We reassert the title
  // on turn_start and turn_end too — pi calls updateTerminalTitle at the same
  // points (interactive-mode.js:1179, 1346, 3971), so re-setting on every
  // turn keeps our "little-coder - <cwd>" winning for the duration of a
  // session.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    applyHeader(ctx);
    setTimeout(() => applyHeader(ctx), 0);
    setTimeout(() => applyHeader(ctx), 150);
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    applyHeader(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    applyHeader(ctx);
  });
}
