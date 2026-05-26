import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFile } from "./frontmatter.ts";

interface SkillEntry {
  name: string;
  type: string;
  sourceDir: string;
  body: string;
  tokenCost: number;
  targetTool?: string;
  keywords: string[];
  requiresTools: string[];
}

const toolSkills = new Map<string, SkillEntry>();
const allSkills: SkillEntry[] = [];
const selectionCache = new Map<string, string>();
let loaded = false;
const recentToolCalls: string[] = [];
let lastFailedTool: string | null = null;

const INTENT_MAP: Record<string, string[]> = {
  read: ["read"], show: ["read"], view: ["read"], cat: ["read"],
  write: ["write"], create: ["write", "bash"], implement: ["write", "read"], code: ["write", "read"],
  edit: ["edit"], change: ["edit"], modify: ["edit"], fix: ["edit"], update: ["edit"], replace: ["edit"], add: ["edit", "write"], refactor: ["edit", "read"],
  run: ["bash"], execute: ["bash"], install: ["bash"], build: ["bash"], test: ["bash"],
  find: ["glob", "grep", "findRead", "code_search"], search: ["grep", "findRead", "code_search"], grep: ["grep"], glob: ["glob", "findRead"],
  function: ["code_search", "grep"], class: ["code_search", "grep"], where: ["code_search"], calls: ["code_search"], callsite: ["code_search"], caller: ["code_search"], implementation: ["code_search"], implements: ["code_search"], reference: ["code_search"], references: ["code_search"], dependency: ["code_search"], depends: ["code_search"], route: ["code_search"], endpoint: ["code_search"], symbol: ["code_search"], definition: ["code_search"], declare: ["code_search"], declares: ["code_search"], variable: ["code_search"], module: ["code_search"], import: ["code_search"], exports: ["code_search"], struct: ["code_search"], interface: ["code_search"], inherit: ["code_search"], extends: ["code_search"], override: ["code_search"], overrides: ["code_search"], codegraph: ["code_search"], codebase: ["code_search"], graph: ["code_search"], semantic: ["code_search"],
  fetch: ["webfetch"], download: ["webfetch"], url: ["webfetch"], web: ["websearch"], research: ["enableBrowserTools", "EvidenceAdd"], researching: ["enableBrowserTools", "EvidenceAdd"], wikipedia: ["enableBrowserTools", "EvidenceAdd"], article: ["enableBrowserTools", "EvidenceAdd"], citation: ["EvidenceAdd", "enableBrowserTools"], cite: ["EvidenceAdd"], source: ["EvidenceAdd", "enableBrowserTools"], fact: ["EvidenceAdd"], factcheck: ["EvidenceAdd", "enableBrowserTools"], question: ["EvidenceAdd", "enableBrowserTools"], answer: ["EvidenceAdd", "EvidenceList"], navigate: ["enableBrowserTools"], browse: ["enableBrowserTools"], page: ["enableBrowserTools"], click: ["enableBrowserTools"], findread: ["findRead"],
};

const RESEARCH_TRIGGERS = [/\bbrows(?:e|ing|er)\b/i, /\bonline\b/i, /\bresearch(?:ing)?\b/i, /\blook\s+up\b/i, /\blookup\b/i, /\bsearch\s+(?:the|for)\b/i, /\bweb\s*search\b/i, /\bwikipedia\b/i, /\bwebsite\b/i, /\bweb\s*page\b/i, /\bgoogle\b/i, /\bcite|citation\b/i, /\bfact[-\s]?check/i];
const REVIEW_TRIGGERS = [/\bcode\s+review\b/i, /\breview(?:ing)?\s+(?:this\s+)?(?:code|diff|pr|pull\s+request|merge\s+request|change|changes)\b/i, /\b(?:pr|pull\s+request|merge\s+request)\s+review\b/i, /\brequest\s+changes\b/i, /\bapprove\s+(?:this\s+)?(?:pr|pull\s+request|merge\s+request|change|changes)\b/i];
const RESEARCH_DIRECTIVE = ["", "## Research-first directive", "This task involves online research.", "1. If Browser* tools are not active yet, call enableBrowserTools first.", "2. Gather facts with BrowserNavigate / BrowserExtract (or websearch for first hops).", "3. Save each citable fact via EvidenceAdd before relying on it.", "4. Only then answer or make file edits.", ""].join("\n");
const MIN_SCORE_THRESHOLD = 2.0;
const PER_ENTRY_CAP = 150;

function skillsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
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
  const root = skillsRoot();
  for (const path of walkMarkdown(root)) {
    const parsed = parseSkillFile(readFileSync(path, "utf-8"));
    if (!parsed?.body) continue;
    const fm = parsed.frontmatter;
    const rel = relative(root, path).split(/[\\/]/);
    const sourceDir = rel[0] || basename(dirname(path));
    const type = inferType(sourceDir, fm.type);
    const targetTool = typeof fm.target_tool === "string" && fm.target_tool ? fm.target_tool : undefined;
    const name = (typeof fm.name === "string" && fm.name) || (typeof fm.topic === "string" && fm.topic) || targetTool || basename(path, ".md");
    let tokenCost = typeof fm.token_cost === "number" ? fm.token_cost : 150;
    if (type !== "tool" && tokenCost > PER_ENTRY_CAP) tokenCost = PER_ENTRY_CAP;
    const keywords = Array.isArray(fm.keywords) ? (fm.keywords as string[]).map((k) => k.toLowerCase()) : [];
    const requiresTools = Array.isArray(fm.requires_tools) ? (fm.requires_tools as string[]) : [];
    const entry = { name, type, sourceDir, body: parsed.body, tokenCost, targetTool, keywords, requiresTools };
    allSkills.push(entry);
    if (targetTool) toolSkills.set(targetTool, entry);
  }
}

function predictTools(userText: string): string[] {
  const text = userText.toLowerCase();
  const words = new Set(text.split(/\s+/).filter(Boolean));
  const predicted: string[] = [];
  for (const [kw, toolNames] of Object.entries(INTENT_MAP)) {
    if (!words.has(kw) && !text.includes(kw)) continue;
    for (const tn of toolNames) if (!predicted.includes(tn)) predicted.push(tn);
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

function selectToolSkills(prompt: string, budget: number, allowed?: Set<string>, required: string[] = []): SkillEntry[] {
  const selected: SkillEntry[] = [];
  let used = 0;
  const tryAdd = (name: string, force = false): void => {
    const sk = toolSkills.get(name);
    if (!sk || selected.includes(sk)) return;
    if (allowed && !allowed.has(name)) return;
    if (!force && used + sk.tokenCost > budget) return;
    selected.push(sk);
    used += sk.tokenCost;
  };
  for (const t of required) tryAdd(t, true);
  if (lastFailedTool) tryAdd(lastFailedTool);
  for (const name of recentToolCalls.slice(0, 4)) tryAdd(name);
  for (const name of predictTools(prompt)) tryAdd(name);
  return selected;
}

function selectReferenceSkills(prompt: string, budget: number): SkillEntry[] {
  const scored = allSkills
    .filter((s) => !s.targetTool)
    .map((entry) => ({ entry, score: scoreEntry(prompt, entry) }))
    .filter((x) => x.score >= MIN_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  const selected: SkillEntry[] = [];
  let used = 0;
  for (const { entry } of scored) {
    if (used + entry.tokenCost > budget) continue;
    selected.push(entry);
    used += entry.tokenCost;
  }
  return selected;
}

function looksLikeResearchTask(text: string): boolean {
  return !!text && RESEARCH_TRIGGERS.some((re) => re.test(text));
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
      const kw = s.keywords.length > 0 ? ` [${s.keywords.join(", ")}]` : "";
      lines.push(`  ${label} (${s.tokenCost} tok)${kw}`);
    }
    lines.push("");
  }
  lines.push(`Total: ${allSkills.length} entries`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("skills", {
    description: "List all available skills",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(listAllSkills(), "info");
    },
  });

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
    const refBudget: number = lc.isSubtask ? 0 : (lc.knowledgeTokenBudget ?? 200);
    const refs = refBudget > 0 ? selectReferenceSkills(prompt, refBudget) : [];
    const requiredTools = Array.from(new Set([...(Array.isArray(lc.requiredTools) ? lc.requiredTools : []), ...refs.flatMap((s) => s.requiresTools)]));
    const toolBudget: number = lc.skillTokenBudget ?? 300;
    const tools = toolBudget > 0 ? selectToolSkills(prompt, toolBudget, allowed, requiredTools) : [];
    const researchTask = looksLikeResearchTask(prompt);
    if (tools.length === 0 && refs.length === 0 && !researchTask) return;

    const key = `${tools.map((s) => s.targetTool).sort().join("|")}::${refs.map((s) => s.name).sort().join("|")}`;
    let block = selectionCache.get(key);
    if (block === undefined) {
      block = buildBlock(tools, refs);
      selectionCache.set(key, block);
    }
    const directive = researchTask ? RESEARCH_DIRECTIVE : "";

    try {
      const parts: string[] = [];
      if (tools.length > 0) parts.push(`+${tools.length} tools [${tools.map((s) => s.targetTool).join(",")}]`);
      if (refs.length > 0) parts.push(`+${refs.length} refs [${refs.map((s) => s.name).join(",")}]`);
      if (researchTask) parts.push("+research-directive");
      ctx.ui.notify(`skill-inject: ${parts.join(" ")}`, "info");
    } catch {}

    return { systemPrompt: basePrompt + block + directive };
  });
}
