// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /insights — Pi Usage Insights
 *
 * Scans all Pi session logs, extracts deterministic stats, runs LLM
 * facet extraction per session (cached), fires 7 parallel insight prompts
 * + 1 synthesis, and writes a self-contained HTML report.
 *
 * Usage:
 *   /insights             — run with caches (fast on re-runs)
 *   /insights --refresh   — invalidate all LLM facet caches, re-extract
 *   /insights --no-open   — don't open the report in the browser
 *
 * Data dir: ~/.pi/agent/usage-data/
 *   session-meta/<id>.json   deterministic stats, cached permanently
 *   facets/<id>.json         LLM-extracted facets, cached permanently
 *   report.html              last generated report
 */

import { complete } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { execFile as execFileCb } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ─── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), ".pi", "agent", "usage-data");
const FACETS_DIR = join(DATA_DIR, "facets");
const META_DIR = join(DATA_DIR, "session-meta");
const REPORT_PATH = join(DATA_DIR, "report.html");
const REPORT_MD_PATH = join(DATA_DIR, "report.md");
const REPORT_PORT = 5463;
const REPORT_URL = `http://localhost:${REPORT_PORT}`;

let reportServer: Server | null = null;

const MAX_SESSIONS_TO_LOAD = 200;
const MAX_FACET_EXTRACTIONS = 50;
const FACET_CONCURRENCY = 50;
const META_BATCH_SIZE = 50;
const LOAD_BATCH_SIZE = 10;
const OVERLAP_WINDOW_MS = 30 * 60_000;

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".py": "Python",
	".rb": "Ruby",
	".go": "Go",
	".rs": "Rust",
	".java": "Java",
	".md": "Markdown",
	".json": "JSON",
	".yaml": "YAML",
	".yml": "YAML",
	".sh": "Shell",
	".css": "CSS",
	".html": "HTML",
	".c": "C",
	".cpp": "C++",
	".cs": "C#",
	".kt": "Kotlin",
	".swift": "Swift",
};

const LABEL_MAP: Record<string, string> = {
	debug_investigate: "Debug / Investigate",
	implement_feature: "Implement Feature",
	fix_bug: "Fix Bug",
	write_script_tool: "Write Script / Tool",
	refactor_code: "Refactor Code",
	configure_system: "Configure System",
	create_pr_commit: "Create PR / Commit",
	analyze_data: "Analyze Data",
	understand_codebase: "Understand Codebase",
	write_tests: "Write Tests",
	write_docs: "Write Docs",
	deploy_infra: "Deploy / Infra",
	warmup_minimal: "Cache Warmup",
	fast_accurate_search: "Fast / Accurate Search",
	correct_code_edits: "Correct Code Edits",
	good_explanations: "Good Explanations",
	proactive_help: "Proactive Help",
	multi_file_changes: "Multi-file Changes",
	handled_complexity: "Multi-file Changes",
	good_debugging: "Good Debugging",
	misunderstood_request: "Misunderstood Request",
	wrong_approach: "Wrong Approach",
	buggy_code: "Buggy Code",
	user_rejected_action: "User Rejected Action",
	assistant_got_blocked: "Assistant Got Blocked",
	user_stopped_early: "User Stopped Early",
	wrong_file_or_location: "Wrong File / Location",
	excessive_changes: "Excessive Changes",
	slow_or_verbose: "Slow / Verbose",
	tool_failed: "Tool Failed",
	user_unclear: "User Unclear",
	external_issue: "External Issue",
	frustrated: "Frustrated",
	dissatisfied: "Dissatisfied",
	likely_satisfied: "Likely Satisfied",
	satisfied: "Satisfied",
	happy: "Happy",
	unsure: "Unsure",
	neutral: "Neutral",
	delighted: "Delighted",
	single_task: "Single Task",
	multi_task: "Multi Task",
	iterative_refinement: "Iterative Refinement",
	exploration: "Exploration",
	quick_question: "Quick Question",
	fully_achieved: "Fully Achieved",
	mostly_achieved: "Mostly Achieved",
	partially_achieved: "Partially Achieved",
	not_achieved: "Not Achieved",
	unclear_from_transcript: "Unclear",
	unhelpful: "Unhelpful",
	slightly_helpful: "Slightly Helpful",
	moderately_helpful: "Moderately Helpful",
	very_helpful: "Very Helpful",
	essential: "Essential",
};

const SATISFACTION_ORDER = [
	"frustrated",
	"dissatisfied",
	"likely_satisfied",
	"satisfied",
	"happy",
	"unsure",
	"neutral",
	"delighted",
];
const OUTCOME_ORDER = [
	"not_achieved",
	"partially_achieved",
	"mostly_achieved",
	"fully_achieved",
	"unclear_from_transcript",
];

function displayLabel(key: string): string {
	return (
		LABEL_MAP[key] ??
		key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
	);
}

async function startReportServer(): Promise<string> {
	if (reportServer?.listening) return REPORT_URL;

	reportServer = createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", REPORT_URL).pathname;
		if (path !== "/" && path !== "/report.html") {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("Not found");
			return;
		}

		try {
			const html = await readFile(REPORT_PATH, "utf8");
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			});
			res.end(html);
		} catch {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("Pi Insights report has not been generated yet. Run /insights first.");
		}
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") resolve();
			else reject(err);
		};
		reportServer!.once("error", onError);
		reportServer!.listen(REPORT_PORT, "127.0.0.1", () => {
			reportServer!.off("error", onError);
			resolve();
		});
	});

	return REPORT_URL;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionMeta = {
	session_id: string;
	session_path: string;
	project_path: string;
	start_time: string;
	duration_minutes: number;
	user_message_count: number;
	assistant_message_count: number;
	tool_counts: Record<string, number>;
	languages: Record<string, number>;
	git_commits: number;
	git_pushes: number;
	input_tokens: number;
	output_tokens: number;
	total_cost: number;
	first_prompt: string;
	user_interruptions: number;
	user_response_times: number[];
	tool_errors: number;
	tool_error_categories: Record<string, number>;
	uses_subagent: boolean;
	uses_mcp: boolean;
	lines_added: number;
	lines_removed: number;
	files_modified: number;
	message_hours: number[];
	user_message_timestamps: string[];
	model_usage: Record<string, { input_tokens: number; output_tokens: number; cost: number; message_count: number }>;
};

type SessionFacets = {
	session_id: string;
	underlying_goal: string;
	goal_categories: Record<string, number>;
	outcome: string;
	user_satisfaction_counts: Record<string, number>;
	assistant_helpfulness: string;
	session_type: string;
	friction_counts: Record<string, number>;
	friction_detail: string;
	primary_success: string;
	brief_summary: string;
	user_instructions_to_assistant?: string[];
};

type AggregatedData = {
	total_sessions: number;
	sessions_with_facets: number;
	date_range: { start: string; end: string };
	total_messages: number;
	total_duration_hours: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_cost: number;
	tool_counts: Record<string, number>;
	languages: Record<string, number>;
	git_commits: number;
	git_pushes: number;
	projects: Record<string, number>;
	goal_categories: Record<string, number>;
	outcomes: Record<string, number>;
	satisfaction: Record<string, number>;
	helpfulness: Record<string, number>;
	session_types: Record<string, number>;
	friction: Record<string, number>;
	success: Record<string, number>;
	session_summaries: Array<{
		id: string;
		date: string;
		summary: string;
		outcome: string;
		helpfulness: string;
	}>;
	friction_details: string[];
	user_instructions: string[];
	total_interruptions: number;
	total_tool_errors: number;
	tool_error_categories: Record<string, number>;
	user_response_times: number[];
	median_response_time: number;
	avg_response_time: number;
	sessions_using_subagent: number;
	sessions_using_mcp: number;
	total_lines_added: number;
	total_lines_removed: number;
	total_files_modified: number;
	days_active: number;
	message_hours: number[];
	multi_clauding: {
		overlap_events: number;
		sessions_involved: number;
		user_messages_during: number;
	};
	model_usage: Record<string, { input_tokens: number; output_tokens: number; cost: number; message_count: number; sessions: number }>;
	model_efficiency: Array<{
		model: string;
		session_id: string;
		date: string;
		cost: number;
		outcome: string;
		session_type: string;
		goal: string;
		flag: "overspend" | "underspend" | "ok";
		reason: string;
	}>;
	estimated_waste: number;
};

type UserContext = {
	existing_agents_md_rules: string[];
	installed_skills: string[];
	installed_extensions: string[];
	installed_packages: string[];
	default_model: string;
};

type TemporalData = {
	diff_headlines: string[];
	this_week: { sessions: number; avg_cost: number; errors_per_session: number; primary_model: string } | null;
	last_week: { sessions: number; avg_cost: number; errors_per_session: number; primary_model: string } | null;
	trajectory: { cost: string; errors: string; note: string };
	anomalies: Array<{ date: string; cost: string; errors: number; reason: string; prompt: string }>;
	major_transition: { when: string; what: string; impact: string } | null;
	resolved_friction: string[];
	ongoing_friction: Array<{ type: string; recent_count: number; total_count: number }>;
	staleness_pct: number;
};

// ─── Cache Utilities ──────────────────────────────────────────────────────────

async function ensureDirs(): Promise<void> {
	await mkdir(META_DIR, { recursive: true });
	await mkdir(FACETS_DIR, { recursive: true });
}

async function loadCachedMeta(sessionId: string): Promise<SessionMeta | null> {
	try {
		const raw = await readFile(join(META_DIR, `${sessionId}.json`), "utf-8");
		return JSON.parse(raw) as SessionMeta;
	} catch {
		return null;
	}
}

async function saveMeta(meta: SessionMeta): Promise<void> {
	await writeFile(
		join(META_DIR, `${meta.session_id}.json`),
		JSON.stringify(meta, null, 2),
		{ encoding: "utf-8", mode: 0o600 },
	);
}

async function loadCachedFacets(
	sessionId: string,
): Promise<SessionFacets | null> {
	try {
		const raw = await readFile(join(FACETS_DIR, `${sessionId}.json`), "utf-8");
		const parsed = JSON.parse(raw) as SessionFacets;
		// Basic schema check
		if (!parsed.session_id || !parsed.brief_summary || !parsed.outcome)
			return null;
		return parsed;
	} catch {
		return null;
	}
}

async function saveFacets(facets: SessionFacets): Promise<void> {
	await writeFile(
		join(FACETS_DIR, `${facets.session_id}.json`),
		JSON.stringify(facets, null, 2),
		{ encoding: "utf-8", mode: 0o600 },
	);
}

async function deleteCachedFacets(sessionId: string): Promise<void> {
	try {
		await unlink(join(FACETS_DIR, `${sessionId}.json`));
	} catch {
		/* ok */
	}
}

async function gatherUserContext(): Promise<UserContext> {
	const agentDir = join(homedir(), ".pi", "agent");
	const ctx: UserContext = { existing_agents_md_rules: [], installed_skills: [], installed_extensions: [], installed_packages: [], default_model: "" };

	try {
		const agentsMd = await readFile(join(agentDir, "AGENTS.md"), "utf-8");
		for (const line of agentsMd.split("\n")) {
			const t = line.trim();
			if (t.length > 20 && t.length < 200 && /\b(always|never|do not|don't|must|require|forbid)\b/i.test(t)) {
				ctx.existing_agents_md_rules.push(t.slice(0, 150));
			}
		}
		ctx.existing_agents_md_rules = ctx.existing_agents_md_rules.slice(0, 20);
	} catch {}

	try {
		const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf-8"));
		ctx.default_model = settings.defaultModel || "";
		ctx.installed_packages = (settings.packages || []).map((p: string) => p.replace(/.*\//, ""));
	} catch {}

	try {
		const entries = await readdir(join(agentDir, "skills"), { withFileTypes: true });
		ctx.installed_skills = entries.filter((e: { isDirectory(): boolean; name: string }) => e.isDirectory()).map((e: { name: string }) => e.name);
	} catch {}

	try {
		const entries = await readdir(join(agentDir, "extensions"));
		ctx.installed_extensions = entries.filter((f: string) => f.endsWith(".ts") || f.endsWith(".js")).map((f: string) => f.replace(/\.[^.]+$/, ""));
	} catch {}

	return ctx;
}

function modeStr(arr: string[]): string {
	const counts: Record<string, number> = {};
	for (const v of arr) if (v) counts[v] = (counts[v] || 0) + 1;
	return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function computeTemporalData(metas: SessionMeta[], facetsMap: Map<string, SessionFacets>): TemporalData {
	const sorted = [...metas].sort((a, b) => a.start_time.localeCompare(b.start_time));
	if (!sorted.length) return { diff_headlines: [], this_week: null, last_week: null, trajectory: { cost: "stable", errors: "stable", note: "" }, anomalies: [], major_transition: null, resolved_friction: [], ongoing_friction: [], staleness_pct: 0 };

	const now = new Date(sorted[sorted.length - 1]!.start_time).getTime();
	const oneWeek = 7 * 86400000;

	// Diff: this week vs last week
	const thisWeekSessions = sorted.filter(m => now - new Date(m.start_time).getTime() < oneWeek);
	const lastWeekSessions = sorted.filter(m => { const age = now - new Date(m.start_time).getTime(); return age >= oneWeek && age < 2 * oneWeek; });

	function periodSummary(sessions: SessionMeta[]) {
		if (!sessions.length) return null;
		const models: Record<string, number> = {};
		let cost = 0, errors = 0;
		for (const m of sessions) { cost += m.total_cost; errors += m.tool_errors; for (const [model, s] of Object.entries(m.model_usage)) models[model] = (models[model] || 0) + s.message_count; }
		return { sessions: sessions.length, avg_cost: cost / sessions.length, errors_per_session: errors / sessions.length, primary_model: Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0]?.replace(/.*\./, "") || "unknown" };
	}

	const tw = periodSummary(thisWeekSessions);
	const lw = periodSummary(lastWeekSessions);
	const diff_headlines: string[] = [];
	if (tw && lw && lw.avg_cost > 0) {
		const costD = Math.round((tw.avg_cost - lw.avg_cost) / lw.avg_cost * 100);
		if (Math.abs(costD) > 15) diff_headlines.push(`Cost ${costD > 0 ? "up" : "down"} ${Math.abs(costD)}% ($${lw.avg_cost.toFixed(1)} \u2192 $${tw.avg_cost.toFixed(1)}/session)`);
		const errD = Math.round((tw.errors_per_session - lw.errors_per_session) / (lw.errors_per_session || 1) * 100);
		if (Math.abs(errD) > 20) diff_headlines.push(`Errors ${errD > 0 ? "up" : "down"} ${Math.abs(errD)}% (${lw.errors_per_session.toFixed(0)} \u2192 ${tw.errors_per_session.toFixed(0)}/session)`);
		if (tw.primary_model !== lw.primary_model) diff_headlines.push(`Model shifted: ${lw.primary_model} \u2192 ${tw.primary_model}`);
	}

	// Trajectory
	const recent10 = sorted.slice(-10);
	const older = sorted.slice(0, -10);
	const recentCost = recent10.reduce((s, m) => s + m.total_cost, 0) / recent10.length;
	const olderCost = older.length ? older.reduce((s, m) => s + m.total_cost, 0) / older.length : recentCost;
	const recentErrors = recent10.reduce((s, m) => s + m.tool_errors, 0) / recent10.length;
	const olderErrors = older.length ? older.reduce((s, m) => s + m.tool_errors, 0) / older.length : recentErrors;
	const trajectory = {
		cost: recentCost > olderCost * 1.2 ? "increasing" : recentCost < olderCost * 0.8 ? "decreasing" : "stable",
		errors: recentErrors > olderErrors * 1.2 ? "increasing" : recentErrors < olderErrors * 0.8 ? "decreasing" : "stable",
		note: older.length ? `Recent 10 vs earlier ${older.length}: cost ${recentCost > olderCost ? "up" : "down"} ${Math.abs(Math.round((recentCost - olderCost) / (olderCost || 1) * 100))}%, errors ${recentErrors > olderErrors ? "up" : "down"} ${Math.abs(Math.round((recentErrors - olderErrors) / (olderErrors || 1) * 100))}%` : "Not enough history",
	};

	// Anomalies
	const anomalies: TemporalData["anomalies"] = [];
	for (let i = 5; i < sorted.length; i++) {
		const m = sorted[i]!;
		const window = sorted.slice(Math.max(0, i - 10), i);
		const avgCost = window.reduce((s, x) => s + x.total_cost, 0) / window.length;
		const avgErrors = window.reduce((s, x) => s + x.tool_errors, 0) / window.length;
		const reasons: string[] = [];
		if (m.total_cost > avgCost * 3 && m.total_cost > 10) reasons.push(`cost spike: $${m.total_cost.toFixed(0)} vs $${avgCost.toFixed(0)} avg`);
		if (m.tool_errors > avgErrors * 3 && m.tool_errors > 10) reasons.push(`error spike: ${m.tool_errors} vs ${avgErrors.toFixed(0)} avg`);
		if (reasons.length) anomalies.push({ date: m.start_time.slice(0, 10), cost: `$${m.total_cost.toFixed(2)}`, errors: m.tool_errors, reason: reasons.join("; "), prompt: m.first_prompt.slice(0, 80) });
	}
	anomalies.sort((a, b) => parseFloat(b.cost.slice(1)) - parseFloat(a.cost.slice(1)));

	// Major transition
	let major_transition: TemporalData["major_transition"] = null;
	for (let i = sorted.length - 1; i >= 10; i--) {
		const after = sorted.slice(i, Math.min(i + 10, sorted.length));
		const before = sorted.slice(Math.max(0, i - 10), i);
		if (before.length < 5 || after.length < 5) continue;
		const beforeModel = modeStr(before.map(m => Object.entries(m.model_usage).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || ""));
		const afterModel = modeStr(after.map(m => Object.entries(m.model_usage).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || ""));
		if (beforeModel && afterModel && beforeModel !== afterModel) {
			const beforeCost = before.reduce((s, m) => s + m.total_cost, 0) / before.length;
			const afterCost = after.reduce((s, m) => s + m.total_cost, 0) / after.length;
			const beforeErrors = before.reduce((s, m) => s + m.tool_errors, 0) / before.length;
			const afterErrors = after.reduce((s, m) => s + m.tool_errors, 0) / after.length;
			major_transition = {
				when: sorted[i]!.start_time.slice(0, 10),
				what: `Shifted from ${beforeModel.replace(/.*\./, "")} to ${afterModel.replace(/.*\./, "")}`,
				impact: `Cost ${afterCost > beforeCost ? "up" : "down"} ${Math.abs(Math.round((afterCost - beforeCost) / (beforeCost || 1) * 100))}%, errors ${afterErrors > beforeErrors ? "up" : "down"} ${Math.abs(Math.round((afterErrors - beforeErrors) / (beforeErrors || 1) * 100))}%`,
			};
			break;
		}
	}

	// Resolved vs ongoing friction
	const recentCutoff = now - 14 * 86400000;
	const recentMetas = sorted.filter(m => new Date(m.start_time).getTime() >= recentCutoff);
	const olderMetas = sorted.filter(m => new Date(m.start_time).getTime() < recentCutoff);
	const recentFriction: Record<string, number> = {};
	const olderFriction: Record<string, number> = {};
	for (const m of recentMetas) { const f = facetsMap.get(m.session_id); if (f) for (const [k, v] of Object.entries(f.friction_counts)) if (v > 0) recentFriction[k] = (recentFriction[k] || 0) + v; }
	for (const m of olderMetas) { const f = facetsMap.get(m.session_id); if (f) for (const [k, v] of Object.entries(f.friction_counts)) if (v > 0) olderFriction[k] = (olderFriction[k] || 0) + v; }
	const resolved_friction: string[] = [];
	const ongoing_friction: TemporalData["ongoing_friction"] = [];
	for (const [type] of Object.entries(olderFriction)) { if (!recentFriction[type]) resolved_friction.push(type); }
	for (const [type, count] of Object.entries(recentFriction)) { if (count > 0) ongoing_friction.push({ type, recent_count: count, total_count: count + (olderFriction[type] || 0) }); }
	ongoing_friction.sort((a, b) => b.recent_count - a.recent_count);

	// Staleness
	const flatCost = sorted.reduce((s, m) => s + m.total_cost, 0) / sorted.length;
	const staleness_pct = flatCost > 0 ? Math.abs((recentCost - flatCost) / flatCost * 100) : 0;

	return { diff_headlines, this_week: tw, last_week: lw, trajectory, anomalies: anomalies.slice(0, 5), major_transition, resolved_friction: resolved_friction.slice(0, 5), ongoing_friction: ongoing_friction.slice(0, 8), staleness_pct };
}

// ─── Session Parsing ──────────────────────────────────────────────────────────

type AnyEntry = Record<string, unknown>;
type AnyMessage = Record<string, unknown>;
type ContentBlock = {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	[k: string]: unknown;
};

function getLanguageFromPath(filePath: string): string | null {
	return EXTENSION_TO_LANGUAGE[extname(filePath).toLowerCase()] ?? null;
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join(" ");
}

function isHumanMessage(msg: AnyMessage): boolean {
	const content = msg.content;
	if (typeof content === "string" && (content as string).trim()) return true;
	if (Array.isArray(content)) {
		return (content as ContentBlock[]).some(
			(b) =>
				b.type === "text" &&
				typeof b.text === "string" &&
				(b.text as string).trim().length > 0,
		);
	}
	return false;
}

function countNewlines(s: string): number {
	return (s.match(/\n/g) ?? []).length;
}

/** Detect sessions that were spawned by the insights pipeline itself */
function isMetaSession(entries: AnyEntry[]): boolean {
	let userMsgCount = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;
		if (msg.role === "user" && isHumanMessage(msg)) {
			const text = extractTextFromContent(msg.content);
			if (
				text.includes("RESPOND WITH ONLY A VALID JSON OBJECT") ||
				text.includes("record_facets") ||
				text.includes("extract structured facets") ||
				text.includes("At a Glance")
			)
				return true;
			userMsgCount++;
			if (userMsgCount >= 3) break;
		}
	}
	return false;
}

function extractSessionStats(entries: AnyEntry[], sessionPath: string) {
	const toolCounts: Record<string, number> = {};
	const languages: Record<string, number> = {};
	const toolErrorCategories: Record<string, number> = {};
	const filesModified = new Set<string>();
	const userResponseTimes: number[] = [];
	const messageHours: number[] = [];
	const userMessageTimestamps: string[] = [];

	let gitCommits = 0;
	let gitPushes = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let totalCost = 0;
	let userInterruptions = 0;
	let toolErrors = 0;
	let usesSubagent = false;
	let usesMcp = false;
	let linesAdded = 0;
	let linesRemoved = 0;
	let userMessageCount = 0;
	let assistantMessageCount = 0;
	let firstPrompt = "";

	const modelUsage: Record<string, { input_tokens: number; output_tokens: number; cost: number; message_count: number }> = {};

	let lastAssistantTs: number | null = null;

	// Deduplicate tool call IDs to avoid double-counting branched entries
	const seenToolCallIds = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;

		const msgTs = typeof msg.timestamp === "number" ? msg.timestamp : null;

		// ── assistant message ──
		if (msg.role === "assistant") {
			assistantMessageCount++;
			if (msgTs) lastAssistantTs = msgTs;

			// Model tracking
			const modelName = (msg.model as string) ?? "unknown";

			// Tokens + cost
			const usage = msg.usage as Record<string, unknown> | undefined;
			if (usage) {
				const msgInput = (usage.input as number) ?? 0;
				const msgOutput = (usage.output as number) ?? 0;
				const cost = usage.cost as Record<string, number> | undefined;
				const msgCost = cost?.total ?? 0;

				inputTokens += msgInput;
				outputTokens += msgOutput;
				if (msgCost) totalCost += msgCost;

				if (!modelUsage[modelName]) modelUsage[modelName] = { input_tokens: 0, output_tokens: 0, cost: 0, message_count: 0 };
				modelUsage[modelName]!.input_tokens += msgInput;
				modelUsage[modelName]!.output_tokens += msgOutput;
				modelUsage[modelName]!.cost += msgCost;
				modelUsage[modelName]!.message_count++;
			}

			// Tool calls inside content
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content as ContentBlock[]) {
					if (block.type !== "toolCall") continue;
					const toolName = (block.name as string) ?? "";
					const toolId = (block.id as string) ?? Math.random().toString(36);

					if (seenToolCallIds.has(toolId)) continue;
					seenToolCallIds.add(toolId);

					toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;

					if (toolName === "subagent") usesSubagent = true;
					if (toolName.startsWith("mcp__")) usesMcp = true;

					const args = (block.arguments as Record<string, unknown>) ?? {};
					const filePath =
						(args.path as string) ?? (args.file_path as string) ?? "";

					if (filePath) {
						const lang = getLanguageFromPath(filePath);
						if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
					}

					if (toolName === "write" && filePath) {
						filesModified.add(filePath);
						const content_ = (args.content as string) ?? "";
						linesAdded += countNewlines(content_) + 1;
					}

					if (toolName === "edit" && filePath) {
						filesModified.add(filePath);
						const edits =
							(args.edits as Array<{
								oldText?: string;
								newText?: string;
								old_string?: string;
								new_string?: string;
							}>) ?? [];
						for (const e of edits) {
							const oldText = e.oldText ?? e.old_string ?? "";
							const newText = e.newText ?? e.new_string ?? "";
							linesAdded += countNewlines(newText) + 1;
							linesRemoved += countNewlines(oldText) + 1;
						}
					}

					if (toolName === "bash") {
						const cmd = (args.command as string) ?? "";
						if (cmd.includes("git commit")) gitCommits++;
						if (cmd.includes("git push")) gitPushes++;
					}
				}
			}
		}

		// ── user message (human) ──
		if (msg.role === "user" && isHumanMessage(msg)) {
			userMessageCount++;
			const text = extractTextFromContent(msg.content);

			if (!firstPrompt && text.trim()) firstPrompt = text.trim().slice(0, 300);

			if (text.includes("[Request interrupted by user")) userInterruptions++;

			if (msgTs) {
				const d = new Date(msgTs);
				messageHours.push(d.getHours());
				userMessageTimestamps.push(d.toISOString());

				if (lastAssistantTs !== null) {
					const gapSec = (msgTs - lastAssistantTs) / 1000;
					if (gapSec > 2 && gapSec < 3600) userResponseTimes.push(gapSec);
				}
			}
		}

		// ── tool result ──
		if (msg.role === "toolResult") {
			const isError = (msg.isError as boolean) === true;
			if (isError) {
				toolErrors++;
				const resultText = extractTextFromContent(msg.content).toLowerCase();
				let cat = "Other";
				if (resultText.includes("exit code")) cat = "Command Failed";
				else if (
					resultText.includes("rejected") ||
					resultText.includes("doesn't want")
				)
					cat = "User Rejected";
				else if (
					resultText.includes("string to replace not found") ||
					resultText.includes("no changes")
				)
					cat = "Edit Failed";
				else if (resultText.includes("modified since read"))
					cat = "File Changed";
				else if (
					resultText.includes("exceeds maximum") ||
					resultText.includes("too large")
				)
					cat = "File Too Large";
				else if (
					resultText.includes("file not found") ||
					resultText.includes("does not exist")
				)
					cat = "File Not Found";
				toolErrorCategories[cat] = (toolErrorCategories[cat] ?? 0) + 1;
			}
		}
	}

	return {
		toolCounts,
		languages,
		toolErrorCategories,
		filesModified: filesModified.size,
		userResponseTimes,
		messageHours,
		userMessageTimestamps,
		gitCommits,
		gitPushes,
		inputTokens,
		outputTokens,
		totalCost,
		userInterruptions,
		toolErrors,
		usesSubagent,
		usesMcp,
		linesAdded,
		linesRemoved,
		userMessageCount,
		assistantMessageCount,
		firstPrompt,
		modelUsage,
	};
}

function buildSessionMeta(
	info: {
		id: string;
		path: string;
		cwd: string;
		created: Date;
		modified: Date;
	},
	entries: AnyEntry[],
): SessionMeta {
	const stats = extractSessionStats(entries, info.path);
	return {
		session_id: info.id,
		session_path: info.path,
		project_path: info.cwd,
		start_time: info.created.toISOString(),
		duration_minutes: Math.round(
			(info.modified.getTime() - info.created.getTime()) / 1000 / 60,
		),
		user_message_count: stats.userMessageCount,
		assistant_message_count: stats.assistantMessageCount,
		tool_counts: stats.toolCounts,
		languages: stats.languages,
		git_commits: stats.gitCommits,
		git_pushes: stats.gitPushes,
		input_tokens: stats.inputTokens,
		output_tokens: stats.outputTokens,
		total_cost: stats.totalCost,
		first_prompt: stats.firstPrompt,
		user_interruptions: stats.userInterruptions,
		user_response_times: stats.userResponseTimes,
		tool_errors: stats.toolErrors,
		tool_error_categories: stats.toolErrorCategories,
		uses_subagent: stats.usesSubagent,
		uses_mcp: stats.usesMcp,
		lines_added: stats.linesAdded,
		lines_removed: stats.linesRemoved,
		files_modified: stats.filesModified,
		message_hours: stats.messageHours,
		user_message_timestamps: stats.userMessageTimestamps,
		model_usage: stats.modelUsage,
	};
}

function formatTranscript(entries: AnyEntry[], meta: SessionMeta): string {
	const lines: string[] = [
		`Session: ${meta.session_id.slice(0, 8)}`,
		`Date: ${meta.start_time}`,
		`Project: ${meta.project_path}`,
		`Duration: ${meta.duration_minutes} min`,
		"",
	];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;

		if (msg.role === "user" && isHumanMessage(msg)) {
			const text = extractTextFromContent(msg.content).slice(0, 500);
			if (text.trim()) lines.push(`[User]: ${text}`);
		} else if (msg.role === "assistant") {
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content as ContentBlock[]) {
					if (block.type === "text" && block.text) {
						lines.push(`[Assistant]: ${(block.text as string).slice(0, 300)}`);
					} else if (block.type === "toolCall" && block.name) {
						lines.push(`[Tool: ${block.name as string}]`);
					}
				}
			}
		}
	}

	return lines.join("\n");
}

// ─── Parallel Session Detection ───────────────────────────────────────────────

function detectMultiClauding(
	sessions: Array<{ session_id: string; user_message_timestamps: string[] }>,
) {
	const all: Array<{ ts: number; sid: string }> = [];
	for (const s of sessions) {
		for (const iso of s.user_message_timestamps) {
			const ts = new Date(iso).getTime();
			if (!isNaN(ts)) all.push({ ts, sid: s.session_id });
		}
	}
	all.sort((a, b) => a.ts - b.ts);

	const pairs = new Set<string>();
	const duringMsgs = new Set<string>();
	let windowStart = 0;
	const sessionLastIdx = new Map<string, number>();

	for (let i = 0; i < all.length; i++) {
		const msg = all[i]!;
		while (
			windowStart < i &&
			msg.ts - all[windowStart]!.ts > OVERLAP_WINDOW_MS
		) {
			const exp = all[windowStart]!;
			if (sessionLastIdx.get(exp.sid) === windowStart)
				sessionLastIdx.delete(exp.sid);
			windowStart++;
		}
		const prevIdx = sessionLastIdx.get(msg.sid);
		if (prevIdx !== undefined) {
			for (let j = prevIdx + 1; j < i; j++) {
				const between = all[j]!;
				if (between.sid !== msg.sid) {
					const pair = [msg.sid, between.sid].sort().join(":");
					pairs.add(pair);
					duringMsgs.add(`${all[prevIdx]!.ts}:${msg.sid}`);
					duringMsgs.add(`${between.ts}:${between.sid}`);
					duringMsgs.add(`${msg.ts}:${msg.sid}`);
					break;
				}
			}
		}
		sessionLastIdx.set(msg.sid, i);
	}

	const involvedSessions = new Set<string>();
	for (const pair of pairs) {
		const [a, b] = pair.split(":");
		if (a) involvedSessions.add(a);
		if (b) involvedSessions.add(b);
	}

	return {
		overlap_events: pairs.size,
		sessions_involved: involvedSessions.size,
		user_messages_during: duringMsgs.size,
	};
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function median(arr: number[]): number {
	if (!arr.length) return 0;
	const s = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mergeRecord(
	target: Record<string, number>,
	source: Record<string, number>,
) {
	for (const [k, v] of Object.entries(source)) {
		target[k] = (target[k] ?? 0) + v;
	}
}

function top8(rec: Record<string, number>): [string, number][] {
	return Object.entries(rec)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8);
}

function aggregateData(
	metas: SessionMeta[],
	facetsMap: Map<string, SessionFacets>,
): AggregatedData {
	const agg: AggregatedData = {
		total_sessions: metas.length,
		sessions_with_facets: 0,
		date_range: { start: "", end: "" },
		total_messages: 0,
		total_duration_hours: 0,
		total_input_tokens: 0,
		total_output_tokens: 0,
		total_cost: 0,
		tool_counts: {},
		languages: {},
		git_commits: 0,
		git_pushes: 0,
		projects: {},
		goal_categories: {},
		outcomes: {},
		satisfaction: {},
		helpfulness: {},
		session_types: {},
		friction: {},
		success: {},
		session_summaries: [],
		friction_details: [],
		user_instructions: [],
		total_interruptions: 0,
		total_tool_errors: 0,
		tool_error_categories: {},
		user_response_times: [],
		median_response_time: 0,
		avg_response_time: 0,
		sessions_using_subagent: 0,
		sessions_using_mcp: 0,
		total_lines_added: 0,
		total_lines_removed: 0,
		total_files_modified: 0,
		days_active: 0,
		message_hours: [],
		multi_clauding: {
			overlap_events: 0,
			sessions_involved: 0,
			user_messages_during: 0,
		},
		model_usage: {},
		model_efficiency: [],
		estimated_waste: 0,
	};

	const dates: string[] = [];
	const activeDays = new Set<string>();

	// Decay weighting: half-life of 10 days for facet-derived charts
	const latestTs = metas.reduce((max, m) => {
		const t = new Date(m.start_time).getTime();
		return t > max ? t : max;
	}, 0);
	const HALF_LIFE_MS = 10 * 86400000;
	const LAMBDA = Math.log(2) / HALF_LIFE_MS;

	function decayWeight(meta: SessionMeta): number {
		const age = latestTs - new Date(meta.start_time).getTime();
		return Math.exp(-LAMBDA * age);
	}

	function mergeWeighted(target: Record<string, number>, source: Record<string, number>, weight: number) {
		for (const [k, v] of Object.entries(source)) {
			target[k] = (target[k] ?? 0) + v * weight;
		}
	}

	for (const meta of metas) {
		agg.total_messages += meta.user_message_count;
		agg.total_duration_hours += meta.duration_minutes / 60;
		agg.total_input_tokens += meta.input_tokens;
		agg.total_output_tokens += meta.output_tokens;
		agg.total_cost += meta.total_cost;
		mergeRecord(agg.tool_counts, meta.tool_counts);
		mergeRecord(agg.languages, meta.languages);
		mergeRecord(agg.tool_error_categories, meta.tool_error_categories);
		agg.git_commits += meta.git_commits;
		agg.git_pushes += meta.git_pushes;
		agg.total_interruptions += meta.user_interruptions;
		agg.total_tool_errors += meta.tool_errors;
		agg.total_lines_added += meta.lines_added;
		agg.total_lines_removed += meta.lines_removed;
		agg.total_files_modified += meta.files_modified;
		agg.user_response_times.push(...meta.user_response_times);
		agg.message_hours.push(...meta.message_hours);
		if (meta.uses_subagent) agg.sessions_using_subagent++;
		if (meta.uses_mcp) agg.sessions_using_mcp++;

		// Aggregate per-model usage
		for (const [model, usage] of Object.entries(meta.model_usage ?? {})) {
			if (!agg.model_usage[model]) agg.model_usage[model] = { input_tokens: 0, output_tokens: 0, cost: 0, message_count: 0, sessions: 0 };
			agg.model_usage[model]!.input_tokens += usage.input_tokens;
			agg.model_usage[model]!.output_tokens += usage.output_tokens;
			agg.model_usage[model]!.cost += usage.cost;
			agg.model_usage[model]!.message_count += usage.message_count;
			agg.model_usage[model]!.sessions++;
		}

		if (meta.start_time) {
			dates.push(meta.start_time);
			activeDays.add(meta.start_time.slice(0, 10));
		}

		if (meta.project_path) {
			const proj = meta.project_path.replace(/.*\//, "") || meta.project_path;
			agg.projects[proj] = (agg.projects[proj] ?? 0) + 1;
		}

		const facets = facetsMap.get(meta.session_id);
		if (facets) {
			agg.sessions_with_facets++;
			const w = decayWeight(meta);
			mergeWeighted(agg.goal_categories, facets.goal_categories, w);
			if (facets.outcome)
				agg.outcomes[facets.outcome] = (agg.outcomes[facets.outcome] ?? 0) + w;
			mergeWeighted(agg.satisfaction, facets.user_satisfaction_counts, w);
			if (facets.assistant_helpfulness)
				agg.helpfulness[facets.assistant_helpfulness] =
					(agg.helpfulness[facets.assistant_helpfulness] ?? 0) + w;
			if (facets.session_type)
				agg.session_types[facets.session_type] =
					(agg.session_types[facets.session_type] ?? 0) + w;
			mergeWeighted(agg.friction, facets.friction_counts, w);
			if (facets.primary_success && facets.primary_success !== "none") {
				agg.success[facets.primary_success] =
					(agg.success[facets.primary_success] ?? 0) + w;
			}
			agg.session_summaries.push({
				id: meta.session_id.slice(0, 8),
				date: meta.start_time.slice(0, 10),
				summary: facets.brief_summary,
				outcome: facets.outcome,
				helpfulness: facets.assistant_helpfulness,
			});
			if (facets.friction_detail?.trim())
				agg.friction_details.push(facets.friction_detail.trim());
			if (facets.user_instructions_to_assistant) {
				agg.user_instructions.push(...facets.user_instructions_to_assistant);
			}
		}
	}

	dates.sort();
	agg.date_range = {
		start: dates[0]?.slice(0, 10) ?? "",
		end: dates[dates.length - 1]?.slice(0, 10) ?? "",
	};
	agg.days_active = activeDays.size;
	agg.median_response_time = median(agg.user_response_times);
	agg.avg_response_time = agg.user_response_times.length
		? agg.user_response_times.reduce((a, b) => a + b, 0) /
			agg.user_response_times.length
		: 0;

	// Trim to caps
	agg.session_summaries = agg.session_summaries.slice(-50);
	agg.friction_details = agg.friction_details.slice(0, 20);
	agg.user_instructions = agg.user_instructions.slice(0, 15);

	agg.multi_clauding = detectMultiClauding(
		metas.map((m) => ({
			session_id: m.session_id,
			user_message_timestamps: m.user_message_timestamps,
		})),
	);

	// Model efficiency analysis
	const MODEL_TIERS: Record<string, "high" | "mid" | "low"> = {};
	const classifyModel = (name: string): "high" | "mid" | "low" => {
		if (MODEL_TIERS[name]) return MODEL_TIERS[name]!;
		const n = name.toLowerCase();
		if (n.includes("opus") || n.includes("o1") || n.includes("o3")) {
			MODEL_TIERS[name] = "high";
		} else if (n.includes("haiku") || n.includes("flash") || n.includes("mini") || n.includes("gpt-4o-mini")) {
			MODEL_TIERS[name] = "low";
		} else {
			MODEL_TIERS[name] = "mid";
		}
		return MODEL_TIERS[name]!;
	};

	const COMPLEX_TYPES = new Set(["multi_task", "iterative_refinement"]);
	const SIMPLE_TYPES = new Set(["quick_question", "single_task"]);

	let estimatedWaste = 0;

	for (const meta of metas) {
		const facets = facetsMap.get(meta.session_id);
		if (!facets) continue;

		// Determine primary model (highest cost or most messages)
		const models = Object.entries(meta.model_usage ?? {});
		if (!models.length) continue;
		const primaryModel = models.sort((a, b) => b[1].cost - a[1].cost)[0]!;
		const [modelName, modelStats] = primaryModel;
		const tier = classifyModel(modelName);

		const isSimple = SIMPLE_TYPES.has(facets.session_type)
			|| (meta.user_message_count <= 3 && meta.duration_minutes < 5);
		const isComplex = COMPLEX_TYPES.has(facets.session_type)
			|| meta.user_message_count > 8
			|| meta.files_modified > 5;
		const poorOutcome = facets.outcome === "not_achieved" || facets.outcome === "partially_achieved";
		const goodOutcome = facets.outcome === "fully_achieved" || facets.outcome === "mostly_achieved";

		let flag: "overspend" | "underspend" | "ok" = "ok";
		let reason = "";

		// Overspend: expensive model on simple task
		if (tier === "high" && isSimple && goodOutcome) {
			flag = "overspend";
			reason = `Used ${modelName} for a simple ${facets.session_type} that completed successfully. A cheaper model would likely suffice.`;
			estimatedWaste += modelStats.cost * 0.8;
		}
		// Underspend: cheap model on complex task with poor outcome
		else if (tier === "low" && isComplex && poorOutcome) {
			flag = "underspend";
			reason = `Used ${modelName} for a complex ${facets.session_type} that ended with ${facets.outcome}. A stronger model may have succeeded.`;
			estimatedWaste += modelStats.cost;
		}
		// Overspend: expensive model on ANY task with poor outcome (wasted tokens)
		else if (tier === "high" && poorOutcome && modelStats.cost > 0.10) {
			flag = "overspend";
			reason = `Spent $${modelStats.cost.toFixed(2)} on ${modelName} but outcome was ${facets.outcome}. Tokens were burned without reaching the goal.`;
			estimatedWaste += modelStats.cost * 0.5;
		}

		if (flag !== "ok") {
			agg.model_efficiency.push({
				model: modelName,
				session_id: meta.session_id,
				date: meta.start_time.slice(0, 10),
				cost: modelStats.cost,
				outcome: facets.outcome,
				session_type: facets.session_type,
				goal: facets.underlying_goal?.slice(0, 80) ?? "",
				flag,
				reason,
			});
		}
	}

	agg.estimated_waste = estimatedWaste;
	agg.model_efficiency.sort((a, b) => b.cost - a.cost);
	agg.model_efficiency = agg.model_efficiency.slice(0, 20);

	return agg;
}

// ─── LLM Calling ─────────────────────────────────────────────────────────────

async function callModel(
	ctx: ExtensionCommandContext,
	prompt: string,
	_maxTokens?: number,
): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("No active model");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
	if (!auth.ok) throw new Error(auth.error);
	const apiKey = auth.apiKey ?? "";
	const headers = auth.headers;

	const response = await complete(
		model as never,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey, headers },
	);

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

function parseJsonFromResponse(text: string): unknown {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		return JSON.parse(match[0]);
	} catch {
		return null;
	}
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const CHUNK_SUMMARIZE_PROMPT = `Summarize this portion of a session transcript. Focus on:
1. What the user asked for
2. What the assistant did (tools used, files modified)
3. Any friction or issues
4. The outcome

Keep it concise - 3-5 sentences. Preserve specific details like file names, error messages, and user feedback.

TRANSCRIPT CHUNK:
`;

const FACET_EXTRACT_PROMPT = `Analyze this session and extract structured facets.

CRITICAL GUIDELINES:

1. goal_categories: Count ONLY what the USER explicitly asked for.
   - DO NOT count autonomous exploration the assistant decided to do
   - ONLY count when user says "can you...", "please...", "I need...", "let's..."

2. user_satisfaction_counts: Base ONLY on explicit user signals.
   - "Yay!", "great!", "perfect!" → happy
   - "thanks", "looks good", "that works" → satisfied
   - "ok, now let's..." (continuing without complaint) → likely_satisfied
   - "that's not right", "try again" → dissatisfied
   - "this is broken", "I give up" → frustrated

3. friction_counts: Be specific about what went wrong.
   - misunderstood_request: assistant interpreted the request incorrectly
   - wrong_approach: right goal, wrong solution method
   - buggy_code: code didn't work correctly
   - user_rejected_action: user said no/stop to a proposed action
   - excessive_changes: over-engineered or changed too much

4. user_instructions_to_assistant: direct instructions the user gave, e.g. "always show diffs before editing". Include only reusable instructions (not one-off requests).

5. If very short or just a warmup, use warmup_minimal for goal_category

SESSION:
`;

function buildSharedDataBlock(agg: AggregatedData, temporal: TemporalData, userCtx: UserContext): string {
	return (
		JSON.stringify(
			{
				sessions: agg.total_sessions,
				analyzed: agg.sessions_with_facets,
				date_range: agg.date_range,
				messages: agg.total_messages,
				hours: Math.round(agg.total_duration_hours),
				commits: agg.git_commits,
				cost_usd: agg.total_cost.toFixed(2),
				top_tools: top8(agg.tool_counts),
				top_goals: top8(agg.goal_categories),
				outcomes: agg.outcomes,
				satisfaction: agg.satisfaction,
				friction: agg.friction,
				success: agg.success,
				languages: agg.languages,
				lines_added: agg.total_lines_added,
				lines_removed: agg.total_lines_removed,
				files_modified: agg.total_files_modified,
				multi_clauding: agg.multi_clauding,
				subagent_sessions: agg.sessions_using_subagent,
				mcp_sessions: agg.sessions_using_mcp,
				model_usage: agg.model_usage,
				model_efficiency_flags: agg.model_efficiency.length,
				estimated_waste_usd: agg.estimated_waste.toFixed(2),
			},
			null,
			2,
		) +
		`

SESSION SUMMARIES:
${agg.session_summaries.map((s) => `- ${s.summary} (${s.outcome}, ${s.helpfulness})`).join("\n")}

FRICTION DETAILS:
${agg.friction_details.map((d) => `- ${d}`).join("\n")}

USER INSTRUCTIONS TO ASSISTANT:
${agg.user_instructions.map((i) => `- ${i}`).join("\n")}` +
		`\n\nTEMPORAL CONTEXT:\n${temporal.diff_headlines.length ? "What changed this week: " + temporal.diff_headlines.join("; ") : "No significant weekly changes."}\nTrajectory: ${temporal.trajectory.note}\n${temporal.major_transition ? "Major transition on " + temporal.major_transition.when + ": " + temporal.major_transition.what + " (" + temporal.major_transition.impact + ")" : ""}\n${temporal.anomalies.length ? "Notable outlier sessions: " + temporal.anomalies.map(a => a.date + " " + a.cost + " - " + a.reason).join("; ") : ""}\nResolved friction (DO NOT suggest fixes): ${temporal.resolved_friction.map(f => displayLabel(f)).join(", ") || "none"}\nOngoing friction (FOCUS here): ${temporal.ongoing_friction.map(f => displayLabel(f.type) + " (" + f.recent_count + " in last 14d)").join(", ") || "none"}\n\nUSER EXISTING SETUP (DO NOT suggest what's already present):\nDefault model: ${userCtx.default_model || "not set"}\nPackages: ${userCtx.installed_packages.join(", ") || "none"}\nSkills: ${userCtx.installed_skills.join(", ") || "none"}\nExtensions: ${userCtx.installed_extensions.join(", ") || "none"}\nExisting AGENTS.md rules: ${userCtx.existing_agents_md_rules.slice(0, 10).join(" | ") || "none"}`
	);
}

const PI_FEATURES_REFERENCE = `## PI FEATURES REFERENCE:
1. Extensions — TypeScript modules in ~/.pi/agent/extensions/ that register custom tools, commands, shortcuts, and react to lifecycle events
   - Good for: automating repetitive actions, gating dangerous operations, custom UI, external integrations

2. Skills — Markdown prompt templates in ~/.pi/agent/skills/ invoked with /skill:name
   - Good for: repeatable workflows like code review, commit message generation, debugging guides

3. Subagents (via pi-subagents extension) — spawn focused agents for parallel/exploratory work
   - Good for: large codebase exploration, parallel tasks, multi-step investigations

4. Lifecycle hooks (via extensions) — react to tool_call, tool_result, before_agent_start events
   - Good for: auto-formatting, type checks, permission gates, auto-commit checkpoints

5. AGENTS.md / SYSTEM.md — project-specific context files loaded automatically
   - Good for: team conventions, architecture notes, coding standards the assistant always follows

6. Settings (settings.json) — default model, packages, custom providers
   - Good for: standardizing across projects, pinning a model, enabling packages`;

function buildSectionPrompts(data: string, temporal: TemporalData, userCtx: UserContext) {
	return {
		project_areas: `Analyze this usage data and identify project areas.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "areas": [
    {
      "name": "area name",
      "session_count": N,
      "description": "2-3 sentences about what was worked on and how Pi was used"
    }
  ]
}

Include 4-5 areas. Skip internal tooling sessions.

DATA:
${data}`,

		interaction_style: `Analyze this usage data and describe the user's interaction style with Pi.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "narrative": "2-3 paragraphs analyzing HOW the user interacts. Use second person 'you'. Describe patterns: do they iterate quickly or write detailed specs upfront? Do they interrupt often or let it run? Include specific examples. Use **bold** for key insights.",
  "key_pattern": "one sentence summary of the most distinctive interaction style"
}

DATA:
${data}`,

		what_works: `Analyze this usage data and identify what's working well for this user with Pi.
Use second person ("you").

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "intro": "1 sentence of context",
  "impressive_workflows": [
    {
      "title": "short title (3-6 words)",
      "description": "2-3 sentences describing the workflow. Use 'you' not 'the user'."
    }
  ]
}

Include 3 impressive workflows.

DATA:
${data}`,

		friction_analysis: `Analyze this usage data and identify friction points for this user.
Use second person ("you").

TEMPORAL CONTEXT:
- Resolved friction (no longer occurring): ${temporal.resolved_friction.map(f => displayLabel(f)).join(", ") || "none detected"}
- Ongoing friction (still happening): ${temporal.ongoing_friction.map(f => displayLabel(f.type) + " (" + f.recent_count + " in last 14 days)").join(", ") || "none detected"}

Focus on ONGOING friction. Mention resolved items briefly as wins.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "intro": "1 sentence summarizing friction trajectory (improving/worsening/stable)",
  "resolved": [
    {
      "category": "friction that stopped",
      "note": "brief note on resolution"
    }
  ],
  "ongoing": [
    {
      "category": "concrete category name",
      "description": "1-2 sentences. Use 'you' not 'the user'.",
      "examples": ["specific example with consequence", "another example"],
      "severity": "high|medium|low"
    }
  ]
}

Max 2 resolved, 3 ongoing.

DATA:
${data}`,

		suggestions: `Analyze this usage data and suggest improvements for working with Pi.

${PI_FEATURES_REFERENCE}

CRITICAL: The user's existing setup is in the data below. DO NOT suggest:
- Rules already in their AGENTS.md
- Skills/extensions/packages they already have installed
- Fixes for "resolved friction" (listed in TEMPORAL CONTEXT)
FOCUS on ongoing friction. Include at least one NEGATIVE suggestion (something to stop/remove).
Tailor copyable prompts to their actual model (${userCtx.default_model || "unknown"}) and projects.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "config_additions": [
    {
      "addition": "a specific rule NOT already in their AGENTS.md",
      "why": "1 sentence referencing actual ongoing friction",
      "where": "AGENTS.md | settings.json | ~/.pi/agent/extensions/ | ~/.pi/agent/skills/"
    }
  ],
  "features_to_try": [
    {
      "feature": "feature name from PI FEATURES REFERENCE",
      "one_liner": "what it does",
      "why_for_you": "why this helps YOUR ongoing friction patterns",
      "example": "actual command or config referencing their real projects"
    }
  ],
  "usage_patterns": [
    {
      "title": "short title",
      "suggestion": "1-2 sentence summary",
      "detail": "3-4 sentences referencing actual projects and patterns",
      "copyable_prompt": "specific prompt using their model, projects, tools"
    }
  ],
  "stop_doing": [
    {
      "what": "something to stop or remove",
      "why": "evidence from sessions",
      "alternative": "what to do instead"
    }
  ]
}

DATA:
${data}`,

		on_the_horizon: `Analyze this usage data and identify future opportunities as models become more capable.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "intro": "1 sentence about the trajectory of AI-assisted development",
  "opportunities": [
    {
      "title": "short title (4-8 words)",
      "whats_possible": "2-3 ambitious sentences about autonomous Pi workflows",
      "how_to_try": "1-2 sentences on how to start experimenting with this",
      "copyable_prompt": "detailed prompt to try right now"
    }
  ]
}

Include 3 opportunities. Think ambitiously — autonomous workflows, parallel subagents, self-correcting pipelines, iterating against test suites.

DATA:
${data}`,

		fun_ending: `Analyze this usage data and find one memorable moment from the sessions.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "headline": "a memorable QUALITATIVE moment from the transcripts — not a statistic. something human, funny, or genuinely surprising.",
  "detail": "brief context about when or where this happened"
}

Find something interesting or amusing. Avoid generic observations.

DATA:
${data}`,

		model_efficiency: `Analyze this model usage data and identify efficiency issues.

Model tiers:
- HIGH cost: Opus, o1, o3 (best quality, most expensive)
- MID cost: Sonnet, GPT-4o, Gemini Pro (good balance)
- LOW cost: Haiku, Flash, Mini (cheap, less capable)

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "summary": "2-3 sentences summarizing model usage efficiency. Use 'you'. Be direct about waste.",
  "overspend_pattern": "1-2 sentences about when expensive models are used unnecessarily, or empty string if none",
  "underspend_pattern": "1-2 sentences about when cheap models fail on complex tasks, or empty string if none",
  "recommendation": "1-2 sentences with a specific model selection strategy for this user",
  "potential_savings_note": "1 sentence about how much could be saved with better model selection"
}

DATA:
${data}`,
	};
}

function buildSynthesisPrompt(
	data: string,
	sections: Record<string, unknown>,
): string {
	return `You're writing an "At a Glance" section for a Pi usage insights report. The goal is to help the user understand their patterns and improve how they work with AI assistance.

Use this 4-part structure:

1. What's working
   What is the user's distinctive style and what impactful things have they done? Keep it high level. Don't be flattering or fluffy. Don't focus on which tools they use.

2. What's hindering you
   Split into two parts:
   (a) assistant-side failures — misunderstandings, wrong approaches, buggy output
   (b) user-side friction — insufficient context, environment issues, setup problems
   Be honest and constructive. Aim for patterns, not one-off incidents.

3. Quick wins to try
   Specific Pi features or workflow changes they could adopt immediately. Avoid generic advice — suggest concrete things.

4. Ambitious workflows
   As models become significantly more capable, what workflows that feel out of reach today will become practical?

Keep each part to 2-3 sentences. Coaching tone, not report tone. Don't cite specific numbers or raw category names.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "whats_working": "...",
  "whats_hindering": "...",
  "quick_wins": "...",
  "ambitious_workflows": "..."
}

DATA:
${data}

## Project Areas
${JSON.stringify((sections.project_areas as { areas?: unknown })?.areas ?? [], null, 2)}

## Impressive Workflows
${JSON.stringify((sections.what_works as { impressive_workflows?: unknown })?.impressive_workflows ?? [], null, 2)}

## Friction Categories
${JSON.stringify((sections.friction_analysis as { categories?: unknown })?.categories ?? [], null, 2)}

## Features to Try
${JSON.stringify((sections.suggestions as { features_to_try?: unknown })?.features_to_try ?? [], null, 2)}

## Usage Patterns
${JSON.stringify((sections.suggestions as { usage_patterns?: unknown })?.usage_patterns ?? [], null, 2)}

## On the Horizon
${JSON.stringify((sections.on_the_horizon as { opportunities?: unknown })?.opportunities ?? [], null, 2)}`;
}

// ─── HTML Generation ──────────────────────────────────────────────────────────

function esc(s: unknown): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function renderMarkdown(text: string): string {
	return text
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\n\n/g, "</p><p>")
		.replace(/\n/g, "<br>")
		.replace(/^- /gm, "• ");
}

function wrapP(text: string): string {
	return `<p>${renderMarkdown(esc(text))}</p>`;
}

function barChart(
	data: Record<string, number>,
	opts: { order?: string[]; limit?: number } = {},
): string {
	let entries: [string, number][];
	if (opts.order) {
		entries = opts.order
			.filter((k) => k in data && data[k]! > 0)
			.map((k) => [k, data[k]!]);
	} else {
		entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
		if (opts.limit) entries = entries.slice(0, opts.limit);
	}
	if (!entries.length) return "<p class='muted'>No data</p>";
	const max = Math.max(...entries.map(([, v]) => v));
	return entries
		.map(([key, val]) => {
			const pct = max > 0 ? (val / max) * 100 : 0;
			return `<div class="bar-row">
  <div class="bar-label">${esc(displayLabel(key))}</div>
  <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
  <div class="bar-count">${Math.round(val)}</div>
</div>`;
		})
		.join("\n");
}

function timeOfDayChart(hours: number[]): string {
	const buckets: Record<string, number> = {};
	for (let h = 0; h < 24; h++) buckets[String(h).padStart(2, "0") + ":00"] = 0;
	for (const h of hours) {
		const key = String(h).padStart(2, "0") + ":00";
		buckets[key] = (buckets[key] ?? 0) + 1;
	}
	const max = Math.max(...Object.values(buckets));
	return Object.entries(buckets)
		.map(([label, val]) => {
			const pct = max > 0 ? (val / max) * 100 : 0;
			return `<div class="bar-row compact">
  <div class="bar-label">${esc(label)}</div>
  <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
  <div class="bar-count">${val || ""}</div>
</div>`;
		})
		.join("\n");
}

function responseTimeChart(times: number[]): string {
	const buckets: Record<string, number> = {
		"2–10s": 0,
		"10–30s": 0,
		"30s–1m": 0,
		"1–2m": 0,
		"2–5m": 0,
		"5–15m": 0,
		">15m": 0,
	};
	for (const t of times) {
		if (t < 10) buckets["2–10s"]!++;
		else if (t < 30) buckets["10–30s"]!++;
		else if (t < 60) buckets["30s–1m"]!++;
		else if (t < 120) buckets["1–2m"]!++;
		else if (t < 300) buckets["2–5m"]!++;
		else if (t < 900) buckets["5–15m"]!++;
		else buckets[">15m"]!++;
	}
	const max = Math.max(...Object.values(buckets));
	return Object.entries(buckets)
		.map(([label, val]) => {
			const pct = max > 0 ? (val / max) * 100 : 0;
			return `<div class="bar-row">
  <div class="bar-label">${esc(label)}</div>
  <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
  <div class="bar-count">${val || ""}</div>
</div>`;
		})
		.join("\n");
}

function statCard(label: string, value: string, sub?: string): string {
	return `<div class="stat-card">
  <div class="stat-value">${esc(value)}</div>
  <div class="stat-label">${esc(label)}</div>
  ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ""}
</div>`;
}

function fmtHours(h: number): string {
	if (h < 1) return `${Math.round(h * 60)}m`;
	return `${h.toFixed(1)}h`;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

function fmtCost(n: number): string {
	if (n < 0.01) return `<$0.01`;
	return `$${n.toFixed(2)}`;
}

function generateMarkdown(
	agg: AggregatedData,
	sections: Record<string, unknown>,
	synthesis: Record<string, string>,
	temporal: TemporalData,
): string {
	const lines: string[] = [];
	lines.push("# Pi Insights");
	lines.push(`> ${agg.date_range.start} to ${agg.date_range.end} | ${agg.total_sessions} sessions | Generated ${new Date().toLocaleDateString()}`);
	lines.push("");

	if (temporal.diff_headlines.length) {
		lines.push("## \u{1F4C8} What Changed This Week");
		for (const h of temporal.diff_headlines) lines.push(`- ${h}`);
		if (temporal.major_transition) lines.push(`- **Major shift (${temporal.major_transition.when}):** ${temporal.major_transition.what}. ${temporal.major_transition.impact}`);
		lines.push("");
	}

	lines.push("## \u26A1 Summary");
	if (synthesis.whats_working) lines.push(`**What's working:** ${synthesis.whats_working}`);
	if (synthesis.whats_hindering) lines.push(`\n**What's hindering you:** ${synthesis.whats_hindering}`);
	if (synthesis.quick_wins) lines.push(`\n**Quick wins:** ${synthesis.quick_wins}`);
	if (synthesis.ambitious_workflows) lines.push(`\n**Ambitious workflows:** ${synthesis.ambitious_workflows}`);
	lines.push("");

	lines.push("## \u{1F4CA} By the Numbers");
	lines.push(`| Metric | Value |`);
	lines.push(`|--------|-------|`);
	lines.push(`| Sessions | ${agg.total_sessions} (${agg.days_active} active days) |`);
	lines.push(`| Messages | ${agg.total_messages} |`);
	lines.push(`| Total Cost | $${agg.total_cost.toFixed(2)} |`);
	lines.push(`| Tokens In | ${fmtTokens(agg.total_input_tokens)} |`);
	lines.push(`| Tokens Out | ${fmtTokens(agg.total_output_tokens)} |`);
	lines.push(`| Lines Added | ${agg.total_lines_added} |`);
	lines.push(`| Git Commits | ${agg.git_commits} |`);
	lines.push(`| Tool Errors | ${agg.total_tool_errors} |`);
	lines.push("");

	const areas = (sections.project_areas as { areas?: Array<{ name: string; session_count: number; description: string }> })?.areas ?? [];
	if (areas.length) {
		lines.push("## \u{1F5C2}\uFE0F Where You Worked");
		for (const a of areas) lines.push(`- **${a.name}** (${a.session_count} sessions): ${a.description}`);
		lines.push("");
	}

	const iStyle = sections.interaction_style as { narrative?: string; key_pattern?: string } | undefined;
	if (iStyle?.narrative) {
		lines.push("## \u{1F3AF} How You Work");
		lines.push(iStyle.narrative);
		if (iStyle.key_pattern) lines.push(`\n> ${iStyle.key_pattern}`);
		lines.push("");
	}

	const whatWorks = sections.what_works as { impressive_workflows?: Array<{ title: string; description: string }> } | undefined;
	if (whatWorks?.impressive_workflows?.length) {
		lines.push("## \u2728 Wins");
		for (const w of whatWorks.impressive_workflows) lines.push(`- **${w.title}**: ${w.description}`);
		lines.push("");
	}

	const frictionSec = sections.friction_analysis as { intro?: string; resolved?: Array<{ category: string; note: string }>; ongoing?: Array<{ category: string; description: string; examples: string[] }>; categories?: Array<{ category: string; description: string; examples: string[] }> } | undefined;
	if (frictionSec) {
		lines.push("## \u26A0\uFE0F Where Things Broke");
		if (frictionSec.intro) lines.push(frictionSec.intro);
		if (frictionSec.resolved?.length) {
			lines.push("\n**Resolved:**");
			for (const r of frictionSec.resolved) lines.push(`- \u2705 ${r.category}: ${r.note}`);
		}
		const ongoing = frictionSec.ongoing ?? frictionSec.categories ?? [];
		if (ongoing.length) {
			lines.push("\n**Ongoing:**");
			for (const o of ongoing) {
				lines.push(`- **${o.category}**: ${o.description}`);
				for (const ex of o.examples ?? []) lines.push(`  - ${ex}`);
			}
		}
		lines.push("");
	}

	const suggSec = sections.suggestions as { config_additions?: Array<{ addition: string; why: string; where: string }>; features_to_try?: Array<{ feature: string; why_for_you: string; example: string }>; usage_patterns?: Array<{ title: string; detail: string; copyable_prompt: string }>; stop_doing?: Array<{ what: string; why: string; alternative: string }> } | undefined;
	if (suggSec) {
		lines.push("## \u{1F4A1} Next Steps");
		if (suggSec.config_additions?.length) {
			lines.push("**Config additions:**");
			for (const c of suggSec.config_additions) lines.push(`- \`${c.where}\`: ${c.addition} (${c.why})`);
		}
		if (suggSec.features_to_try?.length) {
			lines.push("\n**Features to try:**");
			for (const f of suggSec.features_to_try) lines.push(`- **${f.feature}**: ${f.why_for_you}\n  \`\`\`\n  ${f.example}\n  \`\`\``);
		}
		if (suggSec.usage_patterns?.length) {
			lines.push("\n**Usage patterns:**");
			for (const p of suggSec.usage_patterns) lines.push(`- **${p.title}**: ${p.detail}\n  \`\`\`\n  ${p.copyable_prompt}\n  \`\`\``);
		}
		if (suggSec.stop_doing?.length) {
			lines.push("\n**\u{1F6D1} Stop doing:**");
			for (const s of suggSec.stop_doing) lines.push(`- **${s.what}**: ${s.why}. Instead: ${s.alternative}`);
		}
		lines.push("");
	}

	const horizonSec = sections.on_the_horizon as { opportunities?: Array<{ title: string; whats_possible: string; copyable_prompt: string }> } | undefined;
	if (horizonSec?.opportunities?.length) {
		lines.push("## \u{1F680} Future Workflows");
		for (const o of horizonSec.opportunities) lines.push(`- **${o.title}**: ${o.whats_possible}\n  \`\`\`\n  ${o.copyable_prompt}\n  \`\`\``);
		lines.push("");
	}

	lines.push("## \u{1F4B8} Model Spend");
	lines.push(`| Model | Cost | Messages |`);
	lines.push(`|-------|------|----------|`);
	for (const [model, usage] of Object.entries(agg.model_usage).sort((a, b) => b[1].cost - a[1].cost).slice(0, 8)) {
		lines.push(`| ${model.replace(/.*\./, "")} | $${usage.cost.toFixed(2)} | ${usage.message_count} |`);
	}
	if (agg.estimated_waste > 0) lines.push(`\n**Estimated waste from model mismatch:** $${agg.estimated_waste.toFixed(2)}`);
	lines.push("");

	return lines.join("\n");
}

function generateHTML(
	agg: AggregatedData,
	sections: Record<string, unknown>,
	synthesis: Record<string, string>,
	temporal: TemporalData,
): string {
	const areas =
		(
			sections.project_areas as {
				areas?: Array<{
					name: string;
					session_count: number;
					description: string;
				}>;
			}
		)?.areas ?? [];
	const iStyle = sections.interaction_style as
		| { narrative?: string; key_pattern?: string }
		| undefined;
	const whatWorks = sections.what_works as
		| {
				intro?: string;
				impressive_workflows?: Array<{ title: string; description: string }>;
		  }
		| undefined;
	const frictionSec = sections.friction_analysis as
		| {
				intro?: string;
				categories?: Array<{ category: string; description: string; examples: string[] }>;
				resolved?: Array<{ category: string; note: string }>;
				ongoing?: Array<{ category: string; description: string; examples: string[]; severity?: string }>;
		  }
		| undefined;
	const suggSec = sections.suggestions as
		| {
				config_additions?: Array<{ addition: string; why: string; where: string }>;
				features_to_try?: Array<{ feature: string; one_liner: string; why_for_you: string; example: string }>;
				usage_patterns?: Array<{ title: string; suggestion: string; detail: string; copyable_prompt: string }>;
				stop_doing?: Array<{ what: string; why: string; alternative: string }>;
		  }
		| undefined;
	const horizonSec = sections.on_the_horizon as
		| {
				intro?: string;
				opportunities?: Array<{
					title: string;
					whats_possible: string;
					how_to_try: string;
					copyable_prompt: string;
				}>;
		  }
		| undefined;
	const funSec = sections.fun_ending as
		| { headline?: string; detail?: string }
		| undefined;
	const modelEffSec = sections.model_efficiency as
		| { summary?: string; overspend_pattern?: string; underspend_pattern?: string; recommendation?: string; potential_savings_note?: string }
		| undefined;

	const topTools = top8(agg.tool_counts);
	const topGoals = top8(agg.goal_categories);

	const configAdditions = suggSec?.config_additions ?? [];
	const featuresToTry = suggSec?.features_to_try ?? [];
	const usagePatterns = suggSec?.usage_patterns ?? [];

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pi Insights — ${esc(agg.date_range.start)} to ${esc(agg.date_range.end)}</title>
<style>
  :root {
    --bg: #0d0f12; --bg2: #161a1f; --bg3: #1e2329;
    --border: #2a2f38; --border2: #343b47;
    --text: #e4e8ef; --dim: #8892a0; --muted: #4e5866;
    --accent: #4f9cf9; --accent2: #38bdf8;
    --green: #4ade80; --yellow: #fbbf24; --red: #f87171;
    --purple: #c084fc; --teal: #2dd4bf;
    --radius: 10px; --radius-sm: 6px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, 'Segoe UI', sans-serif; font-size: 16px; line-height: 1.7; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { font-weight: 600; }

  .container { max-width: 1040px; margin: 0 auto; padding: 40px 24px 80px; }
  header { text-align: center; padding: 48px 0 40px; border-bottom: 1px solid var(--border); margin-bottom: 40px; }
  header h1 { font-size: 38px; font-weight: 700; color: var(--text); letter-spacing: -0.5px; }
  header .subtitle { color: var(--dim); margin-top: 8px; font-size: 14px; }

  nav { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-bottom: 40px; }
  nav a { background: var(--bg3); border: 1px solid var(--border); padding: 6px 14px; border-radius: 20px; color: var(--dim); font-size: 13px; transition: all 0.15s; }
  nav a:hover { color: var(--text); border-color: var(--border2); text-decoration: none; background: var(--bg2); }

  section { margin-bottom: 48px; }
  h2 { font-size: 24px; font-weight: 700; color: var(--text); margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  h2 .emoji { font-size: 18px; }
  h3 { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 10px; }

  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; }
  .card + .card { margin-top: 12px; }
  .card-grid { display: grid; gap: 12px; }
  .card-grid.cols2 { grid-template-columns: repeat(2, 1fr); }
  .card-grid.cols3 { grid-template-columns: repeat(3, 1fr); }

  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; text-align: center; }
  .stat-value { font-size: 26px; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 12px; color: var(--dim); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }

  .bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; font-size: 14px; }
  .bar-row.compact { margin-bottom: 2px; }
  .bar-label { width: 140px; flex-shrink: 0; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { flex: 1; height: 10px; background: var(--bg3); border-radius: 5px; overflow: hidden; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); border-radius: 5px; transition: width 0.4s ease; }
  .bar-count { width: 40px; text-align: right; color: var(--muted); flex-shrink: 0; }

  .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
  .chart-box { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .chart-box h3 { font-size: 13px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }

  .at-a-glance { background: var(--bg2); border: 1px solid var(--border2); border-radius: var(--radius); overflow: hidden; }
  .at-a-glance-part { padding: 20px 24px; border-bottom: 1px solid var(--border); }
  .at-a-glance-part:last-child { border-bottom: none; }
  .at-a-glance-part h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--accent); margin-bottom: 10px; }
  .at-a-glance-part p { color: var(--text); line-height: 1.7; }

  .area-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .area-card h3 { color: var(--accent2); font-size: 17px; }
  .area-card .count { color: var(--muted); font-size: 12px; margin-left: 8px; }
  .area-card p { color: var(--dim); margin-top: 8px; font-size: 14px; }

  .workflow-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .workflow-card h3 { color: var(--green); font-size: 17px; }
  .workflow-card p { color: var(--dim); margin-top: 8px; font-size: 14px; }

  .friction-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .friction-card h3 { color: var(--yellow); font-size: 17px; }
  .friction-card p { color: var(--dim); margin-top: 8px; font-size: 14px; }
  .friction-card .examples { margin-top: 10px; }
  .friction-card .example { font-size: 13px; color: var(--muted); padding: 4px 0 4px 14px; border-left: 2px solid var(--border2); margin-top: 6px; }

  .sugg-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .sugg-card .tag { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; margin-bottom: 8px; background: var(--bg3); color: var(--dim); border: 1px solid var(--border2); }
  .sugg-card h3 { font-size: 14px; color: var(--text); }
  .sugg-card p { color: var(--dim); font-size: 13px; margin-top: 6px; }
  .sugg-card .why { color: var(--muted); font-size: 12px; margin-top: 6px; font-style: italic; }
  .sugg-card label { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
  .sugg-card input[type=checkbox] { margin-top: 3px; accent-color: var(--accent); width: 15px; height: 15px; flex-shrink: 0; }

  .copy-box { background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: var(--teal); white-space: pre-wrap; word-break: break-all; margin-top: 10px; }
  .copy-btn { display: inline-flex; align-items: center; gap: 6px; background: var(--bg3); border: 1px solid var(--border2); color: var(--dim); font-size: 12px; padding: 5px 12px; border-radius: var(--radius-sm); cursor: pointer; margin-top: 8px; transition: all 0.15s; }
  .copy-btn:hover { color: var(--text); border-color: var(--accent); background: var(--bg2); }
  .copy-all-btn { background: var(--accent); color: #fff; font-weight: 600; border: none; padding: 8px 18px; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; margin-top: 16px; transition: opacity 0.15s; }
  .copy-all-btn:hover { opacity: 0.85; }

  .horizon-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; }
  .horizon-card h3 { color: var(--purple); font-size: 15px; }
  .horizon-card p { color: var(--dim); margin-top: 8px; font-size: 14px; }
  .horizon-card .how { color: var(--muted); font-size: 13px; margin-top: 8px; }

  .fun-box { background: linear-gradient(135deg, #1a1f2e, #1e2329); border: 1px solid var(--border2); border-radius: var(--radius); padding: 28px 32px; text-align: center; }
  .fun-box .headline { font-size: 18px; font-weight: 600; color: var(--text); line-height: 1.5; }
  .fun-box .detail { color: var(--dim); font-size: 14px; margin-top: 10px; }

  .muted { color: var(--muted); font-size: 14px; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
  .badge.green { background: rgba(74,222,128,0.15); color: var(--green); }
  .badge.yellow { background: rgba(251,191,36,0.15); color: var(--yellow); }
  .badge.red { background: rgba(248,113,113,0.15); color: var(--red); }

  @media (max-width: 700px) {
    .card-grid.cols2, .card-grid.cols3 { grid-template-columns: 1fr; }
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
    .charts-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="container">

<header>
  <h1>🔍 Pi Insights</h1>
  <div class="subtitle">
    ${esc(agg.date_range.start)} – ${esc(agg.date_range.end)}
    &nbsp;·&nbsp;
    ${agg.total_sessions} sessions
    &nbsp;·&nbsp;
    Generated ${new Date().toLocaleDateString()}
  </div>
</header>

<nav>
  <a href="#at-a-glance">Summary</a>
  <a href="#stats">Numbers</a>
  <a href="#projects">Where You Worked</a>
  <a href="#style">How You Work</a>
  <a href="#what-works">Wins</a>
  <a href="#friction">Friction</a>
  <a href="#suggestions">Next Steps</a>
  <a href="#horizon">Future</a>
  <a href="#model-efficiency">Model Spend</a>
</nav>

${temporal.diff_headlines.length ? `
<div style="background:linear-gradient(135deg,#1a2332,#1e2a3a);border:1px solid var(--border2);border-radius:var(--radius);padding:24px 28px;margin-bottom:32px">
  <h3 style="color:var(--accent2);font-size:13px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px">\u{1F4C8} What Changed This Week</h3>
  <div style="display:flex;flex-wrap:wrap;gap:10px">
    ${temporal.diff_headlines.map(h => `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 14px;font-size:14px;color:var(--text)">${esc(h)}</div>`).join("\n    ")}
  </div>
  ${temporal.major_transition ? `<div style="margin-top:14px;padding:10px 14px;background:var(--bg);border-radius:var(--radius-sm);border-left:3px solid var(--purple);font-size:13px;color:var(--dim)"><strong style="color:var(--purple)">Major shift (${esc(temporal.major_transition.when)}):</strong> ${esc(temporal.major_transition.what)}. Impact: ${esc(temporal.major_transition.impact)}</div>` : ""}
</div>` : ""}

<!-- ── At a Glance ── -->
<section id="at-a-glance">
  <h2><span class="emoji">⚡</span> Summary</h2>
  <div class="at-a-glance">
    <div class="at-a-glance-part">
      <h3>What's Working</h3>
      ${wrapP(synthesis.whats_working ?? "")}
    </div>
    <div class="at-a-glance-part">
      <h3>What's Hindering You</h3>
      ${wrapP(synthesis.whats_hindering ?? "")}
    </div>
    <div class="at-a-glance-part">
      <h3>Quick Wins to Try</h3>
      ${wrapP(synthesis.quick_wins ?? "")}
    </div>
    <div class="at-a-glance-part">
      <h3>Ambitious Workflows</h3>
      ${wrapP(synthesis.ambitious_workflows ?? "")}
    </div>
  </div>
</section>

<!-- ── Stats ── -->
<section id="stats">
  <h2><span class="emoji">📊</span> By the Numbers</h2>
  <div class="stat-grid">
    ${statCard("Sessions", String(agg.total_sessions), `${agg.days_active} active days`)}
    ${statCard("Messages", String(agg.total_messages), `${(agg.total_messages / Math.max(agg.total_sessions, 1)).toFixed(1)} per session`)}
    ${statCard("Active Time", fmtHours(agg.total_duration_hours), `${(agg.total_duration_hours / Math.max(agg.days_active, 1)).toFixed(1)}h/day`)}
    ${statCard("Tokens In", fmtTokens(agg.total_input_tokens), "")}
    ${statCard("Tokens Out", fmtTokens(agg.total_output_tokens), "")}
    ${statCard("Total Cost", fmtCost(agg.total_cost), "")}
    ${statCard("Lines Added", fmtTokens(agg.total_lines_added), "")}
    ${statCard("Lines Removed", fmtTokens(agg.total_lines_removed), "")}
    ${statCard("Git Commits", String(agg.git_commits), `${agg.git_pushes} pushes`)}
    ${statCard("Files Modified", fmtTokens(agg.total_files_modified), "")}
    ${statCard("Tool Errors", String(agg.total_tool_errors), "")}
    ${statCard("Interruptions", String(agg.total_interruptions), "")}
    ${agg.sessions_using_subagent ? statCard("Subagent Sessions", String(agg.sessions_using_subagent), "") : ""}
    ${agg.sessions_using_mcp ? statCard("MCP Sessions", String(agg.sessions_using_mcp), "") : ""}
    ${agg.multi_clauding.overlap_events ? statCard("Parallel Sessions", String(agg.multi_clauding.overlap_events), "overlap events") : ""}
  </div>

  <div class="charts-grid">
    <div class="chart-box">
      <h3>Goal Categories</h3>
      ${barChart(agg.goal_categories, { limit: 10 })}
    </div>
    <div class="chart-box">
      <h3>Outcomes</h3>
      ${barChart(agg.outcomes, { order: OUTCOME_ORDER })}
    </div>
    <div class="chart-box">
      <h3>Satisfaction</h3>
      ${barChart(agg.satisfaction, { order: SATISFACTION_ORDER })}
    </div>
    <div class="chart-box">
      <h3>Top Tools</h3>
      ${barChart(agg.tool_counts, { limit: 10 })}
    </div>
    <div class="chart-box">
      <h3>Languages</h3>
      ${barChart(agg.languages, { limit: 10 })}
    </div>
    <div class="chart-box">
      <h3>Friction Types</h3>
      ${barChart(agg.friction, { limit: 10 })}
    </div>
    <div class="chart-box">
      <h3>Tool Errors</h3>
      ${barChart(agg.tool_error_categories)}
    </div>
    <div class="chart-box">
      <h3>Response Times</h3>
      ${responseTimeChart(agg.user_response_times)}
    </div>
    <div class="chart-box">
      <h3>Time of Day</h3>
      ${timeOfDayChart(agg.message_hours)}
    </div>
  </div>
</section>

<!-- ── Project Areas ── -->
<section id="projects">
  <h2><span class="emoji">🗂️</span> Where You Worked</h2>
  <div class="card-grid ${areas.length > 2 ? "cols2" : ""}">
    ${areas
			.map(
				(a) => `<div class="area-card">
      <h3>${esc(a.name)}<span class="count">${a.session_count} sessions</span></h3>
      <p>${esc(a.description)}</p>
    </div>`,
			)
			.join("\n")}
  </div>
</section>

<!-- ── Interaction Style ── -->
<section id="style">
  <h2><span class="emoji">🎯</span> How You Work</h2>
  <div class="card">
    ${iStyle?.narrative ? `<div style="line-height:1.8">${renderMarkdown(esc(iStyle.narrative))}</div>` : "<p class='muted'>No data</p>"}
    ${iStyle?.key_pattern ? `<div style="margin-top:16px;padding:14px 16px;background:var(--bg3);border-radius:var(--radius-sm);border:1px solid var(--border2);color:var(--accent2);font-size:14px;font-style:italic">"${esc(iStyle.key_pattern)}"</div>` : ""}
  </div>
</section>

<!-- ── What's Working ── -->
<section id="what-works">
  <h2><span class="emoji">✨</span> Wins</h2>
  ${whatWorks?.intro ? `<p style="color:var(--dim);margin-bottom:16px">${esc(whatWorks.intro)}</p>` : ""}
  <div class="card-grid ${(whatWorks?.impressive_workflows?.length ?? 0) > 1 ? "cols2" : ""}">
    ${(whatWorks?.impressive_workflows ?? [])
			.map(
				(w) => `<div class="workflow-card">
      <h3>${esc(w.title)}</h3>
      <p>${esc(w.description)}</p>
    </div>`,
			)
			.join("\n")}
  </div>
</section>

<!-- ── Friction ── -->
<section id="friction">
  <h2><span class="emoji">⚠️</span> Where Things Broke</h2>
  ${frictionSec?.intro ? `<p style="color:var(--dim);margin-bottom:16px">${esc(frictionSec.intro)}</p>` : ""}
  ${(frictionSec?.resolved?.length) ? `<div style="margin-bottom:20px">
    <h3 style="color:var(--green);font-size:14px;margin-bottom:10px">\u2705 Resolved</h3>
    ${frictionSec.resolved.map(r => `<div style="padding:6px 14px;color:var(--dim);font-size:13px;border-left:2px solid var(--green);margin-bottom:6px"><strong>${esc(r.category)}</strong> \u2014 ${esc(r.note)}</div>`).join("\n")}
  </div>` : ""}
  <div class="card-grid ${((frictionSec?.ongoing ?? frictionSec?.categories)?.length ?? 0) > 1 ? "cols2" : ""}">
    ${((frictionSec?.ongoing ?? frictionSec?.categories) ?? [])
			.map(
				(cat) => `<div class="friction-card">
      <h3>${esc(cat.category)}${(cat as any).severity ? ` <span class="badge ${(cat as any).severity === "high" ? "red" : (cat as any).severity === "medium" ? "yellow" : "green"}">${(cat as any).severity}</span>` : ""}</h3>
      <p>${esc(cat.description)}</p>
      <div class="examples">
        ${(cat.examples ?? []).map((ex) => `<div class="example">${esc(ex)}</div>`).join("")}
      </div>
    </div>`,
			)
			.join("\n")}
  </div>
</section>

<!-- ── Suggestions ── -->
<section id="suggestions">
  <h2><span class="emoji">💡</span> Next Steps</h2>

  ${
		configAdditions.length
			? `<h3 style="margin-bottom:12px">Config Additions</h3>
  <p style="color:var(--muted);font-size:13px;margin-bottom:16px">Select the ones you want, then copy them all at once.</p>
  <div id="config-list">
    ${configAdditions
			.map(
				(
					c,
					i,
				) => `<div class="sugg-card" id="cfg-${i}" style="margin-bottom:10px">
      <label>
        <input type="checkbox" class="cfg-check" checked data-addition="${esc(c.addition)}" data-where="${esc(c.where)}">
        <div>
          <div class="tag">${esc(c.where)}</div>
          <h3>${esc(c.addition)}</h3>
          <p class="why">Why: ${esc(c.why)}</p>
        </div>
      </label>
    </div>`,
			)
			.join("\n")}
  </div>
  <button class="copy-all-btn" onclick="copyAllConfig()">Copy Selected as AGENTS.md Block</button>
  <div id="copy-all-output" style="display:none;margin-top:10px">
    <div class="copy-box" id="copy-all-text"></div>
    <button class="copy-btn" onclick="copyText('copy-all-text')">📋 Copy</button>
  </div>`
			: ""
	}

  ${
		featuresToTry.length
			? `<h3 style="margin:24px 0 12px">Features to Try</h3>
  <div class="card-grid ${featuresToTry.length > 1 ? "cols2" : ""}">
    ${featuresToTry
			.map(
				(f) => `<div class="sugg-card">
      <div class="tag">${esc(f.feature)}</div>
      <h3>${esc(f.one_liner)}</h3>
      <p>${esc(f.why_for_you)}</p>
      <div class="copy-box">${esc(f.example)}</div>
      <button class="copy-btn" onclick="copyFromBox(this)">📋 Copy</button>
    </div>`,
			)
			.join("\n")}
  </div>`
			: ""
	}

  ${
		usagePatterns.length
			? `<h3 style="margin:24px 0 12px">Usage Patterns</h3>
  <div style="display:flex;flex-direction:column;gap:12px">
    ${usagePatterns
			.map(
				(p) => `<div class="sugg-card">
      <h3>${esc(p.title)}</h3>
      <p>${esc(p.suggestion)}</p>
      <p style="margin-top:8px;font-size:13px;color:var(--muted)">${esc(p.detail)}</p>
      <div class="copy-box">${esc(p.copyable_prompt)}</div>
      <button class="copy-btn" onclick="copyFromBox(this)">📋 Copy</button>
    </div>`,
			)
			.join("\n")}
  </div>`
			: ""
	}

  ${(suggSec?.stop_doing?.length) ? `<h3 style="margin:24px 0 12px;color:var(--red)">\u{1F6D1} Consider Stopping</h3>
  <div style="display:flex;flex-direction:column;gap:12px">
    ${suggSec.stop_doing.map(s => `<div class="card" style="border-left:3px solid var(--red)">
      <h3 style="color:var(--red);font-size:14px">${esc(s.what)}</h3>
      <p style="color:var(--dim);margin-top:6px;font-size:13px">${esc(s.why)}</p>
      <p style="color:var(--green);margin-top:6px;font-size:13px"><strong>Instead:</strong> ${esc(s.alternative)}</p>
    </div>`).join("\n")}
  </div>` : ""}
</section>

<!-- ── On the Horizon ── -->
<section id="horizon">
  <h2><span class="emoji">🚀</span> Future Workflows</h2>
  ${horizonSec?.intro ? `<p style="color:var(--dim);margin-bottom:16px">${esc(horizonSec.intro)}</p>` : ""}
  <div style="display:flex;flex-direction:column;gap:12px">
    ${(horizonSec?.opportunities ?? [])
			.map(
				(o) => `<div class="horizon-card">
      <h3>${esc(o.title)}</h3>
      <p>${esc(o.whats_possible)}</p>
      <p class="how">${esc(o.how_to_try)}</p>
      <div class="copy-box">${esc(o.copyable_prompt)}</div>
      <button class="copy-btn" onclick="copyFromBox(this)">📋 Copy</button>
    </div>`,
			)
			.join("\n")}
  </div>
</section>

<!-- ── Model Efficiency ── -->
<section id="model-efficiency">
  <h2><span class="emoji">💸</span> Model Spend</h2>
  ${modelEffSec?.summary ? `<p style="color:var(--dim);margin-bottom:16px">${esc(modelEffSec.summary)}</p>` : ""}

  <div class="stat-grid">
    ${statCard("Estimated Waste", fmtCost(agg.estimated_waste), "from model mismatch")}
    ${statCard("Efficiency Flags", String(agg.model_efficiency.length), `${agg.model_efficiency.filter(e => e.flag === "overspend").length} overspend, ${agg.model_efficiency.filter(e => e.flag === "underspend").length} underspend`)}
    ${statCard("Models Used", String(Object.keys(agg.model_usage).length), "")}
  </div>

  <div class="charts-grid">
    <div class="chart-box">
      <h3>Cost by Model</h3>
      ${barChart(Object.fromEntries(Object.entries(agg.model_usage).map(([k, v]) => [k, Math.round(v.cost * 100)])), { limit: 8 })}
      <p class="muted" style="margin-top:8px;font-size:11px">Values in cents</p>
    </div>
    <div class="chart-box">
      <h3>Messages by Model</h3>
      ${barChart(Object.fromEntries(Object.entries(agg.model_usage).map(([k, v]) => [k, v.message_count])), { limit: 8 })}
    </div>
  </div>

  ${modelEffSec?.overspend_pattern ? `<div class="card" style="margin-top:16px;border-left:3px solid var(--yellow)">
    <h3 style="color:var(--yellow);font-size:14px">Overspend Pattern</h3>
    <p style="color:var(--dim);margin-top:8px">${esc(modelEffSec.overspend_pattern)}</p>
  </div>` : ""}

  ${modelEffSec?.underspend_pattern ? `<div class="card" style="margin-top:12px;border-left:3px solid var(--red)">
    <h3 style="color:var(--red);font-size:14px">Underspend Pattern</h3>
    <p style="color:var(--dim);margin-top:8px">${esc(modelEffSec.underspend_pattern)}</p>
  </div>` : ""}

  ${modelEffSec?.recommendation ? `<div class="card" style="margin-top:12px;border-left:3px solid var(--green)">
    <h3 style="color:var(--green);font-size:14px">Recommendation</h3>
    <p style="color:var(--dim);margin-top:8px">${esc(modelEffSec.recommendation)}</p>
    ${modelEffSec.potential_savings_note ? `<p style="color:var(--muted);margin-top:6px;font-size:12px;font-style:italic">${esc(modelEffSec.potential_savings_note)}</p>` : ""}
  </div>` : ""}

  ${agg.model_efficiency.length ? `<h3 style="margin-top:24px;margin-bottom:12px">Flagged Sessions</h3>
  <div style="display:flex;flex-direction:column;gap:8px">
    ${agg.model_efficiency.slice(0, 10).map(e => `<div class="card" style="padding:14px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span class="badge ${e.flag === "overspend" ? "yellow" : "red"}">${esc(e.flag)}</span>
          <span style="color:var(--dim);font-size:13px;margin-left:8px">${esc(e.date)} · ${esc(e.model)}</span>
        </div>
        <span style="color:var(--accent);font-weight:600;font-size:14px">${fmtCost(e.cost)}</span>
      </div>
      <p style="color:var(--dim);font-size:13px;margin-top:6px">${esc(e.reason)}</p>
      <p style="color:var(--muted);font-size:12px;margin-top:4px">${esc(e.goal)}</p>
    </div>`).join("\n")}
  </div>` : ""}
</section>

<!-- ── Fun Ending ── -->
${
	funSec?.headline
		? `<section>
  <div class="fun-box">
    <div class="headline">${esc(funSec.headline)}</div>
    ${funSec.detail ? `<div class="detail">${esc(funSec.detail)}</div>` : ""}
  </div>
</section>`
		: ""
}

</div>
<script>
function copyText(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = el.nextElementSibling;
    if (btn) { btn.textContent = '✅ Copied'; setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000); }
  });
}
function copyFromBox(btn) {
  const box = btn.previousElementSibling;
  if (!box) return;
  navigator.clipboard.writeText(box.textContent).then(() => {
    btn.textContent = '✅ Copied';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
  });
}
function copyAllConfig() {
  const checks = document.querySelectorAll('.cfg-check:checked');
  const lines = ['# Pi AGENTS.md additions (generated by /insights)', ''];
  for (const ch of checks) {
    const where = ch.dataset.where || '';
    const addition = ch.dataset.addition || '';
    lines.push('# ' + where);
    lines.push(addition);
    lines.push('');
  }
  const text = lines.join('\\n');
  const out = document.getElementById('copy-all-output');
  const textEl = document.getElementById('copy-all-text');
  if (out && textEl) { textEl.textContent = text; out.style.display = 'block'; }
  navigator.clipboard.writeText(text);
}
</script>
</body>
</html>`;
}

// ─── Main Command Handler ─────────────────────────────────────────────────────

async function runInsights(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const refresh = args.includes("--refresh") || args.includes("-r");
	const noOpen = args.includes("--no-open");
	const formatMd = args.includes("--format md") || args.includes("--md");

	// Parse --since flag (e.g. --since 7d, --since 14d, --since 30d)
	const sinceMatch = args.match(/--since\s+(\d+)d/);
	const sinceDays = sinceMatch ? parseInt(sinceMatch[1]!, 10) : 0;

	if (!ctx.model) {
		ctx.ui.notify("No active model — set a model first (/model)", "error");
		return;
	}

	await ensureDirs();

	const currentSessionId = ctx.sessionManager.getSessionId() ?? "";

	// ── Phase 1: Scan ────────────────────────────────────────────────────────────
	ctx.ui.setStatus("insights", "🔍 Scanning sessions...");
	ctx.ui.setWidget("insights", [
		"",
		"  📊 Pi Insights",
		"  ─────────────────────────────────",
		"  Phase 1/5: Scanning session files...",
	]);

	let allInfos = await SessionManager.listAll();

	// Filter current session and meta-sessions by ID
	allInfos = allInfos.filter((info) => info.id !== currentSessionId);

	ctx.ui.setWidget("insights", [
		"",
		"  📊 Pi Insights",
		"  ─────────────────────────────────",
		`  Phase 1/5 done — found ${allInfos.length} sessions`,
		"  Phase 2/5: Extracting session stats...",
	]);

	// ── Phase 2: Session Metadata ────────────────────────────────────────────────
	const metas: SessionMeta[] = [];

	// Load cached metas first (batch)
	const cachedMetaIds = new Set<string>();
	for (let i = 0; i < allInfos.length; i += META_BATCH_SIZE) {
		const batch = allInfos.slice(i, i + META_BATCH_SIZE);
		const results = await Promise.all(
			batch.map((info) => loadCachedMeta(info.id)),
		);
		for (let j = 0; j < batch.length; j++) {
			const cached = results[j];
			if (cached) {
				cachedMetaIds.add(batch[j]!.id);
				metas.push(cached);
			}
		}
	}

	// Parse uncached sessions (up to MAX_SESSIONS_TO_LOAD)
	const uncached = allInfos.filter((info) => !cachedMetaIds.has(info.id));
	const toLoad = uncached.slice(0, MAX_SESSIONS_TO_LOAD);

	let loadedCount = 0;
	for (let i = 0; i < toLoad.length; i += LOAD_BATCH_SIZE) {
		const batch = toLoad.slice(i, i + LOAD_BATCH_SIZE);
		await Promise.all(
			batch.map(async (info) => {
				try {
					const sm = await SessionManager.open(info.path);
					const entries = sm.getEntries() as unknown as AnyEntry[];

					if (isMetaSession(entries)) return;

					const meta = buildSessionMeta(
						{
							id: info.id,
							path: info.path,
							cwd: info.cwd,
							created: info.created,
							modified: info.modified,
						},
						entries,
					);
					await saveMeta(meta);
					metas.push(meta);
				} catch {
					// Skip sessions that fail to load
				}
				loadedCount++;
			}),
		);
		ctx.ui.setWidget("insights", [
			"",
			"  📊 Pi Insights",
			"  ─────────────────────────────────",
			`  Phase 2/5: Loaded ${cachedMetaIds.size} cached, ${loadedCount}/${toLoad.length} new`,
		]);
	}

	// Filter substantive sessions (≥2 user messages, ≥1 min)
	const substantive = metas.filter(
		(m) => m.user_message_count >= 2 && m.duration_minutes >= 1,
	).filter((m) => {
		if (!sinceDays) return true;
		const age = Date.now() - new Date(m.start_time).getTime();
		return age < sinceDays * 86400000;
	});

	ctx.ui.setWidget("insights", [
		"",
		"  📊 Pi Insights",
		"  ─────────────────────────────────",
		`  Phase 2/5 done — ${substantive.length} substantive sessions`,
		"  Phase 3/5: LLM facet extraction...",
	]);

	// ── Phase 3: Facet Extraction ─────────────────────────────────────────────────
	const facetsMap = new Map<string, SessionFacets>();

	// Load cached facets
	for (const meta of substantive) {
		if (refresh) {
			await deleteCachedFacets(meta.session_id);
		} else {
			const cached = await loadCachedFacets(meta.session_id);
			if (cached) facetsMap.set(meta.session_id, cached);
		}
	}

	// Extract new facets
	const needsFacets = substantive
		.filter((m) => !facetsMap.has(m.session_id))
		.slice(0, MAX_FACET_EXTRACTIONS);

	if (needsFacets.length > 0) {
		let facetsDone = 0;
		for (let i = 0; i < needsFacets.length; i += FACET_CONCURRENCY) {
			const batch = needsFacets.slice(i, i + FACET_CONCURRENCY);
			await Promise.all(
				batch.map(async (meta) => {
					try {
						const sm = await SessionManager.open(meta.session_path);
						const entries = sm.getEntries() as unknown as AnyEntry[];
						let transcript = formatTranscript(entries, meta);

						// Summarize long transcripts
						if (transcript.length > 30_000) {
							const CHUNK = 25_000;
							const chunks: string[] = [];
							for (let ci = 0; ci < transcript.length; ci += CHUNK)
								chunks.push(transcript.slice(ci, ci + CHUNK));
							const summaries = await Promise.all(
								chunks.map((ch) =>
									callModel(ctx, CHUNK_SUMMARIZE_PROMPT + ch, 500).catch(() =>
										ch.slice(0, 2000),
									),
								),
							);
							transcript = `Session: ${meta.session_id.slice(0, 8)}\nDate: ${meta.start_time}\nProject: ${meta.project_path}\n[Long session - summarized]\n\n${summaries.join("\n\n---\n\n")}`;
						}

						const prompt = `${FACET_EXTRACT_PROMPT}${transcript}

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "underlying_goal": "...",
  "goal_categories": {"category_name": count},
  "outcome": "fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear_from_transcript",
  "user_satisfaction_counts": {"level": count},
  "assistant_helpfulness": "unhelpful|slightly_helpful|moderately_helpful|very_helpful|essential",
  "session_type": "single_task|multi_task|iterative_refinement|exploration|quick_question",
  "friction_counts": {"friction_type": count},
  "friction_detail": "one sentence or empty string",
  "primary_success": "none|fast_accurate_search|correct_code_edits|good_explanations|proactive_help|multi_file_changes|good_debugging",
  "brief_summary": "one sentence: what user wanted and whether they got it",
  "user_instructions_to_assistant": ["instruction1", "instruction2"]
}`;

						const text = await callModel(ctx, prompt, 4096);
						const parsed = parseJsonFromResponse(text) as SessionFacets | null;
						if (parsed?.brief_summary) {
							const facets: SessionFacets = {
								...parsed,
								session_id: meta.session_id,
							};
							await saveFacets(facets);
							facetsMap.set(meta.session_id, facets);
						}
					} catch {
						// Skip failed extractions
					}
					facetsDone++;
					ctx.ui.setWidget("insights", [
						"",
						"  📊 Pi Insights",
						"  ─────────────────────────────────",
						`  Phase 3/5: Facets ${facetsDone}/${needsFacets.length}...`,
					]);
				}),
			);
		}
	}

	// Post-facet filter: remove sessions where only goal is warmup_minimal
	const kept = substantive.filter((m) => {
		const facets = facetsMap.get(m.session_id);
		if (!facets) return true; // keep if no facets
		const cats = Object.keys(facets.goal_categories).filter(
			(k) => (facets.goal_categories[k] ?? 0) > 0,
		);
		return !(cats.length === 1 && cats[0] === "warmup_minimal");
	});

	ctx.ui.setWidget("insights", [
		"",
		"  📊 Pi Insights",
		"  ─────────────────────────────────",
		`  Phase 3/5 done — ${facetsMap.size} facets extracted`,
		"  Phase 4/5: Generating insights...",
	]);

	// ── Phase 4: Aggregate + Insight Prompts ─────────────────────────────────────
	const agg = aggregateData(kept, facetsMap);
	const temporal = computeTemporalData(kept, facetsMap);
	const userCtx = await gatherUserContext();
	const dataBlock = buildSharedDataBlock(agg, temporal, userCtx);
	const sectionPrompts = buildSectionPrompts(dataBlock, temporal, userCtx);

	const sectionKeys = Object.keys(sectionPrompts) as Array<
		keyof typeof sectionPrompts
	>;
	const sectionResults: Record<string, unknown> = {};
	let sectionsDone = 0;

	await Promise.all(
		sectionKeys.map(async (key) => {
			try {
				const text = await callModel(ctx, sectionPrompts[key], 8192);
				const parsed = parseJsonFromResponse(text);
				if (parsed) sectionResults[key] = parsed;
			} catch {
				// Section failed — continue without it
			}
			sectionsDone++;
			ctx.ui.setWidget("insights", [
				"",
				"  📊 Pi Insights",
				"  ─────────────────────────────────",
				`  Phase 4/5: Insights ${sectionsDone}/${sectionKeys.length}...`,
			]);
		}),
	);

	// Synthesis (At a Glance)
	ctx.ui.setWidget("insights", [
		"",
		"  📊 Pi Insights",
		"  ─────────────────────────────────",
		"  Phase 4/5: Synthesis...",
	]);

	let synthesis: Record<string, string> = {};
	try {
		const synthText = await callModel(
			ctx,
			buildSynthesisPrompt(dataBlock, sectionResults),
			8192,
		);
		synthesis =
			(parseJsonFromResponse(synthText) as Record<string, string>) ?? {};
	} catch {
		synthesis = {
			whats_working:
				"Analysis complete — see sections below for detailed breakdown.",
			whats_hindering: "See Friction Analysis section.",
			quick_wins: "See Suggestions section.",
			ambitious_workflows: "See On the Horizon section.",
		};
	}

	// ── Phase 5: Render HTML ──────────────────────────────────────────────────────
	ctx.ui.setWidget("insights", [
		"",
		"  📊 Pi Insights",
		"  ─────────────────────────────────",
		"  Phase 5/5: Rendering report...",
	]);

	const html = generateHTML(agg, sectionResults, synthesis, temporal);
	await writeFile(REPORT_PATH, html, { encoding: "utf-8" });

	if (formatMd) {
		const md = generateMarkdown(agg, sectionResults, synthesis, temporal);
		await writeFile(REPORT_MD_PATH, md, { encoding: "utf-8" });
		ctx.ui.setStatus("insights", "");
		ctx.ui.setWidget("insights", undefined);
		ctx.ui.notify(`✅ Markdown report saved: ${REPORT_MD_PATH}`, "info");
		return;
	}

	ctx.ui.setStatus("insights", "");
	ctx.ui.setWidget("insights", undefined);

	const reportUrl = await startReportServer();
	ctx.ui.notify(`✅ Report saved: ${REPORT_PATH}`, "info");
	ctx.ui.notify(`Pi Insights report URL: ${reportUrl}`, "info");

	if (!noOpen) {
		const opener = platform() === "darwin" ? "open" : "xdg-open";
		execFile(opener, [reportUrl]).catch(() => {
			ctx.ui.notify(`Open manually: ${reportUrl}`, "info");
		});
	}
}

// ─── Extension Entry ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("insights", {
		description:
			"Generate a personal usage insights report from your Pi session history",
		handler: async (args, ctx) => {
			try {
				await runInsights(args ?? "", ctx);
			} catch (err) {
				ctx.ui.setStatus("insights", "");
				ctx.ui.setWidget("insights", undefined);
				ctx.ui.notify(`Insights failed: ${(err as Error).message}`, "error");
			}
		},
	});
}
