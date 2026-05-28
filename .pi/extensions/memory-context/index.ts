import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { containsSecret } from "../security/index.ts";

const execFileAsync = promisify(execFile);
const MEMORY_DIR = join(process.cwd(), ".pi", "memory");
const NOTE_DIRS = ["20-context", "40-actions", "50-decisions", "60-observations", "70-runbooks", "80-sessions"];
const QUEUE_PATH = join(MEMORY_DIR, "queue.json");
const MAX_INJECT_CHARS = 5000;

interface MemoryNote {
  path: string;
  title: string;
  type: string;
  tags: string[];
  confidence: string;
  body: string;
}

interface QueueItem {
  type: string;
  title: string;
  created_at: string;
  updated_at: string;
  source: string;
  confidence: string;
  tags: string[];
  evidence: Record<string, unknown>;
  body: string;
  match_count?: number;
  last_matched_at?: string;
}

const AUTO_PROMOTE_MATCHES = 3;
const AUTO_PROMOTE_SCORE = 4;

const turn = {
  prompt: "",
  tools: [] as string[],
  filesRead: new Set<string>(),
  filesEdited: new Set<string>(),
  tests: [] as string[],
};

function ensureMemory(): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  for (const dir of NOTE_DIRS) mkdirSync(join(MEMORY_DIR, dir), { recursive: true });
  if (!existsSync(QUEUE_PATH)) writeFileSync(QUEUE_PATH, "[]\n");
}

function words(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9_.\/-]{3,}/g) ?? [])].slice(0, 80);
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith("---\n")) return { meta: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (m) meta[m[1]] = m[2].replace(/^['\"]|['\"]$/g, "");
  }
  return { meta, body: text.slice(end + 5).trim() };
}

function allNotes(): MemoryNote[] {
  ensureMemory();
  const out: MemoryNote[] = [];
  for (const dir of NOTE_DIRS) {
    const full = join(MEMORY_DIR, dir);
    for (const file of readdirSync(full)) {
      if (!file.endsWith(".md")) continue;
      const path = join(full, file);
      const parsed = parseFrontmatter(readFileSync(path, "utf-8"));
      out.push({
        path,
        title: parsed.meta.title || basename(file, ".md"),
        type: parsed.meta.type || dir,
        tags: (parsed.meta.tags || "").split(/[, ]+/).filter(Boolean),
        confidence: parsed.meta.confidence || "unknown",
        body: parsed.body,
      });
    }
  }
  return out;
}

function lexicalScore(query: string, haystack: string): number {
  const terms = words(query);
  if (terms.length === 0) return 0;
  const hay = haystack.toLowerCase();
  let score = 0;
  for (const term of terms) if (hay.includes(term)) score += term.includes("/") || term.includes(".") ? 3 : 1;
  return score;
}

function lexicalSearch(query: string, limit = 5): MemoryNote[] {
  return allNotes()
    .map((note) => ({ note, score: lexicalScore(query, `${note.title}\n${note.tags.join(" ")}\n${note.body}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.note);
}

function looksCodebaseIntent(text: string): boolean {
  return /\b(file|function|class|symbol|architecture|test|error|refactor|implement|bug|repo|codebase|module|extension|package|issue|PR)\b/i.test(text)
    || /[\w.-]+\.(ts|js|py|md|json|tsx|jsx)\b/.test(text)
    || text.includes("@");
}

async function resolveQmd(): Promise<{ mode: string; bin?: string }> {
  const candidates = [process.env.MEMORY_QMD_BIN, process.env.QMD_PATH, join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "qmd.cmd" : "qmd"), "qmd"].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      await execFileAsync(c, ["--version"], { timeout: 1000 });
      return { mode: "qmd", bin: c };
    } catch (e: any) {
      if (e?.code !== "ENOENT" && c !== "qmd") return { mode: "qmd", bin: c };
    }
  }
  return { mode: "grep fallback" };
}

function buildMemoryBlock(notes: MemoryNote[], mode: string): string {
  if (notes.length === 0) return "";
  let out = `\n\n## Local Memory Context\nRetrieval mode: ${mode}. Treat these as hints; inspect source before editing or relying on stale facts.\n`;
  for (const n of notes) {
    const rel = relative(process.cwd(), n.path);
    const body = n.body.replace(/\s+/g, " ").slice(0, 450);
    out += `- [${n.type}] ${n.title} (${rel}, confidence: ${n.confidence}): ${body}\n`;
  }
  return out.slice(0, MAX_INJECT_CHARS);
}

function readQueue(): QueueItem[] {
  ensureMemory();
  try {
    const parsed = JSON.parse(readFileSync(QUEUE_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueueItem[]): void {
  writeFileSync(QUEUE_PATH, `${JSON.stringify(items, null, 2)}\n`);
}

function noteDirForType(type: string): string {
  const normalized = type.toLowerCase();
  if (NOTE_DIRS.includes(normalized)) return normalized;
  if (normalized === "action") return "40-actions";
  if (normalized === "decision") return "50-decisions";
  if (normalized === "observation") return "60-observations";
  if (normalized === "runbook") return "70-runbooks";
  if (normalized === "session") return "80-sessions";
  return "20-context";
}

function yamlString(value: string): string {
  return JSON.stringify(value ?? "");
}

function writeAcceptedMemory(item: QueueItem): string {
  ensureMemory();
  const dir = join(MEMORY_DIR, noteDirForType(item.type));
  let path = join(dir, `${randomUUID()}.md`);
  while (existsSync(path)) path = join(dir, `${randomUUID()}.md`);
  const frontmatter = [
    "---",
    `title: ${yamlString(item.title)}`,
    `type: ${yamlString(item.type)}`,
    `tags: ${yamlString((item.tags ?? []).join(", "))}`,
    `confidence: ${yamlString(item.confidence || "unknown")}`,
    `source: ${yamlString(item.source || "memory-review")}`,
    `created_at: ${yamlString(item.created_at || new Date().toISOString())}`,
    `updated_at: ${yamlString(new Date().toISOString())}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(path, `${frontmatter}${item.body.trim()}\n`);
  return path;
}

function parseSelection(args: string, total: number): number[] {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "all") return Array.from({ length: total }, (_, i) => i);
  const selected = new Set<number>();
  for (const part of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let n = Math.min(start, end); n <= Math.max(start, end); n += 1) if (n >= 1 && n <= total) selected.add(n - 1);
      continue;
    }
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= total) selected.add(n - 1);
  }
  return [...selected].sort((a, b) => a - b);
}

function validateCandidate(item: QueueItem): { candidate: QueueItem | null; unsafe: boolean } {
  const confidence = String(item.confidence ?? "").toLowerCase();
  const body = String(item.body ?? "").trim();
  const candidate = { ...item, confidence, body: body.length > 2400 ? body.slice(0, 2400) : body };
  if (containsSecret(candidate)) return { candidate: null, unsafe: true };
  if (confidence !== "high" && confidence !== "medium") return { candidate: null, unsafe: false };
  if (!body) return { candidate: null, unsafe: false };
  return { candidate, unsafe: false };
}

function queueCandidate(item: QueueItem): void {
  if (process.env.MEMORY_LEARNING === "off") return;
  const { candidate } = validateCandidate(item);
  if (!candidate) return;
  const queue = readQueue();
  queue.push({ ...candidate, match_count: candidate.match_count ?? 0 });
  writeQueue(queue.slice(-200));
}

function durableMatchText(item: QueueItem): string {
  const evidence = item.evidence ?? {};
  const fileTerms = [
    ...((evidence.files_edited as string[] | undefined) ?? []),
    ...((evidence.files_read as string[] | undefined) ?? []),
  ].map((p) => basename(p)).join(" ");
  const body = item.body
    .split("\n")
    .filter((line) => !/^#{1,3}\s+(summary|evidence|validation|files|follow-up)\b/i.test(line.trim()))
    .filter((line) => !/^[-*]\s+(confidence|prompt|review for durability)\b/i.test(line.trim()))
    .filter((line) => !/^(prompt|outcome|validation):/i.test(line.trim()))
    .join("\n");
  return `${item.title}\n${item.tags?.join(" ") ?? ""}\n${fileTerms}\n${body}`;
}

function hasSpecificMatch(query: string, item: QueueItem): boolean {
  const queryLower = query.toLowerCase();
  const hay = durableMatchText(item).toLowerCase();
  const evidence = item.evidence ?? {};
  const paths = [
    ...((evidence.files_edited as string[] | undefined) ?? []),
    ...((evidence.files_read as string[] | undefined) ?? []),
  ];
  const genericTags = new Set(["action", "context", "decision", "observation", "runbook", "session"]);
  const specificTerms = [...(item.tags ?? []).filter((tag) => !genericTags.has(tag.toLowerCase())), ...paths.flatMap((p) => [p, basename(p)])]
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3);
  if (specificTerms.some((term) => queryLower.includes(term))) return true;
  return words(query).some((term) => (term.includes("/") || term.includes(".")) && hay.includes(term));
}

function trackShortTermMatches(query: string): string[] {
  const queue = readQueue();
  if (queue.length === 0) return [];
  const now = new Date().toISOString();
  const promoted: string[] = [];
  const remaining: QueueItem[] = [];
  let changed = false;
  for (const item of queue) {
    const score = lexicalScore(query, durableMatchText(item));
    if (score >= AUTO_PROMOTE_SCORE && hasSpecificMatch(query, item)) {
      item.match_count = (item.match_count ?? 0) + 1;
      item.last_matched_at = now;
      changed = true;
    }
    if ((item.match_count ?? 0) >= AUTO_PROMOTE_MATCHES) {
      const { candidate, unsafe } = validateCandidate(item);
      if (candidate) {
        const path = writeAcceptedMemory({ ...candidate, source: `${candidate.source || "memory-context"}; auto-promoted after ${candidate.match_count} matches` });
        promoted.push(path);
      } else if (!unsafe) {
        remaining.push({ ...item, match_count: AUTO_PROMOTE_MATCHES - 1 });
      }
      changed = true;
    } else {
      remaining.push(item);
    }
  }
  if (promoted.length > 0) dedupeMemories(false);
  if (changed || promoted.length > 0) writeQueue(remaining);
  return promoted;
}

function finalText(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n").trim();
}

function commandText(input: any): string {
  return String(input?.command ?? input?.cmd ?? "");
}

function isTestCommand(cmd: string): boolean {
  return /\b(npm test|vitest|pytest|cargo test|go test|pnpm test|yarn test|npm run test|npm run typecheck|tsc\b)/.test(cmd);
}

function candidateType(prompt: string, outcome: string, edited: string[], tests: string[]): string {
  const text = `${prompt}\n${outcome}`.toLowerCase();
  if (/\b(runbook|playbook|procedure|how to|steps?|usage|command)\b/.test(text)) return "runbook";
  if (/\b(decided|decision|choose|chose|prefer|instead|authoritative|policy|convention|should be)\b/.test(text)) return "decision";
  if (/\b(observed|observation|found|root cause|because|why|note|gotcha)\b/.test(text)) return "observation";
  if (edited.length > 0 || tests.length > 0) return "action";
  return "context";
}

function candidateTitle(type: string, edited: string[]): string {
  const files = edited.map((p) => basename(p)).slice(0, 3).join(", ");
  if (type === "action") return files ? `Updated ${files}` : "Validated project behavior";
  if (type === "decision") return files ? `Decision affecting ${files}` : "Captured durable decision";
  if (type === "observation") return files ? `Observation about ${files}` : "Captured durable observation";
  if (type === "runbook") return files ? `Runbook for ${files}` : "Captured reusable runbook";
  return files ? `Context for ${files}` : "Captured durable context";
}

function formatCandidateBody(args: { prompt: string; outcome: string; edited: string[]; read: string[]; tests: string[]; confidence: string }): string {
  const edited = args.edited.length ? args.edited.map((p) => `- ${p}`).join("\n") : "- none";
  const read = args.read.length ? args.read.slice(0, 10).map((p) => `- ${p}`).join("\n") : "- none recorded";
  const validation = args.tests.length ? args.tests.map((cmd) => `- ${cmd}`).join("\n") : "- not run";
  const summary = args.outcome.replace(/\s+/g, " ").slice(0, 700);
  const prompt = args.prompt.replace(/\s+/g, " ").slice(0, 350);
  return [
    `## Summary\n${summary}`,
    `## Evidence\n- Prompt: ${prompt}\n- Confidence: ${args.confidence}`,
    `## Validation\n${validation}`,
    `## Files\nEdited:\n${edited}\n\nRead:\n${read}`,
    "## Follow-up\n- Review for durability before accepting as long-term memory.",
  ].join("\n\n");
}

function dedupeKey(note: MemoryNote): string {
  const normalizedBody = note.body.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedTitle = note.title.toLowerCase().replace(/\s+/g, " ").trim();
  return `${note.type}\n${normalizedTitle}\n${normalizedBody}`;
}

function dedupeMemories(dryRun: boolean): string[] {
  const seen = new Set<string>();
  const removed: string[] = [];
  for (const note of allNotes().sort((a, b) => a.path.localeCompare(b.path))) {
    const key = dedupeKey(note);
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    removed.push(note.path);
    if (!dryRun) unlinkSync(note.path);
  }
  return removed;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("memory-review", {
    description: "Show queued local memory candidates; use /memory-review accept|deny [all|1,3|2-4]",
    handler: async (args, ctx) => {
      const argText = args?.trim() ?? "";
      const dedupedBefore = dedupeMemories(false);
      const queue = readQueue();
      if (argText.startsWith("accept")) {
        const selected = parseSelection(argText.slice("accept".length), queue.length);
        if (selected.length === 0) {
          if (ctx.hasUI) ctx.ui.notify("No queued memory candidates matched that selection.", "warning");
          return;
        }
        const removeSet = new Set<number>();
        const written: string[] = [];
        let rejected = 0;
        let unsafeRejected = 0;
        for (const index of selected) {
          const { candidate, unsafe } = validateCandidate(queue[index]);
          if (!candidate) {
            rejected += 1;
            if (unsafe) {
              unsafeRejected += 1;
              removeSet.add(index);
            }
            continue;
          }
          written.push(writeAcceptedMemory(candidate));
          removeSet.add(index);
        }
        writeQueue(queue.filter((_item, index) => !removeSet.has(index)));
        const dedupedAfter = dedupeMemories(false);
        const rejectedText = rejected ? `; rejected ${rejected} unsafe/invalid candidate(s)${unsafeRejected ? ` and removed ${unsafeRejected} unsafe` : "; invalid candidates remain queued for review/deny"}` : "";
        if (ctx.hasUI) ctx.ui.notify(`Accepted ${written.length} memory candidate(s)${rejectedText}:\n${written.map((path) => relative(process.cwd(), path)).join("\n")}${dedupedAfter.length ? `\nDeduplicated ${dedupedAfter.length} long-term memor${dedupedAfter.length === 1 ? "y" : "ies"}.` : ""}`, "info");
        return;
      }
      if (argText.startsWith("deny")) {
        const selected = parseSelection(argText.slice("deny".length), queue.length);
        if (selected.length === 0) {
          if (ctx.hasUI) ctx.ui.notify("No queued memory candidates matched that selection.", "warning");
          return;
        }
        const selectedSet = new Set(selected);
        writeQueue(queue.filter((_item, index) => !selectedSet.has(index)));
        if (ctx.hasUI) ctx.ui.notify(`Denied ${selected.length} memory candidate(s).`, "info");
        return;
      }
      const lines = queue.length === 0 ? "No queued memory candidates." : queue.map((item, i) => {
        const matches = item.match_count ? `, matches: ${item.match_count}/${AUTO_PROMOTE_MATCHES}` : "";
        return `${i + 1}. [${item.type}] ${item.title} (${item.confidence}${matches})\n${item.body.trim().split("\n").map((line) => `   ${line}`).join("\n")}`;
      }).join("\n\n");
      const prefix = dedupedBefore.length ? `Deduplicated ${dedupedBefore.length} long-term memor${dedupedBefore.length === 1 ? "y" : "ies"}.\n\n` : "";
      if (ctx.hasUI) ctx.ui.notify(`${prefix}${lines}`, "info");
    },
  });

  pi.registerCommand("memory-doctor", {
    description: "Show local memory health, including whether QMD is available",
    handler: async (_args, ctx) => {
      ensureMemory();
      const qmd = await resolveQmd();
      const notes = allNotes();
      const queue = readQueue();
      const dirs = NOTE_DIRS.map((dir) => {
        const full = join(MEMORY_DIR, dir);
        return `${dir}: ${readdirSync(full).filter((file) => file.endsWith(".md")).length} accepted`;
      }).join("\n");
      const lines = [
        `memory dir: ${relative(process.cwd(), MEMORY_DIR)}`,
        `QMD: ${qmd.mode === "qmd" ? `loaded (${qmd.bin ?? "qmd"})` : "not loaded; using grep fallback"}`,
        `queue: ${queue.length} pending candidate(s)`,
        `accepted memories: ${notes.length}`,
        dirs,
      ].join("\n");
      if (ctx.hasUI) ctx.ui.notify(lines, qmd.mode === "qmd" ? "info" : "warning");
    },
  });

  pi.registerCommand("memory-dedupe", {
    description: "Remove duplicate accepted local memories; use /memory-dedupe --dry-run to preview",
    handler: async (args, ctx) => {
      const dryRun = /(^|\s)--dry-run(\s|$)/.test(args ?? "");
      const removed = dedupeMemories(dryRun);
      const verb = dryRun ? "Would remove" : "Removed";
      const lines = removed.length === 0
        ? "No duplicate accepted memories found."
        : `${verb} ${removed.length} duplicate accepted memor${removed.length === 1 ? "y" : "ies"}:\n${removed.map((path) => relative(process.cwd(), path)).join("\n")}`;
      if (ctx.hasUI) ctx.ui.notify(lines, "info");
    },
  });

  pi.registerCommand("memory-list", {
    description: "List accepted local memories",
    handler: async (_args, ctx) => {
      const notes = allNotes();
      const lines = notes.length === 0 ? "No accepted memories." : notes.map((note, i) => `${i + 1}. ${relative(process.cwd(), note.path)}\n   [${note.type}] ${note.title} (${note.confidence})`).join("\n");
      if (ctx.hasUI) ctx.ui.notify(lines, "info");
    },
  });

  pi.registerCommand("memory-search", {
    description: "Search accepted local memories",
    handler: async (args, ctx) => {
      const query = args?.trim() ?? "";
      if (!query) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /memory-search <query>", "warning");
        return;
      }
      const notes = lexicalSearch(query, 10);
      const lines = notes.length === 0 ? "No matching memories." : notes.map((note) => `${relative(process.cwd(), note.path)}\n[${note.type}] ${note.title} (${note.confidence})\n${note.body.replace(/\s+/g, " ").slice(0, 300)}`).join("\n\n");
      if (ctx.hasUI) ctx.ui.notify(lines, "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    ensureMemory();
    turn.prompt = String((event as any).prompt ?? "");
    turn.tools = [];
    turn.filesRead.clear();
    turn.filesEdited.clear();
    turn.tests = [];
    const mode = (await resolveQmd()).mode;
    const promoted = trackShortTermMatches(turn.prompt);
    const notes = lexicalSearch(turn.prompt, 5);
    const memory = buildMemoryBlock(notes, mode);
    const codebase = looksCodebaseIntent(turn.prompt) ? "\n## Codebase Prefetch\nCodebase intent detected. Use code_search first for repo understanding; prefetch is bounded and may be empty/stale.\n" : "";
    if (!memory && !codebase) return;
    try {
      const parts: string[] = [];
      if (memory) parts.push(`+${notes.length} memories`);
      if (promoted.length) parts.push(`auto-promoted ${promoted.length}`);
      if (codebase) parts.push("+codebase-prefetch");
      ctx.ui.notify(`memory-context: ${parts.join(" ")}`, "info");
    } catch {
      // best-effort
    }
    return { systemPrompt: `${(event as any).systemPrompt ?? ""}${memory}${codebase}` };
  });

  pi.on("tool_call", async (event) => {
    const name = String((event as any).toolName ?? (event as any).name ?? "");
    const input = (event as any).input ?? (event as any).arguments ?? {};
    if (name) turn.tools.push(name);
    const p = input.path || input.file_path;
    if (typeof p === "string") {
      if (/read|findRead|glob|grep/.test(name)) turn.filesRead.add(p);
      if (/write|edit/.test(name)) turn.filesEdited.add(p);
    }
    if (name === "bash") {
      const cmd = commandText(input);
      if (isTestCommand(cmd)) turn.tests.push(cmd.slice(0, 200));
    }
  });

  pi.on("turn_end", async (event) => {
    const text = finalText((event as any).message);
    if (!text || turn.tools.length === 0) return;
    const edited = [...turn.filesEdited];
    const tests = turn.tests;
    if (edited.length === 0 && tests.length === 0) return;
    const now = new Date().toISOString();
    const confidence = edited.length > 0 && tests.length > 0 ? "high" : tests.length > 0 ? "medium" : "low";
    const type = candidateType(turn.prompt, text, edited, tests);
    queueCandidate({
      type,
      title: candidateTitle(type, edited),
      created_at: now,
      updated_at: now,
      source: "memory-context deterministic turn_end",
      confidence,
      tags: [type, ...edited.map((p) => basename(p)).slice(0, 5)],
      evidence: { prompt: turn.prompt.slice(0, 500), tools: [...new Set(turn.tools)], files_edited: edited, files_read: [...turn.filesRead], tests_run: tests },
      body: formatCandidateBody({ prompt: turn.prompt, outcome: text, edited, read: [...turn.filesRead], tests, confidence }),
    });
  });
}
