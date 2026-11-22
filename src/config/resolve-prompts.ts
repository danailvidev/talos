import { PROMPT_TEMPLATES } from "../tasks/prompt-registry.ts";

/** Effective prompt templates: DB overrides layered over the hardcoded defaults. */
export type ResolvedPromptTemplates = Record<string, string>;

export function resolvePromptTemplates(overrides: Record<string, string>): ResolvedPromptTemplates {
  const resolved: ResolvedPromptTemplates = {};
  for (const def of PROMPT_TEMPLATES) {
    resolved[def.id] = overrides[def.id] ?? def.defaultTemplate;
  }
  return resolved;
}
