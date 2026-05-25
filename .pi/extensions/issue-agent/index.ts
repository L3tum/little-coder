// Source: https://github.com/tmustier/pi-extensions/tree/main/pi-ralph-wiggum
// Adapted for little-coder: issue-backed Ralph harness (Forgejo/GitHub), not file-backed tasks.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

const STATES = ["PLANNING", "WAITING_FOR_FEEDBACK", "EXECUTING", "WAITING_FOR_REVIEW"] as const;
type AiState = typeof STATES[number];

type Issue = { number: number; title: string; body?: string; labels: string[]; url: string; apiUrl: string };
type Models = { planning?: string; execution?: string; fallback: string[] };
type Config = { repos: string[]; models: Models; workdir: string; token?: string; intervalMs: number; dryRun: boolean };

let running = false;
let stopRequested = false;
let activeAgentRun = false;
let currentLock: string | undefined;
let activeWork: { repo: string; issue: Issue; cfg: Config; dir: string; fallbackIndex: number; doneText?: string } | undefined;
const recentlyQueued = new Map<string, number>();
const usageLimitedUntil = new Map<string, number>();
const dependencyCheckedAt = new Map<string, number>();
const dependencyBlocked = new Map<string, boolean>();
const QUEUED_COOLDOWN_MS = 10 * 60 * 1000;
const DEPENDENCY_CHECK_COOLDOWN_MS = 10 * 60 * 1000;
const DEPENDENCY_BLOCK_LABEL = "blocked-by-dependency";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(input = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const [k, ...rest] = part.replace(/^--/, "").split("=");
    out[k] = rest.length ? rest.join("=").replace(/^"|"$/g, "") : "true";
  }
  return out;
}

function isTruthy(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function labelValue(labels: string[], key: string): string | undefined {
  const prefix = `ai:${key}:`;
  const colon = labels.find((l) => l.startsWith(prefix));
  if (colon) return colon.slice(prefix.length);
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
    .map((l) => l.match(/^ai(?::|\[)fallback-[^:\]]*-model:?([^\]]+)?\]?$/)?.[1])
    .filter((x): x is string => Boolean(x));
  return {
    planning: overrides.planning ?? labelValue(labels, "planning-model"),
    execution: overrides.execution ?? labelValue(labels, "execution-model"),
    fallback: overrides.fallback.length ? overrides.fallback : fallback,
  };
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

function labelEndpoint(repo: string, issue: Issue): { url: string; kind: "github" | "forgejo" } {
  const r = apiBase(repo);
  return { kind: r.kind, url: r.kind === "github" ? `${issue.apiUrl}/labels` : `${r.base}/repos/${r.owner}/${r.name}/issues/${issue.number}/labels` };
}

async function addLabels(repo: string, issue: Issue, labels: string[], token?: string): Promise<void> {
  if (!labels.length) return;
  const ep = labelEndpoint(repo, issue);
  const body = ep.kind === "github" ? { labels } : { labels };
  await request(ep.url, token, { method: "POST", body: JSON.stringify(body) });
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

async function createPullRequest(repo: string, issue: Issue, branch: string, token?: string, prText?: string): Promise<string> {
  const r = apiBase(repo);
  const url = `${r.base}/repos/${r.owner}/${r.name}/pulls`;
  const prBody = prText?.trim() ? `${prText.trim()}\n\nCloses #${issue.number}` : `Closes #${issue.number}`;
  const body = r.kind === "github"
    ? { title: `AI: ${issue.title}`, head: branch, base: "main", body: prBody }
    : { title: `AI: ${issue.title}`, head: branch, base: "main", body: prBody };
  const pr: any = await request(url, token, { method: "POST", body: JSON.stringify(body) });
  return pr.html_url ?? pr.url ?? `PR opened for ${branch}`;
}

async function setAiState(repo: string, issue: Issue, state: AiState, token?: string): Promise<void> {
  for (const label of issue.labels.filter((l) => /^ai(?::|\[)state/i.test(l))) await removeLabel(repo, issue, label, token);
  await addLabels(repo, issue, [`ai:state:${state}`], token);
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
  execFileSync("git", ["clean", "-fd"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function setWorkspacePermissionsDeny(): void {
  const dir = join(homedir(), ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "little-coder-workspace-boundary.json"), JSON.stringify({ externalFilePolicy: "deny" }, null, 2) + "\n");
}

function config(args: Record<string, string>): Config {
  return {
    repos: (args.repos ?? args.repo ?? process.env.ISSUE_AGENT_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    models: {
      planning: args["planning-model"],
      execution: args["execution-model"],
      fallback: (args["fallback-models"] ?? "").split(",").filter(Boolean),
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

async function queueIssue(pi: ExtensionAPI, repo: string, issue: Issue, cfg: Config, notify?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<string> {
  const dir = cfg.dryRun ? join(cfg.workdir, repoSlug(repo).replace("/", "__")) : checkout(repo, issue, cfg.workdir);
  activeWork = { repo, issue, cfg, dir, fallbackIndex: -1 };
  const models = modelsOf(issue.labels, cfg.models);
  const ar = autoresearchConfig(issue);
  const autoresearch = isAutoresearch(issue)
    ? `\n\nAUTORESEARCH MODE\nThis issue has an autoresearch label. Create or resume autoresearch.md, autoresearch.sh, autoresearch.checks.sh when useful, and autoresearch.jsonl in the checkout. Run bounded experiments only: max iterations ${ar.maxIterations ?? "from issue/config, otherwise choose a small explicit cap"}; metric ${ar.metric ?? "must be stated before experiments"}; direction ${ar.direction ?? "must be stated before experiments"}. The benchmark script must emit METRIC name=value. Keep/discard changes based on benchmark plus checks. Do not run destructive commands without the existing permission gate. When done, call issueAgentDone with a structured PR body: issue link, objective/metric, baseline, best result, confidence/noise note, kept/discarded experiments, files changed, checks run, risks/follow-ups.`
    : "";
  const prompt = `ISSUE AGENT WORKFLOW\nRepo: ${repo}\nIssue: #${issue.number} ${issue.title}\nBranch: ${branchName(issue)}\nCheckout: ${dir}\nState: ${stateOf(issue.labels)}\nPlanning model: ${models.planning ?? "default"}\nExecution model: ${models.execution ?? "default"}\nFallback models: ${models.fallback.join(", ") || "none"}\n\nIssue body:\n${issue.body ?? ""}${autoresearch}\n\nIf state is PLANNING, inspect the checkout and produce a PLAN only. Post the PLAN to the issue, then wait for ai:state:EXECUTING or requested changes. If state is EXECUTING, execute the approved plan. When done, call the issueAgentDone tool with optional PR text; the harness should commit, push ${branchName(issue)}, and open a PR for review. If a provider limit/error occurs, report BLOCKED_WITH_PROVIDER_ERROR so the harness can switch fallback models or pick another issue.`;
  activeAgentRun = true;
  if (cfg.dryRun) {
    notify?.(`DRY RUN: Checkout ${repo} at ${branchName(issue)} into ${dir}`, "info");
    notify?.(`DRY RUN: Send issue workflow prompt to model and assume ${stateOf(issue.labels) === "PLANNING" ? "a plan document" : "an issueAgentDone tool call"}`, "info");
    return dir;
  }
  await pi.sendUserMessage(prompt, { deliverAs: "followUp" } as any);
  return dir;
}

function messageText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === "text").map((x) => x.text).join("\n");
  return "";
}

async function commitPushPr(work: { repo: string; issue: Issue; cfg: Config; dir: string; doneText?: string }, notify?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<string> {
  const branch = branchName(work.issue);
  if (work.cfg.dryRun) {
    notify?.(`DRY RUN: Commit issue #${work.issue.number}: ${work.issue.title}`, "info");
    notify?.(`DRY RUN: Push branch ${branch}`, "info");
    notify?.(`DRY RUN: Open pull request for ${branch}${work.doneText ? ` with body: ${work.doneText}` : ""}`, "info");
    return `DRY RUN: would push ${branch} and open a PR.`;
  }
  execFileSync("git", ["add", "-A"], { cwd: work.dir, stdio: "ignore" });
  const diff = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: work.dir }).toString().trim();
  if (!diff) return "No file changes were present, so no commit/PR was created.";
  execFileSync("git", ["commit", "-m", `AI issue #${work.issue.number}: ${work.issue.title}`], { cwd: work.dir, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", branch], { cwd: work.dir, stdio: "ignore" });
  const pr = await createPullRequest(work.repo, work.issue, branch, work.cfg.token, work.doneText);
  return `Pushed ${branch} and opened PR: ${pr}`;
}

async function finishWork(work: { repo: string; issue: Issue; cfg: Config; dir: string; doneText?: string }, finalText: string, notify?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<void> {
  if (stateOf(work.issue.labels) === "PLANNING") {
    const body = `## AI Plan\n\n${finalText}\n\n---\nApprove by changing labels to \`ai:state:EXECUTING\`; request changes by keeping/setting \`ai:state:WAITING_FOR_FEEDBACK\` and commenting.`;
    if (work.cfg.dryRun) notify?.(`DRY RUN: Post plan document to issue #${work.issue.number}: ${body}`, "info");
    else await postIssueComment(work.repo, work.issue, body, work.cfg.token);
    if (work.cfg.dryRun) notify?.(`DRY RUN: Change issue label to ai:state:WAITING_FOR_FEEDBACK`, "info");
    else await setAiState(work.repo, work.issue, "WAITING_FOR_FEEDBACK", work.cfg.token);
  } else if (work.doneText !== undefined) {
    const result = await commitPushPr(work, notify);
    const body = `## AI Execution Complete\n\n${result}\n\n${work.doneText || finalText}`;
    if (work.cfg.dryRun) notify?.(`DRY RUN: Post execution-complete document to issue #${work.issue.number}: ${body}`, "info");
    else await postIssueComment(work.repo, work.issue, body, work.cfg.token);
    if (work.cfg.dryRun) notify?.(`DRY RUN: Change issue label to ai:state:WAITING_FOR_REVIEW`, "info");
    else await setAiState(work.repo, work.issue, "WAITING_FOR_REVIEW", work.cfg.token);
  } else {
    const body = `AI execution stopped without issueAgentDone; leaving issue for follow-up.\n\n${finalText}`;
    if (work.cfg.dryRun) notify?.(`DRY RUN: Post stopped-without-issueAgentDone document to issue #${work.issue.number}: ${body}`, "info");
    else await postIssueComment(work.repo, work.issue, body, work.cfg.token);
  }
}

async function switchModelByName(pi: ExtensionAPI, ctx: any, modelName: string): Promise<boolean> {
  const registry = ctx?.modelRegistry;
  let model: any;
  if (registry?.find && modelName.includes("/")) {
    const [provider, id] = modelName.split("/", 2);
    model = registry.find(provider, id);
  }
  model ??= registry?.findById?.(modelName) ?? registry?.get?.(modelName);
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
    if (!issue.labels.includes(DEPENDENCY_BLOCK_LABEL)) return;
    if (cfg.dryRun) notify?.(`DRY RUN: Remove issue label ${DEPENDENCY_BLOCK_LABEL} from #${issue.number}`, "info");
    else await removeLabel(repo, issue, DEPENDENCY_BLOCK_LABEL, cfg.token);
    return;
  }

  const closed = (await issueState(repo, dep, cfg.token).catch(() => "")) === "closed";
  dependencyBlocked.set(key, !closed);
  if (closed) {
    if (!issue.labels.includes(DEPENDENCY_BLOCK_LABEL)) return;
    if (cfg.dryRun) notify?.(`DRY RUN: Remove issue label ${DEPENDENCY_BLOCK_LABEL} from #${issue.number}; dependency #${dep} is closed`, "info");
    else await removeLabel(repo, issue, DEPENDENCY_BLOCK_LABEL, cfg.token);
    return;
  }

  if (issue.labels.includes(DEPENDENCY_BLOCK_LABEL)) return;
  if (cfg.dryRun) notify?.(`DRY RUN: Change issue label to ${DEPENDENCY_BLOCK_LABEL}; dependency #${dep} is not closed`, "info");
  else await addLabels(repo, issue, [DEPENDENCY_BLOCK_LABEL], cfg.token);
}

async function maintainIssueLabels(cfg: Config, notify?: (msg: string, type?: "info" | "warning" | "error") => void): Promise<void> {
  for (const repo of cfg.repos) {
    for (const issue of await listIssues(repo, cfg.token)) {
      await maintainIssueDependencies(repo, issue, cfg, notify).catch((err) => notify?.(`issue-agent dependency check failed for #${issue.number}: ${err instanceof Error ? err.message : String(err)}`, "warning"));
      const retryLabel = issue.labels.find((l) => l.startsWith("ai:retry-after:"));
      if (issue.labels.includes("ai:blocked:usage-limit") && retryLabel) {
        const when = Date.parse(retryLabel.slice("ai:retry-after:".length));
        if (Number.isFinite(when) && when <= Date.now()) {
          if (cfg.dryRun) {
            notify?.(`DRY RUN: Remove issue labels ai:blocked:usage-limit, ${retryLabel}, and provider-status labels from #${issue.number}`, "info");
            notify?.(`DRY RUN: Post unblock comment to issue #${issue.number}`, "info");
          } else {
            await removeLabel(repo, issue, "ai:blocked:usage-limit", cfg.token);
            await removeLabel(repo, issue, retryLabel, cfg.token);
            for (const label of issue.labels.filter((l) => l.startsWith("ai:provider-status:"))) await removeLabel(repo, issue, label, cfg.token);
            await postIssueComment(repo, issue, "Recorded usage-limit reset time has passed; unblocking this issue for retry.", cfg.token).catch(() => undefined);
          }
        }
      }
      if (stateOf(issue.labels) !== "WAITING_FOR_FEEDBACK") continue;
      const comments = await listComments(repo, issue, cfg.token).catch(() => []);
      if (comments.some((c) => /^\s*\/approve\b/im.test(String(c.body ?? "")))) {
        if (cfg.dryRun) {
          notify?.(`DRY RUN: Change issue label to ai:state:EXECUTING`, "info");
          notify?.(`DRY RUN: Post approval-detected comment to issue #${issue.number}`, "info");
        } else {
          await setAiState(repo, issue, "EXECUTING", cfg.token);
          await postIssueComment(repo, issue, "Approval detected (`/approve`); switching to `ai:state:EXECUTING`.", cfg.token).catch(() => undefined);
        }
      }
    }
  }
}

async function runLoop(pi: ExtensionAPI, cfg: Config, notify: (msg: string, type?: "info" | "warning" | "error") => void): Promise<void> {
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
  notify(cfg.dryRun ? `issue-agent dry run; printing operations without changing issues, git, or model state` : `issue-agent running with workspace-permissions=deny (/tmp allowed); use /issue-agent-stop or Ctrl-C to stop after the current agent turn`, "info");
  try {
    while (!stopRequested) {
      if (!activeAgentRun) {
        await maintainIssueLabels(cfg, notify).catch((err) => notify(`issue-agent label maintenance failed: ${err instanceof Error ? err.message : String(err)}`, "warning"));
        const candidates: Array<{ repo: string; issue: Issue }> = [];
        for (const repo of cfg.repos) {
          try {
            for (const issue of await listIssues(repo, cfg.token)) candidates.push({ repo, issue });
          } catch (err) {
            notify(`issue-agent failed to list ${repo}: ${err instanceof Error ? err.message : String(err)}`, "warning");
          }
        }
        const now = Date.now();
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
        if (next) {
          const dir = await queueIssue(pi, next.repo, next.issue, cfg, notify);
          recentlyQueued.set(`${next.repo}#${next.issue.number}:${stateOf(next.issue.labels)}`, now);
          notify(`Queued issue #${next.issue.number} from ${basename(next.repo)} in ${dir}`, "info");
          if (cfg.dryRun && activeWork) {
            const work = activeWork;
            activeAgentRun = false;
            activeWork = undefined;
            if (stateOf(work.issue.labels) !== "PLANNING") work.doneText = "DRY RUN: assumed issueAgentDone PR text.";
            await finishWork(work, stateOf(work.issue.labels) === "PLANNING" ? "DRY RUN PLAN: assumed model plan output." : "DRY RUN: assumed issueAgentDone tool call.", notify);
          }
        }
      }
      await sleep(cfg.intervalMs);
    }
  } finally {
    running = false;
    stopRequested = false;
    if (cfg.dryRun) notify("DRY RUN: Release issue-agent lock", "info");
    else releaseLock();
    notify("issue-agent stopped", "info");
  }
}

export default function (pi: ExtensionAPI) {
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
      await queueIssue(pi, work.repo, work.issue, work.cfg);
      if (activeWork) activeWork.fallbackIndex = work.fallbackIndex;
      return;
    }
    await postIssueComment(activeWork.repo, activeWork.issue, `Provider/model error while working this issue: HTTP ${event.status}.${retry}\n\nAll configured fallback models are exhausted or currently rate-limited. The harness will reschedule this issue after the limit resets and continue with other issues.`, activeWork.cfg.token).catch(() => undefined);
    await addLabels(activeWork.repo, activeWork.issue, [`ai:blocked:usage-limit`, `ai:provider-status:${event.status}`, `ai:retry-after:${new Date(retryAt).toISOString()}`], activeWork.cfg.token).catch(() => undefined);
    activeAgentRun = false;
    activeWork = undefined;
  });

  pi.on("agent_end", async (event) => {
    const work = activeWork;
    activeAgentRun = false;
    activeWork = undefined;
    if (!work) return;
    const finalText = event.messages.map(messageText).join("\n").trim();
    try {
      await finishWork(work, finalText);
    } catch (err) {
      await postIssueComment(work.repo, work.issue, `Harness post-processing failed: ${err instanceof Error ? err.message : String(err)}`, work.cfg.token).catch(() => undefined);
      await addLabels(work.repo, work.issue, ["ai:blocked:harness-error"], work.cfg.token).catch(() => undefined);
    }
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      stopRequested = true;
      releaseLock();
    });
  }

  pi.registerCommand("issue-agent", {
    description: "Run continuously over ai:* labeled GitHub/Forgejo issues until interrupted. Args: --repos=url[,url] --planning-model=x --execution-model=y --fallback-models=a,b --interval=30000 --dry-run",
    handler: async (argLine: string, ctx) => {
      const cfg = config(parseArgs(argLine));
      if (!cfg.repos.length) {
        ctx.ui.notify("Usage: /issue-agent --repos=https://github.com/owner/repo[,https://forgejo/owner/repo] [--dry-run]", "warning");
        return;
      }
      if (running) {
        ctx.ui.notify("issue-agent is already running; use /issue-agent-stop first", "warning");
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.onTerminalInput((data) => {
          if (running && data === "\u0003") stopRequested = true;
          return undefined;
        });
      }
      void runLoop(pi, cfg, (msg, type = "info") => ctx.ui.notify(msg, type));
    },
  });

  pi.registerCommand("issue-agent-stop", {
    description: "Gracefully stop the long-running /issue-agent loop after the current agent turn.",
    handler: async (_argLine: string, ctx) => {
      if (!running) { ctx.ui.notify("issue-agent is not running", "info"); return; }
      stopRequested = true;
      ctx.ui.notify("issue-agent stop requested", "info");
    },
  });

  pi.registerTool({
    name: "issueAgentDone",
    label: "Issue Agent Done",
    description: "Mark the active issue-agent execution task as done. Optional text is used in the issue completion comment and pull request body.",
    parameters: Type.Object({ text: Type.Optional(Type.String()) }),
    async execute(_id, input: any) {
      if (!activeWork || stateOf(activeWork.issue.labels) !== "EXECUTING") {
        return { content: [{ type: "text", text: "No active issue-agent execution task." }], details: { ok: false } };
      }
      activeWork.doneText = typeof input.text === "string" ? input.text : "";
      return { content: [{ type: "text", text: "Marked active issue-agent task as done. The harness will commit, push, and open a PR after this turn." }], details: { ok: true } };
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
