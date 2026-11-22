import { ConfigError } from "../core/errors.ts";

export interface AgentCapacityConfig {
  total: number;
  background: number;
  interactiveReservation: number;
}

/**
 * New total capacity takes precedence. Without it, legacy background capacity
 * plus the interactive reservation preserves the previous effective budget.
 */
export function resolveAgentCapacityConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentCapacityConfig {
  const interactiveReservation = integer(
    env.TALOS_AGENT_INTERACTIVE_JOBS,
    1,
    "TALOS_AGENT_INTERACTIVE_JOBS",
    0,
  );
  const legacyBackground = integer(
    env.TALOS_AGENT_JOBS,
    2,
    "TALOS_AGENT_JOBS",
    1,
  );
  const total = env.TALOS_AGENT_CAPACITY?.trim()
    ? integer(env.TALOS_AGENT_CAPACITY, 0, "TALOS_AGENT_CAPACITY", 1)
    : legacyBackground + interactiveReservation;
  const background = total - interactiveReservation;
  if (background < 1) {
    throw new ConfigError(
      "TALOS_AGENT_CAPACITY must be greater than TALOS_AGENT_INTERACTIVE_JOBS.",
    );
  }
  return { total, background, interactiveReservation };
}

function integer(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    const expectation = minimum === 0 ? "a non-negative integer" : "a positive integer";
    throw new ConfigError(`${name} must be ${expectation}; received '${raw}'.`);
  }
  return value;
}
