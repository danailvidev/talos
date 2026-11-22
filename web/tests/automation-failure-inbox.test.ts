import { describe, expect, test } from "bun:test";

import {
  automationFailureInboxFilter,
  updateAutomationFailureRoute,
} from "../src/automation-failure-inbox.ts";
import { keys } from "../src/query-keys.ts";

describe("Automation failure inbox filters", () => {
  test("supplies safe current-failure defaults", () => {
    expect(automationFailureInboxFilter(undefined)).toEqual({
      days: 30,
      presence: "current",
      limit: 25,
      offset: 0,
    });
  });

  test("maps shareable route state to a deterministic query", () => {
    const filter = automationFailureInboxFilter({
      days: 7,
      scheduleId: 22,
      pipelineId: 9001,
      presence: "recent",
      state: "ticketed",
      q: "  checkout  ",
      limit: 50,
      offset: 100,
    });
    expect(filter).toEqual({
      days: 7,
      scheduleId: 22,
      pipelineId: 9001,
      presence: "recent",
      state: "ticketed",
      search: "checkout",
      limit: 50,
      offset: 100,
    });
    expect(keys.automationFailureInbox(filter)).toEqual([
      "automation",
      "failure-inbox",
      {
        days: 7,
        scheduleId: 22,
        pipelineId: 9001,
        presence: "recent",
        state: "ticketed",
        search: "checkout",
        limit: 50,
        offset: 100,
      },
    ]);
  });

  test("clears optional values while retaining unrelated filters", () => {
    expect(
      updateAutomationFailureRoute(
        { days: 7, pipelineId: 9001, state: "untriaged" },
        { pipelineId: undefined, offset: undefined },
      ),
    ).toEqual({ days: 7, state: "untriaged" });
  });
});
