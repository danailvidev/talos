import {
  agentLlmCapabilities,
  LLM_EFFORTS,
  LLM_MODELS,
  type AgentProvider,
  type AgentRunPreferencesView,
  type LlmEffort,
  type LlmModel,
} from "../../shared/api-contract.ts";
import type { Actor } from "../core/actor.ts";
import { ConfigError } from "../core/errors.ts";
import type { LlmDefaultsScope, TaskContext } from "../core/task.ts";
import type { PreferenceRepository } from "./ports.ts";

export const AGENT_RUN_PREFERENCES_KEY = "agent.runDefaults";

const EMPTY_PREFERENCES: AgentRunPreferencesView = {
  model: null,
  effort: null,
};

export class AgentRunPreferences {
  constructor(
    private readonly repository: PreferenceRepository,
    private readonly runtimeAgent: (
      userId: string,
    ) => { provider: AgentProvider; optionId: string } | undefined = () => undefined,
  ) {}

  get(userId: string): AgentRunPreferencesView {
    const raw = this.repository.all(userId)[AGENT_RUN_PREFERENCES_KEY];
    if (!raw) return EMPTY_PREFERENCES;

    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      const capabilities = this.capabilities(userId);
      return {
        model:
          isModel(value.model) && capabilities.models.includes(value.model)
            ? value.model
            : null,
        effort:
          isEffort(value.effort) && capabilities.efforts.includes(value.effort)
            ? value.effort
            : null,
      };
    } catch {
      return EMPTY_PREFERENCES;
    }
  }

  set(userId: string, preferences: AgentRunPreferencesView): AgentRunPreferencesView {
    const capabilities = this.capabilities(userId);
    if (preferences.model !== null && !capabilities.models.includes(preferences.model)) {
      throw new ConfigError(
        `Model '${preferences.model}' is not available for the selected agent connection.`,
      );
    }
    if (preferences.effort !== null && !capabilities.efforts.includes(preferences.effort)) {
      throw new ConfigError(
        `Effort '${preferences.effort}' is not available for the selected agent connection.`,
      );
    }
    if (preferences.model === null && preferences.effort === null) {
      this.repository.clear(userId, AGENT_RUN_PREFERENCES_KEY);
    } else {
      this.repository.set(userId, AGENT_RUN_PREFERENCES_KEY, JSON.stringify(preferences));
    }
    return this.get(userId);
  }

  resolve(
    instanceDefaults: TaskContext["llm"],
    actor: Actor | undefined,
    scope: LlmDefaultsScope,
  ): TaskContext["llm"] {
    if (scope === "instance" || !actor) return instanceDefaults;
    const preferences = this.get(actor.id);
    return {
      ...instanceDefaults,
      model: preferences.model ?? instanceDefaults.model,
      effort: preferences.effort ?? instanceDefaults.effort,
    };
  }

  capabilities(userId: string) {
    const runtime = this.runtimeAgent(userId);
    return agentLlmCapabilities(runtime?.provider ?? "claude", runtime?.optionId);
  }
}

export function isModel(value: unknown): value is LlmModel {
  return typeof value === "string" && (LLM_MODELS as readonly string[]).includes(value);
}

export function isEffort(value: unknown): value is LlmEffort {
  return typeof value === "string" && (LLM_EFFORTS as readonly string[]).includes(value);
}
