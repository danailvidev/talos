import { describe, expect, test } from "bun:test";

import { assistantEventsFromClaudeEvent } from "../src/infrastructure/agent/chat.ts";

describe("connected Claude chat stream", () => {
  test("turns partial text and MCP activity into safe browser events", () => {
    const tools = new Map<string, string>();

    expect(
      assistantEventsFromClaudeEvent({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Current failures:" },
        },
      }, tools),
    ).toEqual([{ type: "text", text: "Current failures:" }]);

    expect(
      assistantEventsFromClaudeEvent({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "mcp__talos__datadog_issues",
              input: { limit: 10 },
            },
          ],
        },
      }, tools),
    ).toEqual([
      {
        type: "tool",
        id: "tool-1",
        name: "datadog issues",
        status: "started",
      },
    ]);

    expect(
      assistantEventsFromClaudeEvent({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "secret payload" }],
        },
      }, tools),
    ).toEqual([
      {
        type: "tool",
        id: "tool-1",
        name: "datadog issues",
        status: "completed",
      },
    ]);
  });

  test("does not forward tool inputs or results", () => {
    const output = assistantEventsFromClaudeEvent({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "unknown",
            is_error: true,
            content: "token=should-not-reach-browser",
          },
        ],
      },
    });

    expect(output).toEqual([
      { type: "tool", id: "unknown", name: "tool", status: "failed" },
    ]);
    expect(JSON.stringify(output)).not.toContain("should-not-reach-browser");
  });
});
