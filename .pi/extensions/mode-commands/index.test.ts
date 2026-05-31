import { describe, expect, it } from "vitest";
import modeCommands from "./index.ts";

describe("mode-commands command registration", () => {
  it("does not register prompt-only /plan", () => {
    const commands: string[] = [];
    const pi: any = { registerCommand: (name: string) => commands.push(name) };
    modeCommands(pi);
    expect(commands).not.toContain("plan");
    expect(commands).toContain("plan-prompt");
    expect(commands).toContain("execute");
    expect(commands).toContain("review");
  });
});
