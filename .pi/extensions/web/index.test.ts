import { describe, expect, it } from "vitest";
import web from "./index.ts";

describe("web extension", () => {
  it("registers /web command", () => {
    const commands: string[] = [];
    const pi: any = { registerCommand: (name: string) => commands.push(name) };
    web(pi);
    expect(commands).toContain("web");
  });

  it("reports stopped status before start", async () => {
    const commands = new Map<string, any>();
    const messages: string[] = [];
    const pi: any = { registerCommand: (name: string, spec: any) => commands.set(name, spec) };
    web(pi);
    await commands.get("web").handler("status", { ui: { notify: (msg: string) => messages.push(msg) } });
    expect(messages[messages.length - 1]).toBe("web is stopped");
  });
});
