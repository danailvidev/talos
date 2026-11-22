/**
 * Slack Web API client.
 *
 * One thing about this connector is unlike the others, and it is the thing to
 * know before reading: **Slack reports failure with HTTP 200.** A call with a
 * revoked token, a misspelled channel, or a channel the app was never invited to
 * comes back `200 {"ok":false,"error":"not_in_channel"}` — a perfectly successful
 * HTTP response carrying a total failure. `HttpClient` throws on status alone, so
 * it cannot see this; every call therefore goes through `call()`, which checks
 * `ok` in the body and raises the error taxonomy by hand.
 *
 * The credential is either the shared bot token (`xoxb-…`) used by release
 * announcements or a developer's user token (`xoxp-…`) used by their inbox.
 * Both are sent as `Authorization: Bearer`; the token type determines which
 * Slack identity posts the message.
 *
 * Only the write path a release announcement needs is implemented — posting a
 * message, plus the `auth.test` probe the health check uses. Nothing here reads
 * conversation history.
 */
import { ConfigError, ConnectorError, PermissionError, AuthenticationError } from "../../core/errors.ts";
import type { Logger } from "../../logging/logger.ts";
import type { SecretStore } from "../../secrets/secret-store.ts";
import { report, runCheck, type Connector, type HealthReport } from "../connector.ts";
import { HttpClient, type FetchLike, type QueryValue } from "../http.ts";
import type { z } from "zod";
import {
  AuthTestResponseSchema,
  ConversationMembersResponseSchema,
  ConversationInfoResponseSchema,
  ConversationsResponseSchema,
  FileInfoResponseSchema,
  HistoryResponseSchema,
  OpenConversationResponseSchema,
  PostMessageResponseSchema,
  SearchMessagesResponseSchema,
  SlackEnvelopeSchema,
  UploadUrlResponseSchema,
  UserGroupsListResponseSchema,
  UserInfoResponseSchema,
  UserPresenceResponseSchema,
  UsersListResponseSchema,
  type SlackConversation,
  type SlackEnvelope,
  type SlackFileInfo,
  type SlackMessage,
  type SlackSearchPage,
  type SlackUser,
  type SlackUserGroup,
} from "./types.ts";

/**
 * Posting one short message is not a long operation, and a Slack outage should
 * fail a release announcement quickly rather than hold the upload request open —
 * the caller treats a failure here as a warning, so waiting is pure cost.
 */
const TIMEOUT_MS = 10_000;

/**
 * Slack error codes that mean "the setup is wrong", each paired with what an
 * operator should actually do about it. Slack's codes are terse to the point of
 * being unhelpful on their own: `not_in_channel` in particular reads like a
 * permissions problem when the fix is a one-word Slack command.
 */
const ERROR_HINTS: Record<string, string> = {
  not_in_channel:
    "the posting identity is not a member of that channel — invite the app when " +
    "using the shared bot, or join it when using a user token",
  channel_not_found:
    "the conversation no longer exists or is not accessible to this token",
  invalid_auth: "the token was rejected — it may have been revoked or reinstalled",
  account_inactive: "the token's app was uninstalled or its account deactivated",
  token_revoked: "the token was revoked — reinstall the app and save the new one",
  missing_scope:
    "the token lacks a required OAuth scope — add the method's user scope and reconnect Slack",
  not_authed: "no token was sent at all",
  is_archived: "the channel is archived, so nothing can be posted to it",
  msg_too_long: "the message exceeded Slack's length limit",
  ratelimited: "Slack is rate limiting this app — try again shortly",
  cant_update_message:
    "Slack will not edit this message — it must be your own message",
  cant_delete_message:
    "Slack will not delete this message — it must be your own message",
  message_not_found: "that Slack message no longer exists",
  user_not_found: "that Slack user does not exist or is not visible to this token",
  cannot_dm_bot: "Slack will not open a direct message with that bot",
};

export interface SlackClientOptions {
  /** `xoxb-…` bot token or a per-user `xoxp-…` OAuth token. */
  token: string;
  fetch?: FetchLike;
  logger?: Logger;
  timeoutMs?: number;
  /** Workspace-level rate-limit bucket shared by each connected user token. */
  budgetKey?: string;
}

export interface PostMessageInput {
  /** `#releases` or a conversation ID (`C…`, `D…`, or `G…`). */
  channel: string;
  /** Slack mrkdwn message text. */
  text: string;
  /** The root message timestamp when posting a thread reply. */
  threadTs?: string;
  signal?: AbortSignal;
}

/** A posted message's identity: the pair `chat.update` needs to edit it later. */
export interface PostedMessage {
  /** The resolved channel ID, even when the request named `#releases`. */
  channel: string;
  /** Slack's message timestamp, which is also its identifier. */
  ts: string;
}

export interface SlackUploadFile {
  name: string;
  title?: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface SlackIdentity {
  teamId?: string;
  teamName?: string;
  userId?: string;
  userName?: string;
}

export class SlackClient implements Connector {
  readonly name = "slack";
  private readonly http: HttpClient;
  private readonly doFetch: FetchLike;
  private readonly authorization: string;

  constructor(options: SlackClientOptions) {
    const token = options.token.trim();
    if (!token) {
      throw new ConfigError("The Slack OAuth token is empty.");
    }
    // A pasted webhook URL is the one wrong-credential case worth naming up
    // front: it is what the Slack docs hand you first, and sent as a bearer
    // token it fails as `invalid_auth` with nothing to say the *kind* of
    // credential is wrong.
    if (token.startsWith("https://")) {
      throw new ConfigError(
        "The Slack credential looks like a webhook URL. This connector needs an OAuth token " +
          "starting with `xoxb-` or `xoxp-`.",
      );
    }
    if (!/^(?:xox[bp]-|xoxe\.xox[bp]-)/.test(token)) {
      throw new ConfigError(
        "The Slack credential does not look like a bot or user OAuth token.",
      );
    }

    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.authorization = `Bearer ${token}`;
    this.http = new HttpClient({
      baseUrl: "https://slack.com/api",
      connector: "slack",
      // Safe to log: the credential is a header, and SLACK_BOT_TOKEN is in the
      // scrubber's redacted set, unlike a webhook URL where the path is secret.
      headers: { authorization: this.authorization },
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
      fetch: this.doFetch,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.budgetKey ? { budgetKey: options.budgetKey, maxConcurrency: 4 } : {}),
    });
  }

  /** Posts a message, returning the identity needed to edit it later. */
  async postMessage(input: PostMessageInput): Promise<PostedMessage> {
    const data = await this.post(
      PostMessageResponseSchema,
      "/chat.postMessage",
      {
        channel: input.channel,
        text: input.text,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        // Slack unfurls links in the text into preview cards. For a release
        // announcement whose whole payload is a merge request link, that turns a
        // two-line message into a block of GitLab metadata nobody asked for.
        unfurl_links: false,
        unfurl_media: false,
      },
      input.signal,
    );
    return { channel: data.channel ?? input.channel, ts: data.ts ?? "" };
  }

  /** Edits a message the token's identity originally posted. */
  async updateMessage(input: {
    channel: string;
    ts: string;
    text: string;
    signal?: AbortSignal;
  }): Promise<PostedMessage> {
    const data = await this.post(
      PostMessageResponseSchema,
      "/chat.update",
      {
        channel: input.channel,
        ts: input.ts,
        text: input.text,
      },
      input.signal,
    );
    return { channel: data.channel ?? input.channel, ts: data.ts ?? input.ts };
  }

  /** Deletes a message the token's identity originally posted. */
  async deleteMessage(input: {
    channel: string;
    ts: string;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.post(
      SlackEnvelopeSchema,
      "/chat.delete",
      {
        channel: input.channel,
        ts: input.ts,
      },
      input.signal,
    );
  }

  async setReaction(input: {
    channel: string;
    timestamp: string;
    name: string;
    active: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    try {
      await this.post(
        SlackEnvelopeSchema,
        input.active ? "/reactions.add" : "/reactions.remove",
        {
          channel: input.channel,
          timestamp: input.timestamp,
          name: input.name,
        },
        input.signal,
      );
    } catch (err) {
      const expected = input.active ? "already_reacted" : "no_reaction";
      if (err instanceof ConnectorError && err.message.includes(`(${expected})`)) return;
      throw err;
    }
  }

  async uploadFiles(input: {
    channel: string;
    files: readonly SlackUploadFile[];
    initialComment?: string;
    threadTs?: string;
    signal?: AbortSignal;
  }): Promise<PostedMessage> {
    const slots = await Promise.all(
      input.files.map(async (file) => {
        const data = await this.post(
          UploadUrlResponseSchema,
          "/files.getUploadURLExternal",
          { filename: file.name, length: file.bytes.byteLength },
          input.signal,
        );
        if (!data.upload_url || !data.file_id) {
          throw new ConnectorError(
            "Slack files.getUploadURLExternal returned no upload URL or file ID.",
            { connector: this.name },
          );
        }
        return { file, uploadUrl: data.upload_url, fileId: data.file_id };
      }),
    );

    await Promise.all(
      slots.map(async ({ file, uploadUrl }) => {
        const timeout = AbortSignal.timeout(30_000);
        const signal = input.signal
          ? AbortSignal.any([input.signal, timeout])
          : timeout;
        let response: Response;
        try {
          response = await this.doFetch(uploadUrl, {
            method: "POST",
            headers: { "content-type": file.mimeType },
            body: new Blob([file.bytes], { type: file.mimeType }),
            signal,
          });
        } catch (cause) {
          if (input.signal?.aborted) throw cause;
          throw new ConnectorError("Slack image upload failed before completion.", {
            cause,
            connector: this.name,
            retryable: true,
          });
        }
        if (!response.ok) {
          throw new ConnectorError(
            `Slack image upload returned ${response.status} ${response.statusText}.`,
            { connector: this.name, status: response.status },
          );
        }
      }),
    );

    await this.post(
      SlackEnvelopeSchema,
      "/files.completeUploadExternal",
      {
        files: slots.map(({ file, fileId }) => ({
          id: fileId,
          title: file.title ?? file.name,
        })),
        channel_id: input.channel,
        ...(input.initialComment ? { initial_comment: input.initialComment } : {}),
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      },
      input.signal,
    );

    const ts = await this.waitForFileShare(
      slots[0]!.fileId,
      input.channel,
      input.threadTs,
      input.signal,
    );
    return { channel: input.channel, ts };
  }

  /**
   * Does this token work, and as whom?
   *
   * One check, not three: unlike Datadog there is no site to get wrong and no
   * separate read scope to probe. `auth.test` needs no scope at all, so it
   * answers "is this token live" cleanly, and it is the only probe available
   * that posts nothing — verifying `chat:write` for real would mean sending a
   * message to a channel, which a health check must not do.
   */
  async check(options: { signal?: AbortSignal } = {}): Promise<HealthReport> {
    const authentication = await runCheck("authentication", async () => {
      const data = await this.identity(options.signal);
      const values = [
        ...(data.teamName ? [`workspace: ${data.teamName}`] : []),
        ...(data.userName ? [`identity: ${data.userName}`] : []),
      ];
      return {
        detail: "token accepted by slack.com",
        // `chat:write` is deliberately not verified — see the doc comment.
        values: [
          ...values,
          "note: posting also needs the `chat:write` scope and the app invited " +
            "to the channel, neither of which this probe can confirm without " +
            "sending a real message",
        ],
      };
    });

    return report(this.name, [authentication]);
  }

  async identity(signal?: AbortSignal): Promise<SlackIdentity> {
    const data = await this.post(AuthTestResponseSchema, "/auth.test", {}, signal);
    return {
      ...(data.team_id ? { teamId: data.team_id } : {}),
      ...(data.team ? { teamName: data.team } : {}),
      ...(data.user_id ? { userId: data.user_id } : {}),
      ...(data.user ? { userName: data.user } : {}),
    };
  }

  async listConversations(options: {
    types?: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  } = {}): Promise<{ conversations: SlackConversation[]; nextCursor?: string }> {
    const data = await this.get(ConversationsResponseSchema, "/users.conversations", {
      exclude_archived: true,
      types: options.types ?? "public_channel,private_channel,im",
      limit: options.limit ?? 100,
      cursor: options.cursor,
    }, options.signal);
    const nextCursor = data.response_metadata?.next_cursor?.trim();
    return {
      conversations: data.channels,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async conversationHistory(options: {
    channel: string;
    cursor?: string;
    limit?: number;
    oldest?: string;
    latest?: string;
    inclusive?: boolean;
    signal?: AbortSignal;
  }): Promise<{ messages: SlackMessage[]; hasMore: boolean; nextCursor?: string }> {
    const data = await this.get(HistoryResponseSchema, "/conversations.history", {
      channel: options.channel,
      cursor: options.cursor,
      limit: options.limit ?? 30,
      oldest: options.oldest,
      latest: options.latest,
      inclusive: options.inclusive ?? false,
    }, options.signal);
    const nextCursor = data.response_metadata?.next_cursor?.trim();
    return {
      messages: data.messages,
      hasMore: data.has_more === true || !!nextCursor,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async conversationInfo(
    channel: string,
    signal?: AbortSignal,
  ): Promise<{ latestTs?: string; lastReadTs?: string; name?: string; topic?: string }> {
    const data = await this.get(
      ConversationInfoResponseSchema,
      "/conversations.info",
      { channel },
      signal,
    );
    return {
      ...(data.channel?.latest?.ts ? { latestTs: data.channel.latest.ts } : {}),
      ...(data.channel?.last_read ? { lastReadTs: data.channel.last_read } : {}),
      ...(data.channel?.name ? { name: data.channel.name } : {}),
      ...(data.channel?.topic?.value ? { topic: data.channel.topic.value } : {}),
    };
  }

  async renameConversation(
    channel: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.post(
      ConversationInfoResponseSchema,
      "/conversations.rename",
      { channel, name },
      signal,
    );
  }

  async setConversationTopic(
    channel: string,
    topic: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.post(
      ConversationInfoResponseSchema,
      "/conversations.setTopic",
      { channel, topic },
      signal,
    );
  }

  async threadReplies(options: {
    channel: string;
    threadTs: string;
    cursor?: string;
    limit?: number;
    latest?: string;
    inclusive?: boolean;
    signal?: AbortSignal;
  }): Promise<{ messages: SlackMessage[]; hasMore: boolean; nextCursor?: string }> {
    const data = await this.get(HistoryResponseSchema, "/conversations.replies", {
      channel: options.channel,
      ts: options.threadTs,
      cursor: options.cursor,
      limit: options.limit ?? 100,
      latest: options.latest,
      inclusive: options.inclusive ?? false,
    }, options.signal);
    const nextCursor = data.response_metadata?.next_cursor?.trim();
    return {
      messages: data.messages,
      hasMore: data.has_more === true || !!nextCursor,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /** Opens a 1:1 DM, or returns the existing one Slack already has. */
  async openDirectMessage(input: {
    userId: string;
    signal?: AbortSignal;
  }): Promise<{ channel: string }> {
    const data = await this.post(
      OpenConversationResponseSchema,
      "/conversations.open",
      { users: input.userId },
      input.signal,
    );
    if (!data.channel?.id) {
      throw new ConnectorError(
        "Slack conversations.open returned no conversation ID.",
        { connector: this.name },
      );
    }
    return { channel: data.channel.id };
  }

  async userInfo(userId: string, signal?: AbortSignal): Promise<SlackUser | undefined> {
    const data = await this.get(
      UserInfoResponseSchema,
      "/users.info",
      { user: userId },
      signal,
    );
    return data.user;
  }

  async userPresence(userId: string, signal?: AbortSignal): Promise<"active" | "away"> {
    const data = await this.get(
      UserPresenceResponseSchema,
      "/users.getPresence",
      { user: userId },
      signal,
    );
    return data.presence ?? "away";
  }

  async listUsers(options: {
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  } = {}): Promise<{ users: SlackUser[]; nextCursor?: string }> {
    const data = await this.get(
      UsersListResponseSchema,
      "/users.list",
      {
        cursor: options.cursor,
        limit: options.limit ?? 200,
      },
      options.signal,
    );
    const nextCursor = data.response_metadata?.next_cursor?.trim();
    return {
      users: data.members,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async listUserGroups(signal?: AbortSignal): Promise<SlackUserGroup[]> {
    const data = await this.get(
      UserGroupsListResponseSchema,
      "/usergroups.list",
      {
        include_count: false,
        include_disabled: false,
        include_users: false,
      },
      signal,
    );
    return data.usergroups;
  }

  async conversationMembers(options: {
    channel: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{ members: string[]; nextCursor?: string }> {
    const data = await this.get(
      ConversationMembersResponseSchema,
      "/conversations.members",
      {
        channel: options.channel,
        cursor: options.cursor,
        limit: options.limit ?? 100,
      },
      options.signal,
    );
    const nextCursor = data.response_metadata?.next_cursor?.trim();
    return {
      members: data.members,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async searchMessages(options: {
    query: string;
    limit?: number;
    page?: number;
    signal?: AbortSignal;
  }): Promise<SlackSearchPage> {
    const data = await this.get(
      SearchMessagesResponseSchema,
      "/search.messages",
      {
        query: options.query,
        count: options.limit ?? 100,
        page: options.page ?? 1,
        sort: "timestamp",
        sort_dir: "desc",
        highlight: false,
      },
      options.signal,
    );
    const paging = data.messages?.paging;
    return {
      matches: data.messages?.matches ?? [],
      page: paging?.page ?? options.page ?? 1,
      pageCount: paging?.pages ?? 0,
      total: paging?.total ?? 0,
    };
  }

  async fileInfo(fileId: string, signal?: AbortSignal): Promise<SlackFileInfo> {
    if (!/^F[A-Z0-9]+$/.test(fileId)) throw new ConfigError("Invalid Slack file ID.");
    const data = await this.get(
      FileInfoResponseSchema,
      "/files.info",
      { file: fileId },
      signal,
    );
    if (!data.file) {
      throw new ConnectorError("Slack files.info returned no file.", {
        connector: this.name,
      });
    }
    return data.file;
  }

  async downloadPrivateFile(url: string, signal?: AbortSignal): Promise<Response> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (cause) {
      throw new ConfigError("Slack returned an invalid private file URL.", { cause });
    }
    if (
      parsed.protocol !== "https:" ||
      (parsed.hostname !== "slack.com" && !parsed.hostname.endsWith(".slack.com"))
    ) {
      throw new ConfigError("Slack returned a private file URL outside slack.com.");
    }

    const timeout = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.doFetch(parsed.toString(), {
        headers: { authorization: this.authorization },
        signal: requestSignal,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new ConnectorError("Slack image download failed before completion.", {
        cause,
        connector: this.name,
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new ConnectorError(
        `Slack image download returned ${response.status} ${response.statusText}.`,
        {
          connector: this.name,
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        },
      );
    }
    return response;
  }

  async markConversation(options: {
    channel: string;
    timestamp: string;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.post(
      SlackEnvelopeSchema,
      "/conversations.mark",
      { channel: options.channel, ts: options.timestamp },
      options.signal,
    );
  }

  async revoke(signal?: AbortSignal): Promise<void> {
    await this.post(SlackEnvelopeSchema, "/auth.revoke", {}, signal);
  }

  private async waitForFileShare(
    fileId: string,
    channel: string,
    threadTs?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const data = await this.get(
        FileInfoResponseSchema,
        "/files.info",
        { file: fileId },
        signal,
      );
      for (const visibility of Object.values(data.file?.shares ?? {})) {
        for (const share of visibility[channel] ?? []) {
          if (!threadTs || share.thread_ts === threadTs) {
            if (share.ts) return share.ts;
          }
        }
      }
      await delay(150 * (attempt + 1), signal);
    }
    // Slack can finish malware scanning after completeUploadExternal returns.
    // This fallback keeps an already-successful upload from being reported as a
    // failure (and retried as a duplicate) while still advancing local read state.
    return slackTimestampNow();
  }

  /**
   * One Web API call, with Slack's `ok:false`-at-200 convention translated into
   * the error taxonomy.
   *
   * This is the whole reason the client does not just call `http.postJson`
   * directly. The mapping matters for retries: `ratelimited` and Slack's own
   * transient codes are worth another attempt, while a missing scope or an
   * uninvited app will fail identically forever, and `ConnectorError` defaults
   * to non-retryable for exactly that reason.
   */
  private async post<T extends SlackEnvelope>(
    schema: z.ZodType<T>,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const { data } = await this.http.postJson(schema, path, body, {
      ...(signal ? { signal } : {}),
    });
    return this.assertOk(data, "POST", path);
  }

  private async get<T extends SlackEnvelope>(
    schema: z.ZodType<T>,
    path: string,
    query: Record<string, QueryValue>,
    signal?: AbortSignal,
  ): Promise<T> {
    const { data } = await this.http.getJson(schema, path, {
      query,
      ...(signal ? { signal } : {}),
    });
    return this.assertOk(data, "GET", path);
  }

  private assertOk<T extends SlackEnvelope>(data: T, method: string, path: string): T {
    if (data.ok) return data;

    const code = data.error ?? "unknown_error";
    const hint = ERROR_HINTS[code];
    const message = `slack: ${method} ${path} returned ok:false (${code})${hint ? ` — ${hint}` : ""}`;

    if (code === "invalid_auth" || code === "not_authed" || code === "token_revoked") {
      throw new AuthenticationError(message, { connector: this.name });
    }
    if (code === "missing_scope" || code === "not_in_channel" || code === "account_inactive") {
      throw new PermissionError(message, { connector: this.name });
    }
    throw new ConnectorError(message, {
      connector: this.name,
      retryable: code === "ratelimited" || code === "service_unavailable",
    });
  }
}

function slackTimestampNow(): string {
  const now = Date.now();
  return `${Math.floor(now / 1_000)}.${String((now % 1_000) * 1_000).padStart(6, "0")}`;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Builds a client from the secret store.
 *
 * Same shape as `createDatadogClient`: the caller says which secrets matter by
 * asking for the client, and nothing else in the codebase has to know the names.
 */
export function createSlackClient(
  secrets: SecretStore,
  options: Omit<SlackClientOptions, "token"> = {},
): SlackClient {
  return new SlackClient({ ...options, token: secrets.require("SLACK_BOT_TOKEN") });
}

/**
 * The channel release announcements go to, or undefined when unset.
 *
 * Normalised to keep `#releases`, `releases` and a stray trailing space from
 * being three different channels: Slack accepts a bare name, so the leading `#`
 * is cosmetic, and an operator will type it about half the time.
 */
export function slackReleaseChannel(secrets: SecretStore): string | undefined {
  const raw = secrets.get("SLACK_RELEASE_CHANNEL")?.trim();
  return raw ? raw : undefined;
}
