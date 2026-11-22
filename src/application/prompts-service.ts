import type { PromptTemplateRepository } from "./ports.ts";

/** `null` reverts that prompt id to its hardcoded default; absent leaves it untouched. */
export type PromptsPatch = Record<string, string | null>;

export class PromptsApplicationService {
  constructor(
    private readonly repository: PromptTemplateRepository,
    private readonly refresh: () => void,
  ) {}

  update(patch: PromptsPatch): void {
    for (const [id, template] of Object.entries(patch)) {
      this.repository.setTemplate(id, template);
    }
    this.refresh();
  }
}
