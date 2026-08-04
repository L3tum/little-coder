import { vi } from "vitest";

export type EventHandler = (...args: unknown[]) => unknown;

export interface MockHandlers {
  [event: string]: EventHandler[];
}

export interface MockPi {
  on: (event: string, handler: EventHandler) => void;
  sendUserMessage?: ReturnType<typeof vi.fn>;
  registerShortcut?: ReturnType<typeof vi.fn>;
  unregisterShortcut?: ReturnType<typeof vi.fn>;
}

export function createMockPi(): {
  pi: MockPi;
  handlers: MockHandlers;
} {
  const handlers: MockHandlers = {};
  const pi: MockPi = {
    on: (event: string, handler: EventHandler) => {
      (handlers[event] ??= []).push(handler);
    },
    sendUserMessage: vi.fn(),
    registerShortcut: vi.fn(),
    unregisterShortcut: vi.fn(),
  };
  return { pi, handlers };
}
