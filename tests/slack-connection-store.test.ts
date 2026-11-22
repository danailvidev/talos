import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { MIGRATIONS, migrate } from "../src/persistence/migrations.ts";
import { SqliteSlackConnectionStore } from "../src/persistence/slack-connection-store.ts";
import { createCipher } from "../src/secrets/crypto.ts";
import { AuthService } from "../src/auth.ts";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const store = new SqliteSlackConnectionStore(
    db,
    createCipher("a sufficiently long test key"),
  );
  return { db, store };
}

describe("Slack connection store", () => {
  test("upgrades a database that already applied the original inbox migration", () => {
    const db = new Database(":memory:");
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 61));
    db.run(
      `INSERT INTO slack_oauth_states (state_hash, user_id, created_at, expires_at)
       VALUES ('old', 'u1', '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
    );

    migrate(db);

    const connectionColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(slack_connections)")
      .all()
      .map((column) => column.name);
    const stateColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(slack_oauth_states)")
      .all()
      .map((column) => column.name);
    expect(connectionColumns).toContain("connection_version");
    expect(stateColumns).toContain("browser_hash");
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM slack_oauth_states").get()
        ?.count,
    ).toBe(0);
    db.close();
  });

  test("encrypts OAuth tokens and returns only metadata from describe", () => {
    const { db, store } = setup();
    store.save({
      userId: "u1",
      teamId: "T1",
      teamName: "Acme",
      slackUserId: "U1",
      slackUserName: "Ada",
      accessToken: "xoxp-access-secret",
      refreshToken: "xoxe-refresh-secret",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      scopes: ["im:read", "im:history"],
    });

    const raw = db
      .query<{ access_token: string; refresh_token: string }, []>(
        "SELECT access_token, refresh_token FROM slack_connections",
      )
      .get()!;
    expect(raw.access_token).not.toContain("xoxp-access-secret");
    expect(raw.refresh_token).not.toContain("xoxe-refresh-secret");
    expect(store.describe("u1")).toMatchObject({
      teamId: "T1",
      slackUserId: "U1",
      slackUserName: "Ada",
    });
    expect(store.credential("u1")).toMatchObject({
      accessToken: "xoxp-access-secret",
      refreshToken: "xoxe-refresh-secret",
    });
    db.close();
  });

  test("keeps channel choices and read cursors isolated by user", () => {
    const { db, store } = setup();
    store.setSelectedChannels("u1", ["C1", "C2", "C1"]);
    store.setSelectedChannels("u2", ["C3"]);
    store.markRead("u1", "D1", "1710000000.000010");
    store.markRead("u1", "D1", "1710000000.000009");

    expect(store.selectedChannels("u1")).toEqual(["C1", "C2"]);
    expect(store.selectedChannels("u2")).toEqual(["C3"]);
    expect(store.readCursor("u1", "D1")).toBe("1710000000.000010");
    expect(store.readCursor("u2", "D1")).toBeUndefined();
    db.close();
  });

  test("stores conversation index metadata without message bodies", () => {
    const { db, store } = setup();
    store.replaceConversations("u1", [
      {
        conversationId: "D1",
        kind: "dm",
        name: "Grace",
        avatarUrl: "https://cdn.example/grace.png",
        peerUserId: "U2",
        private: true,
      },
    ]);
    expect(store.conversations("u1")).toMatchObject([
      {
        conversationId: "D1",
        kind: "dm",
        name: "Grace",
        peerUserId: "U2",
        private: true,
      },
    ]);
    expect(store.conversations("u2")).toEqual([]);
    const columns = Object.keys(
      db.query<Record<string, unknown>, []>("SELECT * FROM slack_conversations").get()!,
    );
    expect(columns).not.toContain("text");
    expect(columns).not.toContain("body");

    store.upsertConversation("u1", {
      conversationId: "D2",
      kind: "dm",
      name: "Nick",
      peerUserId: "U3",
      app: true,
      private: true,
    });
    expect(
      store.conversations("u1")
        .map((row) => [row.conversationId, row.peerUserId])
        .sort(),
    ).toEqual([
      ["D1", "U2"],
      ["D2", "U3"],
    ]);
    expect(store.conversations("u1").find((row) => row.conversationId === "D2")?.app)
      .toBe(true);
    expect(store.removeConversation("u1", "D2")).toBe(true);
    expect(store.removeConversation("u1", "D2")).toBe(false);
    expect(store.conversations("u1").map((row) => row.conversationId)).toEqual(["D1"]);
    store.replaceConversations("u1", [
      {
        conversationId: "D2",
        kind: "dm",
        name: "Nick",
        peerUserId: "U3",
        app: true,
        private: true,
      },
    ]);
    expect(store.conversations("u1")).toEqual([]);
    store.upsertConversation("u1", {
      conversationId: "D2",
      kind: "dm",
      name: "Nick",
      peerUserId: "U3",
      app: true,
      private: true,
    });
    expect(store.conversations("u1").map((row) => row.conversationId)).toEqual(["D2"]);
    db.close();
  });

  test("ignores hidden and uncatalogued conversations in unread activity", () => {
    const { db, store } = setup();
    const conversation = {
      conversationId: "D1",
      kind: "dm" as const,
      name: "Grace",
      peerUserId: "U2",
      private: true,
    };
    store.upsertConversation("u1", conversation);
    expect(store.recordUserActivity("u1", "D1", "1710000000.000001")).toBe(true);
    expect(store.unreadActivityCount("u1")).toBe(1);

    expect(store.removeConversation("u1", "D1")).toBe(true);
    expect(store.recordUserActivity("u1", "D1", "1710000000.000002")).toBe(false);
    expect(store.activities("u1").has("D1")).toBe(false);

    db.run(
      `INSERT INTO slack_conversation_activity
         (user_id, conversation_id, latest_ts, thread_ts, updated_at)
       VALUES ('u1', 'D2', '1710000000.000003', NULL, '2026-01-01T00:00:00.000Z')`,
    );
    expect(store.unreadActivityCount("u1")).toBe(0);

    store.upsertConversation("u1", conversation);
    expect(store.recordUserActivity("u1", "D1", "1710000000.000002")).toBe(true);
    expect(store.unreadActivityCount("u1")).toBe(1);
    db.close();
  });

  test("routes live activity by Slack identity and selected channels", () => {
    const { db, store } = setup();
    for (const [userId, slackUserId] of [
      ["talos-u1", "U1"],
      ["talos-u2", "U2"],
    ] as const) {
      store.save({
        userId,
        teamId: "T1",
        slackUserId,
        accessToken: `xoxp-${userId}`,
        scopes: [],
      });
    }
    store.setSelectedChannels("talos-u1", ["C1"]);
    store.upsertConversation("talos-u1", {
      conversationId: "C1",
      kind: "channel",
      name: "#general",
      private: false,
    });
    store.upsertConversation("talos-u2", {
      conversationId: "D2",
      kind: "dm",
      name: "Grace",
      peerUserId: "U1",
      private: true,
    });

    expect(
      store.recordWorkspaceActivity({
        teamId: "T1",
        slackUserIds: ["U1", "U2"],
        conversationId: "C1",
        conversationType: "channel",
        latestTs: "10.1",
      }),
    ).toEqual(["talos-u1"]);
    expect(
      store.recordWorkspaceActivity({
        teamId: "T1",
        slackUserIds: ["U2"],
        conversationId: "D2",
        conversationType: "im",
        latestTs: "10.2",
      }),
    ).toEqual(["talos-u2"]);
    expect(store.activityRevision("talos-u1")).toBe(1);
    expect(store.activityRevision("talos-u2")).toBe(1);
    expect(store.unreadActivityCount("talos-u1")).toBe(1);
    expect(store.unreadActivityCount("talos-u2")).toBe(1);
    store.markRead("talos-u1", "C1", "10.1");
    expect(store.unreadActivityCount("talos-u1")).toBe(0);
    expect(store.unreadActivityCount("talos-u2")).toBe(1);
    expect(store.activities("talos-u2").has("C1")).toBe(false);
    db.close();
  });

  test("OAuth states are hashed, expiring, and single-use", () => {
    const { db, store } = setup();
    const state = store.createOAuthState("u1", "browser-1");
    const row = db
      .query<{ state_hash: string }, []>("SELECT state_hash FROM slack_oauth_states")
      .get()!;
    expect(row.state_hash).not.toBe(state);
    expect(store.consumeOAuthState(state, "wrong-browser")).toBeUndefined();
    expect(store.consumeOAuthState(state, "browser-1")).toBe("u1");
    expect(store.consumeOAuthState(state, "browser-1")).toBeUndefined();

    const expired = store.createOAuthState("u2", "browser-2", -1);
    expect(store.consumeOAuthState(expired, "browser-2")).toBeUndefined();
    db.close();
  });

  test("disconnect deletes only that user's Slack state", () => {
    const { db, store } = setup();
    for (const userId of ["u1", "u2"]) {
      store.save({
        userId,
        teamId: "T1",
        slackUserId: userId.toUpperCase(),
        accessToken: `xoxp-${userId}`,
        scopes: [],
      });
      store.setSelectedChannels(userId, [`C-${userId}`]);
      store.markRead(userId, `D-${userId}`, "1.0");
    }
    const pendingState = store.createOAuthState("u1", "browser");

    expect(store.delete("u1")).toBe(true);
    expect(store.describe("u1")).toBeUndefined();
    expect(store.selectedChannels("u1")).toEqual([]);
    expect(store.consumeOAuthState(pendingState, "browser")).toBeUndefined();
    expect(store.describe("u2")).toBeDefined();
    expect(store.selectedChannels("u2")).toEqual(["C-u2"]);
    db.close();
  });

  test("an old token refresh cannot overwrite a newer reconnect", () => {
    const { db, store } = setup();
    const original = store.save({
      userId: "u1",
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-original",
      scopes: [],
    });
    store.save({
      userId: "u1",
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-reconnected",
      scopes: [],
    });

    expect(
      store.saveIfUnchanged(
        {
          userId: "u1",
          teamId: "T1",
          slackUserId: "U1",
          accessToken: "xoxp-stale-refresh",
          scopes: [],
        },
        original.connectionVersion,
      ),
    ).toBeUndefined();
    expect(store.credential("u1")?.accessToken).toBe("xoxp-reconnected");
    db.close();
  });

  test("account deletion removes every user-owned Slack row", async () => {
    const { db, store } = setup();
    const auth = new AuthService(db);
    const invitation = auth.createInvitedUser({
      name: "Slack User",
      email: "slack-user@example.com",
      roleId: "qa",
    });
    const { user } = (await auth.acceptInvitation(
      invitation.token,
      "long-test-password",
    ))!;
    store.save({
      userId: user.id,
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [],
    });
    store.setSelectedChannels(user.id, ["C1"]);
    store.markRead(user.id, "D1", "1.0");
    store.recordUserActivity(user.id, "D1", "2.0");
    store.createOAuthState(user.id, "browser");

    auth.deleteAccount(user.id);

    for (const table of [
      "slack_connections",
      "slack_channel_selections",
      "slack_read_cursors",
      "slack_conversation_activity",
      "slack_conversations",
      "slack_activity_revisions",
      "slack_oauth_states",
    ]) {
      const count = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
      expect(count?.count).toBe(0);
    }
    db.close();
  });
});
