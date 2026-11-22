/**
 * `{{variable}}` substitution for the prompt templates the agent tasks build.
 * Intentionally not a general templating engine — no conditionals, no
 * escaping rules — because these are single-shot LLM prompts an operator
 * edits as plain text, not a rendering pipeline.
 */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match,
  );
}
