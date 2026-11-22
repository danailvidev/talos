import type { LlmEffort, LlmModel } from "./api.ts";

export const LLM_DEFAULT = "__default__";

export const MODEL_LABELS: Record<LlmModel, string> = {
  haiku: "Haiku — fast",
  sonnet: "Sonnet — balanced",
  opus: "Opus — highest",
  fable: "Fable — most capable",
  "us.anthropic.claude-sonnet-5": "Sonnet 5 (Bedrock ID)",
  "us.anthropic.claude-opus-5": "Opus 5 (Bedrock ID)",
};

export const EFFORT_LABELS: Record<LlmEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function toLlmSelectValue(value: string | null): string {
  return value && value.length > 0 ? value : LLM_DEFAULT;
}

export function fromLlmSelectValue(value: string): string | null {
  return value === LLM_DEFAULT ? null : value;
}
