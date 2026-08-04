/**
 * Shared contract for systemPromptOptions.littleCoder.
 * Written by benchmark-profiles, read by turn-cap, tool-gating, finalize-warn, etc.
 *
 * Convention: this file has no index.ts sibling to skip auto-discovery.
 */
export interface LittleCoderOptions {
  contextLimit?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  skillTokenBudget?: number;
  knowledgeTokenBudget?: number;
  systemPromptBudget?: number;
  maxRetries?: number;
  temperature?: number;
  maxTurns?: number;
  preferTextTools?: boolean;
  allowedTools?: string[];
  requiredTools?: string[];
  benchmark?: string;
  isSubtask?: boolean;
}

export function getLittleCoderOptions(
  systemPromptOptions?: Record<string, unknown>,
): LittleCoderOptions {
  return (systemPromptOptions?.littleCoder ?? {}) as LittleCoderOptions;
}
