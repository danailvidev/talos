import type { GeneralConfigOverrides } from "../application/ports.ts";
import type { LoadedConfig } from "./load.ts";
import type { LogLevel } from "../logging/logger.ts";

export interface ResolvedLlmDefaults {
  provider: string;
  model?: string;
  effort?: string;
  maxTokens: number;
}

/** The effective general settings: DB overrides layered over the YAML defaults. */
export interface GeneralSettings {
  logLevel: LogLevel;
  timezone?: string;
  llm: ResolvedLlmDefaults;
}

export function resolveGeneralSettings(
  loaded: LoadedConfig,
  overrides: GeneralConfigOverrides,
): GeneralSettings {
  return {
    logLevel: overrides.logLevel ?? loaded.config.logLevel,
    timezone: overrides.timezone ?? loaded.config.timezone,
    llm: {
      provider: overrides.llmProvider ?? loaded.config.llm.provider,
      model: overrides.llmModel ?? loaded.config.llm.model,
      effort: overrides.llmEffort ?? loaded.config.llm.effort,
      maxTokens: overrides.llmMaxTokens ?? loaded.config.llm.maxTokens,
    },
  };
}
