import type { GeneralConfigRepository } from "./ports.ts";
import type { LogLevel } from "../logging/logger.ts";

export interface SettingsPatch {
  logLevel?: LogLevel | null;
  timezone?: string | null;
  llm?: {
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    maxTokens?: number | null;
  };
}

export class SettingsApplicationService {
  constructor(
    private readonly repository: GeneralConfigRepository,
    private readonly refresh: () => void,
  ) {}

  update(patch: SettingsPatch): void {
    this.repository.setConfig({
      ...(patch.logLevel !== undefined
        ? { logLevel: patch.logLevel }
        : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.llm?.provider !== undefined
        ? { llmProvider: patch.llm.provider }
        : {}),
      ...(patch.llm?.model !== undefined ? { llmModel: patch.llm.model } : {}),
      ...(patch.llm?.effort !== undefined ? { llmEffort: patch.llm.effort } : {}),
      ...(patch.llm?.maxTokens !== undefined
        ? { llmMaxTokens: patch.llm.maxTokens }
        : {}),
    });
    this.refresh();
  }
}
