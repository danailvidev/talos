import { describe, expect, test } from "bun:test";
import { agentLlmCapabilities } from "../shared/api-contract.ts";
import { AgentRunPreferences } from "../src/application/agent-run-preferences.ts";
import type { PreferenceRepository } from "../src/application/ports.ts";

class MemoryPreferences implements PreferenceRepository {
  private readonly rows = new Map<string, Map<string, string>>();

  all(userId: string): Record<string, string> {
    return Object.fromEntries(this.rows.get(userId) ?? []);
  }

  set(userId: string, key: string, value: string): void {
    const rows = this.rows.get(userId) ?? new Map<string, string>();
    rows.set(key, value);
    this.rows.set(userId, rows);
  }

  clear(userId: string, key: string): void {
    this.rows.get(userId)?.delete(key);
  }
}

const instanceDefaults = {
  provider: "anthropic",
  model: "sonnet",
  effort: "medium",
  maxTokens: 2048,
};
const actor = { id: "user-1", name: "User", email: "user@example.com" };

describe("AgentRunPreferences", () => {
  test("inherits instance defaults until the developer chooses overrides", () => {
    const preferences = new AgentRunPreferences(new MemoryPreferences());

    expect(preferences.resolve(instanceDefaults, actor, "actor")).toEqual(instanceDefaults);
    preferences.set(actor.id, { model: "opus", effort: "high" });

    expect(preferences.resolve(instanceDefaults, actor, "actor")).toEqual({
      ...instanceDefaults,
      model: "opus",
      effort: "high",
    });
  });

  test("keeps loop execution on instance defaults", () => {
    const preferences = new AgentRunPreferences(new MemoryPreferences());
    preferences.set(actor.id, { model: "opus", effort: "high" });

    expect(preferences.resolve(instanceDefaults, actor, "instance")).toEqual(instanceDefaults);
  });

  test("filters choices when the selected Claude connection changes", () => {
    const store = new MemoryPreferences();
    let optionId = "claude:bedrock-iam";
    const preferences = new AgentRunPreferences(store, () => ({
      provider: "claude",
      optionId,
    }));

    preferences.set(actor.id, {
      model: "us.anthropic.claude-opus-5",
      effort: "high",
    });
    expect(preferences.get(actor.id).model).toBe("us.anthropic.claude-opus-5");

    optionId = "claude:key-api";
    expect(preferences.get(actor.id)).toEqual({ model: null, effort: "high" });
    expect(() =>
      preferences.set(actor.id, {
        model: "us.anthropic.claude-opus-5",
        effort: "high",
      }),
    ).toThrow("not available for the selected agent connection");
  });

  test("does not offer Claude options to other agent providers", () => {
    expect(agentLlmCapabilities("codex", "codex:key")).toEqual({
      models: [],
      efforts: [],
    });
  });
});
