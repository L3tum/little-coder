import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { containsSecret } from "../security/index.ts";

const execFileAsync = promisify(execFile);
function memoryDir(): string {
  return process.env.MEMORY_CONTEXT_DIR || join(process.cwd(), ".pi", "memory");
}

const NOTE_DIRS = ["20-context", "40-actions", "50-decisions", "60-observations", "70-runbooks", "80-sessions"];
const MAX_INJECT_CHARS = 5000;

function queuePath(): string {
  return join(memoryDir(), "queue.json");
}

function rejectionsPath(): string {
  return join(memoryDir(), "rejections.json");
}

function statePath(): string {
  return join(memoryDir(), "state.json");
}

export interface MemoryNote {
  path: string;
  title: string;
  type: string;
  tags: string[];
  confidence: string;
  salience: number;
  status: string;
  useCount: number;
  lastUsedAt: string;
  expiresAt: string;
  body: string;
}

export interface QueueItem {
  type: string;
  title: string;
  created_at: string;
  updated_at: string;
  source: string;
  confidence: string;
  tags: string[];
  evidence: Record<string, unknown>;
  body: string;
  salience?: number;
  rejection_reason?: string;
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
  const dir = memoryDir();
  mkdirSync(dir, { recursive: true });
  for (const noteDir of NOTE_DIRS) mkdirSync(join(dir, noteDir), { recursive: true });
  if (!existsSync(queuePath())) writeFileSync(queuePath(), "[]\n");
  if (!existsSync(rejectionsPath())) writeFileSync(rejectionsPath(), "[]\n");
  if (!existsSync(statePath())) writeFileSync(statePath(), `${JSON.stringify({ active_day: 0, last_access_date: "" }, null, 2)}\n`);
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
    const full = join(memoryDir(), dir);
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
        salience: Number(parsed.meta.salience ?? 0) || 0,
        status: parsed.meta.status || "active",
        useCount: Number(parsed.meta.use_count ?? 0) || 0,
        lastUsedAt: parsed.meta.last_used_at || "",
        expiresAt: parsed.meta.expires_at || "",
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

function categoryBoost(type: string): number {
  if (type === "decision" || type === "50-decisions") return 6;
  if (type === "runbook" || type === "70-runbooks") return 5;
  if (type === "observation" || type === "60-observations") return 4;
  if (type === "context" || type === "20-context") return 2;
  if (type === "action" || type === "40-actions") return -2;
  if (type === "session" || type === "80-sessions") return -3;
  return 0;
}

function genericTitlePenalty(title: string): number {
  return /^(updated|validated project behavior|captured durable|context for|decision affecting|observation about|runbook for)\b/i.test(title.trim()) ? 5 : 0;
}

function usageBoost(note: MemoryNote): number {
  return Math.min(Math.floor(Math.log2(note.useCount + 1)), 3);
}

function recencyBoost(note: MemoryNote): number {
  const lastUsedDay = activeDayValue(note.lastUsedAt);
  if (lastUsedDay <= 0) return 0;
  const age = memoryState().active_day - lastUsedDay;
  if (age <= 1) return 2;
  if (age <= 7) return 1;
  return 0;
}

export function memoryRankScore(query: string, note: MemoryNote): number {
  const lexical = lexicalScore(query, `${note.title}\n${note.tags.join(" ")}\n${note.body}`);
  if (lexical <= 0) return 0;
  const confidenceBoost = note.confidence === "high" ? 2 : note.confidence === "medium" ? 1 : 0;
  return lexical + Math.min(note.salience, 10) + confidenceBoost + categoryBoost(note.type) + usageBoost(note) + recencyBoost(note) - genericTitlePenalty(note.title);
}

export function isExpired(note: MemoryNote): boolean {
  if (!note.expiresAt) return false;
  const activeExpiry = note.expiresAt.match(/^active-days:(\d+)$/);
  if (activeExpiry) {
    const lastUsedDay = activeDayValue(note.lastUsedAt);
    if (lastUsedDay <= 0) return false;
    return memoryState().active_day - lastUsedDay >= Number(activeExpiry[1]);
  }
  const expires = Date.parse(note.expiresAt);
  return Number.isFinite(expires) && expires <= Date.now();
}

export function rankMemories(query: string, notes: MemoryNote[], limit = 5): MemoryNote[] {
  const scored = notes
    .filter((note) => note.status === "active" && !isExpired(note))
    .map((note) => ({ note, score: memoryRankScore(query, note) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const strong = scored.filter((x) => x.score >= 6 || (x.note.salience >= 6 && categoryBoost(x.note.type) > 0));
  const selected = strong.length > 0 ? strong : scored;
  return selected.slice(0, limit).map((x) => x.note);
}

function lexicalSearch(query: string, limit = 5): MemoryNote[] {
  return rankMemories(query, allNotes(), limit);
}

function touchMemories(notes: MemoryNote[]): void {
  if (notes.length === 0) return;
  const activeDay = markMemoryAccess();
  for (const note of notes) upsertFrontmatter(note.path, { use_count: note.useCount + 1, last_used_at: `active-day:${activeDay}` });
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

export function readQueue(): QueueItem[] {
  ensureMemory();
  try {
    const parsed = JSON.parse(readFileSync(queuePath(), "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeQueue(items: QueueItem[]): void {
  writeFileSync(queuePath(), `${JSON.stringify(items, null, 2)}\n`);
}

interface RejectionItem {
  rejected_at: string;
  reason: string;
  type: string;
  title: string;
  confidence: string;
  salience: number;
}

function readRejections(): RejectionItem[] {
  ensureMemory();
  try {
    const parsed = JSON.parse(readFileSync(rejectionsPath(), "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRejections(items: RejectionItem[]): void {
  writeFileSync(rejectionsPath(), `${JSON.stringify(items.slice(-100), null, 2)}\n`);
}

function recordRejection(item: QueueItem, reason: string, salience: number): void {
  writeRejections([...readRejections(), {
    rejected_at: new Date().toISOString(),
    reason,
    type: item.type,
    title: item.title,
    confidence: item.confidence,
    salience,
  }]);
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

function memoryState(): { active_day: number; last_access_date: string } {
  ensureMemory();
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf-8"));
    return { active_day: Number(parsed.active_day ?? 0) || 0, last_access_date: String(parsed.last_access_date ?? "") };
  } catch {
    return { active_day: 0, last_access_date: "" };
  }
}

function markMemoryAccess(): number {
  const state = memoryState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.last_access_date !== today) {
    state.active_day += 1;
    state.last_access_date = today;
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  }
  return state.active_day;
}

function activeDayValue(value: string): number {
  const m = value.match(/^active-day:(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function activeTtl(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function expiryForAccepted(item: QueueItem): string {
  const normalized = noteDirForType(item.type);
  if (normalized !== "40-actions" && normalized !== "80-sessions") return "";
  const salience = item.salience ?? 0;
  if (salience >= 8) return "";
  if (salience >= 6) return `active-days:${activeTtl("MEMORY_CONTEXT_MEDIUM_TTL_ACTIVE_DAYS", 90)}`;
  return `active-days:${activeTtl("MEMORY_CONTEXT_LOW_TTL_ACTIVE_DAYS", 30)}`;
}

function upsertFrontmatter(path: string, updates: Record<string, string | number>): void {
  const text = readFileSync(path, "utf-8");
  const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 4) : -1;
  if (end < 0) return;
  const existing = text.slice(4, end).split("\n");
  const keys = new Set(Object.keys(updates));
  const lines = existing.map((line) => {
    const m = line.match(/^([a-z_]+):/i);
    if (!m || !keys.has(m[1])) return line;
    keys.delete(m[1]);
    const value = updates[m[1]];
    return `${m[1]}: ${typeof value === "number" ? value : yamlString(value)}`;
  });
  for (const key of keys) {
    const value = updates[key];
    lines.push(`${key}: ${typeof value === "number" ? value : yamlString(value)}`);
  }
  writeFileSync(path, `---\n${lines.join("\n")}\n---\n${text.slice(end + 5)}`);
}

function supersessionIntent(item: QueueItem): boolean {
  return /\b(replace[sd]?|supersede[sd]?|instead of|no longer|now use|new convention|changed convention|deprecated|obsolete)\b/i.test(`${item.title}\n${item.body}`);
}

function contradictionIntent(item: QueueItem, note: MemoryNote): boolean {
  const newer = `${item.title}\n${item.body}`.toLowerCase();
  const older = `${note.title}\n${note.body}`.toLowerCase();
  const negative = /\b(must not|should not|do not|don't|never|avoid|disable|reject|deny|skip|ignore|forbid|exclude)\b/;
  const positive = /\b(must|should|always|use|enable|accept|allow|queue|save|include|require)\b/;
  const newerNegative = negative.test(newer);
  const olderPositive = positive.test(older) && !negative.test(older);
  const newerPositive = positive.test(newer) && !newerNegative;
  const olderNegative = negative.test(older);
  if ((newerNegative && olderPositive) || (newerPositive && olderNegative)) return true;
  const pairs: Array<[RegExp, RegExp]> = [
    [/\b(queue|queues|save|saves|persist|persists|store|stores)\b/, /\b(drop|drops|discard|discards|reject|rejects|ignore|ignores|skip|skips)\b/],
    [/\b(enable|allow|include|use)\b/, /\b(disable|deny|exclude|avoid)\b/],
    [/\b(auto-?promote|promote)\b/, /\b(manual review|require review|do not promote|never promote)\b/],
  ];
  return pairs.some(([a, b]) => (a.test(newer) && b.test(older)) || (b.test(newer) && a.test(older)));
}

function overlappingMemory(item: QueueItem, note: MemoryNote): boolean {
  if (note.status !== "active" || item.type !== note.type) return false;
  const itemTags = new Set((item.tags ?? []).map((tag) => tag.toLowerCase()).filter((tag) => !["action", "context", "decision", "observation", "runbook", "session"].includes(tag)));
  const noteTags = note.tags.map((tag) => tag.toLowerCase());
  if (noteTags.some((tag) => itemTags.has(tag))) return true;
  const evidence = item.evidence ?? {};
  const paths = [
    ...((evidence.files_edited as string[] | undefined) ?? []),
    ...((evidence.files_read as string[] | undefined) ?? []),
  ].map((p) => basename(p).toLowerCase());
  const noteText = `${note.title}\n${note.tags.join(" ")}\n${note.body}`.toLowerCase();
  return paths.some((p) => p.length >= 3 && noteText.includes(p));
}

export function supersededMemoryCandidates(item: QueueItem, notes: MemoryNote[]): MemoryNote[] {
  return notes.filter((note) => overlappingMemory(item, note) && (supersessionIntent(item) || contradictionIntent(item, note))).slice(0, 5);
}

export function writeAcceptedMemory(item: QueueItem): string {
  ensureMemory();
  const superseded = supersededMemoryCandidates(item, allNotes());
  const dir = join(memoryDir(), noteDirForType(item.type));
  let path = join(dir, `${randomUUID()}.md`);
  while (existsSync(path)) path = join(dir, `${randomUUID()}.md`);
  const expiresAt = expiryForAccepted(item);
  const supersedes = superseded.map((note) => relative(process.cwd(), note.path)).join(", ");
  const frontmatter = [
    "---",
    `title: ${yamlString(item.title)}`,
    `type: ${yamlString(item.type)}`,
    `tags: ${yamlString((item.tags ?? []).join(", "))}`,
    `confidence: ${yamlString(item.confidence || "unknown")}`,
    `salience: ${Number(item.salience ?? 0) || 0}`,
    `status: ${yamlString("active")}`,
    `use_count: 0`,
    `last_used_at: ${yamlString(`active-day:${markMemoryAccess()}`)}`,
    `expires_at: ${yamlString(expiresAt)}`,
    `supersedes: ${yamlString(supersedes)}`,
    `source: ${yamlString(item.source || "memory-review")}`,
    `created_at: ${yamlString(item.created_at || new Date().toISOString())}`,
    `updated_at: ${yamlString(new Date().toISOString())}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(path, `${frontmatter}${item.body.trim()}\n`);
  const now = new Date().toISOString();
  for (const note of superseded) upsertFrontmatter(note.path, { status: "superseded", updated_at: now });
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

export function scoreCandidate(item: QueueItem): { salience: number; reason?: string } {
  const body = String(item.body ?? "");
  const title = String(item.title ?? "");
  const evidence = item.evidence ?? {};
  const files = [
    ...((evidence.files_edited as string[] | undefined) ?? []),
    ...((evidence.files_read as string[] | undefined) ?? []),
  ];
  const tests = (evidence.tests_run as string[] | undefined) ?? [];
  const text = `${title}\n${item.tags?.join(" ") ?? ""}\n${body}`.toLowerCase();
  if (/^updated\s+[^\n]+$/i.test(title.trim()) && !/decision|decided|root cause|gotcha|preference|convention|must|should|avoid|use `/i.test(body)) {
    return { salience: 0, reason: "generic update summary" };
  }
  if (/^(validated project behavior|captured durable context)$/i.test(title.trim())) {
    return { salience: 0, reason: "generic title" };
  }
  if (/review for durability before accepting as long-term memory/i.test(body) && body.replace(/review for durability before accepting as long-term memory/ig, "").length < 400) {
    return { salience: 0, reason: "boilerplate-only candidate" };
  }
  let score = 0;
  if (/\b(decided|decision|prefer|instead|convention|policy|must|should|never|always)\b/i.test(text)) score += 3;
  if (/\b(root cause|because|gotcha|observed|found|bug|fix|avoid|fallback)\b/i.test(text)) score += 2;
  if (/\b(runbook|steps?|command|usage|how to)\b/i.test(text)) score += 2;
  if (files.some((p) => /[/.]/.test(p))) score += 1;
  if (tests.length > 0) score += 1;
  if (item.confidence === "high") score += 2;
  else if (item.confidence === "medium") score += 1;
  if ((item.type === "decision" || item.type === "runbook" || item.type === "observation") && !genericTitlePenalty(title)) score += 2;
  if (genericTitlePenalty(title)) score -= 3;
  if (item.type === "action" || item.type === "session") score -= 1;
  return score >= 6 ? { salience: Math.min(score, 10) } : { salience: Math.max(score, 0), reason: `low salience (${score}/10)` };
}

export function candidateReview(item: QueueItem): { accepted: boolean; salience: number; reason?: string; unsafe: boolean } {
  const confidence = String(item.confidence ?? "").toLowerCase();
  const body = String(item.body ?? "").trim();
  const scored = scoreCandidate({ ...item, confidence, body });
  const candidate = { ...item, confidence, salience: scored.salience, rejection_reason: scored.reason, body: body.length > 2400 ? body.slice(0, 2400) : body };
  if (containsSecret(candidate)) return { accepted: false, salience: scored.salience, reason: "unsafe content", unsafe: true };
  if (confidence !== "high" && confidence !== "medium") return { accepted: false, salience: scored.salience, reason: "confidence below medium", unsafe: false };
  if (!body) return { accepted: false, salience: scored.salience, reason: "empty body", unsafe: false };
  if (scored.reason) return { accepted: false, salience: scored.salience, reason: scored.reason, unsafe: false };
  return { accepted: true, salience: scored.salience, unsafe: false };
}

function validateCandidate(item: QueueItem): { candidate: QueueItem | null; unsafe: boolean } {
  const confidence = String(item.confidence ?? "").toLowerCase();
  const body = String(item.body ?? "").trim();
  const review = candidateReview({ ...item, confidence, body });
  const candidate = { ...item, confidence, salience: review.salience, rejection_reason: review.reason, body: body.length > 2400 ? body.slice(0, 2400) : body };
  if (!review.accepted) return { candidate: null, unsafe: review.unsafe };
  return { candidate, unsafe: false };
}

export function candidateFingerprint(item: Pick<QueueItem, "type" | "title" | "body">): string {
  const body = String(item.body ?? "")
    .split(/(?=^## )/m)
    .filter((section) => !/^## (Evidence|Validation|Files)\b/i.test(section.trim()))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const title = String(item.title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${item.type}\n${title}\n${body}`;
}

function duplicateQueuedCandidate(item: QueueItem, queue: QueueItem[]): boolean {
  const fingerprint = candidateFingerprint(item);
  return queue.some((queued) => candidateFingerprint(queued) === fingerprint);
}

export function duplicateAcceptedCandidate(item: QueueItem, notes = allNotes()): boolean {
  const fingerprint = candidateFingerprint(item);
  return notes.some((note) => note.status === "active" && candidateFingerprint({ type: note.type, title: note.title, body: note.body }) === fingerprint);
}

function queueCandidate(item: QueueItem): void {
  if (process.env.MEMORY_LEARNING === "off") return;
  const { candidate, unsafe } = validateCandidate(item);
  if (!candidate) {
    const review = candidateReview(item);
    recordRejection(item, unsafe ? "unsafe content" : review.reason ?? "invalid candidate", review.salience);
    return;
  }
  const queue = readQueue();
  if (duplicateQueuedCandidate(candidate, queue) || duplicateAcceptedCandidate(candidate)) {
    recordRejection(candidate, "duplicate candidate", candidate.salience ?? 0);
    return;
  }
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
        if (duplicateAcceptedCandidate(candidate)) {
          recordRejection(candidate, "duplicate candidate", candidate.salience ?? 0);
        } else {
          const path = writeAcceptedMemory({ ...candidate, source: `${candidate.source || "memory-context"}; auto-promoted after ${candidate.match_count} matches` });
          promoted.push(path);
        }
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

export function candidateType(prompt: string, outcome: string, edited: string[], tests: string[]): string {
  const text = `${prompt}\n${outcome}`.toLowerCase();
  if (/\b(runbook|playbook|procedure|how to|steps?|usage|command)\b/.test(text)) return "runbook";
  if (/\b(decided|decision|choose|chose|prefer|instead|authoritative|policy|convention|should be)\b/.test(text)) return "decision";
  if (/\b(observed|observation|found|root cause|because|why|note|gotcha)\b/.test(text)) return "observation";
  if (edited.length > 0 || tests.length > 0) return "action";
  return "context";
}

function titleFragment(text: string): string {
  const cleaned = text
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .split(/[.!?]\s/)[0]
    .trim();
  return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
}

export function candidateTitle(type: string, edited: string[], prompt = "", outcome = ""): string {
  const files = edited.map((p) => basename(p)).slice(0, 2).join(", ");
  const source = titleFragment(outcome) || titleFragment(prompt);
  if (source && !/^(done|implemented|fixed|updated|validated|changed)$/i.test(source)) {
    const prefix = type === "decision" ? "Decision" : type === "observation" ? "Observation" : type === "runbook" ? "Runbook" : type === "action" ? "Action" : "Context";
    return files ? `${prefix}: ${source} (${files})` : `${prefix}: ${source}`;
  }
  if (type === "action") return files ? `Action for ${files}` : "Action with reusable outcome";
  if (type === "decision") return files ? `Decision for ${files}` : "Durable decision";
  if (type === "observation") return files ? `Observation for ${files}` : "Durable observation";
  if (type === "runbook") return files ? `Runbook for ${files}` : "Reusable runbook";
  return files ? `Context for ${files}` : "Durable context";
}

export function candidateFollowUp(args: { edited: string[]; tests: string[]; confidence: string; type?: string }): string[] {
  const out: string[] = [];
  if (args.edited.length > 0 && args.tests.length === 0) out.push("Run targeted tests before promoting this memory.");
  if (args.confidence === "low") out.push("Verify this against source before accepting.");
  if (args.type === "decision" && args.edited.every((p) => !/docs?\//.test(p))) out.push("Consider documenting this decision in project docs if it is policy-level.");
  return out;
}

export function turnCandidate(args: { prompt: string; outcome: string; edited: string[]; read: string[]; tests: string[]; tools: string[]; now?: string }): QueueItem | null {
  if (!args.outcome || (args.edited.length === 0 && args.tests.length === 0)) return null;
  const now = args.now ?? new Date().toISOString();
  const confidence = args.edited.length > 0 && args.tests.length > 0 ? "high" : args.tests.length > 0 ? "medium" : "low";
  const type = candidateType(args.prompt, args.outcome, args.edited, args.tests);
  return {
    type,
    title: candidateTitle(type, args.edited, args.prompt, args.outcome),
    created_at: now,
    updated_at: now,
    source: "memory-context deterministic turn_end",
    confidence,
    tags: [type, ...args.edited.map((p) => basename(p)).slice(0, 5)],
    evidence: { prompt: args.prompt.slice(0, 500), tools: [...new Set(args.tools)], files_edited: args.edited, files_read: args.read, tests_run: args.tests },
    body: formatCandidateBody({ prompt: args.prompt, outcome: args.outcome, edited: args.edited, read: args.read, tests: args.tests, confidence, type }),
  };
}

export function formatCandidateBody(args: { prompt: string; outcome: string; edited: string[]; read: string[]; tests: string[]; confidence: string; type?: string }): string {
  const edited = args.edited.length ? args.edited.map((p) => `- ${p}`).join("\n") : "- none";
  const read = args.read.length ? args.read.slice(0, 10).map((p) => `- ${p}`).join("\n") : "- none recorded";
  const validation = args.tests.length ? args.tests.map((cmd) => `- ${cmd}`).join("\n") : "- not run";
  const summary = args.outcome.replace(/\s+/g, " ").slice(0, 700);
  const prompt = args.prompt.replace(/\s+/g, " ").slice(0, 350);
  const sections = [
    `## Summary\n${summary}`,
    `## Evidence\n- Prompt: ${prompt}\n- Confidence: ${args.confidence}`,
    `## Validation\n${validation}`,
    `## Files\nEdited:\n${edited}\n\nRead:\n${read}`,
  ];
  const followUp = candidateFollowUp(args);
  if (followUp.length > 0) sections.push(`## Follow-up\n${followUp.map((line) => `- ${line}`).join("\n")}`);
  return sections.join("\n\n");
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

export function staleQueueIndexes(items: QueueItem[], now = Date.now()): number[] {
  const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
  const out: number[] = [];
  items.forEach((item, index) => {
    const created = Date.parse(item.created_at);
    if (Number.isFinite(created) && now - created > maxAgeMs) out.push(index);
  });
  return out;
}

export function prunableMemories(notes = allNotes(), category?: string): MemoryNote[] {
  return notes.filter((note) => {
    if (category && note.type !== category && noteDirForType(note.type) !== category) return false;
    return note.status === "active" && (isExpired(note) || ((note.type === "action" || note.type === "session") && note.salience > 0 && note.salience <= 2 && note.useCount === 0));
  });
}

function pruneMemories(dryRun: boolean, category?: string): { expired: MemoryNote[]; staleQueue: number } {
  const expired = prunableMemories(allNotes(), category);
  if (!dryRun) {
    const now = new Date().toISOString();
    for (const note of expired) upsertFrontmatter(note.path, { status: "expired", updated_at: now });
    const queue = readQueue();
    const stale = new Set(staleQueueIndexes(queue));
    if (stale.size > 0) writeQueue(queue.filter((_item, index) => !stale.has(index)));
    return { expired, staleQueue: stale.size };
  }
  return { expired, staleQueue: staleQueueIndexes(readQueue()).length };
}

function categoryArg(args: string | undefined): string | undefined {
  const raw = (args ?? "").match(/--category\s+([a-z0-9_-]+)/i)?.[1];
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  return NOTE_DIRS.includes(normalized) ? normalized : noteDirForType(normalized);
}

function sortedNotes(): MemoryNote[] {
  return allNotes().sort((a, b) => a.path.localeCompare(b.path));
}

export function filterMemoriesByStatus(notes: MemoryNote[], status?: string): MemoryNote[] {
  if (!status || status === "all") return notes;
  return notes.filter((note) => note.status === status || (status === "expired" && isExpired(note)));
}

function resolveMemoryRef(ref: string, notes: MemoryNote[]): MemoryNote | null {
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1 && n <= notes.length) return notes[n - 1];
  const byPath = notes.find((note) => note.path === ref || relative(process.cwd(), note.path) === ref || note.path.endsWith(ref));
  return byPath ?? null;
}

function supersedeMemory(newer: MemoryNote, older: MemoryNote): void {
  const now = new Date().toISOString();
  upsertFrontmatter(newer.path, { supersedes: relative(process.cwd(), older.path), updated_at: now });
  upsertFrontmatter(older.path, { status: "superseded", updated_at: now });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("memory-review", {
    description: "Show queued local memory candidates; use /memory-review explain|accept|deny [all|1,3|2-4]; accept supports --force for duplicates",
    handler: async (args, ctx) => {
      const argText = args?.trim() ?? "";
      const dedupedBefore = dedupeMemories(false);
      const queue = readQueue();
      if (argText.startsWith("explain")) {
        const selected = parseSelection(argText.slice("explain".length), queue.length);
        if (selected.length === 0) {
          if (ctx.hasUI) ctx.ui.notify("Usage: /memory-review explain <candidate-number>", "warning");
          return;
        }
        const notes = allNotes();
        const lines = selected.map((index) => {
          const item = queue[index];
          const review = candidateReview(item);
          const duplicate = duplicateAcceptedCandidate(item, notes);
          const supersedes = supersededMemoryCandidates(item, notes);
          return [
            `${index + 1}. [${item.type}] ${item.title}`,
            `status: ${review.accepted && !duplicate ? "accepted by current filter" : "would reject"}`,
            `salience: ${review.salience}/10`,
            `reason: ${duplicate ? "duplicate candidate" : review.reason ?? "passes current salience filter"}`,
            `confidence: ${item.confidence}`,
            `fingerprint: ${candidateFingerprint(item).slice(0, 180)}`,
            `would supersede: ${supersedes.length ? supersedes.map((note) => relative(process.cwd(), note.path)).join(", ") : "none"}`,
          ].join("\n");
        }).join("\n\n");
        if (ctx.hasUI) ctx.ui.notify(lines, "info");
        return;
      }
      if (argText.startsWith("accept")) {
        const force = /(^|\s)--force(\s|$)/.test(argText);
        const selected = parseSelection(argText.slice("accept".length).replace(/(^|\s)--force(\s|$)/g, " "), queue.length);
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
          if (!force && duplicateAcceptedCandidate(candidate)) {
            rejected += 1;
            recordRejection(candidate, "duplicate candidate", candidate.salience ?? 0);
            removeSet.add(index);
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
        const currentReview = candidateReview(item);
        const matches = item.match_count ? `, matches: ${item.match_count}/${AUTO_PROMOTE_MATCHES}` : "";
        const salience = `, salience: ${item.salience ?? currentReview.salience}/10`;
        const review = currentReview.accepted ? "\n   Review: passes current salience filter" : `\n   Review: ${currentReview.reason ?? "invalid candidate"}`;
        return `${i + 1}. [${item.type}] ${item.title} (${item.confidence}${salience}${matches})${review}\n${item.body.trim().split("\n").map((line) => `   ${line}`).join("\n")}`;
      }).join("\n\n");
      const prefix = dedupedBefore.length ? `Deduplicated ${dedupedBefore.length} long-term memor${dedupedBefore.length === 1 ? "y" : "ies"}.\n\n` : "";
      if (ctx.hasUI) ctx.ui.notify(`${prefix}${lines}`, "info");
    },
  });

  pi.registerCommand("memory-doctor", {
    description: "Show local memory health, including whether QMD is available",
    handler: async (args, ctx) => {
      ensureMemory();
      const verbose = /(^|\s)--verbose(\s|$)/.test(args ?? "");
      const qmd = await resolveQmd();
      const notes = allNotes();
      const queue = readQueue();
      const rejections = readRejections();
      const dirs = NOTE_DIRS.map((dir) => {
        const full = join(memoryDir(), dir);
        return `${dir}: ${readdirSync(full).filter((file) => file.endsWith(".md")).length} accepted`;
      }).join("\n");
      const active = notes.filter((note) => note.status === "active" && !isExpired(note)).length;
      const expired = notes.filter((note) => note.status === "expired" || isExpired(note)).length;
      const inactive = notes.length - active;
      const averageSalience = notes.length ? (notes.reduce((sum, note) => sum + note.salience, 0) / notes.length).toFixed(1) : "0.0";
      const staleQueue = staleQueueIndexes(queue).length;
      const pruneCount = prunableMemories(notes).length;
      const rejectionCounts = rejections.reduce((counts, item) => counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1), new Map<string, number>());
      const topRejections = [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => `${reason}: ${count}`).join(", ") || "none";
      const genericOffenders = notes.filter((note) => note.status === "active" && genericTitlePenalty(note.title) > 0).slice(0, 5);
      const genericLine = genericOffenders.length === 0 ? "none" : genericOffenders.map((note) => relative(process.cwd(), note.path)).join(", ");
      const lines = [
        `memory dir: ${relative(process.cwd(), memoryDir())}`,
        `QMD: ${qmd.mode === "qmd" ? `loaded (${qmd.bin ?? "qmd"})` : "not loaded; using grep fallback"}`,
        `queue: ${queue.length} pending candidate(s), ${staleQueue} stale`,
        `accepted memories: ${notes.length} (${active} active, ${inactive} inactive, ${expired} expired)`,
        `average salience: ${averageSalience}/10`,
        `prunable accepted memories: ${pruneCount}`,
        `recent rejected candidates: ${rejections.length}; top reasons: ${topRejections}`,
        `generic-title offenders: ${genericLine}`,
        dirs,
        verbose ? `\nverbose\nlowest salience active:\n${notes.filter((note) => note.status === "active").sort((a, b) => a.salience - b.salience).slice(0, 5).map((note) => `- ${relative(process.cwd(), note.path)} (${note.salience}/10, uses: ${note.useCount})`).join("\n") || "none"}` : "",
      ].filter(Boolean).join("\n");
      if (ctx.hasUI) ctx.ui.notify(lines, qmd.mode === "qmd" ? "info" : "warning");
    },
  });

  pi.registerCommand("memory-rejections", {
    description: "Show recently rejected local memory candidates; use /memory-rejections clear to reset",
    handler: async (args, ctx) => {
      if ((args ?? "").trim() === "clear") {
        writeRejections([]);
        if (ctx.hasUI) ctx.ui.notify("Cleared rejected memory candidate log.", "info");
        return;
      }
      const rejections = readRejections().slice(-20).reverse();
      const lines = rejections.length === 0 ? "No recent rejected memory candidates." : rejections.map((item, i) => `${i + 1}. [${item.type}] ${item.title} (${item.confidence}, salience: ${item.salience}/10)\n   ${item.reason}\n   ${item.rejected_at}`).join("\n\n");
      if (ctx.hasUI) ctx.ui.notify(lines, "info");
    },
  });

  pi.registerCommand("memory-prune", {
    description: "Expire stale/low-value memories and remove stale queued candidates; use /memory-prune --dry-run [--category action|session] to preview",
    handler: async (args, ctx) => {
      const dryRun = /(^|\s)--dry-run(\s|$)/.test(args ?? "");
      const category = categoryArg(args);
      const result = pruneMemories(dryRun, category);
      const verb = dryRun ? "Would expire" : "Expired";
      const memoryLines = result.expired.length === 0
        ? "No accepted memories matched prune rules."
        : `${verb} ${result.expired.length} accepted memor${result.expired.length === 1 ? "y" : "ies"}:\n${result.expired.map((note) => `- ${relative(process.cwd(), note.path)} [${note.type}] ${note.title}`).join("\n")}`;
      const queueLine = dryRun
        ? `Would remove ${result.staleQueue} stale queued candidate(s).`
        : `Removed ${result.staleQueue} stale queued candidate(s).`;
      const categoryLine = category ? `category: ${category}\n` : "";
      if (ctx.hasUI) ctx.ui.notify(`${categoryLine}${memoryLines}\n${queueLine}`, "info");
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
    description: "List accepted local memories; use /memory-list --status active|expired|superseded",
    handler: async (args, ctx) => {
      const status = (args ?? "").match(/--status\s+(active|expired|superseded|all)\b/)?.[1];
      const notes = filterMemoriesByStatus(sortedNotes(), status);
      const lines = notes.length === 0 ? "No accepted memories matched." : notes.map((note, i) => `${i + 1}. ${relative(process.cwd(), note.path)}\n   [${note.type}] ${note.title} (${note.confidence}, status: ${isExpired(note) && note.status === "active" ? "expired" : note.status}, salience: ${note.salience}/10, uses: ${note.useCount})`).join("\n");
      if (ctx.hasUI) ctx.ui.notify(lines, "info");
    },
  });

  pi.registerCommand("memory-supersede", {
    description: "Mark an older memory superseded by a newer memory; usage: /memory-supersede <new-index-or-path> <old-index-or-path>",
    handler: async (args, ctx) => {
      const [newRef, oldRef] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      if (!newRef || !oldRef) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /memory-supersede <new-index-or-path> <old-index-or-path>", "warning");
        return;
      }
      const notes = sortedNotes();
      const newer = resolveMemoryRef(newRef, notes);
      const older = resolveMemoryRef(oldRef, notes);
      if (!newer || !older) {
        if (ctx.hasUI) ctx.ui.notify("Could not resolve one or both memory references. Use /memory-list for indexes.", "warning");
        return;
      }
      if (newer.path === older.path) {
        if (ctx.hasUI) ctx.ui.notify("A memory cannot supersede itself.", "warning");
        return;
      }
      supersedeMemory(newer, older);
      if (ctx.hasUI) ctx.ui.notify(`${relative(process.cwd(), newer.path)} now supersedes ${relative(process.cwd(), older.path)}.`, "info");
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
      touchMemories(notes);
      const lines = notes.length === 0 ? "No matching memories." : notes.map((note) => `${relative(process.cwd(), note.path)}\n[${note.type}] ${note.title} (${note.confidence}, salience: ${note.salience}/10)\n${note.body.replace(/\s+/g, " ").slice(0, 300)}`).join("\n\n");
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
    touchMemories(notes);
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
    const candidate = turnCandidate({
      prompt: turn.prompt,
      outcome: finalText((event as any).message),
      edited: [...turn.filesEdited],
      read: [...turn.filesRead],
      tests: turn.tests,
      tools: turn.tools,
    });
    if (!candidate || turn.tools.length === 0) return;
    queueCandidate(candidate);
  });
}
