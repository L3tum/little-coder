// Source: https://github.com/tmustier/pi-extensions/tree/main/pi-ralph-wiggum
// Adapted for little-coder: issue-backed Ralph harness (Forgejo/GitHub), not file-backed tasks.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planningModePrompt } from "../plan-mode/planning-prompt.js";

const STATES = ["PLANNING", "WAITING_FOR_FEEDBACK", "EXECUTING", "REQUESTING_REVIEW", "WAITING_FOR_REVIEW", "PR_PENDING"] as const;
type AiState = typeof STATES[number];

type Issue = { number: number; title: string; body?: string; labels: string[]; url: string; apiUrl: string };
type PullRequestItem = Issue & { kind: "pr"; head: string; base: string; headRepo?: string; diffUrl?: string };
type WorkItem = Issue | PullRequestItem;
type WorkKind = "issue" | "review" | "rework";
type RequiredMarker = "plan" | "done" | "verdict";
type ReviewVerdict = "approve" | "comment" | "request_changes";
type PrResult = { createdPr: boolean; message: string };
type Models = { planning?: string; execution?: string; fallback: string[] };
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ThinkingLevels = { planning?: ThinkingLevel; execution?: ThinkingLevel };
type Config = { repos: string[]; models: Models; thinkingLevels: ThinkingLevels; workdir: string; token?: string; intervalMs: number; dryRun: boolean };
type IssueAgentAskRequest = { question?: string; questions?: string[]; choices?: string[]; context: string };

let running = false;
let stopRequested = false;
let activeAgentRun = false;
let currentLock: string | undefined;
let activeWork: { repo: string; issue: WorkItem; cfg: Config; dir: string; fallbackIndex: number; doneText?: string; askRequest?: IssueAgentAskRequest; kind?: WorkKind; requiredMarker?: RequiredMarker } | undefined;
let activeSubAgent: { kill: () => void } | undefined;
let statusText = "idle";
let lastStatusAt = 0;
let statusLog: ((text: string) => void) | undefined;
const recentlyQueued = new Map<string, number>();
const usageLimitedUntil = new Map<string, number>();
const dependencyCheckedAt = new Map<string, number>();
const dependencyBlocked = new Map<string, boolean>();
const QUEUED_COOLDOWN_MS = 10 * 60 * 1000;
const DEPENDENCY_CHECK_COOLDOWN_MS = 10 * 60 * 1000;
const DEPENDENCY_BLOCK_LABEL = "ai:blocked/dependency";
const NO_TOOLCALL_LABEL = "ai:error/NO_TOOLCALL";
const AGENT_SOURCE_LABEL = "ai:source/AGENT";
const REVIEW_CYCLE_PREFIX = "ai:review-cycle/";
const MAX_REQUIRED_TOOL_RETRIES = 3;
const STATE_LABEL_PREFIX = "ai:state/";

function stateLabel(state: AiState): string {
  return `${STATE_LABEL_PREFIX}${state}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(text: string): void {
  if (statusText === text) return;
  statusText = text;
  lastStatusAt = Date.now();
  statusLog?.(text);
}

function formatStatus(): string {
  const age = lastStatusAt ? ` (${Math.floor((Date.now() - lastStatusAt) / 1000)}s ago)` : "";
  const work = activeWork ? ` | #${activeWork.issue.number} ${activeWork.issue.title} | ${activeWork.dir}` : "";
  return `${running ? "running" : "stopped"}: ${statusText}${age}${work}`;
}

function parseArgs(input = ""): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.startsWith("--")) continue;
    const raw = part.slice(2);
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      out[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else if (parts[i + 1] && !parts[i + 1].startsWith("--")) {
      out[raw] = parts[++i];
    } else {
      out[raw] = "true";
    }
  }
  return out;
}

function isTruthy(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function labelValue(labels: string[], key: string): string | undefined {
  const slashPrefix = `ai:${key}/`;
  const slash = labels.find((l) => l.startsWith(slashPrefix));
  if (slash) return slash.slice(slashPrefix.length);
  const colonPrefix = `ai:${key}:`;
  const colon = labels.find((l) => l.startsWith(colonPrefix));
  if (colon) return colon.slice(colonPrefix.length);
  const bracket = labels.find((l) => l.startsWith(`ai[${key}:`) && l.endsWith("]"));
  return bracket?.slice(key.length + 4, -1);
}

function stateOf(labels: string[]): AiState {
  const raw = labelValue(labels, "state")?.toUpperCase();
  return STATES.includes(raw as AiState) ? raw as AiState : "PLANNING";
}

function priorityOf(labels: string[]): number {
  const n = Number(labelValue(labels, "priority") ?? "100");
  return Number.isFinite(n) ? n : 100;
}

function modelsOf(labels: string[], overrides: Models): Models {
  const fallback = labels
    .map((l) => l.match(/^ai:fallback-[^:/\]]*-model[:/]([^\]]+)$/)?.[1] ?? l.match(/^ai\[fallback-[^:\]]*-model:([^\]]+)\]$/)?.[1])
    .filter((x): x is string => Boolean(x));
  return {
    planning: overrides.planning ?? labelValue(labels, "planning-model"),
    execution: overrides.execution ?? labelValue(labels, "execution-model"),
    fallback: overrides.fallback.length ? overrides.fallback : fallback,
  };
}

function asThinkingLevel(value?: string): ThinkingLevel | undefined {
  const raw = value?.toLowerCase();
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(raw ?? "") ? raw as ThinkingLevel : undefined;
}

function thinkingLevelOf(labels: string[], override?: ThinkingLevel): ThinkingLevel | undefined {
  return asThinkingLevel(override ?? labelValue(labels, "thinking-level"));
}

function repoSlug(url: string): string {
  return url.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/");
}

function apiBase(repo: string): { base: string; owner: string; name: string; kind: "github" | "forgejo" } {
  const u = new URL(repo);
  const parts = u.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid repo URL: ${repo}`);
  const [owner, name] = parts.slice(-2);
  const kind = u.hostname === "github.com" ? "github" : "forgejo";
  const prefix = parts.slice(0, -2).join("/");
  const base = kind === "github" ? "https://api.github.com" : `${u.origin}${prefix ? `/${prefix}` : ""}/api/v1`;
  return { base, owner, name, kind };
}

async function request(url: string, token?: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { "accept": "application/json", "content-type": "application/json", ...(init.headers as any) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function postIssueComment(repo: string, issue: Issue, body: string, token?: string): Promise<void> {
  const r = apiBase(repo);
  const url = r.kind === "github" ? `${issue.apiUrl}/comments` : `${r.base}/repos/${r.owner}/${r.name}/issues/${issue.number}/comments`;
  await request(url, token, { method: "POST", body: JSON.stringify({ body }) });
}

function reviewEvent(verdict: ReviewVerdict): string {
  return verdict === "approve" ? "APPROVE" : verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
}

async function submitPullRequestReview(repo: string, pr: PullRequestItem, verdict: ReviewVerdict, body: string, token?: string): Promise<void> {
  const r = apiBase(repo);
  const url = `${r.base}/repos/${r.owner}/${r.name}/pulls/${pr.number}/reviews`;
  const event = reviewEvent(verdict);
  await request(url, token, { method: "POST", body: JSON.stringify({ body, event }) }).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (r.kind !== "forgejo" || verdict !== "approve" || !/^(400|422)\b/.test(msg)) throw err;
    await request(url, token, { method: "POST", body: JSON.stringify({ body, event: "APPROVED" }) });
  });
}

function labelEndpoint(repo: string, issue: Issue): { url: string; kind: "github" | "forgejo" } {
  const r = apiBase(repo);
  return { kind: r.kind, url: r.kind === "github" ? `${issue.apiUrl}/labels` : `${r.base}/repos/${r.owner}/${r.name}/issues/${issue.number}/labels` };
}

async function listRepoLabels(repo: string, token?: string): Promise<any[]> {
  const r = apiBase(repo);
  if (r.kind !== "forgejo") return [];
  const out: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const rows: any[] = await request(`${r.base}/repos/${r.owner}/${r.name}/labels?limit=100&page=${page}`, token).catch(() => []);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

async function ensureRepoLabel(repo: string, label: string, token?: string): Promise<void> {
  const r = apiBase(repo);
  if (r.kind !== "forgejo") return;
  if ((await listRepoLabels(repo, token)).some((x) => String(x?.name ?? "") === label)) return;
  await request(`${r.base}/repos/${r.owner}/${r.name}/labels`, token, {
    method: "POST",
    body: JSON.stringify({ name: label, color: label.startsWith("ai:state/") ? "#1d76db" : "#5319e7", description: "Managed by little-coder issue-agent" }),
  }).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if ((/^409\b/.test(msg) || /^422\b/.test(msg)) && (await listRepoLabels(repo, token)).some((x) => String(x?.name ?? "") === label)) return;
    throw err;
  });
}

async function addLabels(repo: string, issue: Issue, labels: string[], token?: string): Promise<void> {
  if (!labels.length) return;
  for (const label of labels) await ensureRepoLabel(repo, label, token);
  const ep = labelEndpoint(repo, issue);
  const body = ep.kind === "github" ? { labels } : { labels };
  await request(ep.url, token, { method: "POST", body: JSON.stringify(body) });
}

async function ensureStandardLabels(cfg: Config): Promise<void> {
  if (cfg.dryRun) return;
  const labels = [
    ...STATES.map(stateLabel),
    ...["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => `ai:thinking-level/${level}`),
    ...[0, 1, 2, 3, 4, 5].map((n) => `ai:priority/${n}`),
    ...(cfg.models.planning ? [`ai:planning-model/${cfg.models.planning}`] : []),
    ...(cfg.models.execution ? [`ai:execution-model/${cfg.models.execution}`] : []),
    ...cfg.models.fallback.map((model, index) => `ai:fallback-${index + 1}-model/${model}`),
    DEPENDENCY_BLOCK_LABEL,
    "ai:blocked/usage-limit",
    "ai:blocked/harness-error",
    NO_TOOLCALL_LABEL,
    AGENT_SOURCE_LABEL,
    ...[1, 2, 3].map((n) => `${REVIEW_CYCLE_PREFIX}${n}`),
  ];
  for (const repo of cfg.repos) {
    const r = apiBase(repo);
    if (r.kind !== "forgejo") continue;
    for (const label of labels) await ensureRepoLabel(repo, label, cfg.token);
  }
}

async function removeLabel(repo: string, issue: Issue, label: string, token?: string): Promise<void> {
  const ep = labelEndpoint(repo, issue);
  await request(`${ep.url}/${encodeURIComponent(label)}`, token, { method: "DELETE" }).catch(() => undefined);
}

async function listComments(repo: string, issue: Issue, token?: string): Promise<any[]> {
  const r = apiBase(repo);
  const url = r.kind === "github" ? `${issue.apiUrl}/comments?per_page=100` : `${r.base}/repos/${r.owner}/${r.name}/issues/${issue.number}/comments?limit=100`;
  return await request(url, token);
}

function normalizePullRequest(row: any): PullRequestItem {
  const rawHead = String(row.head?.ref ?? row.head?.label ?? "");
  return {
    kind: "pr",
    number: Number(row.number ?? row.id),
    title: String(row.title ?? ""),
    body: row.body ?? "",
    labels: (row.labels ?? []).map((l: any) => typeof l === "string" ? l : l.name),
    url: row.html_url ?? row.url,
    apiUrl: row.issue_url ?? row.url,
    head: rawHead.replace(/^.+:/, ""),
    base: String(row.base?.ref ?? "main"),
    headRepo: row.head?.repo?.clone_url ?? row.head?.repo?.ssh_url,
    diffUrl: row.diff_url,
  };
}

async function createPullRequest(repo: string, issue: Issue, branch: string, token?: string, prText?: string): Promise<PullRequestItem> {
  const r = apiBase(repo);
  const url = `${r.base}/repos/${r.owner}/${r.name}/pulls`;
  const prBody = prText?.trim() ? `${prText.trim()}\n\nCloses #${issue.number}` : `Closes #${issue.number}`;
  const body = r.kind === "github"
    ? { title: `AI: ${issue.title}`, head: branch, base: "main", body: prBody }
    : { title: `AI: ${issue.title}`, head: branch, base: "main", body: prBody };
  const pr: any = await request(url, token, { method: "POST", body: JSON.stringify(body) });
  const item = normalizePullRequest(pr);
  if (!pr.issue_url) item.apiUrl = `${r.base}/repos/${r.owner}/${r.name}/issues/${item.number}`;
  item.labels = [];
  return item;
}

async function setAiState(repo: string, issue: Issue, state: AiState, token?: string): Promise<void> {
  for (const label of issue.labels.filter((l) => /^ai:state[:/]/i.test(l) || /^ai\[state:/i.test(l))) await removeLabel(repo, issue, label, token);
  await addLabels(repo, issue, [stateLabel(state)], token);
}

async function issueState(repo: string, issueNumber: number, token?: string): Promise<string> {
  const r = apiBase(repo);
  const url = r.kind === "github"
    ? `${r.base}/repos/${r.owner}/${r.name}/issues/${issueNumber}`
    : `${r.base}/repos/${r.owner}/${r.name}/issues/${issueNumber}`;
  const row: any = await request(url, token);
  return String(row.state ?? "");
}

async function listIssues(repo: string, token?: string): Promise<Issue[]> {
  const r = apiBase(repo);
  const url = r.kind === "github"
    ? `${r.base}/repos/${r.owner}/${r.name}/issues?state=open&per_page=100`
    : `${r.base}/repos/${r.owner}/${r.name}/issues?state=open&limit=100`;
  const rows: any[] = await request(url, token);
  return rows.filter((x) => !x.pull_request).map((x) => ({
    number: x.number,
    title: x.title,
    body: x.body ?? "",
    labels: (x.labels ?? []).map((l: any) => typeof l === "string" ? l : l.name),
    url: x.html_url ?? x.url,
    apiUrl: x.url,
  })).filter((i: Issue) => i.labels.some((l: string) => l.startsWith("ai")));
}

async function listPullRequests(repo: string, token?: string): Promise<PullRequestItem[]> {
  const r = apiBase(repo);
  const url = r.kind === "github"
    ? `${r.base}/repos/${r.owner}/${r.name}/pulls?state=open&per_page=100`
    : `${r.base}/repos/${r.owner}/${r.name}/pulls?state=open&limit=100`;
  const rows: any[] = await request(url, token);
  const prs = rows.map((row) => {
    const pr = normalizePullRequest(row);
    if (!row.issue_url) pr.apiUrl = `${r.base}/repos/${r.owner}/${r.name}/issues/${pr.number}`;
    return pr;
  });
  for (const pr of prs) {
    if (pr.labels.length) continue;
    const issue: any = await request(`${r.base}/repos/${r.owner}/${r.name}/issues/${pr.number}`, token).catch(() => undefined);
    if (issue?.labels) pr.labels = issue.labels.map((l: any) => typeof l === "string" ? l : l.name);
    if (issue?.url) pr.apiUrl = issue.url;
  }
  return prs.filter((pr) => pr.labels.some((l) => l.startsWith("ai")));
}

function reviewCycle(labels: string[]): number {
  const raw = labelValue(labels, "review-cycle");
  const n = Number(raw ?? "0");
  return Number.isFinite(n) ? n : 0;
}

async function setReviewCycle(repo: string, issue: Issue, cycle: number, token?: string): Promise<void> {
  for (const label of [...issue.labels.filter((l) => l.startsWith(REVIEW_CYCLE_PREFIX) || l.startsWith("ai:review-cycle:")), ...[1, 2, 3].map((n) => `${REVIEW_CYCLE_PREFIX}${n}`)]) await removeLabel(repo, issue, label, token);
  if (cycle > 0) await addLabels(repo, issue, [`${REVIEW_CYCLE_PREFIX}${cycle}`], token);
}

function hasAgentSource(labels: string[]): boolean {
  return labels.some((l) => l.toUpperCase() === AGENT_SOURCE_LABEL.toUpperCase() || labelValue([l], "source")?.toUpperCase() === "AGENT");
}

const ISSUE_AGENT_ASK_MARKER = "<!-- issue-agent-ask";
const ISSUE_AGENT_ASK_END = "issue-agent-ask -->";

function formatIssueAgentAskComment(ask: IssueAgentAskRequest): string {
  const payload = Buffer.from(JSON.stringify(ask), "utf8").toString("base64");
  const questions = ask.questions?.length ? ask.questions : ask.question ? [ask.question] : [];
  const choices = ask.choices?.length ? `\n\nOptions:\n${ask.choices.map((c) => `- ${c}`).join("\n")}` : "";
  return `## AI Clarification Needed\n\n${questions.map((q) => `- ${q}`).join("\n")}${choices}\n\nContext needed to resume planning:\n\n${ask.context}\n\nReply with \`/answer ...\` to continue planning.\n\n${ISSUE_AGENT_ASK_MARKER} ${payload} ${ISSUE_AGENT_ASK_END}`;
}

function parseAskContext(body: string): IssueAgentAskRequest | undefined {
  const escaped = ISSUE_AGENT_ASK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`${escaped}\\s+([^\\s]+)\\s+${ISSUE_AGENT_ASK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  if (!match) return undefined;
  try { return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")); } catch { return undefined; }
}

function latestIssueAgentAnswer(comments: any[]): { answer: string; ask: IssueAgentAskRequest } | undefined {
  const indexed = comments.map((comment, index) => ({ comment, index }));
  for (const { comment, index } of indexed.slice().reverse()) {
    const answer = String(comment.body ?? "").match(/^\s*\/answer\s+([\s\S]+)/im)?.[1]?.trim();
    if (!answer) continue;
    const priorAsk = indexed.slice(0, index).reverse().map(({ comment }) => parseAskContext(String(comment.body ?? ""))).find(Boolean);
    const answeredLater = indexed.slice(index + 1).some(({ comment }) => /## AI Plan|## AI Clarification Needed|Approval detected/i.test(String(comment.body ?? "")));
    if (priorAsk && !answeredLater) return { answer, ask: priorAsk };
  }
  return undefined;
}

function hasReviewCommand(comments: any[]): boolean {
  return comments.some((c) => /^\s*\/review\b/im.test(String(c.body ?? "")));
}

function hasUnansweredReviewCommand(comments: any[]): boolean {
  const indexed = comments.map((comment, index) => ({ comment, index }));
  const relevant = indexed.filter(({ comment }) => /^\s*\/review\b/im.test(String(comment.body ?? "")) || /## AI Review Summary/i.test(String(comment.body ?? "")));
  const reviewCommands = relevant.filter(({ comment }) => /^\s*\/review\b/im.test(String(comment.body ?? "")));
  if (!reviewCommands.length) return false;
  const summaries = relevant.filter(({ comment }) => /## AI Review Summary/i.test(String(comment.body ?? "")));
  const timestamps = relevant.map(({ comment }) => Date.parse(String(comment.created_at ?? comment.updated_at ?? "")));
  const ids = relevant.map(({ comment }) => Number(comment.id));
  const useTimestamps = timestamps.every(Number.isFinite);
  const useIds = !useTimestamps && ids.every(Number.isFinite);
  const order = ({ comment, index }: { comment: any; index: number }) => {
    if (useTimestamps) return Date.parse(String(comment.created_at ?? comment.updated_at ?? "")) * 1000 + index;
    if (useIds) return Number(comment.id) * 1000 + index;
    return index + 1;
  };
  return Math.max(...reviewCommands.map(order)) > Math.max(0, ...summaries.map(order));
}

function dependencyOf(issue: Issue): number | undefined {
  const match = String(issue.body ?? "").match(/^\s*depends-on:\s*#?(\d+)\b/im);
  const n = Number(match?.[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function branchName(issue: Issue): string {
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return `ai/${issue.number}-${slug || "issue"}`;
}

function isAutoresearch(issue: Issue): boolean {
  return issue.labels.some((l) => l === "autoresearch" || l === "ai:autoresearch");
}

function autoresearchConfig(issue: Issue): { maxIterations?: string; metric?: string; direction?: string } {
  const value = (key: string) => issue.labels.find((l) => l.startsWith(`autoresearch:${key}=`))?.slice(`autoresearch:${key}=`.length);
  return { maxIterations: value("max-iterations"), metric: value("metric"), direction: value("direction") };
}

function checkout(repo: string, issue: Issue, workdir: string): string {
  mkdirSync(workdir, { recursive: true });
  const dir = join(workdir, repoSlug(repo).replace("/", "__"));
  const branch = branchName(issue);
  try { execFileSync("git", ["clone", repo, dir], { stdio: "ignore" }); } catch {}
  execFileSync("git", ["fetch", "--prune", "origin"], { cwd: dir, stdio: "ignore" });
  let base = "origin/main";
  try {
    const head = execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dir }).toString().trim();
    if (head) base = head;
  } catch {
    try { execFileSync("git", ["rev-parse", "--verify", "origin/master"], { cwd: dir, stdio: "ignore" }); base = "origin/master"; } catch {}
  }
  execFileSync("git", ["checkout", "-B", branch, base], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["reset", "--hard", base], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["clean", "-fdx"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function checkoutPullRequest(repo: string, pr: PullRequestItem, workdir: string): string {
  mkdirSync(workdir, { recursive: true });
  const dir = join(workdir, repoSlug(repo).replace("/", "__"));
  try { execFileSync("git", ["clone", repo, dir], { stdio: "ignore" }); } catch {}
  execFileSync("git", ["fetch", "--prune", "origin"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["fetch", "origin", `+${pr.base}:refs/remotes/origin/${pr.base}`], { cwd: dir, stdio: "ignore" });
  const remote = pr.headRepo && pr.headRepo.replace(/\.git$/, "") !== repo.replace(/\.git$/, "") ? pr.headRepo : "origin";
  execFileSync("git", ["fetch", remote, `+${pr.head}:refs/remotes/pr-head/${pr.number}`], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", pr.head, `refs/remotes/pr-head/${pr.number}`], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["clean", "-fdx"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function setWorkspacePermissionsDeny(): void {
  const dir = join(homedir(), ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "little-coder-workspace-boundary.json"), JSON.stringify({ externalFilePolicy: "deny" }, null, 2) + "\n");
}

function extractPlan(text: string): string {
  const fenced = text.match(/```(?:plan|md|markdown)?\s*\n([\s\S]*?\bPLAN\b[\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const marker = source.match(/(?:^|\n)\s*(#{1,3}\s*)?PLAN\b[:\s-]*(?:\n|$)/i);
  if (!marker) return source.trim();
  return source.slice(marker.index! + marker[0].length).replace(/(?:^|\n)\s*(?:---\s*)?(?:SUMMARY|EXECUTION|NOTES)\b[\s\S]*$/i, "").trim();
}

function issuePrompt(state: AiState, repo: string, issue: Issue, dir: string, models: Models, thinkingLevel: ThinkingLevel | undefined, autoresearch: string, answerContext?: { answer: string; ask: IssueAgentAskRequest }): string {
  const header = `Repo: ${repo}\nIssue: #${issue.number} ${issue.title}\nBranch: ${branchName(issue)}\nCheckout: ${dir}\nPlanning model: ${models.planning ?? "default"}\nExecution model: ${models.execution ?? "default"}\nFallback models: ${models.fallback.join(", ") || "none"}\nThinking level: ${thinkingLevel ?? "current setting"}\n\nIssue body:\n${issue.body ?? ""}${autoresearch}`;
  if (state === "PLANNING") {
    const answerBlock = answerContext ? `\n\nANSWER TO PRIOR CLARIFICATION\nPrior question/context:\n${answerContext.ask.context}\n\nAnswer:\n${answerContext.answer}` : "";
    return `ISSUE AGENT PLANNING TASK\n${header}${answerBlock}\n\n${planningModePrompt({ mode: "issue-agent" })}\n\nInspect the checkout and produce an approved-work plan. Do not edit files, commit, push, or open a PR.`;
  }
  return `ISSUE AGENT EXECUTION TASK\n${header}\n\nExecute the approved plan for this issue in the checkout. Make the necessary code changes and run appropriate checks. When complete, call issueAgentDone with a concise PR-ready summary of changes, checks run, and risks/follow-ups. If no changes are needed, still call issueAgentDone and explain why. The harness requires this tool call.`;
}

function reviewPrompt(repo: string, pr: PullRequestItem, dir: string): string {
  return `ISSUE AGENT AI-REVIEW TASK\nRepo: ${repo}\nPull request: #${pr.number} ${pr.title}\nBranch: ${pr.head}\nBase: ${pr.base}\nCheckout: ${dir}\n\nPR body:\n${pr.body ?? ""}\n\nReview this PR using the code-review skill/rubric. Gather context from the checkout and inspect the diff with commands such as git diff origin/${pr.base}...HEAD. Post no comments yourself. When done, call issueAgentDone with review text that begins exactly with one of these machine-readable verdict lines followed by a blank line and the human-readable review:\nverdict: approve\nverdict: comment\nverdict: request_changes\n\nUse request_changes only for blocking defects that require rework. The harness requires this tool call; keep working until you call it.`;
}

function reworkPrompt(repo: string, pr: PullRequestItem, dir: string, reviewText: string): string {
  return `ISSUE AGENT PR REWORK TASK\nRepo: ${repo}\nPull request: #${pr.number} ${pr.title}\nBranch: ${pr.head}\nCheckout: ${dir}\n\nAddress the following AI review on the existing PR branch. Make normal commits only; do not force-push. Run appropriate checks. When complete, call issueAgentDone with a concise summary of changes and checks.\n\n${reviewText}`;
}

function subAgentCommand(): { command: string; prefix: string[] } {
  if (process.env.ISSUE_AGENT_LITTLE_CODER_BIN) return { command: process.env.ISSUE_AGENT_LITTLE_CODER_BIN, prefix: ["--issue-agent-subagent"] };
  const launcher = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "little-coder.mjs");
  if (existsSync(launcher)) return { command: process.execPath, prefix: [launcher, "--issue-agent-subagent"] };
  return { command: process.execPath, prefix: process.argv.slice(1).filter((arg) => arg !== "--print" && arg !== "--no-session") };
}

function stopActiveSubAgent(): void {
  activeSubAgent?.kill();
}

function handleSubAgentJsonLine(line: string, emit: (line: string, type?: "info" | "warning" | "error") => void, seenAssistantText?: Set<string>): string | undefined {
  let event: any;
  try { event = JSON.parse(line); } catch { return undefined; }
  if (event.type === "tool_execution_start") {
    emit(`sub-agent tool started: ${event.toolName}`, "info");
    return undefined;
  }
  if (event.type === "tool_execution_end") {
    emit(`sub-agent tool ${event.isError ? "failed" : "finished"}: ${event.toolName}`, event.isError ? "warning" : "info");
    return undefined;
  }
  const message = event.message && typeof event.message === "object" ? event.message : undefined;
  if (message?.stopReason === "error" || message?.stopReason === "aborted") {
    const err = String(message.errorMessage ?? `sub-agent ${message.stopReason}`);
    emit(`sub-agent error: ${err}`, "error");
    return err;
  }
  if (event.error || event.errorMessage) {
    const err = String(event.error ?? event.errorMessage);
    emit(`sub-agent error: ${err}`, "error");
    return err;
  }
  if (message?.role !== "assistant") return undefined;
  const text = messageText(message).trim();
  if (text && !seenAssistantText?.has(text)) {
    seenAssistantText?.add(text);
    emit(`sub-agent assistant:\n${text}`, "info");
  }
  return text || undefined;
}

async function runSubAgent(prompt: string, dir: string, workdir: string, model: string | undefined, thinkingLevel: ThinkingLevel | undefined, emit: (line: string, type?: "info" | "warning" | "error") => void): Promise<string> {
  const markerDir = join(workdir, ".issue-agent-markers");
  mkdirSync(markerDir, { recursive: true });
  const marker = join(markerDir, `${process.pid}-${Date.now()}.json`);
  rmSync(marker, { force: true });
  const subAgent = subAgentCommand();
  const args = [...subAgent.prefix, "--mode", "json", "--no-session", ...(model ? ["--model", model] : []), ...(thinkingLevel ? ["--thinking", thinkingLevel] : []), "-p", prompt];
  const child = spawn(subAgent.command, args, { cwd: dir, env: { ...process.env, ISSUE_AGENT_DONE_FILE: marker, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", LITTLE_CODER_NO_UPDATE_CHECK: "1", LITTLE_CODER_SUBAGENT: "1", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  activeSubAgent = {
    kill: () => {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref();
    },
  };
  let output = "";
  let stderr = "";
  let stdoutBuffer = "";
  const seenAssistantText = new Set<string>();
  const flushStdout = (text: string) => {
    stdoutBuffer += text;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) output = handleSubAgentJsonLine(line, emit, seenAssistantText) ?? output;
  };
  child.stdout.on("data", (chunk) => flushStdout(String(chunk)));
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (err) => { stderr += err.message; resolve(-1); });
    child.on("close", (closeCode) => resolve(closeCode));
  });
  activeSubAgent = undefined;
  if (stdoutBuffer.trim()) output = handleSubAgentJsonLine(stdoutBuffer.trim(), emit, seenAssistantText) ?? output;
  if (existsSync(marker) && activeWork) {
    try {
      const data = JSON.parse(readFileSync(marker, "utf-8"));
      if (data?.ask) activeWork.askRequest = data.ask;
      else activeWork.doneText = data?.text ?? "";
    } catch {
      activeWork.doneText = readFileSync(marker, "utf-8");
    }
    rmSync(marker, { force: true });
  }
  if (stopRequested) throw new Error("sub-agent stopped by request");
  if (code !== 0) {
    for (const line of stderr.split(/\r?\n/).filter(Boolean)) emit(`sub-agent stderr: ${line}`, "warning");
    throw new Error(`sub-agent exited with code ${code}\n${stderr.trim() || output.trim()}`);
  }
  return output.trim();
}

function validMarker(kind: RequiredMarker, doneText?: string): boolean {
  if (doneText === undefined) return false;
  if (kind === "done") return true;
  if (kind === "plan") return /(?:^|\n)\s*(#{1,3}\s*)?PLAN\b[:\s-]*(?:\n|$)/i.test(doneText.trim());
  return /^verdict: (approve|comment|request_changes)\b/i.test(doneText.trim());
}

function parseVerdict(text: string): ReviewVerdict {
  const raw = text.trim().match(/^verdict: (approve|comment|request_changes)\b/i)?.[1]?.toLowerCase();
  return raw === "approve" || raw === "request_changes" ? raw : "comment";
}

async function runRequiredSubAgent(work: NonNullable<typeof activeWork>, prompt: string, model: string | undefined, thinkingLevel: ThinkingLevel | undefined, required: RequiredMarker, emit: (line: string, type?: "info" | "warning" | "error") => void): Promise<string> {
  let finalText = "";
  for (let attempt = 1; attempt <= MAX_REQUIRED_TOOL_RETRIES; attempt++) {
    work.doneText = undefined;
    activeWork = work;
    finalText = await runSubAgent(prompt, work.dir, work.cfg.workdir, model, thinkingLevel, emit);
    if (work.askRequest) return finalText;
    if (validMarker(required, work.doneText)) return finalText;
    emit(`sub-agent finished without required ${required} tool marker (attempt ${attempt}/${MAX_REQUIRED_TOOL_RETRIES})`, "warning");
  }
  if (!work.cfg.dryRun) {
    await addLabels(work.repo, work.issue, [NO_TOOLCALL_LABEL], work.cfg.token).catch(() => undefined);
    await postIssueComment(work.repo, work.issue, `AI lifecycle stopped: sub-agent did not call the required ${required} tool after ${MAX_REQUIRED_TOOL_RETRIES} attempts.`, work.cfg.token).catch(() => undefined);
  }
  throw new Error(`missing required ${required} tool marker after ${MAX_REQUIRED_TOOL_RETRIES} attempts`);
}

function config(args: Record<string, string>): Config {
  return {
    repos: (args.repos ?? args.repo ?? process.env.ISSUE_AGENT_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    models: {
      planning: args["planning-model"] ?? args.model,
      execution: args["execution-model"] ?? args.model,
      fallback: (args["fallback-models"] ?? "").split(",").filter(Boolean),
    },
    thinkingLevels: {
      planning: asThinkingLevel(args["planning-thinking-level"] ?? args["thinking-level"]),
      execution: asThinkingLevel(args["execution-thinking-level"] ?? args["thinking-level"]),
    },
    workdir: args.workdir ?? process.env.ISSUE_AGENT_WORKDIR ?? join(tmpdir(), "little-coder-issue-agent"),
    token: args.token ?? process.env.GITHUB_TOKEN ?? process.env.FORGEJO_TOKEN,
    intervalMs: Math.max(5000, Number(args.interval ?? process.env.ISSUE_AGENT_INTERVAL_MS ?? 30000)),
    dryRun: isTruthy(args["dry-run"]) || isTruthy(process.env.ISSUE_AGENT_DRY_RUN),
  };
}

function lockPath(cfg: Config): string {
  return join(cfg.workdir, ".issue-agent.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(cfg: Config): boolean {
  mkdirSync(cfg.workdir, { recursive: true });
  const file = lockPath(cfg);
  if (existsSync(file)) {
    try {
      const lock = JSON.parse(readFileSync(file, "utf-8"));
      const pid = Number(lock.pid);
      if (Number.isFinite(pid) && pidAlive(pid)) return false;
    } catch {}
    rmSync(file, { force: true });
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), repos: cfg.repos }, null, 2));
  currentLock = file;
  return true;
}

function releaseLock(): void {
  if (currentLock) rmSync(currentLock, { force: true });
  currentLock = undefined;
}

async function queueIssue(pi: ExtensionAPI, ctx: any, repo: string, issue: Issue, cfg: Config, emit?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<string> {
  const models = modelsOf(issue.labels, cfg.models);
  const state = stateOf(issue.labels);
  const selectedModel = state === "PLANNING" ? models.planning : state === "EXECUTING" ? models.execution : undefined;
  const plannedDir = join(cfg.workdir, repoSlug(repo).replace("/", "__"));
  if (!cfg.dryRun && selectedModel && !findModelByName(ctx, selectedModel)) {
    emit?.(`Configured ${state === "PLANNING" ? "planning" : "execution"} model not found: ${selectedModel}; skipping #${issue.number} instead of spawning a sub-agent.`, "warning");
    return plannedDir;
  }
  const dir = cfg.dryRun ? plannedDir : checkout(repo, issue, cfg.workdir);
  const requiredMarker: RequiredMarker = state === "PLANNING" ? "plan" : "done";
  activeWork = { repo, issue, cfg, dir, fallbackIndex: -1, kind: "issue", requiredMarker };
  const ar = autoresearchConfig(issue);
  const autoresearch = isAutoresearch(issue)
    ? `\n\nAUTORESEARCH MODE\nThis issue has an autoresearch label. Create or resume autoresearch.md, autoresearch.sh, autoresearch.checks.sh when useful, and autoresearch.jsonl in the checkout. Run bounded experiments only: max iterations ${ar.maxIterations ?? "from issue/config, otherwise choose a small explicit cap"}; metric ${ar.metric ?? "must be stated before experiments"}; direction ${ar.direction ?? "must be stated before experiments"}. The benchmark script must emit METRIC name=value. Keep/discard changes based on benchmark plus checks. Do not run destructive commands without the existing permission gate. When done, call issueAgentDone with a structured PR body: issue link, objective/metric, baseline, best result, confidence/noise note, kept/discarded experiments, files changed, checks run, risks/follow-ups.`
    : "";
  const thinkingLevelOverride = state === "PLANNING" ? cfg.thinkingLevels.planning : state === "EXECUTING" ? cfg.thinkingLevels.execution : undefined;
  const thinkingLevel = thinkingLevelOf(issue.labels, thinkingLevelOverride);
  const answerContext = state === "PLANNING" ? latestIssueAgentAnswer(await listComments(repo, issue, cfg.token).catch(() => [])) : undefined;
  const prompt = issuePrompt(state, repo, issue, dir, models, thinkingLevel, autoresearch, answerContext);
  activeAgentRun = true;
  if (cfg.dryRun) {
    emit?.(`DRY RUN: Checkout ${repo} at ${branchName(issue)} into ${dir}`, "info");
    if (selectedModel) emit?.(`DRY RUN: Set ${state === "PLANNING" ? "planning" : "execution"} model to ${selectedModel}`, "info");
    if (thinkingLevel) emit?.(`DRY RUN: Set thinking level to ${thinkingLevel}`, "info");
    emit?.(`DRY RUN: Send issue workflow prompt to model and assume ${state === "PLANNING" ? "a plan document" : "an issueAgentDone tool call"}`, "info");
    return dir;
  }
  emit?.(`Starting isolated sub-agent in ${dir}; its project AGENTS.md/system prompt will be loaded from that checkout.`, "info");
  const finalText = await runRequiredSubAgent(activeWork, prompt, selectedModel, thinkingLevel, requiredMarker, emit ?? (() => undefined));
  const work = activeWork;
  activeAgentRun = false;
  activeWork = undefined;
  if (work?.askRequest) {
    const body = formatIssueAgentAskComment(work.askRequest);
    await postIssueComment(work.repo, work.issue, body, work.cfg.token);
    await setAiState(work.repo, work.issue, "WAITING_FOR_FEEDBACK", work.cfg.token);
    emit?.(`Posted clarification question for #${work.issue.number}; waiting for /answer`, "info");
    return dir;
  }
  if (work) await finishWork(work, finalText, emit);
  return dir;
}

function messageText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === "text").map((x) => x.text).join("\n");
  return "";
}

async function commitPushPr(work: { repo: string; issue: Issue; cfg: Config; dir: string; doneText?: string }, notify?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<PrResult> {
  const branch = branchName(work.issue);
  if (work.cfg.dryRun) {
    notify?.(`DRY RUN: Commit issue #${work.issue.number}: ${work.issue.title}`, "info");
    notify?.(`DRY RUN: Push branch ${branch}`, "info");
    notify?.(`DRY RUN: Open pull request for ${branch}${work.doneText ? ` with body: ${work.doneText}` : ""}`, "info");
    return { createdPr: true, message: `DRY RUN: would push ${branch} and open a PR.` };
  }
  execFileSync("git", ["add", "-A"], { cwd: work.dir, stdio: "ignore" });
  const diff = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: work.dir }).toString().trim();
  if (!diff) return { createdPr: false, message: "No file changes were present, so no commit/PR was created." };
  execFileSync("git", ["commit", "-m", `AI issue #${work.issue.number}: ${work.issue.title}`], { cwd: work.dir, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", branch], { cwd: work.dir, stdio: "ignore" });
  const pr = await createPullRequest(work.repo, work.issue, branch, work.cfg.token, work.doneText);
  try {
    await addLabels(work.repo, pr, [AGENT_SOURCE_LABEL, stateLabel("REQUESTING_REVIEW")], work.cfg.token);
  } catch (err) {
    await setAiState(work.repo, work.issue, "PR_PENDING", work.cfg.token).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    await postIssueComment(work.repo, work.issue, `Opened PR ${pr.url ?? `#${pr.number}`}, but failed to apply AI review labels to it. Leaving the issue in ${stateLabel("PR_PENDING")} to avoid duplicate execution.\n\n${message}`, work.cfg.token).catch(() => undefined);
    throw err;
  }
  return { createdPr: true, message: `Pushed ${branch} and opened PR: ${pr.url ?? `#${pr.number}`}` };
}

async function finishWork(work: { repo: string; issue: Issue; cfg: Config; dir: string; doneText?: string }, finalText: string, notify?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<void> {
  if (stateOf(work.issue.labels) === "PLANNING") {
    const plan = extractPlan(work.doneText ?? finalText);
    const body = `## AI Plan\n\n${plan}\n\n---\nApprove by changing labels to \`${stateLabel("EXECUTING")}\`; request changes by keeping/setting \`${stateLabel("WAITING_FOR_FEEDBACK")}\` and commenting.`;
    if (work.cfg.dryRun) notify?.(`DRY RUN: Post plan document to issue #${work.issue.number}: ${body}`, "info");
    else await postIssueComment(work.repo, work.issue, body, work.cfg.token);
    if (work.cfg.dryRun) notify?.(`DRY RUN: Change issue label to ${stateLabel("WAITING_FOR_FEEDBACK")}`, "info");
    else await setAiState(work.repo, work.issue, "WAITING_FOR_FEEDBACK", work.cfg.token);
  } else if (work.doneText !== undefined) {
    const result = await commitPushPr(work, notify);
    const body = `## AI Execution Complete\n\n${result.message}\n\n${work.doneText || finalText}`;
    if (work.cfg.dryRun) notify?.(`DRY RUN: Post execution-complete document to issue #${work.issue.number}: ${body}`, "info");
    else await postIssueComment(work.repo, work.issue, body, work.cfg.token);
    if (result.createdPr) {
      if (work.cfg.dryRun) notify?.(`DRY RUN: PR opened with labels ${AGENT_SOURCE_LABEL} and ${stateLabel("REQUESTING_REVIEW")}; change issue label to ${stateLabel("PR_PENDING")}`, "info");
      else await setAiState(work.repo, work.issue, "PR_PENDING", work.cfg.token);
    } else {
      if (work.cfg.dryRun) notify?.(`DRY RUN: No PR opened; change issue label to ${stateLabel("WAITING_FOR_REVIEW")}`, "info");
      else await setAiState(work.repo, work.issue, "WAITING_FOR_REVIEW", work.cfg.token);
    }
  } else {
    const body = `AI execution stopped without issueAgentDone; leaving issue for follow-up.\n\n${finalText}`;
    if (work.cfg.dryRun) notify?.(`DRY RUN: Post stopped-without-issueAgentDone document to issue #${work.issue.number}: ${body}`, "info");
    else await postIssueComment(work.repo, work.issue, body, work.cfg.token);
  }
}

async function commitRework(work: { repo: string; issue: PullRequestItem; cfg: Config; dir: string; doneText?: string }, notify?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<void> {
  if (work.cfg.dryRun) {
    notify?.(`DRY RUN: Commit and push rework to ${work.issue.head}`, "info");
    return;
  }
  execFileSync("git", ["add", "-A"], { cwd: work.dir, stdio: "ignore" });
  const diff = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: work.dir }).toString().trim();
  if (!diff) return;
  execFileSync("git", ["commit", "-m", `AI review rework for PR #${work.issue.number}`], { cwd: work.dir, stdio: "ignore" });
  const remote = work.issue.headRepo && work.issue.headRepo.replace(/\.git$/, "") !== work.repo.replace(/\.git$/, "") ? work.issue.headRepo : "origin";
  execFileSync("git", ["push", remote, `HEAD:${work.issue.head}`], { cwd: work.dir, stdio: "ignore" });
}

async function queueReview(pi: ExtensionAPI, ctx: any, repo: string, pr: PullRequestItem, cfg: Config, emit?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<string> {
  const dir = cfg.dryRun ? join(cfg.workdir, repoSlug(repo).replace("/", "__")) : checkoutPullRequest(repo, pr, cfg.workdir);
  activeWork = { repo, issue: pr, cfg, dir, fallbackIndex: -1, kind: "review", requiredMarker: "verdict" };
  activeAgentRun = true;
  if (cfg.dryRun) {
    emit?.(`DRY RUN: AI-review PR #${pr.number} in ${dir}`, "info");
    activeWork.doneText = "verdict: comment\n\nDRY RUN review.";
  } else {
    await runRequiredSubAgent(activeWork, reviewPrompt(repo, pr, dir), undefined, undefined, "verdict", emit ?? (() => undefined));
  }
  const work = activeWork;
  activeAgentRun = false;
  activeWork = undefined;
  if (!work) return dir;
  const reviewText = work.doneText ?? "verdict: comment\n\nNo review text was produced.";
  const verdict = parseVerdict(reviewText);
  const cycle = hasAgentSource(pr.labels) ? Math.min(reviewCycle(pr.labels) + 1, 3) : reviewCycle(pr.labels);
  if (cfg.dryRun) {
    emit?.(`DRY RUN: Submit PR review ${verdict} and summary comment for PR #${pr.number}`, "info");
  } else {
    await submitPullRequestReview(repo, pr, verdict, reviewText, cfg.token);
    await postIssueComment(repo, pr, `## AI Review Summary\n\n${reviewText}`, cfg.token);
    if (hasAgentSource(pr.labels)) {
      await setReviewCycle(repo, pr, cycle, cfg.token);
      pr.labels = [...pr.labels.filter((l) => !l.startsWith(REVIEW_CYCLE_PREFIX) && !l.startsWith("ai:review-cycle:")), `${REVIEW_CYCLE_PREFIX}${cycle}`];
    }
  }
  if (hasAgentSource(pr.labels) && verdict === "request_changes" && cycle < 3) {
    await queueRework(pi, ctx, repo, pr, cfg, reviewText, emit);
  } else if (!cfg.dryRun) {
    await setAiState(repo, pr, "WAITING_FOR_REVIEW", cfg.token);
  }
  return dir;
}

async function queueRework(pi: ExtensionAPI, ctx: any, repo: string, pr: PullRequestItem, cfg: Config, reviewText: string, emit?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<void> {
  const dir = cfg.dryRun ? join(cfg.workdir, repoSlug(repo).replace("/", "__")) : checkoutPullRequest(repo, pr, cfg.workdir);
  activeWork = { repo, issue: pr, cfg, dir, fallbackIndex: -1, kind: "rework", requiredMarker: "done" };
  activeAgentRun = true;
  if (cfg.dryRun) {
    emit?.(`DRY RUN: Rework PR #${pr.number} on ${pr.head}`, "info");
    activeWork.doneText = "DRY RUN rework complete.";
  } else {
    await runRequiredSubAgent(activeWork, reworkPrompt(repo, pr, dir, reviewText), undefined, undefined, "done", emit ?? (() => undefined));
    await commitRework(activeWork as any, emit);
    await setAiState(repo, pr, "REQUESTING_REVIEW", cfg.token);
  }
  activeAgentRun = false;
  activeWork = undefined;
}

function normalizedModelName(modelName: string): string {
  return modelName.includes(":") && !modelName.includes("://") ? modelName.replace(/:(?:off|minimal|low|medium|high|xhigh)$/i, "") : modelName;
}

function findModelByName(ctx: any, modelName: string): any {
  const registry = ctx?.modelRegistry;
  const name = normalizedModelName(modelName);
  if (!registry || !name || name === "true") return undefined;
  const all = typeof registry.getAll === "function" ? registry.getAll() : [];
  const slash = name.indexOf("/");
  if (slash > 0) {
    const provider = name.slice(0, slash);
    const id = name.slice(slash + 1);
    return registry.find?.(provider, id) ?? all.find((m: any) => m.provider === provider && m.id === id);
  }
  return all.find((m: any) => m.id === name || m.name === name);
}

function configuredModelNames(cfg: Config): string[] {
  return [cfg.models.planning, cfg.models.execution, ...cfg.models.fallback].filter((m): m is string => Boolean(m));
}

async function switchModelByName(pi: ExtensionAPI, ctx: any, modelName: string): Promise<boolean> {
  const model = findModelByName(ctx, modelName);
  return model ? await pi.setModel(model) : false;
}

async function maintainIssueDependencies(repo: string, issue: Issue, cfg: Config, notify?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<void> {
  const dep = dependencyOf(issue);
  const key = `${repo}#${issue.number}`;
  const now = Date.now();
  if ((dependencyCheckedAt.get(key) ?? 0) + DEPENDENCY_CHECK_COOLDOWN_MS > now) return;
  dependencyCheckedAt.set(key, now);

  if (!dep) {
    dependencyBlocked.set(key, false);
    const existing = issue.labels.find((l) => l === DEPENDENCY_BLOCK_LABEL || l === "blocked-by-dependency");
    if (!existing) return;
    if (cfg.dryRun) notify?.(`DRY RUN: Remove issue label ${existing} from #${issue.number}`, "info");
    else await removeLabel(repo, issue, existing, cfg.token);
    return;
  }

  const closed = (await issueState(repo, dep, cfg.token).catch(() => "")) === "closed";
  dependencyBlocked.set(key, !closed);
  if (closed) {
    const existing = issue.labels.find((l) => l === DEPENDENCY_BLOCK_LABEL || l === "blocked-by-dependency");
    if (!existing) return;
    if (cfg.dryRun) notify?.(`DRY RUN: Remove issue label ${existing} from #${issue.number}; dependency #${dep} is closed`, "info");
    else await removeLabel(repo, issue, existing, cfg.token);
    return;
  }

  if (issue.labels.includes(DEPENDENCY_BLOCK_LABEL) || issue.labels.includes("blocked-by-dependency")) return;
  if (cfg.dryRun) notify?.(`DRY RUN: Change issue label to ${DEPENDENCY_BLOCK_LABEL}; dependency #${dep} is not closed`, "info");
  else await addLabels(repo, issue, [DEPENDENCY_BLOCK_LABEL], cfg.token);
}

async function maintainIssueLabels(cfg: Config, notify?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<void> {
  for (const repo of cfg.repos) {
    for (const issue of await listIssues(repo, cfg.token)) {
      await maintainIssueDependencies(repo, issue, cfg, notify).catch((err) => notify?.(`issue-agent dependency check failed for #${issue.number}: ${err instanceof Error ? err.message : String(err)}`, "warning"));
      const retryLabel = issue.labels.find((l) => l.startsWith("ai:retry-after/") || l.startsWith("ai:retry-after:"));
      const usageLimitLabel = issue.labels.find((l) => l === "ai:blocked/usage-limit" || l === "ai:blocked:usage-limit");
      if (usageLimitLabel && retryLabel) {
        const when = Date.parse(retryLabel.replace(/^ai:retry-after[:/]/, ""));
        if (Number.isFinite(when) && when <= Date.now()) {
          if (cfg.dryRun) {
            notify?.(`DRY RUN: Remove issue labels ${usageLimitLabel}, ${retryLabel}, and provider-status labels from #${issue.number}`, "info");
            notify?.(`DRY RUN: Post unblock comment to issue #${issue.number}`, "info");
          } else {
            await removeLabel(repo, issue, usageLimitLabel, cfg.token);
            await removeLabel(repo, issue, retryLabel, cfg.token);
            for (const label of issue.labels.filter((l) => l.startsWith("ai:provider-status/") || l.startsWith("ai:provider-status:"))) await removeLabel(repo, issue, label, cfg.token);
            await postIssueComment(repo, issue, "Recorded usage-limit reset time has passed; unblocking this issue for retry.", cfg.token).catch(() => undefined);
          }
        }
      }
      if (stateOf(issue.labels) !== "WAITING_FOR_FEEDBACK") continue;
      const comments = await listComments(repo, issue, cfg.token).catch(() => []);
      const answeredAsk = latestIssueAgentAnswer(comments);
      if (answeredAsk) {
        if (cfg.dryRun) {
          notify?.(`DRY RUN: Change issue label to ${stateLabel("PLANNING")} after /answer on #${issue.number}`, "info");
        } else {
          await setAiState(repo, issue, "PLANNING", cfg.token);
          await postIssueComment(repo, issue, `Answer detected (\`/answer\`); switching back to \`${stateLabel("PLANNING")}\`.`, cfg.token).catch(() => undefined);
        }
        continue;
      }
      if (comments.some((c) => /^\s*\/approve\b/im.test(String(c.body ?? "")))) {
        if (cfg.dryRun) {
          notify?.(`DRY RUN: Change issue label to ${stateLabel("EXECUTING")}`, "info");
          notify?.(`DRY RUN: Post approval-detected comment to issue #${issue.number}`, "info");
        } else {
          await setAiState(repo, issue, "EXECUTING", cfg.token);
          await postIssueComment(repo, issue, `Approval detected (\`/approve\`); switching to \`${stateLabel("EXECUTING")}\`.`, cfg.token).catch(() => undefined);
        }
      }
    }
  }
}

async function runLoop(pi: ExtensionAPI, ctx: any, cfg: Config, notify: (msg: string, type?: "info" | "warning" | "error") => void): Promise<void> {
  setStatus("starting");
  if (cfg.dryRun) {
    notify("DRY RUN: Acquire issue-agent lock", "info");
    notify("DRY RUN: Set workspace-permissions=deny", "info");
  } else {
    if (!acquireLock(cfg)) {
      notify(`issue-agent lock exists in ${cfg.workdir}; remove .issue-agent.lock if the previous run died`, "warning");
      return;
    }
    setWorkspacePermissionsDeny();
  }
  running = true;
  stopRequested = false;
  await ensureStandardLabels(cfg).catch((err) => notify(`issue-agent label setup failed: ${err instanceof Error ? err.message : String(err)}`, "warning"));
  const argsSummary = `args: --repos=${cfg.repos.join(",")} --model=<sets both> --planning-model=${cfg.models.planning ?? "<label/default>"} --execution-model=${cfg.models.execution ?? "<label/default>"} --fallback-models=${cfg.models.fallback.join(",") || "<labels/none>"} --thinking-level=<sets both> --planning-thinking-level=${cfg.thinkingLevels.planning ?? "<label/current>"} --execution-thinking-level=${cfg.thinkingLevels.execution ?? "<label/current>"} --interval=${cfg.intervalMs} --workdir=${cfg.workdir} --dry-run=${cfg.dryRun}`;
  notify(cfg.dryRun ? `issue-agent dry run; printing operations without changing issues, git, or model state; ${argsSummary}` : `issue-agent running with workspace-permissions=deny (/tmp allowed); use /issue-agent-stop or Ctrl-C to stop after the current agent turn; ${argsSummary}`, "info");
  try {
    while (!stopRequested) {
      if (!activeAgentRun) {
        setStatus("checking labels/dependencies");
        await maintainIssueLabels(cfg, notify).catch((err) => notify(`issue-agent label maintenance failed: ${err instanceof Error ? err.message : String(err)}`, "warning"));
        const candidates: Array<{ repo: string; issue: Issue }> = [];
        const prCandidates: Array<{ repo: string; pr: PullRequestItem; forced: boolean }> = [];
        for (const repo of cfg.repos) {
          try {
            setStatus(`listing issues in ${basename(repo)}`);
            for (const issue of await listIssues(repo, cfg.token)) candidates.push({ repo, issue });
            for (const pr of await listPullRequests(repo, cfg.token)) {
              const comments = await listComments(repo, pr, cfg.token).catch(() => []);
              const forced = hasUnansweredReviewCommand(comments);
              if (stateOf(pr.labels) === "REQUESTING_REVIEW" || forced) prCandidates.push({ repo, pr, forced });
            }
          } catch (err) {
            notify(`issue-agent failed to list ${repo}: ${err instanceof Error ? err.message : String(err)}`, "warning");
          }
        }
        const now = Date.now();
        prCandidates.sort((a, b) => priorityOf(a.pr.labels) - priorityOf(b.pr.labels));
        const nextPr = prCandidates.find((x) => {
          const cycle = reviewCycle(x.pr.labels);
          const key = `${x.repo}#${x.pr.number}:AI-REVIEW:${cycle}:${x.forced ? "forced" : "auto"}`;
          const queuedAt = recentlyQueued.get(key) ?? 0;
          if (x.forced) return true;
          if (now - queuedAt <= QUEUED_COOLDOWN_MS) return false;
          if (x.pr.labels.includes(NO_TOOLCALL_LABEL)) return false;
          return !hasAgentSource(x.pr.labels) || cycle < 3;
        });
        candidates.sort((a, b) => priorityOf(a.issue.labels) - priorityOf(b.issue.labels));
        const next = candidates.find((x) => {
          const state = stateOf(x.issue.labels);
          const key = `${x.repo}#${x.issue.number}:${state}`;
          const queuedAt = recentlyQueued.get(key) ?? 0;
          const models = modelsOf(x.issue.labels, cfg.models);
          const allModels = [models.planning, models.execution, ...models.fallback].filter((m): m is string => Boolean(m));
          const anyModelAvailable = allModels.length === 0 || allModels.some((m) => (usageLimitedUntil.get(m) ?? 0) <= now);
          return ["PLANNING", "EXECUTING"].includes(state) && now - queuedAt > QUEUED_COOLDOWN_MS && !x.issue.labels.some((l) => /blocked/i.test(l)) && !dependencyBlocked.get(`${x.repo}#${x.issue.number}`) && anyModelAvailable;
        });
        if (nextPr) {
          setStatus(`AI-reviewing PR #${nextPr.pr.number} ${nextPr.pr.title}`);
          try {
            if (nextPr.forced && nextPr.pr.labels.includes(NO_TOOLCALL_LABEL) && !cfg.dryRun) await removeLabel(nextPr.repo, nextPr.pr, NO_TOOLCALL_LABEL, cfg.token);
            const dir = await queueReview(pi, ctx, nextPr.repo, nextPr.pr, cfg, notify);
            recentlyQueued.set(`${nextPr.repo}#${nextPr.pr.number}:AI-REVIEW:${reviewCycle(nextPr.pr.labels)}:${nextPr.forced ? "forced" : "auto"}`, now);
            notify(`Processed AI review for PR #${nextPr.pr.number} from ${basename(nextPr.repo)} in ${dir}`, "info");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            notify(`issue-agent AI-review failed for PR #${nextPr.pr.number}: ${message}`, "error");
            activeAgentRun = false;
            activeWork = undefined;
          }
        } else if (next) {
          setStatus(`queueing #${next.issue.number} ${next.issue.title}`);
          let dir = "";
          try {
            dir = await queueIssue(pi, ctx, next.repo, next.issue, cfg, notify);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (stopRequested) {
              notify(`issue-agent sub-agent stopped for #${next.issue.number}: ${message}`, "info");
              activeAgentRun = false;
              activeWork = undefined;
              break;
            }
            const providerLimited = /\b(429|rate.?limit|usage.?limit)\b/i.test(message);
            const missingToolCall = /^missing required \w+ tool marker/i.test(message);
            notify(`issue-agent sub-agent failed for #${next.issue.number}: ${message}`, "error");
            if (!cfg.dryRun && !missingToolCall) {
              await postIssueComment(next.repo, next.issue, `Harness sub-agent failed while working this issue:\n\n${message}`, cfg.token).catch(() => undefined);
              await addLabels(next.repo, next.issue, [providerLimited ? "ai:blocked/usage-limit" : "ai:blocked/harness-error"], cfg.token).catch(() => undefined);
            }
            activeAgentRun = false;
            activeWork = undefined;
            setStatus(`blocked #${next.issue.number} after sub-agent failure`);
            continue;
          }
          recentlyQueued.set(`${next.repo}#${next.issue.number}:${stateOf(next.issue.labels)}`, now);
          setStatus(activeAgentRun ? `agent turn running for #${next.issue.number}` : `finished #${next.issue.number}`);
          notify(`${activeAgentRun ? "Queued" : "Processed"} issue #${next.issue.number} from ${basename(next.repo)} in ${dir}`, "info");
          if (cfg.dryRun && activeWork) {
            const work = activeWork;
            activeAgentRun = false;
            activeWork = undefined;
            if (stateOf(work.issue.labels) !== "PLANNING") work.doneText = "DRY RUN: assumed issueAgentDone PR text.";
            await finishWork(work, stateOf(work.issue.labels) === "PLANNING" ? "DRY RUN PLAN: assumed model plan output." : "DRY RUN: assumed issueAgentDone tool call.", notify);
          }
        } else {
          setStatus(`idle; no runnable issue found, next poll in ${Math.round(cfg.intervalMs / 1000)}s`);
        }
      }
      await sleep(cfg.intervalMs);
    }
  } finally {
    running = false;
    stopRequested = false;
    if (cfg.dryRun) notify("DRY RUN: Release issue-agent lock", "info");
    else releaseLock();
    setStatus("stopped");
    notify("issue-agent stopped", "info");
  }
}

export const __issueAgentTest = { runSubAgent, handleSubAgentJsonLine, stateOf, normalizePullRequest, listPullRequests, hasReviewCommand, hasUnansweredReviewCommand, reviewCycle, parseVerdict, reviewEvent, validMarker, hasAgentSource, createPullRequest, addLabels, setAiState, stateLabel, formatIssueAgentAskComment, latestIssueAgentAnswer, issuePrompt };

export default function (pi: ExtensionAPI) {
  const chatStatus = (message: string, type: "info" | "warning" | "error" = "info") => {
    pi.sendMessage({
      customType: "issue-agent-status",
      content: `issue-agent: ${message}`,
      display: true,
      details: { type, timestamp: Date.now() },
    }, { deliverAs: "followUp" });
  };

  pi.on("after_provider_response", async (event, ctx) => {
    if (!activeWork || event.status < 429) return;
    const retrySeconds = Number(event.headers["retry-after"] ?? 0);
    const retryAt = Date.now() + (Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 : 60 * 60 * 1000);
    const models = modelsOf(activeWork.issue.labels, activeWork.cfg.models);
    const fallbacks = models.fallback.filter((m) => (usageLimitedUntil.get(m) ?? 0) <= Date.now());
    const next = fallbacks[activeWork.fallbackIndex + 1];
    const retry = event.headers["retry-after"] ? ` Retry-After: ${event.headers["retry-after"]}.` : "";
    const currentModel = String((ctx as any).model?.provider && (ctx as any).model?.id ? `${(ctx as any).model.provider}/${(ctx as any).model.id}` : ((ctx as any).model?.id ?? "current-model"));
    usageLimitedUntil.set(currentModel, retryAt);
    if (next && await switchModelByName(pi, ctx, next)) {
      activeWork.fallbackIndex += 1;
      await postIssueComment(activeWork.repo, activeWork.issue, `Provider/model error HTTP ${event.status}.${retry}\n\nSwitching to fallback model \`${next}\` and retrying this issue.`, activeWork.cfg.token).catch(() => undefined);
      const work = activeWork;
      activeAgentRun = false;
      await queueIssue(pi, ctx, work.repo, work.issue, work.cfg);
      if (activeWork) activeWork.fallbackIndex = work.fallbackIndex;
      return;
    }
    await postIssueComment(activeWork.repo, activeWork.issue, `Provider/model error while working this issue: HTTP ${event.status}.${retry}\n\nAll configured fallback models are exhausted or currently rate-limited. The harness will reschedule this issue after the limit resets and continue with other issues.`, activeWork.cfg.token).catch(() => undefined);
    await addLabels(activeWork.repo, activeWork.issue, [`ai:blocked/usage-limit`, `ai:provider-status/${event.status}`, `ai:retry-after/${new Date(retryAt).toISOString()}`], activeWork.cfg.token).catch(() => undefined);
    activeAgentRun = false;
    activeWork = undefined;
  });

  pi.on("agent_end", async (event) => {
    const work = activeWork;
    activeAgentRun = false;
    activeWork = undefined;
    if (!work) return;
    setStatus(`post-processing #${work.issue.number}`);
    const finalText = event.messages.map(messageText).join("\n").trim();
    try {
      await finishWork(work, finalText);
      setStatus(`finished #${work.issue.number}`);
    } catch (err) {
      await postIssueComment(work.repo, work.issue, `Harness post-processing failed: ${err instanceof Error ? err.message : String(err)}`, work.cfg.token).catch(() => undefined);
      await addLabels(work.repo, work.issue, ["ai:blocked/harness-error"], work.cfg.token).catch(() => undefined);
    }
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      stopRequested = true;
      stopActiveSubAgent();
      releaseLock();
    });
  }

  pi.registerCommand("issue-agent", {
    description: "Run continuously over ai:* labeled GitHub/Forgejo issues until interrupted. Args: --repos=url[,url] --model=x --planning-model=x --execution-model=y --fallback-models=a,b --thinking-level=low|medium|high --planning-thinking-level=low|medium|high --execution-thinking-level=low|medium|high --interval=30000 --workdir=/tmp/dir --dry-run",
    handler: async (argLine: string, ctx) => {
      const cfg = config(parseArgs(argLine));
      if (!cfg.repos.length) {
        ctx.ui.notify("Usage: /issue-agent --repos=https://github.com/owner/repo[,https://forgejo/owner/repo] [--model=provider/id] [--planning-model=provider/id] [--execution-model=provider/id] [--thinking-level=low|medium|high] [--planning-thinking-level=low|medium|high] [--execution-thinking-level=low|medium|high] [--fallback-models=a,b] [--workdir=/tmp/dir] [--interval=30000] [--dry-run]", "warning");
        return;
      }
      if (running) {
        ctx.ui.notify("issue-agent is already running; use /issue-agent-stop first", "warning");
        return;
      }
      const missingModels = configuredModelNames(cfg).filter((model) => !findModelByName(ctx, model));
      if (missingModels.length) {
        ctx.ui.notify(`Configured issue-agent model(s) not found: ${missingModels.map(normalizedModelName).join(", ")}. Not starting issue-agent.`, "warning");
        return;
      }
      let stopStatusUi: (() => void) | undefined;
      const previousStatusLog = statusLog;
      statusLog = (text) => chatStatus(text);
      if (ctx.hasUI) {
        ctx.ui.onTerminalInput((data) => {
          if (running && data === "\u0003") { stopRequested = true; stopActiveSubAgent(); }
          return undefined;
        });
        const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let frame = 0;
        const paint = () => {
          const text = running ? `${frames[frame++ % frames.length]} ${formatStatus()}` : undefined;
          ctx.ui.setStatus("issue-agent", text);
          ctx.ui.setWidget("issue-agent", text ? [`issue-agent ${text}`] : undefined, { placement: "belowEditor" });
        };
        const timer = setInterval(paint, 120);
        paint();
        stopStatusUi = () => { clearInterval(timer); ctx.ui.setStatus("issue-agent", undefined); ctx.ui.setWidget("issue-agent", undefined); };
      }
      try {
        await runLoop(pi, ctx, cfg, (msg, type = "info") => {
          chatStatus(msg, type);
          ctx.ui.notify(msg, type);
        });
      } finally {
        stopStatusUi?.();
        statusLog = previousStatusLog;
      }
    },
  });

  pi.registerCommand("issue-agent-status", {
    description: "Show what /issue-agent is currently doing and where to view the spawned task chat.",
    handler: async (_argLine: string, ctx) => {
      ctx.ui.notify(formatStatus(), running ? "info" : "warning");
      if (activeWork) {
        ctx.ui.notify("The issue is being handled by an isolated sub-agent process in the checkout; its stdout/stderr is piped back into this chat as follow-up issue-agent messages.", "info");
      }
    },
  });

  pi.registerCommand("issue-agent-stop", {
    description: "Gracefully stop the long-running /issue-agent loop after the current agent turn.",
    handler: async (_argLine: string, ctx) => {
      if (!running) { ctx.ui.notify("issue-agent is not running", "info"); return; }
      stopRequested = true;
      stopActiveSubAgent();
      ctx.ui.notify("issue-agent stop requested; active sub-agent is being terminated", "info");
    },
  });

  if (process.env.ISSUE_AGENT_DONE_FILE) {
    pi.registerTool({
      name: "issueAgentDone",
      label: "Issue Agent Done",
      description: "Mark the active issue-agent execution task as done. Optional text is used in the issue completion comment and pull request body.",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      async execute(_id, input: any) {
        const text = typeof input.text === "string" ? input.text : "";
        writeFileSync(process.env.ISSUE_AGENT_DONE_FILE!, JSON.stringify({ text }, null, 2));
        return { content: [{ type: "text", text: "Marked sub-agent issue task as done." }], details: { ok: true } };
      },
    });
  }

  pi.registerTool({
    name: "issueAgentAsk",
    label: "Issue Agent Ask",
    description: "Ask the issue reporter for clarification during issue-agent planning without blocking. Provide question(s), optional choices, and context needed to resume after /answer.",
    parameters: Type.Object({
      question: Type.Optional(Type.String()),
      questions: Type.Optional(Type.Array(Type.String())),
      choices: Type.Optional(Type.Array(Type.String())),
      context: Type.String(),
    }),
    async execute(_id, input: any) {
      const ask: IssueAgentAskRequest = {
        question: typeof input.question === "string" ? input.question : undefined,
        questions: Array.isArray(input.questions) ? input.questions.map(String) : undefined,
        choices: Array.isArray(input.choices) ? input.choices.map(String) : undefined,
        context: String(input.context ?? ""),
      };
      if (!ask.question && !ask.questions?.length) return { content: [{ type: "text", text: "issueAgentAsk requires question or questions." }], details: { ok: false } };
      if (!ask.context.trim()) return { content: [{ type: "text", text: "issueAgentAsk requires context for resuming the planning agent." }], details: { ok: false } };
      if (process.env.ISSUE_AGENT_DONE_FILE) {
        writeFileSync(process.env.ISSUE_AGENT_DONE_FILE, JSON.stringify({ ask }, null, 2));
        return { content: [{ type: "text", text: "Recorded issue-agent clarification request." }], details: { ok: true } };
      }
      if (!activeWork || stateOf(activeWork.issue.labels) !== "PLANNING") return { content: [{ type: "text", text: "No active issue-agent planning task." }], details: { ok: false } };
      activeWork.askRequest = ask;
      return { content: [{ type: "text", text: "Recorded issue-agent clarification request." }], details: { ok: true } };
    },
  });

  pi.registerTool({
    name: "issueAgentList",
    label: "Issue Agent List",
    description: "List ai:* labeled GitHub/Forgejo issues by priority/state without starting work.",
    parameters: Type.Object({ repos: Type.String(), token: Type.Optional(Type.String()) }),
    async execute(_id, input: any) {
      const repos = input.repos.split(",").map((s: string) => s.trim()).filter(Boolean);
      const rows = [];
      for (const repo of repos) for (const issue of await listIssues(repo, input.token)) rows.push({ repo, issue });
      rows.sort((a, b) => priorityOf(a.issue.labels) - priorityOf(b.issue.labels));
      return { content: [{ type: "text", text: rows.map((r) => `${priorityOf(r.issue.labels)} ${stateOf(r.issue.labels)} ${r.repo}#${r.issue.number} ${r.issue.title}`).join("\n") || "No ai issues found" }], details: {} };
    },
  });
}
