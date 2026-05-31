import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFile } from "./frontmatter.ts";

export interface SkillEntry {
  name: string;
  type: string;
  sourceDir: string;
  origin: "repo" | "user";
  path: string;
  body: string;
  tokenCost: number;
  targetTool?: string;
  description?: string;
  keywords: string[];
  requiresTools: string[];
}

const toolSkills = new Map<string, SkillEntry>();
const explicitSkills = new Map<string, SkillEntry>();
const allSkills: SkillEntry[] = [];
const selectionCache = new Map<string, string>();
let loaded = false;
const recentToolCalls: string[] = [];
let lastFailedTool: string | null = null;
let userTurn = 0;
let longConversationLastWarnTurn = -999;
const recentInjected = new Map<string, number>();
const COOLDOWN_TURNS = 3;

const RESEARCH_TRIGGERS = [/\bbrows(?:e|ing|er)\b/i, /\bonline\b/i, /\bresearch(?:ing)?\b/i, /\blook\s+up\b/i, /\blookup\b/i, /\bsearch\s+(?:the|for)\b/i, /\bweb\s*search\b/i, /\bwikipedia\b/i, /\bwebsite\b/i, /\bweb\s*page\b/i, /\bgoogle\b/i, /\bcite|citation\b/i, /\bfact[-\s]?check/i];
const REVIEW_TRIGGERS = [/\bcode\s+review\b/i, /\breview\s+mode\b/i, /\breview(?:ing)?\s+(?:this\s+|the\s+)?(?:code|diff|pr|pull\s+request|merge\s+request|change|changes|uncommitted\s+changes)\b/i, /\breview(?:ing)?\s+.*\bchanges\b/i, /\b(?:pr|pull\s+request|merge\s+request)\s+review\b/i, /\brequest\s+changes\b/i, /\bapprove\s+(?:this\s+)?(?:pr|pull\s+request|merge\s+request|change|changes)\b/i];
const RESEARCH_DIRECTIVE = ["", "## Research-first directive", "This task involves online research.", "1. If Browser* tools are not active yet, call enableBrowserTools first.", "2. Gather facts with BrowserNavigate / BrowserExtract (or websearch for first hops).", "3. Save each citable fact via EvidenceAdd before relying on it.", "4. Only then answer or make file edits.", ""].join("\n");
const MIN_SCORE_THRESHOLD = 2.0;
const PER_ENTRY_CAP = 150;

function repoSkillsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
}

function userSkillsRoot(): string {
  return join(homedir(), ".pi", "skills");
}

function settingsPath(): string { return join(homedir(), ".pi", "agent", "settings.json"); }
function readSettings(): any { try { return JSON.parse(readFileSync(settingsPath(), "utf-8")); } catch { return {}; } }
function writeSettings(settings: any): void { mkdirSync(dirname(settingsPath()), { recursive: true }); writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n"); }
function littleCoderSettings(): any { const s = readSettings(); s.little_coder ??= {}; return s; }
function persistedBudget(key: "knowledgeTokenBudget" | "skillTokenBudget"): number | undefined {
  const lc = readSettings()?.little_coder ?? {};
  const snakeKey = key === "knowledgeTokenBudget" ? "knowledge_token_budget" : "skill_token_budget";
  const value = lc[key] ?? lc[snakeKey];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function setPersistedBudgets(knowledgeTokenBudget: number, skillTokenBudget: number): void {
  const s = littleCoderSettings();
  s.little_coder.knowledgeTokenBudget = knowledgeTokenBudget;
  s.little_coder.skillTokenBudget = skillTokenBudget;
  writeSettings(s);
}

function inferType(sourceDir: string, fmType: unknown): string {
  if (typeof fmType === "string" && fmType) return fmType;
  if (sourceDir === "tools") return "tool";
  if (sourceDir === "knowledge") return "knowledge";
  if (sourceDir === "protocols") return "protocol";
  return sourceDir || "skill";
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) out.push(...walkMarkdown(path));
      else if (name.endsWith(".md")) out.push(path);
    } catch {}
  }
  return out;
}

function loadSkills(): void {
  if (loaded) return;
  loaded = true;
  const roots = [
    { root: repoSkillsRoot(), origin: "repo" as const },
    { root: userSkillsRoot(), origin: "user" as const },
  ];
  for (const { root, origin } of roots) {
    for (const path of walkMarkdown(root)) {
      const parsed = parseSkillFile(readFileSync(path, "utf-8"));
      if (!parsed?.body) continue;
      const fm = parsed.frontmatter;
      const rel = relative(root, path).split(/[\\/]/);
      const sourceDir = origin === "user" ? "user" : (rel[0] || basename(dirname(path)));
      const type = inferType(sourceDir, fm.type);
      const targetTool = typeof fm.target_tool === "string" && fm.target_tool ? fm.target_tool : undefined;
      const name = (typeof fm.name === "string" && fm.name) || (typeof fm.topic === "string" && fm.topic) || targetTool || basename(path, ".md");
      const description = typeof fm.description === "string" && fm.description ? fm.description : firstBodyLine(parsed.body);
      let tokenCost = typeof fm.token_cost === "number" ? fm.token_cost : 150;
      if (type !== "tool" && tokenCost > PER_ENTRY_CAP) tokenCost = PER_ENTRY_CAP;
      const keywords = Array.isArray(fm.keywords) ? (fm.keywords as string[]).map((k) => k.toLowerCase()) : [];
      const requiresTools = Array.isArray(fm.requires_tools) ? (fm.requires_tools as string[]) : [];
      const entry = { name, type, sourceDir, origin, path, body: parsed.body, tokenCost, targetTool, description, keywords, requiresTools };
      allSkills.push(entry);
      explicitSkills.set(`${origin}:${name}`, entry);
      explicitSkills.set(`${origin}:${name.toLowerCase()}`, entry);
      if (origin === "user" || !explicitSkills.has(name)) {
        explicitSkills.set(name, entry);
        explicitSkills.set(name.toLowerCase(), entry);
      }
      if (targetTool && (origin === "user" || !toolSkills.has(targetTool))) toolSkills.set(targetTool, entry);
    }
  }
}

function firstBodyLine(body: string): string | undefined {
  return body.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean)?.slice(0, 140);
}

export function predictTools(userText: string, skills: SkillEntry[] = allSkills): string[] {
  const scored = skills
    .filter((s) => s.targetTool)
    .map((entry) => ({ entry, score: scoreEntry(userText, entry) }))
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score || (a.entry.origin === "user" ? -1 : 1));
  const predicted: string[] = [];
  for (const { entry } of scored) {
    if (entry.targetTool && !predicted.includes(entry.targetTool)) predicted.push(entry.targetTool);
  }
  return predicted;
}

function scoreEntry(userText: string, e: SkillEntry): number {
  if (e.keywords.length === 0) return 0;
  const textLower = userText.toLowerCase();
  const words = new Set(textLower.split(/\s+/).filter(Boolean));
  let score = 0;
  for (const kw of e.keywords) score += kw.includes(" ") ? (textLower.includes(kw) ? 2 : 0) : (words.has(kw) ? 1 : 0);
  if (e.keywords.some((kw) => kw === "code review" || kw === "pr review") && REVIEW_TRIGGERS.some((re) => re.test(userText))) score += 2;
  return score;
}

function selectToolSkills(prompt: string, budget: number, allowed?: Set<string>, required: string[] = []): { selected: SkillEntry[]; skippedBudget: SkillEntry[]; suppressedRecent: SkillEntry[] } {
  const selected: SkillEntry[] = [];
  const skippedBudget: SkillEntry[] = [];
  const suppressedRecent: SkillEntry[] = [];
  let used = 0;
  const tryAdd = (name: string, force = false): void => {
    const sk = toolSkills.get(name);
    if (!sk || selected.includes(sk) || skippedBudget.includes(sk) || suppressedRecent.includes(sk)) return;
    if (allowed && !allowed.has(name)) return;
    const recent = recentInjected.get(sk.name);
    if (!force && recent !== undefined && userTurn - recent < COOLDOWN_TURNS) {
      suppressedRecent.push(sk);
      return;
    }
    if (!force && used + sk.tokenCost > budget) {
      skippedBudget.push(sk);
      return;
    }
    selected.push(sk);
    used += sk.tokenCost;
  };
  for (const t of required) tryAdd(t, true);
  if (lastFailedTool) tryAdd(lastFailedTool, true);
  for (const name of recentToolCalls.slice(0, 4)) tryAdd(name);
  for (const name of predictTools(prompt)) tryAdd(name);
  return { selected, skippedBudget, suppressedRecent };
}

function selectReferenceSkills(prompt: string, budget: number): { selected: SkillEntry[]; skippedBudget: SkillEntry[] } {
  const scored = allSkills
    .filter((s) => !s.targetTool)
    .map((entry) => ({ entry, score: scoreEntry(prompt, entry) }))
    .filter((x) => x.score >= MIN_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  const selected: SkillEntry[] = [];
  const skippedBudget: SkillEntry[] = [];
  let used = 0;
  for (const { entry } of scored) {
    if (used + entry.tokenCost > budget) {
      skippedBudget.push(entry);
      continue;
    }
    selected.push(entry);
    used += entry.tokenCost;
  }
  return { selected, skippedBudget };
}

function looksLikeResearchTask(text: string): boolean {
  return !!text && RESEARCH_TRIGGERS.some((re) => re.test(text));
}

function looksLikeReviewTask(text: string): boolean {
  return !!text && REVIEW_TRIGGERS.some((re) => re.test(text));
}

function buildBlock(tools: SkillEntry[], refs: SkillEntry[]): string {
  let out = "";
  if (tools.length > 0) {
    out += "\n\n## Tool Usage Guidance\n";
    for (const s of tools) out += `\n### ${s.targetTool}\n${s.body}\n`;
  }
  if (refs.length > 0) {
    out += "\n\n## Skill Reference\n";
    for (const s of refs) out += `\n### ${s.name}\n${s.body}\n`;
  }
  return out;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function explicitSkillPrompt(skill: SkillEntry): string {
  const title = skill.targetTool ?? skill.name;
  return [`The user explicitly loaded skill '${skill.name}' via /skill:${skill.name}.`, `Apply this skill guidance for the next response:`, ``, `## ${title}`, skill.body].join("\n");
}

function findExplicitSkill(name: string): SkillEntry | undefined {
  loadSkills();
  const key = name.trim();
  return explicitSkills.get(key) ?? explicitSkills.get(key.toLowerCase());
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    const st = statSync(from);
    if (st.isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

function promotableUserSkills(): SkillEntry[] {
  loadSkills();
  return allSkills.filter((s) => s.origin === "user" && !allSkills.some((r) => r.origin === "repo" && r.name === s.name));
}

function listPromotableUserSkills(): string {
  const skills = promotableUserSkills();
  if (skills.length === 0) return "No user skills are promotable; every user skill name already exists in repo skills.";
  return ["Promotable user skills:", ...skills.map((s) => `  ${s.name} — ${s.description ?? s.type}`)].join("\n");
}

function listAllSkills(): string {
  loadSkills();
  if (allSkills.length === 0) return "No skills loaded.";
  const groups = new Map<string, SkillEntry[]>();
  for (const s of allSkills) {
    const key = s.sourceDir || s.type;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const lines: string[] = [];
  for (const [group, entries] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${group}:`);
    for (const s of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const label = s.targetTool ? `${s.name} -> ${s.targetTool}` : s.name;
      const desc = s.description ? ` — ${s.description}` : "";
      lines.push(`  ${label} (${s.tokenCost} tok, ${s.origin})${desc}`);
    }
    lines.push("");
  }
  lines.push(`Total: ${allSkills.length} entries`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  loadSkills();

  const loadExplicitSkill = (skill: SkillEntry, ctx: any): void => {
    pi.sendUserMessage(explicitSkillPrompt(skill), { deliverAs: "steer" });
    if (ctx.hasUI) ctx.ui.notify(`Loaded skill: ${skill.name}`, "info");
  };

  pi.registerCommand("skill-budgets", {
    description: "Set persisted skill injection budgets: /skill-budgets <knowledge-tokens> <tool-tokens>",
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const currentKnowledge = persistedBudget("knowledgeTokenBudget") ?? 200;
      const currentTools = persistedBudget("skillTokenBudget") ?? 300;
      if (parts.length === 0) {
        ctx.ui?.notify?.(`Skill injection budgets: knowledge=${currentKnowledge}, tools=${currentTools}. Usage: /skill-budgets <knowledge-tokens> <tool-tokens>`, "info");
        return;
      }
      if (parts.length !== 2) {
        ctx.ui?.notify?.("Usage: /skill-budgets <knowledge-tokens> <tool-tokens>", "warning");
        return;
      }
      const knowledge = Number(parts[0]);
      const tools = Number(parts[1]);
      if (!Number.isInteger(knowledge) || !Number.isInteger(tools) || knowledge < 0 || tools < 0) {
        ctx.ui?.notify?.("Budgets must be non-negative integer token counts.", "warning");
        return;
      }
      setPersistedBudgets(knowledge, tools);
      ctx.ui?.notify?.(`Skill injection budgets set to knowledge=${knowledge}, tools=${tools}.`, "info");
    },
  });

  pi.registerCommand("skills", {
    description: "List all available skills",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(listAllSkills(), "info");
    },
  });

  pi.registerCommand("promote-user-skill", {
    description: "Copy a user-level skill into repo skills/user/ after duplicate checks",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      if (!raw) {
        ctx.ui?.notify?.(listPromotableUserSkills(), "info");
        return;
      }
      const force = /(?:^|\s)--force(?:\s|$)/.test(raw);
      const name = raw.replace(/(?:^|\s)--force(?:\s|$)/g, " ").trim();
      const skill = allSkills.find((s) => s.origin === "user" && s.name === name);
      if (!skill) {
        ctx.ui?.notify?.(`Unknown user skill: ${name}`, "error");
        return;
      }
      const sameName = allSkills.find((s) => s.origin === "repo" && s.name === skill.name);
      if (sameName && !force) {
        ctx.ui?.notify?.(`Repo skill named '${skill.name}' already exists. Use --force with a renamed user skill; not overwriting.`, "warning");
        return;
      }
      const nearDup = allSkills.find((s) => s.origin === "repo" && s.description && skill.description && s.description.toLowerCase() === skill.description.toLowerCase());
      if (nearDup && !force) {
        ctx.ui?.notify?.(`Possible duplicate of repo skill '${nearDup.name}' by description. Rename/refine it or rerun with --force.`, "warning");
        return;
      }
      const srcDir = statSync(skill.path).isDirectory() ? skill.path : dirname(skill.path);
      const dest = join(repoSkillsRoot(), "user", skill.name);
      if (existsSync(dest) && !force) {
        ctx.ui?.notify?.(`Destination exists: ${dest}. Not overwriting; use --force only after resolving conflicts.`, "warning");
        return;
      }
      copyDir(srcDir, dest);
      ctx.ui?.notify?.(`Promoted user skill '${skill.name}' to ${dest}`, "info");
    },
  });

  pi.registerCommand("skill", {
    description: "Load a skill by name (also available as /skill:<name>)",
    getArgumentCompletions: (prefix) => {
      const p = prefix.toLowerCase();
      const matches = allSkills
        .filter((s) => s.name.toLowerCase().startsWith(p))
        .map((s) => ({ value: s.name, label: s.name, description: s.description ?? s.type }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const skill = findExplicitSkill(args);
      if (!skill) {
        if (ctx.hasUI) ctx.ui.notify(`Unknown skill: ${args.trim() || "<empty>"}`, "error");
        return;
      }
      loadExplicitSkill(skill, ctx);
    },
  });

  for (const skill of allSkills) {
    pi.registerCommand(`skill:${skill.name}`, {
      description: skill.description ?? `Load skill: ${skill.name}`,
      handler: async (_args, ctx) => loadExplicitSkill(skill, ctx),
    });
  }

  pi.registerTool({
    name: "skills",
    label: "Skills",
    description: "List all available skills.",
    promptSnippet: "skills(): list installed skills.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: listAllSkills() }], details: {} };
    },
  });

  pi.on("tool_result", async (event) => {
    const name = (event as any).toolName || (event as any).name;
    if (typeof name === "string") {
      const idx = recentToolCalls.indexOf(name);
      if (idx !== -1) recentToolCalls.splice(idx, 1);
      recentToolCalls.unshift(name);
      if (recentToolCalls.length > 8) recentToolCalls.length = 8;
    }
    lastFailedTool = (event as any).isError === true && typeof name === "string" ? name : null;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    userTurn += 1;
    loadSkills();
    if (allSkills.length === 0) return;
    const opts: any = (event as any).systemPromptOptions ?? {};
    const lc = opts.littleCoder ?? {};
    const basePrompt = event.systemPrompt ?? "";
    const contextLimit: number = lc.contextLimit ?? 8192;
    if (estimateTokens(basePrompt) > contextLimit * 0.4) return;

    let allowedList: string[] | undefined = lc.allowedTools;
    if (!allowedList && process.env.LITTLE_CODER_ALLOWED_TOOLS) allowedList = process.env.LITTLE_CODER_ALLOWED_TOOLS.split(",").map((s) => s.trim()).filter(Boolean);
    const allowed = allowedList && allowedList.length > 0 ? new Set(allowedList) : undefined;

    const prompt = event.prompt ?? "";
    const modeHint = looksLikeReviewTask(basePrompt) ? "review mode code review" : "";
    const selectionPrompt = `${prompt}\n${modeHint}`;
    const refBudget: number = lc.isSubtask ? 0 : (lc.knowledgeTokenBudget ?? persistedBudget("knowledgeTokenBudget") ?? 200);
    const refSelection = refBudget > 0 ? selectReferenceSkills(selectionPrompt, refBudget) : { selected: [], skippedBudget: [] };
    const refs = refSelection.selected;
    const requiredTools = Array.from(new Set([...(Array.isArray(lc.requiredTools) ? lc.requiredTools : []), ...refs.flatMap((s) => s.requiresTools)]));
    const baseToolBudget: number = lc.skillTokenBudget ?? persistedBudget("skillTokenBudget") ?? 300;
    const toolBudget = userTurn === 1 ? baseToolBudget * 2 : baseToolBudget;
    const toolSelection = toolBudget > 0 ? selectToolSkills(selectionPrompt, toolBudget, allowed, requiredTools) : { selected: [], skippedBudget: [], suppressedRecent: [] };
    const tools = toolSelection.selected;
    const researchTask = looksLikeResearchTask(prompt);
    const contextTokens = estimateTokens(basePrompt);
    const shouldWarnLong = (contextTokens > contextLimit * 0.75 || userTurn >= 16) && userTurn - longConversationLastWarnTurn >= 6;
    if (shouldWarnLong) longConversationLastWarnTurn = userTurn;
    if (tools.length === 0 && refs.length === 0 && !researchTask && !shouldWarnLong && toolSelection.skippedBudget.length === 0 && refSelection.skippedBudget.length === 0 && toolSelection.suppressedRecent.length === 0) return;

    const key = `${tools.map((s) => s.targetTool).sort().join("|")}::${refs.map((s) => s.name).sort().join("|")}`;
    let block = selectionCache.get(key);
    if (block === undefined) {
      block = buildBlock(tools, refs);
      selectionCache.set(key, block);
    }
    const directive = researchTask ? RESEARCH_DIRECTIVE : "";
    for (const s of [...tools, ...refs]) recentInjected.set(s.name, userTurn);

    try {
      const parts: string[] = [];
      if (tools.length > 0) parts.push(`+${tools.length} tools [${tools.map((s) => s.targetTool).join(",")}]`);
      if (refs.length > 0) parts.push(`+${refs.length} refs [${refs.map((s) => s.name).join(",")}]`);
      if (toolSelection.skippedBudget.length > 0) parts.push(`skipped tools budget [${toolSelection.skippedBudget.map((s) => s.targetTool ?? s.name).join(",")}]`);
      if (refSelection.skippedBudget.length > 0) parts.push(`skipped refs budget [${refSelection.skippedBudget.map((s) => s.name).join(",")}]`);
      if (toolSelection.suppressedRecent.length > 0) parts.push(`suppressed recent [${toolSelection.suppressedRecent.map((s) => s.targetTool ?? s.name).join(",")}]`);
      if (researchTask) parts.push("+research-directive");
      if (shouldWarnLong) parts.push("long session: consider /compact or a fresh session");
      ctx.ui.notify(`skill-inject: ${parts.join(" ")}`, "info");
    } catch {}

    return { systemPrompt: basePrompt + block + directive };
  });
}
