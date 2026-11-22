import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { App } from "../src/app.ts";
import { handleApiRequest } from "../src/api/router.ts";
import { AuthService } from "../src/auth.ts";

process.env.TALOS_ADMIN_PASSWORD = "talos-admin";
import { SlackActivityEventHub } from "../src/application/slack-activity-events.ts";
import { migrate } from "../src/persistence/migrations.ts";

let db: Database;
let app: App;
let cookie: string;
let completedFor: { state: string; code: string } | undefined;
let markedFor: { actorId: string; conversationId: string; timestamp: string } | undefined;
let sentFor:
  | { actorId: string; conversationId: string; text: string; threadTs?: string }
  | undefined;
let reactionFor:
  | { actorId: string; conversationId: string; timestamp: string; name: string; active: boolean }
  | undefined;
let updatedFor:
  | { actorId: string; conversationId: string; timestamp: string; text: string }
  | undefined;
let deletedFor:
  | { actorId: string; conversationId: string; timestamp: string }
  | undefined;
let imagesFor:
  | { actorId: string; conversationId: string; names: string[]; text?: string }
  | undefined;
let imageDownloadFor:
  | { actorId: string; conversationId: string; fileId: string; thumbnail: boolean }
  | undefined;
let usersFor: { actorId: string; query?: string } | undefined;
let openedFor: { actorId: string; userId: string } | undefined;
let membersFor: { actorId: string; conversationId: string } | undefined;
let profileFor: { actorId: string; userId: string } | undefined;
let detailsPatchFor:
  | { actorId: string; conversationId: string; name?: string; topic?: string }
  | undefined;
let searchFor:
  | {
      actorId: string;
      conversationId: string;
      query: string;
      page: number;
      filters: Record<string, boolean>;
    }
  | undefined;
let messagesFor:
  | { actorId: string; conversationId: string; cursor?: string; focusedTs?: string }
  | undefined;

beforeEach(async () => {
  db = new Database(":memory:");
  migrate(db);
  const auth = new AuthService(db);
  cookie = (await auth.login("admin@talos.local", "talos-admin"))!.cookie.split(";")[0]!;
  const slackInbox = {
    connectionView: (userId: string) => ({
      configured: userId === "admin",
      storable: true,
      workspaceId: "T1",
      userId: "U1",
    }),
    completeOAuth: async (input: { state: string; code: string; browserNonce: string }) => {
      if (input.browserNonce !== "browser-1") throw new Error("wrong browser");
      completedFor = { state: input.state, code: input.code };
    },
    cancelOAuth: () => {},
    startOAuth: () => ({
      authorizeUrl: "https://slack.com/oauth/v2_user/authorize?state=state-1",
      browserNonce: "browser-1",
    }),
    activityRevision: () => 7,
    unreadActivityCount: () => 3,
    resync: () => {},
    markRead: async (
      actor: { id: string },
      conversationId: string,
      timestamp: string,
    ) => {
      markedFor = { actorId: actor.id, conversationId, timestamp };
    },
    sendMessage: async (
      actor: { id: string },
      conversationId: string,
      text: string,
      threadTs?: string,
    ) => {
      sentFor = {
        actorId: actor.id,
        conversationId,
        text,
        ...(threadTs ? { threadTs } : {}),
      };
      return {
        channel: conversationId,
        timestamp: "1710000000.000010",
        ...(threadTs ? { threadTs } : {}),
      };
    },
    updateMessage: async (
      actor: { id: string },
      conversationId: string,
      timestamp: string,
      text: string,
    ) => {
      updatedFor = { actorId: actor.id, conversationId, timestamp, text };
      return { channel: conversationId, timestamp };
    },
    deleteMessage: async (
      actor: { id: string },
      conversationId: string,
      timestamp: string,
    ) => {
      deletedFor = { actorId: actor.id, conversationId, timestamp };
    },
    setReaction: async (
      actor: { id: string },
      conversationId: string,
      timestamp: string,
      name: string,
      active: boolean,
    ) => {
      reactionFor = { actorId: actor.id, conversationId, timestamp, name, active };
    },
    workspaceUsers: async (actor: { id: string }, query?: string) => {
      usersFor = { actorId: actor.id, ...(query ? { query } : {}) };
      return { users: [{ id: "U2", name: "Grace" }] };
    },
    openDirectMessage: async (actor: { id: string }, userId: string) => {
      openedFor = { actorId: actor.id, userId };
      return {
        id: "D9",
        kind: "dm",
        name: "Grace",
        private: true,
        unread: false,
      };
    },
    conversationMembers: async (actor: { id: string }, conversationId: string) => {
      membersFor = { actorId: actor.id, conversationId };
      return {
        total: 2,
        members: [
          { id: "U1", name: "Ada", self: true },
          { id: "U2", name: "Grace", self: false },
        ],
      };
    },
    conversationDetails: async (_actor: { id: string }, conversationId: string) => ({
      id: conversationId,
      name: "Talos deployment",
      topic: "Deployment coordination",
      canRename: true,
      canSetTopic: true,
    }),
    updateConversationDetails: async (
      actor: { id: string },
      conversationId: string,
      patch: { name?: string; topic?: string },
    ) => {
      detailsPatchFor = { actorId: actor.id, conversationId, ...patch };
      return {
        id: conversationId,
        name: patch.name ?? "Talos deployment",
        topic: patch.topic ?? "Deployment coordination",
        canRename: true,
        canSetTopic: true,
      };
    },
    userProfile: async (actor: { id: string }, userId: string) => {
      profileFor = { actorId: actor.id, userId };
      return {
        id: userId,
        name: "Grace",
        presence: "away",
        self: false,
        timezone: "Europe/Sofia",
      };
    },
    searchConversation: async (
      actor: { id: string },
      conversationId: string,
      query: string,
      page: number,
      filters: Record<string, boolean>,
    ) => {
      searchFor = { actorId: actor.id, conversationId, query, page, filters };
      return {
        results: [
          {
            ts: "1710000000.000010",
            at: "2024-03-09T16:00:00.000Z",
            userName: "Grace",
            text: "deployment",
          },
        ],
        page,
        pageCount: 1,
        total: 1,
      };
    },
    messages: async (
      actor: { id: string },
      conversationId: string,
      cursor?: string,
      focusedTs?: string,
    ) => {
      messagesFor = {
        actorId: actor.id,
        conversationId,
        ...(cursor ? { cursor } : {}),
        ...(focusedTs ? { focusedTs } : {}),
      };
      return {
        conversation: { id: conversationId, kind: "group-dm", name: "Team", private: true },
        messages: [],
        ...(focusedTs ? { focusedTs } : {}),
      };
    },
    sendImages: async (
      actor: { id: string },
      conversationId: string,
      files: Array<{ name: string }>,
      text?: string,
    ) => {
      imagesFor = {
        actorId: actor.id,
        conversationId,
        names: files.map((file) => file.name),
        ...(text ? { text } : {}),
      };
      return { channel: conversationId, timestamp: "1710000000.000020" };
    },
    imageContent: async (
      actor: { id: string },
      conversationId: string,
      fileId: string,
      thumbnail: boolean,
    ) => {
      imageDownloadFor = {
        actorId: actor.id,
        conversationId,
        fileId,
        thumbnail,
      };
      return {
        body: new Response(new Uint8Array([1, 2, 3])).body,
        contentType: "image/png",
        filename: "screen shot.png",
        contentLength: "3",
      };
    },
  };
  app = {
    auth,
    slackInbox,
    slackActivityEvents: new SlackActivityEventHub(),
    logger: { warn: () => {}, debug: () => {}, error: () => {} },
  } as unknown as App;
});

afterEach(() => db.close());

describe("Slack API routing", () => {
  test("keeps connection state behind the TALOS session", async () => {
    const denied = await handleApiRequest(
      new Request("http://localhost/api/me/slack/connection"),
      app,
    );
    expect(denied?.status).toBe(401);

    const allowed = await handleApiRequest(
      new Request("http://localhost/api/me/slack/connection", {
        headers: { cookie },
      }),
      app,
    );
    expect(await allowed?.json()).toMatchObject({
      configured: true,
      workspaceId: "T1",
      userId: "U1",
    });
    expect(allowed?.headers.get("cache-control")).toBe("private, no-store");
    expect(allowed?.headers.get("vary")).toBe("Cookie");
  });

  test("authenticates the cross-site OAuth callback with one-time state", async () => {
    const response = await handleApiRequest(
      new Request("https://talos.example/api/auth/slack/callback?state=state-1&code=code-1", {
        headers: { cookie: "talos_slack_oauth=browser-1" },
      }),
      app,
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("https://talos.example/slack?slack=connected");
    expect(completedFor).toEqual({ state: "state-1", code: "code-1" });
    expect(response?.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("keeps the OAuth browser nonce in an HttpOnly callback cookie", async () => {
    const response = await handleApiRequest(
      new Request("https://talos.example/api/me/slack/oauth/start", {
        method: "POST",
        headers: { cookie },
      }),
      app,
    );
    const body = await response?.json();
    expect(body).toEqual({
      authorizeUrl: "https://slack.com/oauth/v2_user/authorize?state=state-1",
    });
    expect(response?.headers.get("set-cookie")).toContain(
      "talos_slack_oauth=browser-1",
    );
    expect(response?.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response?.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response?.headers.get("set-cookie")).toContain("Secure");
  });

  test("records TALOS-local read state as the session user", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/api/me/slack/read", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: "D1",
          timestamp: "1710000000.000001",
        }),
      }),
      app,
    );
    expect(response?.status).toBe(200);
    expect(markedFor).toEqual({
      actorId: "admin",
      conversationId: "D1",
      timestamp: "1710000000.000001",
    });
  });

  test("lists Slack people and opens a DM as the session user", async () => {
    const listed = await handleApiRequest(
      new Request("http://localhost/api/slack/users?q=grace", {
        headers: { cookie },
      }),
      app,
    );
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toEqual({ users: [{ id: "U2", name: "Grace" }] });
    expect(usersFor).toEqual({ actorId: "admin", query: "grace" });

    const opened = await handleApiRequest(
      new Request("http://localhost/api/slack/direct-messages", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ userId: "U2" }),
      }),
      app,
    );
    expect(opened?.status).toBe(200);
    expect(await opened?.json()).toMatchObject({ id: "D9", kind: "dm", name: "Grace" });
    expect(openedFor).toEqual({ actorId: "admin", userId: "U2" });
  });

  test("routes group members, scoped search, and focused history", async () => {
    const denied = await handleApiRequest(
      new Request("http://localhost/api/slack/conversations/G1/members"),
      app,
    );
    expect(denied?.status).toBe(401);

    const members = await handleApiRequest(
      new Request("http://localhost/api/slack/conversations/G1/members", {
        headers: { cookie },
      }),
      app,
    );
    expect(members?.status).toBe(200);
    expect(await members?.json()).toMatchObject({ total: 2 });
    expect(membersFor).toEqual({ actorId: "admin", conversationId: "G1" });

    const updatedDetails = await handleApiRequest(
      new Request("http://localhost/api/slack/conversations/G1/details", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ topic: "New topic" }),
      }),
      app,
    );
    expect(updatedDetails?.status).toBe(200);
    expect(detailsPatchFor).toEqual({
      actorId: "admin",
      conversationId: "G1",
      topic: "New topic",
    });

    const profile = await handleApiRequest(
      new Request("http://localhost/api/slack/users/U2/profile", {
        headers: { cookie },
      }),
      app,
    );
    expect(profile?.status).toBe(200);
    expect(await profile?.json()).toMatchObject({ id: "U2", name: "Grace" });
    expect(profileFor).toEqual({ actorId: "admin", userId: "U2" });

    const search = await handleApiRequest(
      new Request(
        "http://localhost/api/slack/conversations/G1/search?q=deployment&page=2&fromMe=true&includesMe=true&hasLink=true&threadsOnly=true",
        { headers: { cookie } },
      ),
      app,
    );
    expect(search?.status).toBe(200);
    expect(await search?.json()).toMatchObject({ page: 2, total: 1 });
    expect(searchFor).toEqual({
      actorId: "admin",
      conversationId: "G1",
      query: "deployment",
      page: 2,
      filters: {
        fromMe: true,
        includesMe: true,
        hasLink: true,
        threadsOnly: true,
      },
    });

    const focused = await handleApiRequest(
      new Request(
        "http://localhost/api/slack/conversations/G1/messages?focus=1710000000.000010",
        { headers: { cookie } },
      ),
      app,
    );
    expect(focused?.status).toBe(200);
    expect(await focused?.json()).toMatchObject({ focusedTs: "1710000000.000010" });
    expect(messagesFor).toEqual({
      actorId: "admin",
      conversationId: "G1",
      focusedTs: "1710000000.000010",
    });
  });

  test("posts a Slack message as the authenticated TALOS user", async () => {
    const denied = await handleApiRequest(
      new Request("http://localhost/api/slack/conversations/D1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
      app,
    );
    expect(denied?.status).toBe(401);

    const response = await handleApiRequest(
      new Request("http://localhost/api/slack/conversations/D1/messages", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          text: "reply",
          threadTs: "1710000000.000001",
        }),
      }),
      app,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      channel: "D1",
      timestamp: "1710000000.000010",
      threadTs: "1710000000.000001",
    });
    expect(sentFor).toEqual({
      actorId: "admin",
      conversationId: "D1",
      text: "reply",
      threadTs: "1710000000.000001",
    });
  });

  test("edits and deletes a Slack message as the authenticated TALOS user", async () => {
    const denied = await handleApiRequest(
      new Request("http://localhost/api/slack/conversations/D1/messages/1710000000.000010", {
        method: "DELETE",
      }),
      app,
    );
    expect(denied?.status).toBe(401);

    const updated = await handleApiRequest(
      new Request("http://localhost/api/slack/conversations/D1/messages/1710000000.000010", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "edited" }),
      }),
      app,
    );
    expect(updated?.status).toBe(200);
    expect(await updated?.json()).toEqual({
      channel: "D1",
      timestamp: "1710000000.000010",
    });
    expect(updatedFor).toEqual({
      actorId: "admin",
      conversationId: "D1",
      timestamp: "1710000000.000010",
      text: "edited",
    });

    const deleted = await handleApiRequest(
      new Request("http://localhost/api/slack/conversations/D1/messages/1710000000.000010", {
        method: "DELETE",
        headers: { cookie },
      }),
      app,
    );
    expect(deleted?.status).toBe(200);
    expect(await deleted?.json()).toEqual({ ok: true });
    expect(deletedFor).toEqual({
      actorId: "admin",
      conversationId: "D1",
      timestamp: "1710000000.000010",
    });
  });

  test("routes reactions and bounded multipart image uploads as the session user", async () => {
    const reaction = await handleApiRequest(
      new Request(
        "http://localhost/api/slack/conversations/D1/messages/1710000000.000001/reaction",
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ name: "+1", active: true }),
        },
      ),
      app,
    );
    expect(reaction?.status).toBe(200);
    expect(reactionFor).toEqual({
      actorId: "admin",
      conversationId: "D1",
      timestamp: "1710000000.000001",
      name: "+1",
      active: true,
    });

    const form = new FormData();
    form.append(
      "images",
      new File([new Uint8Array([1, 2, 3])], "clipboard.png", {
        type: "image/png",
      }),
    );
    form.set("text", "caption");
    const upload = await handleApiRequest(
      new Request("http://localhost/api/slack/conversations/D1/images", {
        method: "POST",
        headers: { cookie, "content-length": "1000" },
        body: form,
      }),
      app,
    );
    expect(upload?.status).toBe(200);
    expect(await upload?.json()).toEqual({
      channel: "D1",
      timestamp: "1710000000.000020",
    });
    expect(imagesFor).toEqual({
      actorId: "admin",
      conversationId: "D1",
      names: ["clipboard.png"],
      text: "caption",
    });
  });

  test("proxies private Slack image bytes as the session user", async () => {
    const denied = await handleApiRequest(
      new Request(
        "http://localhost/api/slack/conversations/D1/files/F1?variant=thumbnail",
      ),
      app,
    );
    expect(denied?.status).toBe(401);

    const response = await handleApiRequest(
      new Request(
        "http://localhost/api/slack/conversations/D1/files/F1?variant=thumbnail",
        { headers: { cookie } },
      ),
      app,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(response?.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response?.headers.get("content-disposition")).toContain("screen shot.png");
    expect([...new Uint8Array(await response!.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(imageDownloadFor).toEqual({
      actorId: "admin",
      conversationId: "D1",
      fileId: "F1",
      thumbnail: true,
    });
  });

  test("serves the live activity revision from local state", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/api/me/slack/activity", {
        headers: { cookie },
      }),
      app,
    );
    expect(await response?.json()).toEqual({ revision: 7, unreadCount: 3 });
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });

  test("treats a closed client connection as cancellation rather than a server error", async () => {
    app.slackInbox.connectionView = () => {
      const error = new Error("The connection was closed.");
      error.name = "AbortError";
      throw error;
    };
    const response = await handleApiRequest(
      new Request("http://localhost/api/me/slack/connection", {
        headers: { cookie },
      }),
      app,
    );
    expect(response?.status).toBe(499);
    expect(await response?.json()).toEqual({ error: "Request cancelled." });
  });

  test("streams authenticated Slack activity without polling", async () => {
    const abort = new AbortController();
    const response = await handleApiRequest(
      new Request("http://localhost/api/me/slack/activity/stream", {
        headers: { cookie },
        signal: abort.signal,
      }),
      app,
    );
    expect(response?.headers.get("content-type")).toBe("text/event-stream");
    const reader = response!.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(initial).toContain('"revision":7');
    expect(initial).toContain('"unreadCount":3');
    abort.abort();
  });
});
