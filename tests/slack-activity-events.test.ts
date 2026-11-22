import { describe, expect, test } from "bun:test";

import { SlackActivityEventHub } from "../src/application/slack-activity-events.ts";

describe("Slack activity SSE", () => {
  test("streams only the subscribed user's changes and tracks active users", async () => {
    const hub = new SlackActivityEventHub();
    const abort = new AbortController();
    const response = hub.stream("u1", abort.signal, (conversationIds) => ({
      revision: 1,
      unreadCount: 2,
      conversationIds,
    }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    expect(hub.activeUserIds()).toEqual(["u1"]);
    const initial = decoder.decode((await reader.read()).value);
    expect(initial).toContain('"conversationIds":[]');

    hub.publish({ userId: "u2", conversationId: "D-other" });
    hub.publish({ userId: "u1", conversationId: "D1" });
    const update = decoder.decode((await reader.read()).value);
    expect(update).toContain('"conversationIds":["D1"]');

    abort.abort();
    expect(hub.activeUserIds()).toEqual([]);
  });
});
