import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { WelcomeHeader, discoverLoadedCounts, getRecentSessions } from "pi-powerline-footer/welcome.ts";
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

// Brand accent — "honey" #E15A1F from the brand book (v1.0). Emitted as a
// 24-bit truecolor SGR so the cursor matches the documented hex exactly,
// independent of the active pi theme's named "accent" colour. \x1b[39m resets
// only the foreground, leaving any surrounding bold/style intact.
const HONEY = "\x1b[38;2;225;90;31m";
const honeyFg = (s: string): string => `${HONEY}${s}\x1b[39m`;

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
  // Brand-book "prompt lockup" (the variant the brand reserves for terminals
  // and dark surfaces): a honey prompt caret, the wordmark in the foreground,
  // and the honey block cursor — "lc▌"'s ready-to-type punchline, applied to
  // the full wordmark. Honey stays the only accent, well under the brand's
  // ~10%-of-layout cap.
  const logo =
    honeyFg("> ") +
    theme.bold("little-coder") +
    honeyFg("▌") +
    theme.fg("dim", ` v${VERSION}`);
  const tagline = theme.fg("muted", TAGLINE);
  const dim = (s: string) => theme.fg("dim", s);
  const sep = theme.fg("muted", " · ");
  const extensionLine1 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/plan"),
    theme.fg("muted", " for planning mode"),
  ].join("");
  const extensionLine2 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/execute"),
    theme.fg("muted", " to execute the latest plan"),
  ].join("");
  const extensionLine3 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/review"),
    theme.fg("muted", " for read-only review mode"),
  ].join("");
  const extensionLine4 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/autoresearch"),
    theme.fg("muted", " for bounded experiment mode"),
  ].join("");
  const extensionLine5 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/plannotator"),
    theme.fg("muted", " for plan review"),
  ].join("");
  const extensionLine6 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/usage"),
    theme.fg("muted", " for the inline usage dashboard, or "),
    theme.fg("text", "/insights"),
    theme.fg("muted", " for the full report"),
  ].join("");
  const extensionLine8 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/workspace-permissions"),
    theme.fg("muted", " for workspace access policy"),
  ].join("");
  const extensionLine9 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/lsp-doctor"),
    theme.fg("muted", " or "),
    theme.fg("text", "/lsp"),
    theme.fg("muted", " to inspect usable LSP servers"),
  ].join("");
  const extensionLine10 = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/codebase"),
    theme.fg("muted", " to inspect codebase-memory"),
  ].join("");
  const reflectionLine = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/reflect"),
    theme.fg("muted", ", "),
    theme.fg("text", "/reflect-review"),
    theme.fg("muted", ", "),
    theme.fg("text", "/reflect-accept"),
    theme.fg("muted", ", "),
    theme.fg("text", "/breadcrumbs"),
    theme.fg("muted", ", and "),
    theme.fg("text", "/skills"),
    theme.fg("muted", " for reusable session learning"),
  ].join("");
  const skillLine = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/skill [name]"),
    theme.fg("muted", ", "),
    theme.fg("text", "/skill-budgets"),
    theme.fg("muted", ", and "),
    theme.fg("text", "/promote-user-skill"),
    theme.fg("muted", " to load, tune, and package skills"),
  ].join("");
  const subagentLine = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/subagent-level"),
    theme.fg("muted", ", "),
    theme.fg("text", "/subagent-model"),
    theme.fg("muted", ", and "),
    theme.fg("text", "/subagent-thinking"),
    theme.fg("muted", " to tune delegation"),
  ].join("");
  const subprocessLine = [
    theme.fg("muted", "Use "),
    theme.fg("text", "/subprocesses"),
    theme.fg("muted", " and "),
    theme.fg("text", "/subprocess"),
    theme.fg("muted", " to inspect background workers"),
  ].join("");
  const issueAgentSection = [
    theme.bold("Issue agent:"),
    [
      theme.fg("muted", "Run "),
      theme.fg("text", "/issue-agent --repos=url[,url]"),
      theme.fg("muted", " to work labeled issues"),
    ].join(""),
    [
      theme.fg("muted", "States: "),
      theme.fg("text", "ai:state/PLANNING"),
      sep,
      theme.fg("text", "WAITING_FOR_FEEDBACK"),
      sep,
      theme.fg("text", "EXECUTING"),
    ].join(""),
    [
      theme.fg("muted", "Flow: PLAN comment → wait for "),
      theme.fg("text", "/approve"),
      theme.fg("muted", " or "),
      theme.fg("text", "ai:state/EXECUTING"),
      theme.fg("muted", " → push branch and open PR"),
    ].join(""),
    [
      theme.fg("muted", "Labels: "),
      theme.fg("text", "ai:priority/N"),
      sep,
      theme.fg("text", "ai:planning-model/x"),
      sep,
      theme.fg("text", "ai:execution-model/y"),
    ].join(""),
    [
      theme.fg("muted", "Provider limits add "),
      theme.fg("text", "ai:blocked/usage-limit"),
      theme.fg("muted", ", plus provider status/retry labels"),
    ].join(""),
    [
      theme.fg("muted", "Options: "),
      theme.fg("text", "--dry-run"),
      sep,
      theme.fg("text", "--fallback-models=a,b"),
      sep,
      theme.fg("text", "--thinking-level=low"),
    ].join(""),
    [
      theme.fg("muted", "Setup: provide an API key via "),
      theme.fg("text", "--token"),
      theme.fg("muted", ", "),
      theme.fg("text", "GITHUB_TOKEN"),
      theme.fg("muted", ", or "),
      theme.fg("text", "FORGEJO_TOKEN"),
    ].join(""),
  ];
  const hints = [
    `${dim("esc")} interrupt`,
    `${dim("ctrl-l/ctrl-c")} clear/exit`,
    `${dim("/")} commands`,
    `${dim("!")} bash`,
    `${dim("ctrl-r")} more`,
  ].join(sep);
  return [
    "",
    logo,
    tagline,
    extensionLine1,
    extensionLine2,
    extensionLine3,
    extensionLine4,
    extensionLine5,
    extensionLine6,
    extensionLine8,
    extensionLine9,
    extensionLine10,
    reflectionLine,
    skillLine,
    subagentLine,
    subprocessLine,
    "",
    ...issueAgentSection,
    "",
    hints,
    "",
  ];
}

function applyBranding(ctx: { ui: { setHeader: Function; setTitle: Function }; cwd: string; model?: { name?: string; id?: string; provider?: string } }): void {
  const modelName = ctx.model?.name || ctx.model?.id || "No model";
  const providerName = ctx.model?.provider || "Unknown";
  const powerlineHeader = new WelcomeHeader(modelName, providerName, getRecentSessions(3), discoverLoadedCounts());

  ctx.ui.setHeader((_tui: unknown, theme: Theme) => ({
    render(width: number): string[] {
      return [...powerlineHeader.render(width), ...buildHeader(theme)].map((line) =>
        truncateToWidth(line, width, "…"),
      );
    },
    invalidate() {
      powerlineHeader.invalidate();
    },
  }));
  setTitleForCwd(ctx.ui.setTitle.bind(ctx.ui), ctx.cwd);
}

function setTitleForCwd(setTitle: (t: string) => void, cwd: string): void {
  setTitle(`little-coder - ${basename(cwd)}`);
}

export default function (pi: ExtensionAPI) {
  if (process.env.LITTLE_CODER_SUBAGENT === "1") return;
  // session_start fires on initial load AND on every session switch.
  // Pi's updateTerminalTitle() runs in init() *after* session_start, so our
  // setTitle here gets clobbered back to "π - <cwd>". We reassert the title
  // on turn_start and turn_end too — pi calls updateTerminalTitle at the same
  // points (interactive-mode.js:1179, 1346, 3971), so re-setting on every
  // turn keeps our "little-coder - <cwd>" winning for the duration of a
  // session.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    applyBranding(ctx);
    setTimeout(() => applyBranding(ctx), 0);
    setTimeout(() => applyBranding(ctx), 150);
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    applyBranding(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    applyBranding(ctx);
  });
}
