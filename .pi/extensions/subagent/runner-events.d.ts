import type { SingleResult } from "./types.js";
export function processPiEvent(event: unknown, result: SingleResult): boolean;
export function processPiJsonLine(line: string, result: SingleResult): boolean;
export function getFinalAssistantText(messages: unknown[]): string;
export function getResultSummaryText(result: SingleResult): string;
