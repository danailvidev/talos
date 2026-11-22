import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

import type {
  SaveSlackConnectionInput,
  SlackConnectionCredential,
  SlackConnectionRepository,
  SlackConversationActivity,
  SlackConversationMetadata,
  StoredSlackConnection,
} from "../application/ports.ts";
import { ConfigError } from "../core/errors.ts";
import type { Cipher } from "../secrets/crypto.ts";
import { fromIso, toIso } from "./database.ts";

interface ConnectionRow {
  user_id: string;
  team_id: string;
  team_name: string | null;
  slack_user_id: string;
  slack_user_name: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  scopes_json: string;
  connection_version: number;
  connected_at: string;
  updated_at: string;
}

interface ActivityRow {
  conversation_id: string;
  latest_ts: string;
  thread_ts: string | null;
  updated_at: string;
}

interface ConversationRow {
  conversation_id: string;
  kind: "dm" | "group-dm" | "channel";
  name: string;
  avatar_url: string | null;
  peer_user_id: string | null;
  is_app: number;
  is_private: number;
  updated_at: string;
}

const OAUTH_STATE_TTL_MS = 10 * 60_000;

export class SqliteSlackConnectionStore implements SlackConnectionRepository {
  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher | null,
    private readonly onActivity?: (userId: string, conversationId?: string) => void,
  ) {}

  get secretsEnabled(): boolean {
    return this.cipher != null;
  }

  connectedUserIds(): string[] {
    return this.db
      .query<{ user_id: string }, []>(
        "SELECT user_id FROM slack_connections ORDER BY user_id",
      )
      .all()
      .map((row) => row.user_id);
  }

  describe(userId: string): StoredSlackConnection | undefined {
    const row = this.row(userId);
    if (!row) return undefined;
    try {
      if (!this.cipher) throw new ConfigError("Slack connection secrets are locked.");
      this.cipher.decrypt(row.access_token);
      return toStored(row);
    } catch {
      return { ...toStored(row), unreadable: true };
    }
  }

  credential(userId: string): SlackConnectionCredential | undefined {
    const row = this.row(userId);
    if (!row) return undefined;
    if (!this.cipher) {
      throw new ConfigError(
        "Slack connections need TALOS_SECRET_KEY. Set it in config/.env and restart.",
      );
    }
    return {
      ...toStored(row),
      accessToken: this.cipher.decrypt(row.access_token),
      ...(row.refresh_token ? { refreshToken: this.cipher.decrypt(row.refresh_token) } : {}),
      ...(row.expires_at ? { expiresAt: fromIso(row.expires_at)! } : {}),
    };
  }

  save(input: SaveSlackConnectionInput): StoredSlackConnection {
    if (!this.cipher) {
      throw new ConfigError(
        "Storing a Slack connection needs TALOS_SECRET_KEY. Set it in config/.env and restart.",
      );
    }
    const accessToken = input.accessToken.trim();
    if (!accessToken) throw new ConfigError("Slack returned an empty access token.");
    const now = toIso(new Date());
    const row = this.db
      .query<ConnectionRow, (string | null)[]>(
        `INSERT INTO slack_connections
           (user_id, team_id, team_name, slack_user_id, slack_user_name,
            access_token, refresh_token, expires_at, scopes_json, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           team_id = excluded.team_id,
           team_name = excluded.team_name,
           slack_user_id = excluded.slack_user_id,
           slack_user_name = excluded.slack_user_name,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scopes_json = excluded.scopes_json,
           connection_version = slack_connections.connection_version + 1,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(
        input.userId,
        input.teamId,
        input.teamName ?? null,
        input.slackUserId,
        input.slackUserName ?? null,
        this.cipher.encrypt(accessToken),
        input.refreshToken ? this.cipher.encrypt(input.refreshToken.trim()) : null,
        input.expiresAt ? toIso(input.expiresAt) : null,
        JSON.stringify([...new Set(input.scopes)].sort()),
        now,
        now,
      );
    if (!row) throw new ConfigError("Could not store the Slack connection.");
    return toStored(row);
  }

  saveIfUnchanged(
    input: SaveSlackConnectionInput,
    expectedVersion: number,
  ): StoredSlackConnection | undefined {
    if (!this.cipher) {
      throw new ConfigError(
        "Storing a Slack connection needs TALOS_SECRET_KEY. Set it in config/.env and restart.",
      );
    }
    const now = toIso(new Date());
    const row = this.db
      .query<ConnectionRow, (string | null)[]>(
        `UPDATE slack_connections SET
           team_id = ?, team_name = ?, slack_user_id = ?, slack_user_name = ?,
           access_token = ?, refresh_token = ?, expires_at = ?, scopes_json = ?,
           connection_version = connection_version + 1, updated_at = ?
         WHERE user_id = ? AND connection_version = ?
         RETURNING *`,
      )
      .get(
        input.teamId,
        input.teamName ?? null,
        input.slackUserId,
        input.slackUserName ?? null,
        this.cipher.encrypt(input.accessToken.trim()),
        input.refreshToken ? this.cipher.encrypt(input.refreshToken.trim()) : null,
        input.expiresAt ? toIso(input.expiresAt) : null,
        JSON.stringify([...new Set(input.scopes)].sort()),
        now,
        input.userId,
        String(expectedVersion),
      );
    return row ? toStored(row) : undefined;
  }

  delete(userId: string): boolean {
    let removed = false;
    this.db.transaction(() => {
      this.db.run("DELETE FROM slack_channel_selections WHERE user_id = ?", [userId]);
      this.db.run("DELETE FROM slack_read_cursors WHERE user_id = ?", [userId]);
      this.db.run("DELETE FROM slack_oauth_states WHERE user_id = ?", [userId]);
      this.db.run("DELETE FROM slack_conversation_activity WHERE user_id = ?", [userId]);
      this.db.run("DELETE FROM slack_hidden_conversations WHERE user_id = ?", [userId]);
      this.db.run("DELETE FROM slack_conversations WHERE user_id = ?", [userId]);
      this.db.run("DELETE FROM slack_activity_revisions WHERE user_id = ?", [userId]);
      removed =
        this.db.run("DELETE FROM slack_connections WHERE user_id = ?", [userId]).changes > 0;
    })();
    return removed;
  }

  selectedChannels(userId: string): string[] {
    return this.db
      .query<{ channel_id: string }, [string]>(
        `SELECT channel_id FROM slack_channel_selections
         WHERE user_id = ? ORDER BY selected_at, channel_id`,
      )
      .all(userId)
      .map((row) => row.channel_id);
  }

  setSelectedChannels(userId: string, channelIds: readonly string[]): void {
    const unique = [...new Set(channelIds.map((id) => id.trim()).filter(Boolean))];
    const now = toIso(new Date());
    this.db.transaction(() => {
      this.db.run("DELETE FROM slack_channel_selections WHERE user_id = ?", [userId]);
      for (const channelId of unique) {
        this.db.run(
          `INSERT INTO slack_channel_selections (user_id, channel_id, selected_at)
           VALUES (?, ?, ?)`,
          [userId, channelId, now],
        );
      }
    })();
  }

  conversations(userId: string): SlackConversationMetadata[] {
    return this.db
      .query<ConversationRow, [string]>(
        `SELECT conversation_id, kind, name, avatar_url, peer_user_id, is_app,
                is_private, updated_at
           FROM slack_conversations WHERE user_id = ?`,
      )
      .all(userId)
      .map((row) => ({
        conversationId: row.conversation_id,
        kind: row.kind,
        name: row.name,
        ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
        ...(row.peer_user_id ? { peerUserId: row.peer_user_id } : {}),
        ...(row.is_app === 1 ? { app: true } : {}),
        private: row.is_private === 1,
        updatedAt: fromIso(row.updated_at)!,
      }));
  }

  replaceConversations(
    userId: string,
    conversations: readonly Omit<SlackConversationMetadata, "updatedAt">[],
  ): void {
    const now = toIso(new Date());
    const hidden = new Set(
      this.db
        .query<{ conversation_id: string }, [string]>(
          `SELECT conversation_id FROM slack_hidden_conversations
           WHERE user_id = ?`,
        )
        .all(userId)
        .map((row) => row.conversation_id),
    );
    const visible = conversations.filter(
      (conversation) => !hidden.has(conversation.conversationId),
    );
    const keep = new Set(visible.map((conversation) => conversation.conversationId));
    this.db.transaction(() => {
      this.db.run("DELETE FROM slack_conversations WHERE user_id = ?", [userId]);
      for (const conversation of visible) {
        this.db.run(
          `INSERT INTO slack_conversations
             (user_id, conversation_id, kind, name, avatar_url, peer_user_id,
              is_app, is_private, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            conversation.conversationId,
            conversation.kind,
            conversation.name,
            conversation.avatarUrl ?? null,
            conversation.peerUserId ?? null,
            conversation.app ? 1 : 0,
            conversation.private ? 1 : 0,
            now,
          ],
        );
      }
      for (const row of this.db
        .query<{ conversation_id: string }, [string]>(
          "SELECT conversation_id FROM slack_conversation_activity WHERE user_id = ?",
        )
        .all(userId)) {
        if (!keep.has(row.conversation_id)) {
          this.db.run(
            `DELETE FROM slack_conversation_activity
             WHERE user_id = ? AND conversation_id = ?`,
            [userId, row.conversation_id],
          );
        }
      }
    })();
  }

  upsertConversation(
    userId: string,
    conversation: Omit<SlackConversationMetadata, "updatedAt">,
  ): void {
    this.db.transaction(() => {
      this.db.run(
        `DELETE FROM slack_hidden_conversations
         WHERE user_id = ? AND conversation_id = ?`,
        [userId, conversation.conversationId],
      );
      this.db.run(
        `INSERT INTO slack_conversations
           (user_id, conversation_id, kind, name, avatar_url, peer_user_id,
            is_app, is_private, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, conversation_id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           avatar_url = excluded.avatar_url,
           peer_user_id = excluded.peer_user_id,
           is_app = excluded.is_app,
           is_private = excluded.is_private,
           updated_at = excluded.updated_at`,
        [
          userId,
          conversation.conversationId,
          conversation.kind,
          conversation.name,
          conversation.avatarUrl ?? null,
          conversation.peerUserId ?? null,
          conversation.app ? 1 : 0,
          conversation.private ? 1 : 0,
          toIso(new Date()),
        ],
      );
    })();
  }

  removeConversation(userId: string, conversationId: string): boolean {
    let removed = false;
    this.db.transaction(() => {
      removed =
        this.db.run(
          `DELETE FROM slack_conversations
           WHERE user_id = ? AND conversation_id = ?`,
          [userId, conversationId],
        ).changes > 0;
      if (!removed) return;
      this.db.run(
        `INSERT INTO slack_hidden_conversations
           (user_id, conversation_id, hidden_at)
         VALUES (?, ?, ?)
         ON CONFLICT (user_id, conversation_id) DO UPDATE SET
           hidden_at = excluded.hidden_at`,
        [userId, conversationId, toIso(new Date())],
      );
      this.db.run(
        `DELETE FROM slack_conversation_activity
         WHERE user_id = ? AND conversation_id = ?`,
        [userId, conversationId],
      );
      this.db.run(
        `INSERT INTO slack_activity_revisions (user_id, revision) VALUES (?, 1)
         ON CONFLICT (user_id) DO UPDATE SET revision = revision + 1`,
        [userId],
      );
    })();
    if (removed) this.onActivity?.(userId, conversationId);
    return removed;
  }

  clearConversations(userId: string): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM slack_conversations WHERE user_id = ?", [userId]);
      this.db.run("DELETE FROM slack_hidden_conversations WHERE user_id = ?", [userId]);
    })();
  }

  activities(userId: string): Map<string, SlackConversationActivity> {
    return new Map(
      this.db
        .query<ActivityRow, [string]>(
          `SELECT conversation_id, latest_ts, thread_ts, updated_at
           FROM slack_conversation_activity WHERE user_id = ?`,
        )
        .all(userId)
        .map((row) => [
          row.conversation_id,
          {
            conversationId: row.conversation_id,
            latestTs: row.latest_ts,
            ...(row.thread_ts ? { threadTs: row.thread_ts } : {}),
            updatedAt: fromIso(row.updated_at)!,
          },
        ]),
    );
  }

  seedUserActivity(userId: string, conversationId: string, latestTs: string): void {
    this.db.run(
      `INSERT INTO slack_conversation_activity
         (user_id, conversation_id, latest_ts, thread_ts, updated_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT (user_id, conversation_id) DO NOTHING`,
      [userId, conversationId, latestTs, toIso(new Date())],
    );
  }

  recordUserActivity(
    userId: string,
    conversationId: string,
    latestTs: string,
    threadTs?: string,
  ): boolean {
    let changed = false;
    this.db.transaction(() => {
      const hidden = this.db
        .query<{ hidden: number }, [string, string]>(
          `SELECT 1 AS hidden FROM slack_hidden_conversations
           WHERE user_id = ? AND conversation_id = ?`,
        )
        .get(userId, conversationId);
      if (hidden) return;
      const current = this.db
        .query<{ latest_ts: string }, [string, string]>(
          `SELECT latest_ts FROM slack_conversation_activity
           WHERE user_id = ? AND conversation_id = ?`,
        )
        .get(userId, conversationId);
      if (current && compareSlackTs(current.latest_ts, latestTs) >= 0) return;
      const now = toIso(new Date());
      this.db.run(
        `INSERT INTO slack_conversation_activity
           (user_id, conversation_id, latest_ts, thread_ts, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, conversation_id) DO UPDATE SET
           latest_ts = excluded.latest_ts,
           thread_ts = excluded.thread_ts,
           updated_at = excluded.updated_at`,
        [userId, conversationId, latestTs, threadTs ?? null, now],
      );
      this.db.run(
        `INSERT INTO slack_activity_revisions (user_id, revision) VALUES (?, 1)
         ON CONFLICT (user_id) DO UPDATE SET revision = revision + 1`,
        [userId],
      );
      changed = true;
    })();
    if (changed) this.onActivity?.(userId, conversationId);
    return changed;
  }

  recordWorkspaceActivity(input: {
    teamId: string;
    slackUserIds: readonly string[];
    conversationId: string;
    conversationType: "im" | "mpim" | "channel" | "group";
    latestTs: string;
    threadTs?: string;
  }): string[] {
    const userIds = new Set<string>();
    for (const slackUserId of new Set(input.slackUserIds)) {
      const rows = this.db
        .query<{ user_id: string }, [string, string]>(
          `SELECT user_id FROM slack_connections
           WHERE team_id = ? AND slack_user_id = ?`,
        )
        .all(input.teamId, slackUserId);
      for (const row of rows) userIds.add(row.user_id);
    }

    const changed: string[] = [];
    for (const userId of userIds) {
      const sharedChannel =
        input.conversationType === "channel" || input.conversationType === "group";
      if (
        sharedChannel &&
        !this.selectedChannels(userId).includes(input.conversationId)
      ) {
        continue;
      }
      if (
        this.recordUserActivity(
          userId,
          input.conversationId,
          input.latestTs,
          input.threadTs,
        )
      ) {
        changed.push(userId);
      }
    }
    return changed;
  }

  activityRevision(userId: string): number {
    return (
      this.db
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM slack_activity_revisions WHERE user_id = ?",
        )
        .get(userId)?.revision ?? 0
    );
  }

  unreadActivityCount(userId: string): number {
    const rows = this.db
      .query<{ latest_ts: string; last_read_ts: string | null }, [string]>(
        `SELECT activity.latest_ts, cursors.last_read_ts
           FROM slack_conversation_activity AS activity
           INNER JOIN slack_conversations AS conversations
             ON conversations.user_id = activity.user_id
            AND conversations.conversation_id = activity.conversation_id
           LEFT JOIN slack_read_cursors AS cursors
             ON cursors.user_id = activity.user_id
            AND cursors.conversation_id = activity.conversation_id
          WHERE activity.user_id = ?`,
      )
      .all(userId);
    return rows.filter(
      (row) =>
        row.last_read_ts == null || compareSlackTs(row.latest_ts, row.last_read_ts) > 0,
    ).length;
  }

  clearActivities(userId: string): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM slack_conversation_activity WHERE user_id = ?", [userId]);
      this.db.run(
        `INSERT INTO slack_activity_revisions (user_id, revision) VALUES (?, 1)
         ON CONFLICT (user_id) DO UPDATE SET revision = revision + 1`,
        [userId],
      );
    })();
    this.onActivity?.(userId);
  }

  readCursors(userId: string): Map<string, string> {
    return new Map(
      this.db
        .query<{ conversation_id: string; last_read_ts: string }, [string]>(
          `SELECT conversation_id, last_read_ts FROM slack_read_cursors
           WHERE user_id = ?`,
        )
        .all(userId)
        .map((row) => [row.conversation_id, row.last_read_ts]),
    );
  }

  readCursor(userId: string, conversationId: string): string | undefined {
    return (
      this.db
        .query<{ last_read_ts: string }, [string, string]>(
          `SELECT last_read_ts FROM slack_read_cursors
           WHERE user_id = ? AND conversation_id = ?`,
        )
        .get(userId, conversationId)?.last_read_ts ?? undefined
    );
  }

  baselineReadCursor(userId: string, conversationId: string, timestamp: string): void {
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO slack_read_cursors
         (user_id, conversation_id, last_read_ts, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, conversation_id) DO NOTHING`,
      [userId, conversationId, timestamp, now],
    );
  }

  markRead(userId: string, conversationId: string, timestamp: string): void {
    const current = this.readCursor(userId, conversationId);
    if (current && compareSlackTs(current, timestamp) >= 0) return;
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO slack_read_cursors (user_id, conversation_id, last_read_ts, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET
         last_read_ts = excluded.last_read_ts, updated_at = excluded.updated_at`,
      [userId, conversationId, timestamp, now],
    );
    this.onActivity?.(userId, conversationId);
  }

  createOAuthState(
    userId: string,
    browserNonce: string,
    ttlMs = OAUTH_STATE_TTL_MS,
  ): string {
    const state = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db.run("DELETE FROM slack_oauth_states WHERE expires_at <= ?", [toIso(new Date(now))]);
    this.db.run(
      `INSERT INTO slack_oauth_states
         (state_hash, browser_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        hashState(state),
        hashState(browserNonce),
        userId,
        toIso(new Date(now)),
        toIso(new Date(now + ttlMs)),
      ],
    );
    return state;
  }

  consumeOAuthState(state: string, browserNonce: string): string | undefined {
    const row = this.db
      .query<{ user_id: string; expires_at: string }, [string, string]>(
        `DELETE FROM slack_oauth_states WHERE state_hash = ? AND browser_hash = ?
         RETURNING user_id, expires_at`,
      )
      .get(hashState(state), hashState(browserNonce));
    if (!row || Date.parse(row.expires_at) <= Date.now()) return undefined;
    return row.user_id;
  }

  private row(userId: string): ConnectionRow | undefined {
    return (
      this.db
        .query<ConnectionRow, [string]>(
          "SELECT * FROM slack_connections WHERE user_id = ?",
        )
        .get(userId) ?? undefined
    );
  }
}

function toStored(row: ConnectionRow): StoredSlackConnection {
  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopes_json);
    if (Array.isArray(parsed)) scopes = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    scopes = [];
  }
  return {
    userId: row.user_id,
    connectionVersion: row.connection_version,
    teamId: row.team_id,
    ...(row.team_name ? { teamName: row.team_name } : {}),
    slackUserId: row.slack_user_id,
    ...(row.slack_user_name ? { slackUserName: row.slack_user_name } : {}),
    scopes,
    connectedAt: fromIso(row.connected_at)!,
    updatedAt: fromIso(row.updated_at)!,
  };
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function compareSlackTs(left: string, right: string): number {
  const split = (value: string): [string, string] => {
    const [whole = "0", fraction = ""] = value.split(".", 2);
    return [whole.replace(/^0+(?=\d)/, ""), fraction];
  };
  const [leftWhole, leftFraction] = split(left);
  const [rightWhole, rightFraction] = split(right);
  if (leftWhole.length !== rightWhole.length) return leftWhole.length - rightWhole.length;
  const whole = leftWhole.localeCompare(rightWhole);
  if (whole !== 0) return whole;
  const width = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(width, "0").localeCompare(rightFraction.padEnd(width, "0"));
}
