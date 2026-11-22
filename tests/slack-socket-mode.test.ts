import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { SlackSocketModeReceiver } from "../src/connectors/slack/socket-mode.ts";
import { SLACK_REQUIRED_USER_SCOPES } from "../src/connectors/slack/oauth.ts";
import { createLogger } from "../src/logging/logger.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteSlackConnectionStore } from "../src/persistence/slack-connection-store.ts";
import { createCipher } from "../src/secrets/crypto.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { FakeHttp } from "./fixtures/http.ts";

class FakeSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({});
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe("Slack Socket Mode", () => {
  test("acks events and stores only per-user activity metadata", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const connections = new SqliteSlackConnectionStore(
      db,
      createCipher("a sufficiently long test key"),
    );
    connections.save({
      userId: "talos-u1",
      teamId: "T1",
      slackUserId: "U1",
      accessToken: "xoxp-user",
      scopes: [...SLACK_REQUIRED_USER_SCOPES],
    });
    const http = new FakeHttp([
      {
        match: "/api/apps.connections.open",
        method: "POST",
        respond: { json: { ok: true, url: "wss://socket.slack.test/1" } },
      },
      {
        match: "/api/apps.event.authorizations.list",
        method: "POST",
        respond: {
          json: {
            ok: true,
            authorizations: [{ team_id: "T1", user_id: "U1", is_bot: false }],
          },
        },
      },
    ]);
    const sockets: FakeSocket[] = [];
    const receiver = new SlackSocketModeReceiver({
      secrets: new EnvSecretStore({ SLACK_APP_TOKEN: "xapp-test" }),
      connections,
      logger: createLogger({ level: "fatal", secretValues: [] }),
      fetch: http.fetch,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 1,
    });
    receiver.start();
    await waitFor(() => sockets.length === 1);

    sockets[0]!.emit({
      envelope_id: "env-1",
      type: "events_api",
      payload: {
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev1",
        event_context: "ctx-1",
        authorizations: [{ team_id: "T1", user_id: "U1", is_bot: false }],
        event: {
          type: "message",
          channel: "D1",
          channel_type: "im",
          user: "U1",
          text: "private message body must not be stored",
          ts: "1710000000.000001",
        },
      },
    });
    await waitFor(() => connections.activityRevision("talos-u1") === 1);

    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ envelope_id: "env-1" });
    expect(http.callsTo("apps.event.authorizations.list")).toHaveLength(0);
    expect(connections.activities("talos-u1").get("D1")).toMatchObject({
      latestTs: "1710000000.000001",
    });
    expect(connections.readCursor("talos-u1", "D1")).toBeUndefined();
    const persisted = db
      .query<Record<string, unknown>, []>("SELECT * FROM slack_conversation_activity")
      .get();
    expect(JSON.stringify(persisted)).not.toContain("private message body");

    await receiver.stop();
    db.close();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("condition was not reached");
}
