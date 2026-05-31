import { afterEach, describe, expect, it } from "vitest";
import web from "./index.ts";

async function command(action: string, tools: any[] = []): Promise<string[]> {
  const commands = new Map<string, any>();
  const messages: string[] = [];
  const pi: any = {
    getAllTools: () => tools,
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
  };
  web(pi);
  await commands.get("web").handler(action, { ui: { notify: (msg: string) => messages.push(msg) } });
  return messages;
}

function urlFrom(messages: string[]): string {
  const m = messages.join("\n").match(/http:\/\/127\.0\.0\.1:\d+/);
  if (!m) throw new Error(`no url in ${messages.join("\n")}`);
  return m[0];
}

describe("web api", () => {
  afterEach(async () => { await command("stop"); });

  it("serves status, tools, skills, and costs endpoints", async () => {
    const messages = await command("start", [{ name: "read", description: "Read files" }]);
    const base = urlFrom(messages);
    const status = await fetch(`${base}/api/status`).then((r) => r.json());
    const tools = await fetch(`${base}/api/tools`).then((r) => r.json());
    const skills = await fetch(`${base}/api/skills`).then((r) => r.json());
    const costs = await fetch(`${base}/api/costs`).then((r) => r.json());
    const reflection = await fetch(`${base}/api/reflection`).then((r) => r.json());
    const breadcrumbs = await fetch(`${base}/api/breadcrumbs?q=test&mode=semantic`).then((r) => r.json());
    expect(status.running).toBe(true);
    expect(status.chat).toBe("placeholder");
    expect(tools[0].name).toBe("read");
    expect(skills.some((s: any) => s.name === "bash-guidance" && s.description)).toBe(true);
    expect(costs.sessions).toBeGreaterThanOrEqual(0);
    expect(costs.daily).toBeDefined();
    expect(costs.tools).toBeDefined();
    expect(reflection.queue).toBeDefined();
    expect(breadcrumbs.mode).toMatch(/fallback|lexical/);
  });
});
