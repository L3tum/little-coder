import { describe, it, expect } from "vitest";
import setupClear from "./index.ts";

describe("/clear command", () => {
  function register() {
    let reg: { name: string; opts: any } | undefined;
    const pi = {
      registerCommand(name: string, opts: any) {
        reg = { name, opts };
      },
    };
    setupClear(pi as any);
    if (!reg) throw new Error("no command registered");
    return reg;
  }

  it("registers a command named 'clear' with a description", () => {
    const reg = register();
    expect(reg.name).toBe("clear");
    expect(typeof reg.opts.description).toBe("string");
    expect(reg.opts.description.length).toBeGreaterThan(0);
    expect(typeof reg.opts.handler).toBe("function");
  });

  it("starts a new session when invoked", async () => {
    const reg = register();
    let calls = 0;
    const ctx = {
      newSession: async () => {
        calls++;
        return { cancelled: false };
      },
    };
    await reg.opts.handler("", ctx);
    expect(calls).toBe(1);
  });
});
