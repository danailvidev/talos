import { describe, expect, test } from "bun:test";
import { resolveAgentCapacityConfig } from "../src/config/agent-capacity.ts";

describe("agent capacity configuration", () => {
  test("preserves the legacy effective default of three total slots", () => {
    expect(resolveAgentCapacityConfig({})).toEqual({
      total: 3,
      background: 2,
      interactiveReservation: 1,
    });
  });

  test("derives total from legacy settings when the explicit total is absent", () => {
    expect(resolveAgentCapacityConfig({
      TALOS_AGENT_JOBS: "4",
      TALOS_AGENT_INTERACTIVE_JOBS: "2",
    })).toEqual({
      total: 6,
      background: 4,
      interactiveReservation: 2,
    });
  });

  test("gives explicit total capacity precedence", () => {
    expect(resolveAgentCapacityConfig({
      TALOS_AGENT_CAPACITY: "5",
      TALOS_AGENT_JOBS: "99",
      TALOS_AGENT_INTERACTIVE_JOBS: "2",
    })).toEqual({
      total: 5,
      background: 3,
      interactiveReservation: 2,
    });
  });

  test("rejects a reservation that consumes the whole total", () => {
    expect(() => resolveAgentCapacityConfig({
      TALOS_AGENT_CAPACITY: "2",
      TALOS_AGENT_INTERACTIVE_JOBS: "2",
    })).toThrow("must be greater");
  });
});
