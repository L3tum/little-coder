import { discoverSessions } from "./session-history.ts";

export interface CostSummary {
  sessions: number;
  messages: number;
  totalCost: number;
  providers: Record<string, { messages: number; cost: number }>;
  models: Record<string, { messages: number; cost: number }>;
  tools: Record<string, { calls: number }>;
  projects: Record<string, { sessions: number; cost: number }>;
  daily: Array<{ date: string; cost: number; messages: number }>;
  topSessions: Array<{ id: string; cost: number; project?: string; transcript?: string }>;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function costFromTurn(turn: any): number {
  return numeric(turn.cost) || numeric(turn.usage?.cost) || numeric(turn.message?.cost) || 0;
}

export function summarizeCosts(): CostSummary {
  const providers: CostSummary["providers"] = {};
  const models: CostSummary["models"] = {};
  const tools: CostSummary["tools"] = {};
  const projects: CostSummary["projects"] = {};
  const dailyMap: Record<string, { cost: number; messages: number }> = {};
  const topSessions: CostSummary["topSessions"] = [];
  let messages = 0;
  let totalCost = 0;

  for (const session of discoverSessions()) {
    let sessionCost = 0;
    const project = session.project || "unknown";
    projects[project] ??= { sessions: 0, cost: 0 };
    projects[project].sessions += 1;
    for (const turn of session.turns as any[]) {
      if (turn.toolName) {
        tools[turn.toolName] ??= { calls: 0 };
        tools[turn.toolName].calls += 1;
      }
      if (turn.role === "tool_result") continue;
      messages += 1;
      const cost = costFromTurn(turn);
      sessionCost += cost;
      totalCost += cost;
      const day = String(turn.timestamp || session.date || "unknown").slice(0, 10);
      dailyMap[day] ??= { cost: 0, messages: 0 };
      dailyMap[day].cost += cost;
      dailyMap[day].messages += 1;
      const provider = turn.provider || turn.modelProvider || "unknown";
      const model = turn.model || turn.modelName || "unknown";
      providers[provider] ??= { messages: 0, cost: 0 };
      providers[provider].messages += 1;
      providers[provider].cost += cost;
      models[model] ??= { messages: 0, cost: 0 };
      models[model].messages += 1;
      models[model].cost += cost;
    }
    projects[project].cost += sessionCost;
    topSessions.push({ id: session.id, cost: sessionCost, project: session.project, transcript: session.path });
  }

  topSessions.sort((a, b) => b.cost - a.cost);
  const daily = Object.entries(dailyMap).map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date));
  return { sessions: topSessions.length, messages, totalCost, providers, models, tools, projects, daily, topSessions: topSessions.slice(0, 10) };
}
