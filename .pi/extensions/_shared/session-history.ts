import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export interface SessionTurn { role: string; text: string; toolName?: string; timestamp?: string; cost?: number; provider?: string; model?: string }
export interface SessionOutline { id: string; path: string; project?: string; cwd?: string; date?: string; turns: SessionTurn[] }

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isDirectory()) walkJsonl(path, out);
      else if (name.endsWith(".jsonl")) out.push(path);
    } catch {}
  }
  return out;
}

function eventText(obj: any): string {
  const c = obj?.content ?? obj?.message?.content ?? obj?.text ?? obj?.prompt ?? "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => typeof x === "string" ? x : x?.text ?? "").join("\n");
  return "";
}

export function parseSessionFile(path: string): SessionOutline | undefined {
  try {
    const turns: SessionTurn[] = [];
    let cwd: string | undefined;
    let project: string | undefined;
    let date: string | undefined;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      cwd ||= obj.cwd || obj.projectCwd || obj.session?.cwd;
      project ||= obj.project || obj.projectName || (cwd ? cwd.split(/[\\/]/).pop() : undefined);
      date ||= obj.timestamp || obj.time || obj.createdAt;
      const role = obj.role || obj.message?.role || obj.type;
      const toolName = obj.toolName || obj.name || obj.tool?.name;
      const text = eventText(obj).replace(/\s+/g, " ").trim();
      if (role || toolName || text) turns.push({
        role: role || (toolName ? "tool" : "event"),
        toolName,
        text,
        timestamp: obj.timestamp || obj.time,
        cost: obj.cost ?? obj.usage?.cost ?? obj.message?.cost,
        provider: obj.provider ?? obj.modelProvider ?? obj.message?.provider,
        model: obj.model ?? obj.modelName ?? obj.message?.model,
      });
    }
    return { id: relative(agentDir(), path).replace(/\.jsonl$/, ""), path, cwd, project, date, turns };
  } catch { return undefined; }
}

export function discoverSessions(base = agentDir()): SessionOutline[] {
  const dir = join(base, "sessions");
  return walkJsonl(dir).map(parseSessionFile).filter((x): x is SessionOutline => !!x)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

export function outlineText(session: SessionOutline, maxTurns = 8): string {
  return session.turns.filter((t) => t.text && t.role !== "tool_result").slice(-maxTurns)
    .map((t) => `${t.role}${t.toolName ? `:${t.toolName}` : ""}: ${t.text.slice(0, 300)}`).join("\n");
}

function termFrequency(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let i = text.indexOf(term);
  while (i !== -1) {
    count += 1;
    i = text.indexOf(term, i + term.length);
  }
  return count;
}

export function lexicalSessionScore(query: string, session: SessionOutline, cwd = process.cwd()): number {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  if (terms.length === 0) return session.cwd === cwd ? 3 : 1;
  let score = session.cwd === cwd ? 3 : 0;
  const project = (session.project ?? "").toLowerCase();
  const sessionCwd = (session.cwd ?? "").toLowerCase();
  for (const term of terms) {
    if (project.includes(term)) score += 3;
    if (sessionCwd.includes(term)) score += term.includes("/") ? 4 : 2;
    for (const turn of session.turns) {
      const text = turn.text.toLowerCase();
      const hits = Math.min(termFrequency(text, term), 5);
      if (hits === 0) continue;
      const roleBoost = turn.role === "user" ? 3 : turn.role === "tool" ? 1.5 : 1;
      const pathBoost = /(?:^|[\s"'`])(?:\.?\.?\/)?[\w.-]+(?:\/[\w.-]+)+/.test(turn.text) ? 1.5 : 1;
      const toolBoost = turn.toolName?.toLowerCase().includes(term) ? 2 : 1;
      score += hits * roleBoost * pathBoost * toolBoost;
    }
  }
  return score;
}

export function searchSessions(query: string, sessions = discoverSessions(), cwd = process.cwd(), limit = 5): Array<SessionOutline & { score: number; snippet: string; mode: string }> {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  return sessions.map((s) => {
    const score = lexicalSessionScore(query, s, cwd);
    const snippet = outlineText(s, 4).slice(0, 300);
    return { ...s, score, snippet, mode: "lexical" };
  }).filter((s) => s.score > 0 || terms.length === 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function searchSessionsWithMode(query: string, mode = "lexical", sessions = discoverSessions(), cwd = process.cwd(), limit = 5): Promise<{ rows: Array<SessionOutline & { score: number; snippet: string; mode: string }>; mode: string; note?: string }> {
  if (mode !== "semantic") return { rows: searchSessions(query, sessions, cwd, limit), mode: "lexical" };
  try {
    await import("@tobilu/qmd" as any);
    return { rows: searchSessions(query, sessions, cwd, limit).map((r) => ({ ...r, mode: "semantic-fallback" })), mode: "lexical-fallback", note: "QMD is installed, but session semantic indexing is not built yet; using lexical fallback." };
  } catch {
    return { rows: searchSessions(query, sessions, cwd, limit), mode: "lexical-fallback", note: "Semantic session search is unavailable because @tobilu/qmd could not initialize; using lexical fallback." };
  }
}
