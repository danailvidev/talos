import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { SlackInboxService } from "../src/application/slack-inbox-service.ts";
import { SLACK_READ_SYNC_PREFERENCE } from "../shared/api-contract.ts";
import {
  SLACK_REQUIRED_USER_SCOPES,
  SLACK_USER_SCOPES,
} from "../src/connectors/slack/oauth.ts";
import { ConfigError } from "../src/core/errors.ts";
import { createLogger } from "../src/logging/logger.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteSlackConnectionStore } from "../src/persistence/slack-connection-store.ts";
import { SqlitePreferenceStore } from "../src/persistence/preference-store.ts";
import { createCipher } from "../src/secrets/crypto.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { FakeHttp } from "./fixtures/http.ts";

const actor = { id: "talos-u1", name: "Ada", email: "ada@example.com" };

function setup(http: FakeHttp) {
  const db = new Database(":memory:");
  migrate(db);
  const connections = new SqliteSlackConnectionStore(
    db,
    createCipher("a sufficiently long test key"),
  );
  const preferences = new SqlitePreferenceStore(db);
  const service = new SlackInboxService({
    connections,
    preferences,
    secrets: new EnvSecretStore({
      SLACK_CLIENT_ID: "client",
      SLACK_CLIENT_SECRET: "secret",
      SLACK_WORKSPACE_ID: "T1",
    }),
    logger: createLogger({ level: "fatal", secretValues: [] }),
    fetch: http.fetch,
  });
  return { db, connections, preferences, service };
}

describe("Slack inbox service", () => {
  test("separates app DMs and preserves safe Block Kit links", async () => {
    const http = new FakeHttp([
      {
        match: "/api/users.conversations",
        respond: (call) => ({
          json: {
            ok: true,
            channels:
              call.url.searchParams.get("types") === "im"
                ? [{ id: "DAPP", is_im: true, user: "UBOT" }]
                : [],
          },
        }),
      },
      {
        match: "/api/users.list",
        respond: {
          json: {
            ok: true,
            members: [
              {
                id: "UBOT",
                name: "google-calendar",
                is_bot: true,
                profile: {
                  display_name: "Google Calendar",
                  image_48: "https://cdn.example/google-calendar.png",
                },
              },
            ],
          },
        },
      },
      {
        match: "/api/conversations.info",
        respond: { json: { ok: true, channel: { id: "DAPP", latest: null } } },
      },
      {
        match: "/api/conversations.history",
        respond: {
          json: {
            ok: true,
            messages: [
              {
                type: "message",
                subtype: "bot_message",
                bot_id: "BGOOGLE",
                text: "Today — Thursday, September 17, 2026",
                bot_profile: {
                  name: "Google Calendar",
                  icons: { image_48: "https://cdn.example/google-calendar.png" },
                },
                blocks: [
                  { type: "header", text: { type: "plain_text", text: "Today" } },
                  {
                    type: "section",
                    fields: [
                      { type: "mrkdwn", text: "*UI daily stand-up*" },
                      { type: "mrkdwn", text: "3:30 PM–4:00 PM" },
                    ],
                  },
                  {
                    type: "actions",
                    elements: [
                      {
                        type: "button",
                        text: { type: "plain_text", text: "Join Google Meet Meeting" },
                        url: "https://meet.google.com/abc-defg-hij",
                        style: "primary",
                      },
                      {
                        type: "button",
                        text: { type: "plain_text", text: "Unsafe" },
                        url: "javascript:alert(1)",
                      },
                    ],
                  },
                ],
                ts: "1710000000.000001",
              },
            ],
          },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [...SLACK_REQUIRED_USER_SCOPES],
    });

    const inbox = await service.inbox(actor);
    expect(inbox.conversations).toMatchObject([
      {
        id: "DAPP",
        name: "Google Calendar",
        app: true,
        avatarUrl: "https://cdn.example/google-calendar.png",
      },
    ]);
    expect((await service.messages(actor, "DAPP")).messages[0]).toMatchObject({
      userName: "Google Calendar",
      avatarUrl: "https://cdn.example/google-calendar.png",
      blocks: [
        { type: "header", text: "Today" },
        {
          type: "section",
          fields: ["*UI daily stand-up*", "3:30 PM–4:00 PM"],
        },
        {
          type: "actions",
          actions: [
            {
              text: "Join Google Meet Meeting",
              url: "https://meet.google.com/abc-defg-hij",
              style: "primary",
            },
          ],
        },
      ],
    });
    db.close();
  });

  test("keeps 1:1 DMs working when an existing token lacks optional group-DM scopes", async () => {
    const http = new FakeHttp([
      {
        match: "/api/users.conversations",
        respond: { json: { ok: true, channels: [] } },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [...SLACK_REQUIRED_USER_SCOPES],
    });

    const inbox = await service.inbox(actor);

    expect(inbox.conversations).toEqual([]);
    expect(inbox.connection.groupDmsEnabled).toBe(false);
    expect(inbox.connection.postingEnabled).toBe(false);
    expect(inbox.connection.reactionsEnabled).toBe(false);
    expect(inbox.connection.imageUploadsEnabled).toBe(false);
    expect(
      http.callsTo("users.conversations").some(
        (call) => call.url.searchParams.get("types") === "im",
      ),
    ).toBe(true);
    await expect(service.sendMessage(actor, "D1", "hello")).rejects.toThrow(
      /missing chat:write/,
    );
    await expect(
      service.updateMessage(actor, "D1", "1710000000.000001", "edit"),
    ).rejects.toThrow(/missing chat:write/);
    await expect(
      service.deleteMessage(actor, "D1", "1710000000.000001"),
    ).rejects.toThrow(/missing chat:write/);
    db.close();
  });

  test("resolves a user omitted from OAuth through auth.test", async () => {
    const http = new FakeHttp([
      {
        match: "/api/oauth.v2.user.access",
        method: "POST",
        respond: {
          json: {
            ok: true,
            access_token: "xoxp-user",
            scope: SLACK_USER_SCOPES.join(","),
            team: { id: "T1", name: "Acme" },
          },
        },
      },
      {
        match: "/api/auth.test",
        method: "POST",
        respond: {
          json: {
            ok: true,
            team: "Acme",
            team_id: "T1",
            user: "Ada",
            user_id: "U1",
          },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-old",
      scopes: [...SLACK_REQUIRED_USER_SCOPES],
    });
    connections.replaceConversations(actor.id, [
      {
        conversationId: "D-existing",
        kind: "dm",
        name: "Existing DM",
        private: true,
      },
    ]);
    const started = service.startOAuth(actor, "https://talos.example");
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;

    await service.completeOAuth({
      state,
      browserNonce: started.browserNonce,
      code: "code",
      origin: "https://talos.example",
    });

    expect(connections.describe(actor.id)).toMatchObject({
      teamId: "T1",
      slackUserId: "U1",
      slackUserName: "Ada",
    });
    expect(connections.conversations(actor.id)).toMatchObject([
      { conversationId: "D-existing", name: "Existing DM" },
    ]);
    db.close();
  });

  test("binds OAuth state to a TALOS user and rejects another workspace", async () => {
    const http = new FakeHttp([
      {
        match: "/api/oauth.v2.user.access",
        method: "POST",
        respond: {
          json: {
            ok: true,
            access_token: "xoxp-user",
            scope: SLACK_USER_SCOPES.join(","),
            team: { id: "T-wrong" },
          },
        },
      },
      {
        match: "/api/auth.test",
        method: "POST",
        respond: {
          json: {
            ok: true,
            team: "Wrong workspace",
            team_id: "T-wrong",
            user: "Ada",
            user_id: "U1",
          },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    const started = service.startOAuth(actor, "https://talos.example");
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;

    await expect(
      service.completeOAuth({
        state,
        browserNonce: "another-browser",
        code: "code",
        origin: "https://talos.example",
      }),
    ).rejects.toThrow(/invalid or has expired/);
    expect(http.calls).toHaveLength(0);

    await expect(
      service.completeOAuth({
        state,
        browserNonce: started.browserNonce,
        code: "code",
        origin: "https://talos.example",
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(connections.describe(actor.id)).toBeUndefined();
    await expect(
      service.completeOAuth({
        state,
        browserNonce: started.browserNonce,
        code: "replay",
        origin: "https://talos.example",
      }),
    ).rejects.toThrow(/invalid or has expired/);
    db.close();
  });

  test("shows DMs and selected channels while refusing unselected channel history", async () => {
    const http = new FakeHttp([
      {
        match: "/api/users.conversations",
        respond: (call) => {
          const types = call.url.searchParams.get("types");
          return types === "im,mpim"
            ? call.url.searchParams.get("cursor")
              ? {
                  json: {
                    ok: true,
                    channels: [
                      { id: "D2", is_im: true, user: "U3" },
                      { id: "G1", is_mpim: true },
                    ],
                  },
                }
              : {
                  json: {
                    ok: true,
                    channels: [
                      { id: "D1", is_im: true, user: "U2" },
                      { id: "D0", is_im: true, user: "U0", is_user_deleted: true },
                    ],
                    response_metadata: { next_cursor: "dm-next" },
                  },
                }
            : {
                json: {
                  ok: true,
                  channels: [
                    { id: "C1", name: "selected", is_channel: true },
                    { id: "C2", name: "hidden", is_channel: true },
                  ],
                },
              };
        },
      },
      {
        match: "/api/conversations.history",
        respond: (call) => ({
          json: {
            ok: true,
            messages: [
              {
                type: "message",
                user: "U2",
                text:
                  `message in ${call.url.searchParams.get("channel")} ` +
                  "<@U3> <!subteam^S03C8LZJG0G>",
                reactions: [{ name: "+1", count: 2, users: ["U1", "U3"] }],
                files: [{ id: "F1", name: "screenshot.png", mimetype: "image/png" }],
                ts:
                  call.url.searchParams.get("channel") === "G1"
                    ? "1710000000.000003"
                    : call.url.searchParams.get("channel") === "D2"
                      ? "1710000000.000002"
                      : "1710000000.000001",
              },
            ],
          },
        }),
      },
      {
        match: "/api/conversations.members",
        respond: { json: { ok: true, members: ["U1", "U2", "U3"] } },
      },
      {
        match: "/api/users.list",
        respond: {
          json: {
            ok: true,
            members: [
              {
                id: "U2",
                name: "grace",
                profile: {
                  display_name: "Grace",
                  image_48: "https://cdn.example/grace.png",
                },
              },
              {
                id: "U3",
                name: "nick",
                profile: { display_name: "Nick" },
              },
            ],
          },
        },
      },
      {
        match: "/api/usergroups.list",
        respond: {
          json: {
            ok: true,
            usergroups: [
              { id: "S03C8LZJG0G", handle: "qa", name: "Quality assurance" },
            ],
          },
        },
      },
      {
        match: "/api/users.getPresence",
        respond: (call) => ({
          json: {
            ok: true,
            presence:
              call.url.searchParams.get("user") === "U3" ? "active" : "away",
          },
        }),
      },
      {
        match: "/api/search.messages",
        respond: {
          json: {
            ok: true,
            messages: {
              matches: [
                { type: "mpim", ts: "1710000000.000003", channel: { id: "G1", is_mpim: true } },
                { type: "im", ts: "1710000000.000002", channel: { id: "D2" } },
                { type: "im", ts: "1710000000.000001", channel: { id: "D1" } },
              ],
            },
          },
        },
      },
      {
        match: "/api/conversations.info",
        respond: (call) => ({
          json: {
            ok: true,
            channel: {
              id: call.url.searchParams.get("channel"),
              last_read: "1710000000.000001",
            },
          },
        }),
      },
      {
        match: "/api/users.info",
        respond: {
          json: {
            ok: true,
            user: {
              id: "U2",
              name: "grace",
              profile: {
                display_name: "Grace",
                image_48: "https://cdn.example/grace.png",
              },
            },
          },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      slackUserName: "Ada",
      accessToken: "xoxp-user",
      scopes: [...SLACK_USER_SCOPES],
    });
    connections.setSelectedChannels(actor.id, ["C1"]);

    const inbox = await service.inbox(actor);
    expect(http.callsTo("conversations.history")).toHaveLength(0);
    expect(http.callsTo("users.info")).toHaveLength(0);
    expect(inbox.conversations.map((conversation) => conversation.id)).toEqual([
      "G1",
      "D2",
      "D1",
      "C1",
    ]);
    expect(inbox.conversations[0]).toMatchObject({
      kind: "group-dm",
      name: "Grace, Nick",
      avatarUrl: "https://cdn.example/grace.png",
    });
    expect(inbox.conversations.find((conversation) => conversation.id === "D2"))
      .toMatchObject({ online: true });
    expect(inbox.conversations.find((conversation) => conversation.id === "D1"))
      .toMatchObject({ online: false });
    expect(
      http.callsTo("users.conversations").find(
        (call) => call.url.searchParams.get("types") === "im,mpim",
      )?.url.searchParams.get("limit"),
    ).toBe("200");
    expect(
      http.callsTo("conversations.history").some(
        (call) => call.url.searchParams.get("channel") === "D0",
      ),
    ).toBe(false);
    expect(inbox.conversations.every((conversation) => !conversation.unread)).toBe(true);

    connections.recordWorkspaceActivity({
      teamId: "T1",
      slackUserIds: ["U1"],
      conversationId: "D1",
      conversationType: "im",
      latestTs: "1710000000.000004",
    });
    const callsAfterBootstrap = http.calls.length;
    const withNewMessage = await service.inbox(actor);
    expect(http.calls).toHaveLength(callsAfterBootstrap + 1);
    expect(
      http
        .callsTo("conversations.info")
        .filter((call) => call.url.searchParams.get("channel") === "D1"),
    ).toHaveLength(1);
    expect(
      withNewMessage.conversations.find((conversation) => conversation.id === "D1")
        ?.unread,
    ).toBe(true);

    await service.markRead(actor, "D1", "1710000000.000004");
    const refreshed = await service.inbox(actor);
    expect(refreshed.conversations.find((conversation) => conversation.id === "D1")?.unread)
      .toBe(false);
    expect((await service.messages(actor, "D1")).messages[0]).toMatchObject({
      text: "message in D1 <@U3> <!subteam^S03C8LZJG0G>",
      mentions: { U3: "Grace", S03C8LZJG0G: "qa" },
      reactions: [{ name: "+1", count: 2, reacted: true }],
      attachments: [{ id: "F1", name: "screenshot.png", mimeType: "image/png" }],
      mine: false,
    });
    await expect(service.messages(actor, "C2")).rejects.toThrow(
      /not part of your TALOS inbox/,
    );
    await service.setChannels(actor, ["C2"]);
    const afterChannelChange = connections.conversations(actor.id);
    expect(afterChannelChange.filter((conversation) => conversation.kind !== "channel"))
      .toHaveLength(3);
    expect(afterChannelChange.find((conversation) => conversation.conversationId === "C2"))
      .toMatchObject({ name: "#hidden", kind: "channel" });
    expect(() => service.hideDirectMessage(actor, "C2")).toThrow(
      /Only direct messages/,
    );
    expect(service.hideDirectMessage(actor, "D1")).toBe(true);
    expect(connections.conversations(actor.id).some((row) => row.conversationId === "D1"))
      .toBe(false);
    expect(connections.activities(actor.id).has("D1")).toBe(false);
    db.close();
  });

  test("lists every group member, scopes search, and focuses an older result", async () => {
    const http = new FakeHttp([
      {
        match: "/api/users.conversations",
        respond: {
          json: {
            ok: true,
            channels: [
              {
                id: "G1",
                name: "mpdm-ada--grace--nick-1",
                is_mpim: true,
                is_private: true,
              },
            ],
          },
        },
      },
      {
        match: "/api/conversations.members",
        respond: (call) => ({
          json: call.url.searchParams.get("cursor")
            ? { ok: true, members: ["U3"] }
            : {
                ok: true,
                members: ["U1", "U2"],
                response_metadata: { next_cursor: "members-2" },
              },
        }),
      },
      {
        match: "/api/users.info",
        respond: (call) => {
          const id = call.url.searchParams.get("user")!;
          const names: Record<string, string> = {
            U1: "Ada",
            U2: "Grace",
            U3: "Nick",
          };
          return {
            json: {
              ok: true,
              user: {
                id,
                name: names[id]?.toLowerCase(),
                tz: "Europe/Sofia",
                tz_label: "Eastern European Time",
                tz_offset: 10_800,
                profile: {
                  display_name: names[id],
                  image_48: `https://cdn.example/${id}.png`,
                  image_512: `https://cdn.example/${id}-large.png`,
                  title: "Engineer",
                  status_text: "In a meeting",
                  status_emoji: ":spiral_calendar_pad:",
                  email: `${id.toLowerCase()}@example.com`,
                },
              },
            },
          };
        },
      },
      {
        match: "/api/users.getPresence",
        respond: { json: { ok: true, presence: "away" } },
      },
      {
        match: "/api/conversations.info",
        respond: {
          json: {
            ok: true,
            channel: {
              id: "G1",
              is_mpim: true,
              name: "talos-deployment",
              topic: { value: "Deployment coordination" },
            },
          },
        },
      },
      {
        match: "/api/conversations.rename",
        method: "POST",
        respond: {
          json: {
            ok: true,
            channel: { id: "G1", is_mpim: true, name: "new-deployment" },
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
                  ts: "1710000000.000020",
                  thread_ts: "1710000000.000010",
                  user: "U2",
                  text: "the matching deployment <@U3>",
                  channel: { id: "G2", name: "other", is_mpim: true },
                },
                {
                  ts: "1710000000.000030",
                  user: "U3",
                  text: "same words elsewhere",
                  channel: { id: "G2", name: "other", is_mpim: true },
                },
              ],
              paging: { page: 1, pages: 2, total: 3 },
            },
          },
        },
      },
      {
        match: "/api/conversations.history",
        respond: {
          json: {
            ok: true,
            messages: [
              {
                type: "message",
                user: "U2",
                text: "the matching deployment <@U3>",
                ts: "1710000000.000020",
                thread_ts: "1710000000.000010",
              },
            ],
          },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [...SLACK_USER_SCOPES],
    });
    connections.upsertConversation(actor.id, {
      conversationId: "G1",
      kind: "group-dm",
      name: "Talos deployment",
      private: true,
    });

    expect(await service.conversationMembers(actor, "G1")).toEqual({
      total: 3,
      members: [
        {
          id: "U1",
          name: "Ada",
          avatarUrl: "https://cdn.example/U1.png",
          username: "ada",
          online: false,
          email: "u1@example.com",
          self: true,
        },
        {
          id: "U2",
          name: "Grace",
          avatarUrl: "https://cdn.example/U2.png",
          username: "grace",
          online: false,
          email: "u2@example.com",
          self: false,
        },
        {
          id: "U3",
          name: "Nick",
          avatarUrl: "https://cdn.example/U3.png",
          username: "nick",
          online: false,
          email: "u3@example.com",
          self: false,
        },
      ],
    });
    expect(await service.userProfile(actor, "U2")).toMatchObject({
      id: "U2",
      name: "Grace",
      username: "grace",
      avatarUrl: "https://cdn.example/U2-large.png",
      title: "Engineer",
      statusText: "In a meeting",
      statusEmoji: ":spiral_calendar_pad:",
      timezone: "Europe/Sofia",
      timezoneLabel: "Eastern European Time",
      timezoneOffset: 10_800,
      presence: "away",
      self: false,
    });
    expect(await service.conversationDetails(actor, "G1")).toMatchObject({
      id: "G1",
      name: "Talos deployment",
      topic: "Deployment coordination",
      canRename: true,
      canSetTopic: true,
    });
    expect(
      await service.updateConversationDetails(actor, "G1", {
        name: "New deployment",
      }),
    ).toMatchObject({ name: "New deployment" });

    const filtered = await service.searchConversation(actor, "G1", "deployment", 1, {
      fromMe: true,
      includesMe: true,
      hasLink: true,
      threadsOnly: true,
    });
    expect(filtered.results).toEqual([]);
    expect(http.callsTo("search.messages")[0]!.url.searchParams.get("query")).toBe(
      'deployment in:"New deployment" from:<@U1> with:<@U1> has:link is:thread',
    );

    const search = await service.searchConversation(actor, "G1", "deployment");
    expect(search).toMatchObject({
      page: 1,
      pageCount: 1,
      total: 1,
      results: [
        {
          ts: "1710000000.000020",
          threadTs: "1710000000.000010",
          userName: "Grace",
          text: "the matching deployment <@U3>",
          mentions: { U3: "Nick" },
        },
      ],
    });

    const focused = await service.messages(
      actor,
      "G1",
      undefined,
      "1710000000.000020",
    );
    expect(focused.focusedTs).toBe("1710000000.000020");
    const history = http
      .callsTo("conversations.history")
      .find((call) => call.url.searchParams.get("latest") != null)!;
    expect(history.url.searchParams.get("latest")).toBe("1710000000.000020");
    expect(history.url.searchParams.get("inclusive")).toBe("true");
    db.close();
  });

  test("refreshes an expiring user token before a live read", async () => {
    const http = new FakeHttp([
      {
        match: "/api/oauth.v2.user.access",
        method: "POST",
        respond: {
          json: {
            ok: true,
            access_token: "xoxe.xoxp-fresh",
            refresh_token: "xoxe-refresh-next",
            expires_in: 3600,
          },
        },
      },
      {
        match: "/api/users.conversations",
        respond: { json: { ok: true, channels: [] } },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxe.xoxp-expired",
      refreshToken: "xoxe-refresh-old",
      expiresAt: new Date(Date.now() - 1_000),
      scopes: [...SLACK_USER_SCOPES],
    });

    await service.channels(actor);

    expect(connections.credential(actor.id)).toMatchObject({
      accessToken: "xoxe.xoxp-fresh",
      refreshToken: "xoxe-refresh-next",
    });
    expect(http.callsTo("users.conversations")[0]?.headers.authorization).toBe(
      "Bearer xoxe.xoxp-fresh",
    );
    db.close();
  });

  test("posts with the user's token only to an inbox conversation and stores no body", async () => {
    const http = new FakeHttp([
      {
        match: "/api/users.conversations",
        respond: {
          json: {
            ok: true,
            channels: [{ id: "D1", is_im: true, user: "U2" }],
          },
        },
      },
      {
        match: "/api/chat.postMessage",
        method: "POST",
        respond: {
          json: { ok: true, channel: "D1", ts: "1710000000.000010" },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-current-user",
      scopes: [...SLACK_USER_SCOPES],
    });

    const sent = await service.sendMessage(
      actor,
      "D1",
      " private outgoing body ",
      "1710000000.000001",
    );

    expect(sent).toEqual({
      channel: "D1",
      timestamp: "1710000000.000010",
      threadTs: "1710000000.000001",
    });
    const post = http.callsTo("chat.postMessage")[0]!;
    expect(post.headers.authorization).toBe("Bearer xoxp-current-user");
    expect(JSON.parse(post.body!)).toMatchObject({
      channel: "D1",
      text: "private outgoing body",
      thread_ts: "1710000000.000001",
    });
    expect(connections.readCursor(actor.id, "D1")).toBe("1710000000.000010");
    expect(connections.activities(actor.id).get("D1")).toMatchObject({
      latestTs: "1710000000.000010",
      threadTs: "1710000000.000001",
    });
    const activityRow = db
      .query<Record<string, unknown>, []>(
        "SELECT * FROM slack_conversation_activity WHERE conversation_id = 'D1'",
      )
      .get();
    expect(JSON.stringify(activityRow)).not.toContain("private outgoing body");

    await expect(service.sendMessage(actor, "C2", "nope")).rejects.toThrow(
      /not part of your TALOS inbox/,
    );
    expect(http.callsTo("chat.postMessage")).toHaveLength(1);
    db.close();
  });

  test("edits and deletes the caller's own Slack message without persisting the body", async () => {
    const http = new FakeHttp([
      {
        match: "/api/users.conversations",
        respond: {
          json: { ok: true, channels: [{ id: "D1", is_im: true, user: "U2" }] },
        },
      },
      {
        match: "/api/chat.update",
        method: "POST",
        respond: {
          json: { ok: true, channel: "D1", ts: "1710000000.000010" },
        },
      },
      {
        match: "/api/chat.delete",
        method: "POST",
        respond: { json: { ok: true } },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-current-user",
      scopes: [...SLACK_USER_SCOPES],
    });

    const updated = await service.updateMessage(
      actor,
      "D1",
      "1710000000.000010",
      " private edited body ",
    );
    await service.deleteMessage(actor, "D1", "1710000000.000010");

    expect(updated).toEqual({ channel: "D1", timestamp: "1710000000.000010" });
    expect(JSON.parse(http.callsTo("chat.update")[0]!.body!)).toMatchObject({
      channel: "D1",
      ts: "1710000000.000010",
      text: "private edited body",
    });
    expect(JSON.parse(http.callsTo("chat.delete")[0]!.body!)).toMatchObject({
      channel: "D1",
      ts: "1710000000.000010",
    });
    expect(
      JSON.stringify(
        db.query<Record<string, unknown>, []>("SELECT * FROM slack_conversation_activity").all(),
      ),
    ).not.toContain("private edited body");
    db.close();
  });

  test("reacts and uploads clipboard images without persisting their contents", async () => {
    const http = new FakeHttp([
      {
        match: "/api/users.conversations",
        respond: {
          json: { ok: true, channels: [{ id: "D1", is_im: true, user: "U2" }] },
        },
      },
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
            upload_url: "https://uploads.slack.test/image",
            file_id: "F1",
          },
        },
      },
      {
        match: "/image",
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
                  D1: [{ ts: "1710000000.000021", thread_ts: "1710000000.000001" }],
                },
              },
            },
          },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-current-user",
      scopes: [...SLACK_USER_SCOPES],
    });

    await service.setReaction(
      actor,
      "D1",
      "1710000000.000001",
      "+1",
      true,
    );
    const sent = await service.sendImages(
      actor,
      "D1",
      [
        {
          name: "clipboard.png",
          mimeType: "image/png",
          bytes: new Uint8Array([115, 101, 99, 114, 101, 116]),
        },
      ],
      "private image caption",
      "1710000000.000001",
    );

    expect(sent.timestamp).toBe("1710000000.000021");
    expect(connections.readCursor(actor.id, "D1")).toBe("1710000000.000021");
    expect(http.callsTo("reactions.add")[0]?.headers.authorization).toBe(
      "Bearer xoxp-current-user",
    );
    expect(http.callsTo("files.completeUploadExternal")[0]?.body).toContain(
      '"initial_comment":"private image caption"',
    );
    const rows = db
      .query<Record<string, unknown>, []>(
        "SELECT * FROM slack_conversation_activity WHERE conversation_id = 'D1'",
      )
      .all();
    expect(JSON.stringify(rows)).not.toContain("private image caption");
    expect(JSON.stringify(rows)).not.toContain("secret");
    db.close();
  });

  test("lists workspace people and opens a DM without storing message text", async () => {
    const http = new FakeHttp([
      {
        match: "/api/users.list",
        respond: {
          json: {
            ok: true,
            members: [
              { id: "U1", name: "ada", profile: { display_name: "Ada" } },
              { id: "U2", name: "grace", profile: { display_name: "Grace", image_48: "https://cdn.example/grace.png" } },
              { id: "U3", name: "bot", is_bot: true, profile: { display_name: "Helper" } },
              { id: "U4", name: "gone", deleted: true, profile: { display_name: "Gone" } },
            ],
          },
        },
      },
      {
        match: "/api/conversations.open",
        method: "POST",
        respond: { json: { ok: true, channel: { id: "D9" } } },
      },
      {
        match: "/api/users.info",
        respond: {
          json: {
            ok: true,
            user: {
              id: "U2",
              name: "grace",
              profile: { display_name: "Grace", image_48: "https://cdn.example/grace.png" },
            },
          },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-current-user",
      scopes: [...SLACK_USER_SCOPES],
    });
    connections.replaceConversations(actor.id, [
      { conversationId: "D1", kind: "dm", name: "Existing", private: true },
    ]);

    const people = await service.workspaceUsers(actor, "gra");
    expect(people.users).toEqual([
      { id: "U2", name: "Grace", avatarUrl: "https://cdn.example/grace.png" },
    ]);

    const opened = await service.openDirectMessage(actor, "U2");
    expect(opened).toMatchObject({
      id: "D9",
      kind: "dm",
      name: "Grace",
      private: true,
    });
    expect(connections.conversations(actor.id).map((row) => row.conversationId).sort()).toEqual([
      "D1",
      "D9",
    ]);
    expect(JSON.parse(http.callsTo("conversations.open")[0]!.body!)).toMatchObject({
      users: "U2",
    });
    db.close();
  });

  test("search polling records inactive-DM activity without storing message text", async () => {
    const http = new FakeHttp([
      {
        match: "/api/search.messages",
        respond: {
          json: {
            ok: true,
            messages: {
              matches: [
                {
                  type: "im",
                  ts: "1710000000.000009",
                  text: "private body is intentionally outside the schema",
                  user: null,
                  channel: { id: "D1", name: "U2", is_private: true },
                },
              ],
            },
          },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [...SLACK_USER_SCOPES],
    });
    connections.recordUserActivity(actor.id, "D1", "1710000000.000001");
    connections.markRead(actor.id, "D1", "1710000000.000001");

    await service.pollRecentActivity(undefined, []);
    expect(http.calls).toHaveLength(0);
    await service.pollRecentActivity();

    expect(connections.activities(actor.id).get("D1")?.latestTs).toBe(
      "1710000000.000009",
    );
    const row = db
      .query<Record<string, unknown>, []>(
        "SELECT * FROM slack_conversation_activity WHERE conversation_id = 'D1'",
      )
      .get();
    expect(JSON.stringify(row)).not.toContain("private body");
    db.close();
  });

  test("search polling does not restore activity for a hidden DM", async () => {
    const http = new FakeHttp([
      {
        match: "/api/search.messages",
        respond: {
          json: {
            ok: true,
            messages: {
              matches: [
                {
                  type: "im",
                  ts: "1710000000.000009",
                  text: "hidden message",
                  user: null,
                  channel: { id: "D1", name: "U2", is_private: true },
                },
              ],
            },
          },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [...SLACK_USER_SCOPES],
    });
    connections.upsertConversation(actor.id, {
      conversationId: "D1",
      kind: "dm",
      name: "Grace",
      peerUserId: "U2",
      private: true,
    });
    expect(connections.removeConversation(actor.id, "D1")).toBe(true);

    await service.pollRecentActivity();

    expect(connections.activities(actor.id).has("D1")).toBe(false);
    expect(connections.unreadActivityCount(actor.id)).toBe(0);
    db.close();
  });

  test("streams only images shared in the caller's inbox conversation", async () => {
    const http = new FakeHttp([
      {
        match: (url) => url.pathname === "/api/files.info",
        respond: (call) => ({
          json: {
            ok: true,
            file: {
              id: call.url.searchParams.get("file"),
              name: "screenshot.png",
              mimetype: "image/png",
              size: 3,
              url_private: "https://files.slack.com/files-pri/T1-F1/original.png",
              thumb_360: "https://files.slack.com/files-pri/T1-F1/thumb.png",
              shares: {
                private: {
                  [call.url.searchParams.get("file") === "F1" ? "D1" : "D2"]: [
                    { ts: "1710000000.000009" },
                  ],
                },
              },
            },
          },
        }),
      },
      {
        match: "/files-pri/T1-F1/thumb.png",
        respond: {
          bytes: new Uint8Array([1, 2, 3]),
          headers: { "content-type": "image/png", "content-length": "3" },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [...SLACK_USER_SCOPES],
    });
    connections.upsertConversation(actor.id, {
      conversationId: "D1",
      kind: "dm",
      name: "Grace",
      peerUserId: "U2",
      private: true,
    });

    const image = await service.imageContent(actor, "D1", "F1", true);
    expect(image).toMatchObject({
      contentType: "image/png",
      contentLength: "3",
      filename: "screenshot.png",
    });
    expect([...new Uint8Array(await new Response(image.body).arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
    expect(http.callsTo("thumb.png")[0]?.headers.authorization).toBe(
      "Bearer xoxp-user",
    );
    await expect(service.imageContent(actor, "D1", "F2", true)).rejects.toThrow(
      /not shared in this conversation/,
    );
    db.close();
  });

  test("marks Slack read only after the user opts in", async () => {
    const http = new FakeHttp([
      {
        match: "/api/conversations.mark",
        method: "POST",
        respond: { json: { ok: true } },
      },
    ]);
    const { db, connections, preferences, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [...SLACK_USER_SCOPES],
    });

    await service.markRead(actor, "D1", "1710000000.000001");
    expect(http.callsTo("conversations.mark")).toHaveLength(0);

    preferences.set(actor.id, SLACK_READ_SYNC_PREFERENCE, "true");
    await service.markRead(actor, "D1", "1710000000.000002");
    expect(http.callsTo("conversations.mark")).toHaveLength(1);
    expect(http.callsTo("conversations.mark")[0]?.body).toContain(
      '"ts":"1710000000.000002"',
    );
    db.close();
  });

  test("imports read cursors advanced in Slack when the inbox is loaded", async () => {
    const http = new FakeHttp([
      {
        match: "/api/conversations.info",
        respond: {
          json: {
            ok: true,
            channel: {
              id: "D1",
              latest: { ts: "1710000000.000003" },
              last_read: "1710000000.000003",
            },
          },
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [...SLACK_REQUIRED_USER_SCOPES],
    });
    connections.replaceConversations(actor.id, [
      { conversationId: "D1", kind: "dm", name: "Grace", private: true },
    ]);
    connections.recordUserActivity(actor.id, "D1", "1710000000.000003");
    connections.markRead(actor.id, "D1", "1710000000.000001");

    const inbox = await service.inbox(actor);

    expect(connections.readCursor(actor.id, "D1")).toBe("1710000000.000003");
    expect(connections.unreadActivityCount(actor.id)).toBe(0);
    expect(inbox.conversations[0]?.unread).toBe(false);
    expect(http.callsTo("conversations.info")).toHaveLength(1);
    db.close();
  });

  test("backfills missing recency with lightweight info calls once, then stays local", async () => {
    const http = new FakeHttp([
      {
        match: "/api/conversations.info",
        respond: (call) => {
          const channel = call.url.searchParams.get("channel");
          return {
            json: {
              ok: true,
              channel: {
                id: channel,
                latest: {
                  ts:
                    channel === "D2"
                      ? "1710000000.000002"
                      : "1710000000.000001",
                },
              },
            },
          };
        },
      },
    ]);
    const { db, connections, service } = setup(http);
    connections.save({
      userId: actor.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [...SLACK_REQUIRED_USER_SCOPES],
    });
    connections.replaceConversations(actor.id, [
      { conversationId: "D1", kind: "dm", name: "Older", private: true },
      { conversationId: "D2", kind: "dm", name: "Newer", private: true },
    ]);

    const first = await service.inbox(actor);
    expect(first.conversations.map((conversation) => conversation.id)).toEqual([
      "D2",
      "D1",
    ]);
    expect(http.callsTo("conversations.info")).toHaveLength(2);

    await service.inbox(actor);
    expect(http.callsTo("conversations.info")).toHaveLength(2);
    db.close();
  });
});
