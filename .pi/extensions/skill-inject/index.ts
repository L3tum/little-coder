import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFile } from "./frontmatter.ts";

// ── Tool-skill registry ─────────────────────────────────────────────────
// Port of local/skill_augment.py. Loads skills/tools/*.md once, hooks
// `before_agent_start` to append a `## Tool Usage Guidance` block to the
// system prompt. Per-user-prompt selection using the whitepaper's 3-priority
// algorithm (error recovery > recency > intent). Budget-guarded, cached.

interface ToolSkill {
  targetTool: string;
  body: string;
  tokenCost: number;
}

const skills = new Map<string, ToolSkill>();
const selectionCache = new Map<string, string>();
let loaded = false;

// State tracked across the session so we have error-recovery + recency
// signals by the time the next `before_agent_start` fires.
const recentToolCalls: string[] = []; // most-recent-first, capped at 8
let lastFailedTool: string | null = null;

// ── Intent keywords → likely tools ──────────────────────────────────────
const INTENT_MAP: Record<string, string[]> = {
  read: ["read"], show: ["read"], view: ["read"], cat: ["read"],
  write: ["write"], create: ["write", "bash"],
  implement: ["write", "read"], code: ["write", "read"],
  // function/class are defined later (code graph) — JS last-wins
  edit: ["edit"], change: ["edit"], modify: ["edit"],
  fix: ["edit"], update: ["edit"], replace: ["edit"],
  add: ["edit", "write"], refactor: ["edit", "read"],
  run: ["bash"], execute: ["bash"], install: ["bash"],
  build: ["bash"], test: ["bash"],
  find: ["glob", "grep", "findRead", "codebase_memory_search_graph"], search: ["grep", "findRead", "codebase_memory_search_graph"],
  grep: ["grep"], glob: ["glob", "findRead"],
  // Code graph / structural code search
  function: ["codebase_memory_search_graph", "grep"], class: ["codebase_memory_search_graph", "grep"],
  where: ["codebase_memory_search_graph"], calls: ["codebase_memory_search_graph"],
  callsite: ["codebase_memory_search_graph"], caller: ["codebase_memory_search_graph"],
  implementation: ["codebase_memory_search_graph"], implements: ["codebase_memory_search_graph"],
  reference: ["codebase_memory_search_graph"], references: ["codebase_memory_search_graph"],
  dependency: ["codebase_memory_search_graph"], depends: ["codebase_memory_search_graph"],
  route: ["codebase_memory_search_graph"], endpoint: ["codebase_memory_search_graph"],
  symbol: ["codebase_memory_search_graph"], definition: ["codebase_memory_search_graph"],
  declare: ["codebase_memory_search_graph"], declares: ["codebase_memory_search_graph"],
  variable: ["codebase_memory_search_graph"], module: ["codebase_memory_search_graph"],
  import: ["codebase_memory_search_graph"], exports: ["codebase_memory_search_graph"],
  struct: ["codebase_memory_search_graph"], interface: ["codebase_memory_search_graph"],
  inherit: ["codebase_memory_search_graph"], extends: ["codebase_memory_search_graph"],
  override: ["codebase_memory_search_graph"], overrides: ["codebase_memory_search_graph"],
  codegraph: ["codebase_memory_search_graph"], codebase: ["codebase_memory_search_graph"],
  graph: ["codebase_memory_search_graph"], semantic: ["codebase_memory_search_graph"],
  "what calls": ["codebase_memory_search_graph"], "where is": ["codebase_memory_search_graph"],
  "who uses": ["codebase_memory_search_graph"], "find all": ["codebase_memory_search_graph"],
  "search code": ["codebase_memory_search_graph"], "code search": ["codebase_memory_search_graph"],
  "find usage": ["codebase_memory_search_graph"], "find usages": ["codebase_memory_search_graph"],
  "find implement": ["codebase_memory_search_graph"], "find definition": ["codebase_memory_search_graph"],
  "go to definition": ["codebase_memory_search_graph"], "find references": ["codebase_memory_search_graph"],
  "call graph": ["codebase_memory_search_graph"], "call hierarchy": ["codebase_memory_search_graph"],
  "type hierarchy": ["codebase_memory_search_graph"], "class hierarchy": ["codebase_memory_search_graph"],
  "rename across": ["codebase_memory_search_graph"], "safe delete": ["codebase_memory_search_graph"],
  "impact analysis": ["codebase_memory_search_graph"], "affected by": ["codebase_memory_search_graph"],
  fetch: ["webfetch"], download: ["webfetch"], url: ["webfetch"],
  web: ["websearch"],
  // Research / browser / evidence
  research: ["enableBrowserTools", "EvidenceAdd"],
  researching: ["enableBrowserTools", "EvidenceAdd"],
  wikipedia: ["enableBrowserTools", "EvidenceAdd"],
  article: ["enableBrowserTools", "EvidenceAdd"],
  citation: ["EvidenceAdd", "enableBrowserTools"],
  cite: ["EvidenceAdd"],
  source: ["EvidenceAdd", "enableBrowserTools"],
  fact: ["EvidenceAdd"],
  factcheck: ["EvidenceAdd", "enableBrowserTools"],
  question: ["EvidenceAdd", "enableBrowserTools"],
  answer: ["EvidenceAdd", "EvidenceList"],
  navigate: ["enableBrowserTools"],
  browse: ["enableBrowserTools"],
  page: ["enableBrowserTools"],
  click: ["enableBrowserTools"],
  // Composite tools
  findread: ["findRead"],
};

function skillsDir(): string {
  // Extension lives at .pi/extensions/skill-inject/, repo root is 3 levels up
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "skills", "tools");
}

function loadSkills(): void {
  if (loaded) return;
  loaded = true;
  const dir = skillsDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const parsed = parseSkillFile(readFileSync(join(dir, file), "utf-8"));
    if (!parsed) continue;
    const target = parsed.frontmatter.target_tool;
    if (typeof target !== "string" || !target) continue;
    const cost = typeof parsed.frontmatter.token_cost === "number"
      ? parsed.frontmatter.token_cost
      : 150;
    skills.set(target, { targetTool: target, body: parsed.body, tokenCost: cost });
  }
}

function predictTools(userText: string): string[] {
  const words = new Set(userText.toLowerCase().split(/\s+/).filter(Boolean));
  const predicted: string[] = [];
  for (const [kw, toolNames] of Object.entries(INTENT_MAP)) {
    if (!words.has(kw)) continue;
    for (const tn of toolNames) if (!predicted.includes(tn)) predicted.push(tn);
  }
  return predicted;
}

function selectSkills(prompt: string, budget: number, allowed?: Set<string>): ToolSkill[] {
  const selected: ToolSkill[] = [];
  let used = 0;
  const tryAdd = (name: string): void => {
    const sk = skills.get(name);
    if (!sk || selected.includes(sk)) return;
    if (allowed && !allowed.has(name)) return;
    if (used + sk.tokenCost > budget) return;
    selected.push(sk);
    used += sk.tokenCost;
  };

  // 1. Error recovery — last failed tool
  if (lastFailedTool) tryAdd(lastFailedTool);

  // 2. Recency — last 2 tool calls
  for (const name of recentToolCalls.slice(0, 4)) {
    if (used >= budget) break;
    tryAdd(name);
  }

  // 3. Intent prediction on the user's current prompt
  if (used < budget) {
    for (const name of predictTools(prompt)) {
      if (used >= budget) break;
      tryAdd(name);
    }
  }

  return selected;
}

function buildBlock(selected: ToolSkill[]): string {
  let out = "\n\n## Tool Usage Guidance\n";
  for (const s of selected) out += `\n### ${s.targetTool}\n${s.body}\n`;
  return out;
}

// Keyword-triggered directive: when the user's prompt smells like a
// research / web-lookup task, prepend an explicit "browse-first, then
// edit-write" rule. Without it, qwen-class small models often skip
// straight to Edit/Write on free-form questions, never gathering evidence.
const RESEARCH_TRIGGERS = [
  /\bbrows(?:e|ing|er)\b/i,
  /\bonline\b/i,
  /\bresearch(?:ing)?\b/i,
  /\blook\s+up\b/i,
  /\blookup\b/i,
  /\bsearch\s+(?:the|for)\b/i,
  /\bweb\s*search\b/i,
  /\bwikipedia\b/i,
  /\bwebsite\b/i,
  /\bweb\s*page\b/i,
  /\bgoogle\b/i,
  /\bcite|citation\b/i,
  /\bfact[-\s]?check/i,
];

function looksLikeResearchTask(text: string): boolean {
  if (!text) return false;
  for (const re of RESEARCH_TRIGGERS) {
    if (re.test(text)) return true;
  }
  return false;
}

const RESEARCH_DIRECTIVE = [
  "",
  "## Research-first directive",
  "This task involves online research.",
  "1. If Browser* tools are not active yet, call enableBrowserTools first.",
  "2. Gather facts with BrowserNavigate / BrowserExtract (or websearch for first hops).",
  "3. Save each citable fact via EvidenceAdd before relying on it.",
  "4. Only then answer or make file edits.",
  "",
].join("\n");

function listAllSkills(): string {
  loadSkills();
  const lines: string[] = [];

  // Tool skills (skills/tools/*.md)
  if (skills.size > 0) {
    lines.push("Tool Skills:");
    const sorted = [...skills.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, sk] of sorted) {
      lines.push(`  ${name}  (${sk.tokenCost} tok)`);
    }
    lines.push("");
  }

  // Knowledge entries (skills/knowledge/*.md + skills/protocols/*.md)
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, "..", "..", "..");
  const knowledgeDir = join(repo, "skills", "knowledge");
  const protocolsDir = join(repo, "skills", "protocols");

  if (existsSync(knowledgeDir)) {
    lines.push("Knowledge:");
    for (const file of readdirSync(knowledgeDir).sort()) {
      if (!file.endsWith(".md")) continue;
      const parsed = parseSkillFile(readFileSync(join(knowledgeDir, file), "utf-8"));
      const name = parsed?.frontmatter?.name ?? parsed?.frontmatter?.topic ?? file;
      const kw = Array.isArray(parsed?.frontmatter?.keywords) ? parsed.frontmatter.keywords.join(", ") : "";
      lines.push(`  ${name}${kw ? `  [${kw}]` : ""}`);
    }
    lines.push("");
  }

  if (existsSync(protocolsDir)) {
    lines.push("Protocols:");
    for (const file of readdirSync(protocolsDir).sort()) {
      if (!file.endsWith(".md")) continue;
      const parsed = parseSkillFile(readFileSync(join(protocolsDir, file), "utf-8"));
      const name = parsed?.frontmatter?.name ?? parsed?.frontmatter?.topic ?? file;
      lines.push(`  ${name}`);
    }
    lines.push("");
  }

  if (lines.length === 0) return "No skills loaded.";
  const total = skills.size + (existsSync(knowledgeDir) ? readdirSync(knowledgeDir).filter(f => f.endsWith(".md")).length : 0) + (existsSync(protocolsDir) ? readdirSync(protocolsDir).filter(f => f.endsWith(".md")).length : 0);
  lines.push(`Total: ${total} entries`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  // Register /skills command for listing all available skills
  pi.registerCommand("skills", {
    description: "List all available skills (tool skills, knowledge, protocols)",
    handler: async (_args, ctx) => {
      const text = listAllSkills();
      if (ctx.hasUI) {
        ctx.ui.notify(text, "info");
      }
    },
  });

  pi.registerTool({
    name: "skills",
    label: "Skills",
    description: "List all available skills (tool skills, knowledge entries, protocols).",
    promptSnippet: "skills(): list installed tool skills, knowledge entries, and protocols.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: listAllSkills() }], details: {} };
    },
  });

  // Track tool usage across the whole session so recency + error-recovery
  // state is available on the next before_agent_start.
  pi.on("tool_result", async (event) => {
    const name = (event as any).toolName || (event as any).name;
    if (typeof name === "string") {
      // prepend, keep deduplicated recency list capped
      const idx = recentToolCalls.indexOf(name);
      if (idx !== -1) recentToolCalls.splice(idx, 1);
      recentToolCalls.unshift(name);
      if (recentToolCalls.length > 8) recentToolCalls.length = 8;
    }
    const isError = (event as any).isError === true;
    lastFailedTool = isError && typeof name === "string" ? name : null;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    loadSkills();
    if (skills.size === 0) return;

    const opts: any = (event as any).systemPromptOptions ?? {};
    const lc = opts.littleCoder ?? {};
    const budget: number = lc.skillTokenBudget ?? 300;
    if (budget <= 0) return;

    // Allow-list source: prefer systemPromptOptions (set by tool-gating's
    // before_agent_start), but fall back to LITTLE_CODER_ALLOWED_TOOLS env
    // directly. Pi runs before_agent_start handlers in extension load order
    // (alphabetical), so skill-inject fires before tool-gating and
    // lc.allowedTools is undefined on the first turn unless we read env here.
    let allowedList: string[] | undefined = lc.allowedTools;
    if (!allowedList && process.env.LITTLE_CODER_ALLOWED_TOOLS) {
      allowedList = process.env.LITTLE_CODER_ALLOWED_TOOLS
        .split(",").map((s) => s.trim()).filter(Boolean);
    }
    const allowed = allowedList && allowedList.length > 0 ? new Set(allowedList) : undefined;

    // Knowledge-inject may publish required_tools on systemPromptOptions —
    // pre-add those before selecting so they win even when budget is tight.
    // Benchmark profiles can also publish requiredTools (e.g. GAIA -> Browser+Evidence).
    const preferred: string[] = Array.isArray(lc.requiredTools) ? lc.requiredTools : [];
    for (const t of preferred) {
      if (!recentToolCalls.includes(t)) recentToolCalls.unshift(t);
    }

    // Don't inject skills if the system prompt is already large (same guard
    // as knowledge-inject: skip when base prompt exceeds 40% of context).
    const contextLimit: number = lc.contextLimit ?? 8192;
    const basePrompt = event.systemPrompt ?? "";
    if (basePrompt.length > contextLimit * 0.4 * 4) return; // ~4 chars/token est.

    const selected = selectSkills(event.prompt ?? "", budget, allowed);
    const researchTask = looksLikeResearchTask(event.prompt ?? "");

    if (selected.length === 0 && !researchTask) return;

    const skillBlock = selected.length > 0
      ? (() => {
          const key = selected.map((s) => s.targetTool).sort().join("|");
          let b = selectionCache.get(key);
          if (b === undefined) {
            b = buildBlock(selected);
            selectionCache.set(key, b);
          }
          return b;
        })()
      : "";

    const directive = researchTask ? RESEARCH_DIRECTIVE : "";

    // Fire-and-forget notify so the benchmark harness can count per-turn
    // skill injections without having to reconstruct the system prompt.
    try {
      const parts: string[] = [];
      if (selected.length > 0) {
        parts.push(`+${selected.length} [${selected.map((s) => s.targetTool).join(",")}]`);
      }
      if (researchTask) parts.push("+research-directive");
      ctx.ui.notify(`skill-inject: ${parts.join(" ")}`, "info");
    } catch {
      // UI unavailable in some run modes — silent best-effort
    }

    // Order: [AGENTS.md] [tool skill cards] [research directive].
    // The directive is the LAST block in the system prompt by design —
    // small models show strong recency bias and the per-task instruction
    // is exactly what we want freshest in their attention.
    return { systemPrompt: (event.systemPrompt ?? "") + skillBlock + directive };
  });
}
