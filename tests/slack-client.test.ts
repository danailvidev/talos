import { describe, expect, test } from "bun:test";

import { SlackClient } from "../src/connectors/slack/client.ts";
import {
  exchangeSlackUserCode,
  slackAuthorizeUrl,
  SLACK_USER_SCOPES,
} from "../src/connectors/slack/oauth.ts";
import { PermissionError } from "../src/core/errors.ts";
import { FakeHttp } from "./fixtures/http.ts";

describe("Slack user client", () => {
  test("lists conversations and retrieves history and thread replies", async () => {
    const http = new FakeHttp([
      {
        match: "/api/users.conversations",
        respond: {
          json: {
            ok: true,
            channels: [{ id: "D1", is_im: true, user: "U2" }],
            response_metadata: { next_cursor: "next" },
          },
        },
      },
      {
        match: "/api/conversations.history",
        respond: {
          json: {
            ok: true,
            messages: [{ type: "message", user: "U2", text: "hello", ts: "10.1" }],
          },
        },
      },
      {
        match: "/api/conversations.replies",
        respond: {
          json: {
            ok: true,
            messages: [
              { type: "message", user: "U2", text: "root", ts: "10.1" },
              { type: "message", user: "U1", text: "reply", ts: "10.2", thread_ts: "10.1" },
            ],
          },
        },
      },
      {
        match: "/api/users.getPresence",
        respond: { json: { ok: true, presence: "active" } },
      },
    ]);
    const client = new SlackClient({ token: "xoxp-user-token", fetch: http.fetch });

    expect(await client.listConversations({ types: "im", limit: 20 })).toMatchObject({
      conversations: [{ id: "D1", is_im: true }],
      nextCursor: "next",
    });
    expect((await client.conversationHistory({ channel: "D1" })).messages[0]?.text).toBe(
      "hello",
    );
    expect(
      (await client.threadReplies({ channel: "D1", threadTs: "10.1" })).messages,
    ).toHaveLength(2);
    expect(await client.userPresence("U2")).toBe("active");
    expect(http.callsTo("users.conversations")[0]!.url.searchParams.get("types")).toBe("im");
    expect(http.callsTo("users.getPresence")[0]!.url.searchParams.get("user")).toBe("U2");
  });

  test("retrieves focused history and parses paged message search results", async () => {
    const http = new FakeHttp([
      {
        match: "/api/conversations.history",
        respond: {
          json: {
            ok: true,
            messages: [{ type: "message", user: "U2", text: "target", ts: "20.2" }],
          },
        },
      },
      {
        match: "/api/search.messages",
        respond: {
          json: {
            ok: true,
            messages: {
              matches: [
                {
                  ts: "20.2",
                  thread_ts: "20.1",
                  user: "U2",
                  username: "grace",
                  text: "target text",
                  channel: { id: "G1", name: "mpdm-grace--nick-1", is_mpim: true },
                },
              ],
              paging: { page: 2, pages: 3, total: 201 },
            },
          },
        },
      },
    ]);
    const client = new SlackClient({ token: "xoxp-user-token", fetch: http.fetch });

    await client.conversationHistory({
      channel: "G1",
      latest: "20.2",
      inclusive: true,
    });
    expect(await client.searchMessages({ query: "target in:mpdm-grace--nick-1", page: 2 }))
      .toEqual({
        matches: [
          expect.objectContaining({
            ts: "20.2",
            thread_ts: "20.1",
            text: "target text",
          }),
        ],
        page: 2,
        pageCount: 3,
        total: 201,
      });

    const historyCall = http.callsTo("conversations.history")[0]!;
    expect(historyCall.url.searchParams.get("latest")).toBe("20.2");
    expect(historyCall.url.searchParams.get("inclusive")).toBe("true");
    expect(http.callsTo("search.messages")[0]!.url.searchParams.get("page")).toBe("2");
  });

  test("maps Slack ok:false permission failures even when HTTP is 200", async () => {
    const http = new FakeHttp([
      {
        match: "/api/conversations.history",
        respond: { json: { ok: false, error: "missing_scope", messages: [] } },
      },
    ]);
    const client = new SlackClient({ token: "xoxp-user-token", fetch: http.fetch });
    await expect(client.conversationHistory({ channel: "D1" })).rejects.toBeInstanceOf(
      PermissionError,
    );
  });

  test("accepts non-standard styles in legacy attachment actions", async () => {
    const http = new FakeHttp([
      {
        match: "/api/conversations.history",
        respond: {
          json: {
            ok: true,
            messages: [
              {
                text: "deployment",
                ts: "10.1",
                attachments: [
                  {
                    actions: [
                      {
                        type: "button",
                        text: "Details",
                        url: "https://example.com/deployment",
                        style: "default",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
    const client = new SlackClient({ token: "xoxp-user-token", fetch: http.fetch });

    expect(
      (await client.conversationHistory({ channel: "D1" })).messages[0]?.attachments?.[0]
        ?.actions?.[0]?.style,
    ).toBe("default");
  });

  test("accepts conversations with no latest message", async () => {
    const http = new FakeHttp([
      {
        match: "/api/conversations.info",
        respond: {
          json: {
            ok: true,
            channel: { id: "D1", latest: null, last_read: "10.1" },
          },
        },
      },
    ]);
    const client = new SlackClient({ token: "xoxp-user-token", fetch: http.fetch });
    expect(await client.conversationInfo("D1")).toEqual({ lastReadTs: "10.1" });
  });

  test("renames a group conversation and updates its topic", async () => {
    const http = new FakeHttp([
      {
        match: "/api/conversations.rename",
        method: "POST",
        respond: {
          json: { ok: true, channel: { id: "G1", is_mpim: true, name: "talos-deployment" } },
        },
      },
      {
        match: "/api/conversations.setTopic",
        method: "POST",
        respond: {
          json: {
            ok: true,
            channel: {
              id: "G1",
              is_mpim: true,
              topic: { value: "Deployment coordination" },
            },
          },
        },
      },
    ]);
    const client = new SlackClient({ token: "xoxp-user-token", fetch: http.fetch });

    await client.renameConversation("G1", "talos-deployment");
    await client.setConversationTopic("G1", "Deployment coordination");

    expect(http.callsTo("conversations.rename")[0]?.body).toContain(
      '"name":"talos-deployment"',
    );
    expect(http.callsTo("conversations.setTopic")[0]?.body).toContain(
      '"topic":"Deployment coordination"',
    );
  });

  test("reacts and uploads an image with the user token", async () => {
    const http = new FakeHttp([
      {
        match: "/api/reactions.add",
        method: "POST",
        respond: { json: { ok: true } },
      },
      {
        match: "/api/files.getUploadURLExternal",
        method: "POST",
        respond: {
          json: {
            ok: true,
            upload_url: "https://uploads.slack.test/upload-1",
            file_id: "F1",
          },
        },
      },
      {
        match: "/upload-1",
        method: "POST",
        respond: { text: "OK" },
      },
      {
        match: "/api/files.completeUploadExternal",
        method: "POST",
        respond: { json: { ok: true } },
      },
      {
        match: "/api/files.info",
        respond: {
          json: {
            ok: true,
            file: {
              id: "F1",
              shares: {
                private: {
                  D1: [{ ts: "1710000000.000020" }],
                },
              },
            },
          },
        },
      },
    ]);
    const client = new SlackClient({ token: "xoxp-user-token", fetch: http.fetch });

    await client.setReaction({
      channel: "D1",
      timestamp: "1710000000.000001",
      name: "+1",
      active: true,
    });
    const uploaded = await client.uploadFiles({
      channel: "D1",
      files: [
        {
          name: "clipboard.png",
          mimeType: "image/png",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    });

    expect(uploaded).toEqual({ channel: "D1", ts: "1710000000.000020" });
    expect(http.callsTo("reactions.add")[0]?.body).toContain('"name":"+1"');
    expect(http.callsTo("files.getUploadURLExternal")[0]?.body).toContain(
      '"length":3',
    );
    expect(http.callsTo("upload-1")[0]?.headers["content-type"]).toBe("image/png");
    expect(http.callsTo("files.completeUploadExternal")[0]?.body).toContain(
      '"channel_id":"D1"',
    );
  });

  test("edits and deletes a posted message with the user token", async () => {
    const http = new FakeHttp([
      {
        match: "/api/chat.update",
        method: "POST",
        respond: { json: { ok: true, channel: "D1", ts: "1710000000.000001" } },
      },
      {
        match: "/api/chat.delete",
        method: "POST",
        respond: { json: { ok: true } },
      },
    ]);
    const client = new SlackClient({ token: "xoxp-user-token", fetch: http.fetch });

    expect(
      await client.updateMessage({
        channel: "D1",
        ts: "1710000000.000001",
        text: "edited",
      }),
    ).toEqual({ channel: "D1", ts: "1710000000.000001" });
    await client.deleteMessage({ channel: "D1", ts: "1710000000.000001" });

    expect(JSON.parse(http.callsTo("chat.update")[0]!.body!)).toMatchObject({
      channel: "D1",
      ts: "1710000000.000001",
      text: "edited",
    });
    expect(JSON.parse(http.callsTo("chat.delete")[0]!.body!)).toMatchObject({
      channel: "D1",
      ts: "1710000000.000001",
    });
  });

  test("opens a direct message with the user token", async () => {
    const http = new FakeHttp([
      {
        match: "/api/conversations.open",
        method: "POST",
        respond: { json: { ok: true, channel: { id: "D9" } } },
      },
    ]);
    const client = new SlackClient({ token: "xoxp-user-token", fetch: http.fetch });
    expect(await client.openDirectMessage({ userId: "U2" })).toEqual({ channel: "D9" });
    expect(JSON.parse(http.callsTo("conversations.open")[0]!.body!)).toMatchObject({
      users: "U2",
    });
  });
});

describe("Slack user OAuth", () => {
  test("builds a one-workspace authorization URL with posting access", () => {
    const url = new URL(
      slackAuthorizeUrl({
        clientId: "123.456",
        workspaceId: "T1",
        redirectUri: "https://talos.example/api/auth/slack/callback",
        state: "state",
      }),
    );
    expect(url.pathname).toBe("/oauth/v2_user/authorize");
    expect(url.searchParams.get("team")).toBe("T1");
    expect(url.searchParams.get("scope")?.split(",").sort()).toEqual(
      [...SLACK_USER_SCOPES].sort(),
    );
  });

  test("exchanges a code without exposing the client secret in the URL", async () => {
    const http = new FakeHttp([
      {
        match: "/api/oauth.v2.user.access",
        method: "POST",
        respond: {
          json: {
            ok: true,
            access_token: "xoxp-connected",
            refresh_token: "xoxe-refresh",
            expires_in: 3600,
            scope: SLACK_USER_SCOPES.join(","),
            authed_user: {
              id: "U1",
              team: { id: "T1", name: "Acme" },
            },
          },
        },
      },
    ]);
    const result = await exchangeSlackUserCode({
      clientId: "client",
      clientSecret: "super-secret",
      code: "code",
      redirectUri: "https://talos.example/api/auth/slack/callback",
      fetch: http.fetch,
    });

    expect(result).toMatchObject({
      accessToken: "xoxp-connected",
      refreshToken: "xoxe-refresh",
      teamId: "T1",
      userId: "U1",
    });
    expect(http.calls[0]!.url.toString()).not.toContain("super-secret");
    expect(http.calls[0]!.body).toContain("client_secret=super-secret");
  });
});
