import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { outlineText, discoverSessions } from "../_shared/session-history.ts";
import { listSkillCatalog } from "../_shared/skill-catalog.ts";

export interface Proposal { name: string; content: string; createdAt: string }
const queue: Proposal[] = [];
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

function userSkillsRoot(): string {
  return process.env.LITTLE_CODER_USER_SKILLS_DIR || join(homedir(), ".pi", "skills");
}

function historyPath(): string {
  return process.env.LITTLE_CODER_REFLECT_HISTORY || join(homedir(), ".pi", "agent", "reflect-skills", "history.jsonl");
}

export function recordHistory(action: string, detail: Record<string, unknown> = {}): void {
  const file = historyPath();
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), action, ...detail }) + "\n");
}

export function readHistory(limit = 20): string {
  try {
    const lines = readFileSync(historyPath(), "utf-8").trim().split("\n").filter(Boolean).slice(-limit);
    if (lines.length === 0) return "No reflection history recorded.";
    return lines.map((line) => {
      try {
        const e = JSON.parse(line);
        return `${e.timestamp} ${e.action}${e.name ? ` ${e.name}` : ""}${e.file ? ` -> ${e.file}` : ""}`;
      } catch { return line; }
    }).join("\n");
  } catch { return "No reflection history recorded."; }
}

function missedInjectionSuggestions(context: string): string {
  const text = context.toLowerCase();
  const suggestions: string[] = [];
  for (const skill of listSkillCatalog()) {
    if (skill.keywords.length === 0) continue;
    const hits = skill.keywords.filter((kw) => text.includes(kw.toLowerCase()));
    const reviewLike = /review|diff|uncommitted|changes|pr|pull request/.test(text) && /review|code-review|code review/.test(skill.name + " " + skill.description);
    if (hits.length > 0 || reviewLike) {
      const extra = reviewLike ? ["review uncommitted changes", "review the changes", "diff review"] : [];
      suggestions.push(`- ${skill.name}: observed cues [${[...new Set([...hits, ...extra])].slice(0, 6).join(", ")}]`);
    }
  }
  return suggestions.slice(0, 8).join("\n") || "- No obvious missed skill injections detected from bounded breadcrumbs.";
}

function proposalFromRecent(guidance = ""): Proposal {
  const recent = discoverSessions().find((s) => s.cwd === process.cwd()) ?? discoverSessions()[0];
  const name = slug(`session-reflection-${new Date().toISOString().slice(0, 10)}`);
  const context = recent ? outlineText(recent, 8) : "No recent session history found.";
  const missed = missedInjectionSuggestions(context);
  return {
    name,
    createdAt: new Date().toISOString(),
    content: `---\nname: ${name}\ndescription: User-reviewed reflection skill drafted from recent session patterns.\ntype: workflow\ntoken_cost: 120\nkeywords: [reflection, session, workflow, local]\nuser-invocable: true\n---\nReview this draft before accepting. It was generated from bounded session breadcrumbs, not full transcripts.\n\n${guidance ? `User edit guidance:\n\n${guidance}\n\n` : ""}Recent pattern summary:\n\n${context}\n\nPotential missed skill injections / keyword improvements:\n\n${missed}\n\nIf this pattern is useful, replace this paragraph with concrete reusable guidance before promoting it.\n`,
  };
}

export function writeProposal(p: Proposal): string {
  const dir = join(userSkillsRoot(), p.name);
  if (!/^[a-z0-9-]+$/.test(p.name)) throw new Error("invalid skill slug");
  if (existsSync(dir)) throw new Error(`skill already exists: ${dir}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, p.content);
  return file;
}

export function reflectionQueue(): Proposal[] {
  return queue.map((p) => ({ ...p }));
}

export function renderQueue(): string {
  if (queue.length === 0) return "No reflection skill proposals queued. Run /reflect to draft one.";
  return queue.map((p, i) => `${i + 1}. ${p.name} (${p.createdAt})\n${p.content}`).join("\n\n---\n\n");
}

function proposalIndex(args: string): number {
  const value = args.trim().split(/\s+/)[1] ?? args.trim() ?? "1";
  const n = Number(value || "1");
  return Math.max(0, n - 1);
}

function acceptProposal(idx: number): string {
  const p = queue[idx];
  if (!p) return "No such reflection proposal.";
  const file = writeProposal(p);
  queue.splice(idx, 1);
  recordHistory("accept", { name: p.name, file });
  return `Accepted reflection skill: ${file}`;
}

function denyProposal(idx: number): string {
  const p = queue[idx];
  if (!p) return "No such reflection proposal.";
  queue.splice(idx, 1);
  recordHistory("deny", { name: p.name });
  return "Reflection proposal discarded.";
}

function editProposal(args: string): string {
  const parts = args.trim().split(/\s+/);
  const maybeIndex = Number(parts[1]);
  const idx = Number.isFinite(maybeIndex) && maybeIndex > 0 ? maybeIndex - 1 : 0;
  const guidance = parts.slice(Number.isFinite(maybeIndex) ? 2 : 1).join(" ").trim();
  const current = queue[idx];
  if (!current) return "No such reflection proposal.";
  if (!guidance) return "Usage: /reflect-review edit [n] <guidance>";
  queue[idx] = proposalFromRecent(guidance);
  recordHistory("edit", { name: queue[idx].name, guidance });
  return `Regenerated reflection proposal ${idx + 1} with edit guidance.`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reflect", {
    description: "Draft a user-level skill proposal from bounded recent session breadcrumbs",
    handler: async (_args, ctx) => {
      const p = proposalFromRecent();
      queue.push(p);
      recordHistory("propose", { name: p.name });
      const idx = queue.length;
      ctx.ui?.notify?.(`Queued reflection proposal '${p.name}'.\n\n${p.content}`, "info");
      if (!ctx.hasUI || typeof ctx.ui?.select !== "function") {
        ctx.ui?.notify?.(`Review with /reflect-review accept|deny|edit ${idx}.`, "info");
        return;
      }
      const choice = await ctx.ui.select("Reflection proposal", ["Accept", "Deny", "Edit later"]);
      if (choice === "Accept") ctx.ui?.notify?.(acceptProposal(idx - 1), "info");
      else if (choice === "Deny") ctx.ui?.notify?.(denyProposal(idx - 1), "info");
      else ctx.ui?.notify?.(`Left proposal queued. Use /reflect-review edit ${idx} <guidance> or /reflect-accept ${idx}.`, "info");
    },
  });
  pi.registerCommand("reflect-review", {
    description: "Show queued reflection skill proposals, or /reflect-review accept|deny|edit [n]",
    handler: async (args, ctx) => {
      const text = String(args ?? "").trim();
      const action = text.split(/\s+/)[0];
      try {
        if (action === "accept") return ctx.ui?.notify?.(acceptProposal(proposalIndex(text)), "info");
        if (action === "deny") return ctx.ui?.notify?.(denyProposal(proposalIndex(text)), "info");
        if (action === "edit") return ctx.ui?.notify?.(editProposal(text), "info");
        return ctx.ui?.notify?.(renderQueue(), "info");
      } catch (e) {
        return ctx.ui?.notify?.(`Reflection review failed: ${(e as Error).message}`, "error");
      }
    },
  });
  pi.registerCommand("reflect-accept", {
    description: "Accept queued proposal by number and write it to ~/.pi/skills",
    handler: async (args, ctx) => {
      try { ctx.ui?.notify?.(acceptProposal(proposalIndex(String(args ?? "1"))), "info"); }
      catch (e) { ctx.ui?.notify?.(`Could not accept reflection skill: ${(e as Error).message}`, "error"); }
    },
  });
  pi.registerCommand("reflect-deny", { description: "Discard queued proposal by number", handler: async (args, ctx) => ctx.ui?.notify?.(denyProposal(proposalIndex(String(args ?? "1"))), "info") });
  pi.registerCommand("reflect-history", { description: "Show reflection run and approval history", handler: async (_args, ctx) => ctx.ui?.notify?.(readHistory(), "info") });
  pi.registerCommand("reflect-doctor", { description: "Check reflection dependencies", handler: async (_args, ctx) => ctx.ui?.notify?.(`reflect-skills: using bounded breadcrumbs parser; writes accepted skills to ${userSkillsRoot()}.`, "info") });
}
