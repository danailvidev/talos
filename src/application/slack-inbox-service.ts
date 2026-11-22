import {
  SLACK_READ_SYNC_PREFERENCE,
  type SlackChannelView,
  type SlackConnectionView,
  type SlackConversationDetailsPatch,
  type SlackConversationDetailsView,
  type SlackConversationMembersView,
  type SlackConversationSearchFilters,
  type SlackConversationSearchView,
  type SlackConversationView,
  type SlackInboxView,
  type SlackMessageBlockView,
  type SlackMessageSendResult,
  type SlackMessageUpdateResult,
  type SlackMessageView,
  type SlackMessagesView,
  type SlackUserProfileView,
  type SlackWorkspaceUsersView,
} from "../../shared/api-contract.ts";
import { randomBytes } from "node:crypto";
import { AuthenticationError, ConfigError } from "../core/errors.ts";
import type { Actor } from "../core/actor.ts";
import { SlackClient, type SlackUploadFile } from "../connectors/slack/client.ts";
import {
  exchangeSlackUserCode,
  refreshSlackUserToken,
  slackAuthorizeUrl,
  SLACK_FILE_READ_SCOPE,
  SLACK_GROUP_DM_SCOPES,
  SLACK_FILE_SCOPES,
  SLACK_IM_WRITE_SCOPE,
  SLACK_MARK_READ_SCOPES,
  SLACK_MPIM_TOPIC_SCOPE,
  SLACK_MPIM_WRITE_SCOPE,
  SLACK_REACTIONS_SCOPE,
  SLACK_REQUIRED_USER_SCOPES,
  SLACK_SEARCH_SCOPE,
  SLACK_USERGROUPS_SCOPE,
  SLACK_USER_SCOPES,
  SLACK_WRITE_SCOPE,
} from "../connectors/slack/oauth.ts";
import type {
  SlackConversation,
  SlackMessage,
  SlackSearchMatch,
  SlackUser,
} from "../connectors/slack/types.ts";
import type { FetchLike } from "../connectors/http.ts";
import type { Logger } from "../logging/logger.ts";
import { registerSecretValues } from "../logging/logger.ts";
import type {
  SlackConnectionCredential,
  SlackConnectionRepository,
  SlackConversationActivity,
  SlackConversationMetadata,
  PreferenceRepository,
} from "./ports.ts";
import type { SecretStore } from "../secrets/secret-store.ts";

const MAX_CHANNELS = 500;
const MAX_DMS_FOR_AUTHORIZATION = 1_000;
const MAX_SELECTED_CHANNELS = 20;
const MAX_SEARCH_HISTORY_MESSAGES = 5_000;
const MAX_PRESENCE_DMS = 10;
const PRESENCE_CACHE_MS = 60_000;
const READ_CURSOR_CACHE_MS = 60_000;
const REFRESH_EARLY_MS = 60_000;
const SAFE_SLACK_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface SlackImageContent {
  body: ReadableStream<Uint8Array> | null;
  contentType: string;
  filename: string;
  contentLength?: string;
}

interface SlackInboxServiceDeps {
  connections: SlackConnectionRepository;
  preferences: PreferenceRepository;
  secrets: SecretStore;
  logger: Logger;
  fetch?: FetchLike;
}

export class SlackInboxService {
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly presenceCache = new Map<
    string,
    { online: boolean; expiresAt: number }
  >();
  private readonly readCursorChecks = new Map<string, number>();

  constructor(private readonly deps: SlackInboxServiceDeps) {}

  connectionView(userId: string): SlackConnectionView {
    const connection = this.deps.connections.describe(userId);
    const liveUpdatesConfigured = !!this.deps.secrets.get("SLACK_APP_TOKEN")?.trim();
    if (!connection) {
      return {
        configured: false,
        storable: this.deps.connections.secretsEnabled,
        liveUpdatesConfigured,
      };
    }
    return {
      configured: !connection.unreadable,
      storable: this.deps.connections.secretsEnabled,
      workspaceId: connection.teamId,
      ...(connection.teamName ? { workspaceName: connection.teamName } : {}),
      userId: connection.slackUserId,
      ...(connection.slackUserName ? { userName: connection.slackUserName } : {}),
      connectedAt: connection.connectedAt.toISOString(),
      groupDmsEnabled: supportsGroupDms(connection),
      liveUpdatesConfigured,
      reliableUnreadEnabled: connection.scopes.includes(SLACK_SEARCH_SCOPE),
      userGroupMentionsEnabled: connection.scopes.includes(SLACK_USERGROUPS_SCOPE),
      postingEnabled: connection.scopes.includes(SLACK_WRITE_SCOPE),
      reactionsEnabled: connection.scopes.includes(SLACK_REACTIONS_SCOPE),
      imageUploadsEnabled: SLACK_FILE_SCOPES.every((scope) =>
        connection.scopes.includes(scope),
      ),
      readSyncAvailable: supportsSlackReadSync(connection),
      ...(connection.unreadable ? { unreadable: true } : {}),
    };
  }

  startOAuth(actor: Actor, origin: string): { authorizeUrl: string; browserNonce: string } {
    if (!this.deps.connections.secretsEnabled) {
      throw new ConfigError(
        "Slack connections need TALOS_SECRET_KEY. Set it in config/.env and restart.",
      );
    }
    const clientId = this.deps.secrets.require("SLACK_CLIENT_ID");
    const workspaceId = this.deps.secrets.require("SLACK_WORKSPACE_ID");
    this.deps.secrets.require("SLACK_CLIENT_SECRET");
    const browserNonce = randomBytes(32).toString("base64url");
    const state = this.deps.connections.createOAuthState(actor.id, browserNonce);
    return {
      authorizeUrl: slackAuthorizeUrl({
        clientId,
        workspaceId,
        redirectUri: callbackUri(origin),
        state,
      }),
      browserNonce,
    };
  }

  async completeOAuth(input: {
    state: string;
    browserNonce: string;
    code: string;
    origin: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const userId = this.deps.connections.consumeOAuthState(input.state, input.browserNonce);
    if (!userId) throw new ConfigError("This Slack connection link is invalid or has expired.");

    const tokens = await exchangeSlackUserCode({
      clientId: this.deps.secrets.require("SLACK_CLIENT_ID"),
      clientSecret: this.deps.secrets.require("SLACK_CLIENT_SECRET"),
      code: input.code,
      redirectUri: callbackUri(input.origin),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const expectedTeam = this.deps.secrets.require("SLACK_WORKSPACE_ID").trim();
    const missing = SLACK_REQUIRED_USER_SCOPES.filter(
      (scope) => !tokens.scopes.includes(scope),
    );
    if (missing.length > 0) {
      throw new ConfigError(
        `Slack did not grant the required read scopes: ${missing.join(", ")}. Reinstall the app with those user scopes.`,
      );
    }

    const client = new SlackClient({
      token: tokens.accessToken,
      logger: this.deps.logger,
      budgetKey: `workspace:${expectedTeam}`,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
    const identity = await client.identity(input.signal);
    const connectedTeam = identity.teamId ?? tokens.teamId;
    const connectedUser = identity.userId ?? tokens.userId;
    if (!connectedTeam || !connectedUser) {
      throw new ConfigError("Slack accepted the token but did not identify its user or workspace.");
    }
    if (connectedTeam !== expectedTeam) {
      throw new ConfigError(
        `Slack connected workspace ${connectedTeam}, but this TALOS install accepts only ${expectedTeam}.`,
      );
    }
    registerSecretValues([
      tokens.accessToken,
      ...(tokens.refreshToken ? [tokens.refreshToken] : []),
    ]);
    const previous = this.deps.connections.describe(userId);
    this.deps.connections.save({
      userId,
      teamId: connectedTeam,
      teamName: identity.teamName ?? tokens.teamName,
      slackUserId: connectedUser,
      slackUserName: identity.userName,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    });
    if (
      previous &&
      (previous.teamId !== connectedTeam || previous.slackUserId !== connectedUser)
    ) {
      this.deps.connections.clearConversations(userId);
      this.deps.connections.clearActivities(userId);
    }
  }

  async disconnect(userId: string, signal?: AbortSignal): Promise<boolean> {
    const connection = this.deps.connections.credential(userId);
    if (!connection) return false;
    try {
      await new SlackClient({
        token: connection.accessToken,
        logger: this.deps.logger,
        budgetKey: `workspace:${connection.teamId}`,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      }).revoke(signal);
    } catch (err) {
      // Local removal is the privacy boundary TALOS controls. A revoked or
      // temporarily unreachable Slack token must not trap its ciphertext here.
      this.deps.logger.warn(
        { userId, err: err instanceof Error ? err.message : String(err) },
        "could not revoke Slack token before disconnecting it locally",
      );
    }
    return this.deps.connections.delete(userId);
  }

  cancelOAuth(state: string, browserNonce: string): void {
    if (state && browserNonce) this.deps.connections.consumeOAuthState(state, browserNonce);
  }

  activityRevision(userId: string): number {
    return this.deps.connections.activityRevision(userId);
  }

  unreadActivityCount(userId: string): number {
    return this.deps.connections.unreadActivityCount(userId);
  }

  resync(userId: string): void {
    this.deps.connections.clearConversations(userId);
    this.deps.connections.clearActivities(userId);
    for (const key of this.readCursorChecks.keys()) {
      if (key.startsWith(`${userId}:`)) this.readCursorChecks.delete(key);
    }
  }

  async pollRecentActivity(
    signal?: AbortSignal,
    activeUserIds?: readonly string[],
  ): Promise<void> {
    const userIds = activeUserIds ?? this.deps.connections.connectedUserIds();
    for (const userId of userIds) {
      if (signal?.aborted) return;
      const metadata = this.deps.connections.describe(userId);
      if (
        !metadata ||
        !metadata.scopes.includes(SLACK_SEARCH_SCOPE) ||
        this.deps.connections.activities(userId).size === 0
      ) {
        continue;
      }
      try {
        const { client } = await this.clientFor(userId, signal);
        await this.syncRecentActivityForUser(userId, client, signal);
      } catch (err) {
        this.deps.logger.warn(
          { userId, err: err instanceof Error ? err.message : String(err) },
          "Slack recent-message sync failed",
        );
      }
    }
  }

  async channels(actor: Actor, signal?: AbortSignal): Promise<SlackChannelView[]> {
    const { client } = await this.clientFor(actor.id, signal);
    const selected = new Set(this.deps.connections.selectedChannels(actor.id));
    const channels = await this.allConversations(
      client,
      "public_channel,private_channel",
      MAX_CHANNELS,
      signal,
    );
    return channels
      .filter((channel) => !!channel.name)
      .map((channel) => ({
        id: channel.id,
        name: channel.name!,
        private: channel.is_private === true,
        selected: selected.has(channel.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async setChannels(
    actor: Actor,
    channelIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<SlackChannelView[]> {
    const unique = [...new Set(channelIds.map((id) => id.trim()).filter(Boolean))];
    if (unique.length > MAX_SELECTED_CHANNELS) {
      throw new ConfigError(`Select at most ${MAX_SELECTED_CHANNELS} Slack channels.`);
    }
    const available = await this.channels(actor, signal);
    const allowed = new Set(available.map((channel) => channel.id));
    const invalid = unique.filter((id) => !allowed.has(id));
    if (invalid.length > 0) {
      throw new ConfigError("One or more selected Slack channels are no longer accessible.");
    }
    this.deps.connections.setSelectedChannels(actor.id, unique);
    const privateConversations = this.deps.connections
      .conversations(actor.id)
      .filter((conversation) => conversation.kind !== "channel")
      .map(({ updatedAt: _updatedAt, ...conversation }) => conversation);
    const selectedChannels = available
      .filter((channel) => unique.includes(channel.id))
      .map((channel) => ({
        conversationId: channel.id,
        kind: "channel" as const,
        name: `#${channel.name}`,
        private: channel.private,
      }));
    this.deps.connections.replaceConversations(actor.id, [
      ...privateConversations,
      ...selectedChannels,
    ]);
    return available.map((channel) => ({ ...channel, selected: unique.includes(channel.id) }));
  }

  async inbox(
    actor: Actor,
    _cursor?: string,
    signal?: AbortSignal,
  ): Promise<SlackInboxView> {
    const storedConversations = this.deps.connections.conversations(actor.id);
    const storedActivity = this.deps.connections.activities(actor.id);
    const knownIds = new Set(
      storedConversations.map((conversation) => conversation.conversationId),
    );
    const hasUnknownActivity = [...storedActivity.keys()].some(
      (conversationId) => !knownIds.has(conversationId),
    );
    if (storedConversations.length > 0 && !hasUnknownActivity) {
      const missingActivity = storedConversations.filter(
        (conversation) => !storedActivity.has(conversation.conversationId),
      );
      let presenceClient: SlackClient | undefined;
      if (missingActivity.length > 0) {
        const { client } = await this.clientFor(actor.id, signal);
        presenceClient = client;
        await this.backfillConversationActivity(
          actor.id,
          client,
          missingActivity,
          signal,
        );
      } else {
        try {
          presenceClient = (await this.clientFor(actor.id, signal)).client;
        } catch (err) {
          this.deps.logger.warn(
            { userId: actor.id, err: err instanceof Error ? err.message : String(err) },
            "could not refresh Slack presence",
          );
        }
      }
      return this.localInbox(
        actor.id,
        storedConversations,
        this.deps.connections.activities(actor.id),
        presenceClient,
        signal,
      );
    }

    const { client, connection } = await this.clientFor(actor.id, signal);
    // Slack orders users.conversations by its own opaque "priority", not by
    // latest message. Ranking only its first page is why a 20-day-old DM could
    // appear while yesterday's was absent. Enumerate the user's DMs first, then
    // read one latest message from each and sort that complete set.
    const directMessages = (
      await this.allConversations(
        client,
        privateConversationTypes(connection),
        MAX_DMS_FOR_AUTHORIZATION,
        signal,
      )
    ).filter((conversation) => conversation.is_user_deleted !== true);
    const selectedIds = new Set(this.deps.connections.selectedChannels(actor.id));
    const selectedChannels = (await this.allConversations(
      client,
      "public_channel,private_channel",
      MAX_CHANNELS,
      signal,
    )).filter((channel) => selectedIds.has(channel.id));
    const conversations = [...selectedChannels, ...directMessages];
    if (connection.scopes.includes(SLACK_SEARCH_SCOPE)) {
      try {
        await this.syncRecentActivityForUser(actor.id, client, signal);
      } catch (err) {
        this.deps.logger.warn(
          { userId: actor.id, err: err instanceof Error ? err.message : String(err) },
          "could not seed Slack activity from search during catalog refresh",
        );
      }
    }
    const activities = this.deps.connections.activities(actor.id);
    const users = new Map<string, Promise<SlackUser | undefined>>();
    try {
      for (const user of await this.allUsers(client, signal)) {
        users.set(user.id, Promise.resolve(user));
      }
    } catch (err) {
      // A bulk profile failure must not hide the inbox. Presentation falls back
      // to the existing per-user lookup path for the conversations being shown.
      this.deps.logger.warn(
        { userId: actor.id, err: err instanceof Error ? err.message : String(err) },
        "could not preload Slack user profiles",
      );
    }
    const summaries = await mapConcurrent(conversations, 4, async (conversation) => {
      try {
        return await this.summary(
          actor.id,
          connection.slackUserId,
          client,
          conversation,
          activities.get(conversation.id),
          users,
          signal,
        );
      } catch (err) {
        if (err instanceof AuthenticationError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        const context = {
          userId: actor.id,
          conversation: conversation.id,
          err: message,
        };
        if (message.includes("(channel_not_found)")) {
          // Slack can retain a closed/deleted DM in users.conversations after
          // history access is gone. It is an omitted stale row, not an operator
          // problem worth warning about on every refresh.
          this.deps.logger.debug(context, "skipped an inaccessible Slack conversation");
        } else {
          this.deps.logger.warn(context, "could not read one Slack inbox summary");
        }
        return undefined;
      }
    });
    const available = summaries.filter(
      (summary): summary is SlackConversationView => summary != null,
    );
    const peerUserIds = new Map(
      directMessages.flatMap((conversation) =>
        conversation.is_im && conversation.user
          ? [[conversation.id, conversation.user] as const]
          : [],
      ),
    );
    this.deps.connections.replaceConversations(
      actor.id,
      available.map((conversation) => ({
        conversationId: conversation.id,
        kind: conversation.kind,
        name: conversation.name,
        ...(conversation.avatarUrl ? { avatarUrl: conversation.avatarUrl } : {}),
        ...(conversation.app ? { app: true } : {}),
        ...(peerUserIds.get(conversation.id)
          ? { peerUserId: peerUserIds.get(conversation.id)! }
          : {}),
        private: conversation.private,
      })),
    );
    const catalog = this.deps.connections.conversations(actor.id);
    const currentActivity = this.deps.connections.activities(actor.id);
    const missingActivity = catalog.filter(
      (conversation) => !currentActivity.has(conversation.conversationId),
    );
    if (missingActivity.length > 0) {
      await this.backfillConversationActivity(
        actor.id,
        client,
        missingActivity,
        signal,
      );
    }
    return this.localInbox(
      actor.id,
      catalog,
      this.deps.connections.activities(actor.id),
      client,
      signal,
    );
  }

  private async localInbox(
    userId: string,
    conversations: readonly SlackConversationMetadata[],
    activities: ReadonlyMap<string, SlackConversationActivity>,
    client?: SlackClient,
    signal?: AbortSignal,
  ): Promise<SlackInboxView> {
    const readCursors = this.deps.connections.readCursors(userId);
    if (client) {
      await this.syncSlackReadCursors(
        userId,
        client,
        conversations,
        activities,
        readCursors,
        signal,
      );
    }
    const views = conversations.map((conversation): SlackConversationView => {
      const activity = activities.get(conversation.conversationId);
      const readTs = readCursors.get(conversation.conversationId);
      return {
        id: conversation.conversationId,
        kind: conversation.kind,
        name: conversation.name,
        ...(conversation.avatarUrl ? { avatarUrl: conversation.avatarUrl } : {}),
        ...(conversation.app ? { app: true } : {}),
        private: conversation.private,
        unread:
          activity != null &&
          (!readTs || compareSlackTs(activity.latestTs, readTs) > 0),
        ...(activity
          ? {
              latestTs: activity.latestTs,
              latestAt: slackTimestampDate(activity.latestTs).toISOString(),
            }
          : {}),
      };
    });
    const sortedViews = sortConversationViews(views);
    const metadataById = new Map(
      conversations.map((conversation) => [conversation.conversationId, conversation]),
    );
    const presenceByConversation = new Map<string, boolean>();
    if (client) {
      const targets = sortedViews
        .filter((conversation) => conversation.kind === "dm" && !conversation.app)
        .slice(0, MAX_PRESENCE_DMS)
        .flatMap((conversation) => {
          const peerUserId = metadataById.get(conversation.id)?.peerUserId;
          return peerUserId ? [{ conversationId: conversation.id, peerUserId }] : [];
        });
      await mapConcurrent(targets, 4, async ({ conversationId, peerUserId }) => {
        const online = await this.cachedPresence(userId, client, peerUserId, signal);
        if (online != null) presenceByConversation.set(conversationId, online);
        return undefined;
      });
    }
    return {
      connection: this.connectionView(userId),
      conversations: sortedViews.map((conversation) => {
        const online = presenceByConversation.get(conversation.id);
        return online == null ? conversation : { ...conversation, online };
      }),
    };
  }

  private async syncSlackReadCursors(
    userId: string,
    client: SlackClient,
    conversations: readonly SlackConversationMetadata[],
    activities: ReadonlyMap<string, SlackConversationActivity>,
    readCursors: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const now = Date.now();
    const targets = conversations.filter((conversation) => {
      const activity = activities.get(conversation.conversationId);
      const readTs = readCursors.get(conversation.conversationId);
      if (!activity || !readTs || compareSlackTs(activity.latestTs, readTs) <= 0) {
        return false;
      }
      const key = `${userId}:${conversation.conversationId}`;
      return (this.readCursorChecks.get(key) ?? 0) <= now;
    });
    await mapConcurrent(targets, 4, async (conversation) => {
      const key = `${userId}:${conversation.conversationId}`;
      this.readCursorChecks.set(key, now + READ_CURSOR_CACHE_MS);
      try {
        const { lastReadTs } = await client.conversationInfo(
          conversation.conversationId,
          signal,
        );
        const localReadTs = readCursors.get(conversation.conversationId);
        if (
          lastReadTs &&
          (!localReadTs || compareSlackTs(lastReadTs, localReadTs) > 0)
        ) {
          this.deps.connections.markRead(
            userId,
            conversation.conversationId,
            lastReadTs,
          );
          readCursors.set(conversation.conversationId, lastReadTs);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const context = {
          userId,
          conversation: conversation.conversationId,
          err: message,
        };
        if (message.includes("(channel_not_found)")) {
          this.deps.logger.debug(context, "skipped inaccessible Slack read metadata");
        } else {
          this.deps.logger.warn(context, "could not read Slack read metadata");
        }
      }
      return undefined;
    });
  }

  private async backfillConversationActivity(
    userId: string,
    client: SlackClient,
    conversations: readonly SlackConversationMetadata[],
    signal?: AbortSignal,
  ): Promise<void> {
    await mapConcurrent(conversations, 4, async (conversation) => {
      let latestTs = "0.0";
      try {
        latestTs =
          (await client.conversationInfo(conversation.conversationId, signal)).latestTs ??
          latestTs;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const context = {
          userId,
          conversation: conversation.conversationId,
          err: message,
        };
        if (message.includes("(channel_not_found)")) {
          this.deps.logger.debug(context, "skipped inaccessible Slack recency metadata");
        } else {
          this.deps.logger.warn(context, "could not read Slack recency metadata");
        }
      }
      this.deps.connections.seedUserActivity(
        userId,
        conversation.conversationId,
        latestTs,
      );
      this.deps.connections.baselineReadCursor(
        userId,
        conversation.conversationId,
        latestTs,
      );
      return undefined;
    });
  }

  async messages(
    actor: Actor,
    conversationId: string,
    cursor?: string,
    focusedTs?: string,
    signal?: AbortSignal,
  ): Promise<SlackMessagesView> {
    if (focusedTs) validateSlackTimestamp(focusedTs, "message");
    const { client, connection } = await this.clientFor(actor.id, signal);
    const metadata = this.deps.connections
      .conversations(actor.id)
      .find((conversation) => conversation.conversationId === conversationId);
    const conversation = metadata
      ? undefined
      : await this.authorizedConversation(
          actor.id,
          client,
          conversationId,
          supportsGroupDms(connection),
          signal,
        );
    const page = await client.conversationHistory({
      channel: conversationId,
      cursor,
      limit: 30,
      ...(focusedTs ? { latest: focusedTs, inclusive: true } : {}),
      signal,
    });
    const users = new Map<string, Promise<SlackUser | undefined>>();
    const presentation = conversation
      ? await this.conversationPresentation(
          client,
          conversation,
          connection.slackUserId,
          users,
          signal,
        )
      : undefined;
    return {
      conversation: {
        id: conversationId,
        kind: metadata?.kind ?? conversationKind(conversation!),
        name: metadata?.name ?? presentation!.name,
        private:
          metadata?.private ??
          (conversation!.is_private === true ||
            conversation!.is_im === true ||
            conversation!.is_mpim === true),
      },
      messages: await this.messageViews(
        client,
        page.messages,
        connection.slackUserId,
        users,
        connection.scopes.includes(SLACK_USERGROUPS_SCOPE),
        signal,
      ),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(focusedTs ? { focusedTs } : {}),
    };
  }

  async thread(
    actor: Actor,
    conversationId: string,
    threadTs: string,
    cursor?: string,
    focusedTs?: string,
    signal?: AbortSignal,
  ): Promise<SlackMessagesView> {
    if (focusedTs) validateSlackTimestamp(focusedTs, "message");
    const { client, connection } = await this.clientFor(actor.id, signal);
    const metadata = this.deps.connections
      .conversations(actor.id)
      .find((conversation) => conversation.conversationId === conversationId);
    const conversation = metadata
      ? undefined
      : await this.authorizedConversation(
          actor.id,
          client,
          conversationId,
          supportsGroupDms(connection),
          signal,
        );
    const page = await client.threadReplies({
      channel: conversationId,
      threadTs,
      cursor,
      limit: 100,
      ...(focusedTs ? { latest: focusedTs, inclusive: true } : {}),
      signal,
    });
    const users = new Map<string, Promise<SlackUser | undefined>>();
    const presentation = conversation
      ? await this.conversationPresentation(
          client,
          conversation,
          connection.slackUserId,
          users,
          signal,
        )
      : undefined;
    return {
      conversation: {
        id: conversationId,
        kind: metadata?.kind ?? conversationKind(conversation!),
        name: metadata?.name ?? presentation!.name,
        private:
          metadata?.private ??
          (conversation!.is_private === true ||
            conversation!.is_im === true ||
            conversation!.is_mpim === true),
      },
      messages: await this.messageViews(
        client,
        page.messages,
        connection.slackUserId,
        users,
        connection.scopes.includes(SLACK_USERGROUPS_SCOPE),
        signal,
      ),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(focusedTs ? { focusedTs } : {}),
    };
  }

  async imageContent(
    actor: Actor,
    conversationId: string,
    fileId: string,
    thumbnail: boolean,
    signal?: AbortSignal,
  ): Promise<SlackImageContent> {
    validateConversationId(conversationId);
    if (!/^F[A-Z0-9]+$/.test(fileId)) {
      throw new ConfigError("Invalid Slack file ID.");
    }
    const { client, connection } = await this.clientFor(actor.id, signal);
    if (!connection.scopes.includes(SLACK_FILE_READ_SCOPE)) {
      throw new ConfigError(
        "Your Slack connection is missing files:read. Add that user scope and reconnect.",
      );
    }
    const inInbox = this.deps.connections
      .conversations(actor.id)
      .some((conversation) => conversation.conversationId === conversationId);
    if (!inInbox) {
      throw new ConfigError("That Slack conversation is not part of your TALOS inbox.");
    }

    const file = await client.fileInfo(fileId, signal);
    if (!fileSharedToConversation(file.shares, conversationId)) {
      throw new ConfigError("That Slack image is not shared in this conversation.");
    }
    const contentType = file.mimetype?.split(";", 1)[0]?.trim().toLowerCase();
    if (!contentType || !SAFE_SLACK_IMAGE_TYPES.has(contentType)) {
      throw new ConfigError("That Slack attachment is not a supported image.");
    }
    const source =
      (thumbnail ? file.thumb_360 : undefined) ??
      file.url_private_download ??
      file.url_private;
    if (!source) throw new ConfigError("Slack returned no downloadable URL for this image.");

    const response = await client.downloadPrivateFile(source, signal);
    const contentLength = response.headers.get("content-length")?.trim();
    return {
      body: response.body,
      contentType,
      filename: file.name?.trim() || "slack-image",
      ...(contentLength ? { contentLength } : {}),
    };
  }

  async conversationMembers(
    actor: Actor,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<SlackConversationMembersView> {
    validateConversationId(conversationId);
    const { client, connection } = await this.clientFor(actor.id, signal);
    const conversation = await this.authorizedConversation(
      actor.id,
      client,
      conversationId,
      supportsGroupDms(connection),
      signal,
    );
    if (conversationKind(conversation) !== "group-dm") {
      throw new ConfigError("Member details are available for Slack group messages only.");
    }

    const memberIds = await this.allConversationMembers(client, conversationId, signal);
    const users = new Map<string, Promise<SlackUser | undefined>>();
    const members = await mapConcurrent(memberIds, 4, async (id) => {
      const [user, online] = await Promise.all([
        this.cachedUser(client, id, users, signal),
        this.cachedPresence(actor.id, client, id, signal),
      ]);
      return {
        id,
        name: displayName(user) || id,
        ...(user?.name ? { username: user.name } : {}),
        ...(user?.profile?.image_48 ? { avatarUrl: user.profile.image_48 } : {}),
        ...(online != null ? { online } : {}),
        ...(user?.profile?.email ? { email: user.profile.email } : {}),
        self: id === connection.slackUserId,
      };
    });
    members.sort((left, right) => {
      if (left.self !== right.self) return left.self ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return { members, total: memberIds.length };
  }

  async conversationDetails(
    actor: Actor,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<SlackConversationDetailsView> {
    validateConversationId(conversationId);
    const { client, connection } = await this.clientFor(actor.id, signal);
    const conversation = await this.authorizedConversation(
      actor.id,
      client,
      conversationId,
      supportsGroupDms(connection),
      signal,
    );
    if (conversationKind(conversation) !== "group-dm") {
      throw new ConfigError("Conversation details are available for Slack group messages only.");
    }
    const metadata = this.deps.connections
      .conversations(actor.id)
      .find((candidate) => candidate.conversationId === conversationId);
    const info = await client.conversationInfo(conversationId, signal);
    return {
      id: conversationId,
      name: metadata?.name ?? info.name ?? conversation.name ?? conversationId,
      ...(info.topic ? { topic: info.topic } : {}),
      canRename: connection.scopes.includes(SLACK_MPIM_WRITE_SCOPE),
      canSetTopic: connection.scopes.includes(SLACK_MPIM_TOPIC_SCOPE),
    };
  }

  async updateConversationDetails(
    actor: Actor,
    conversationId: string,
    patch: SlackConversationDetailsPatch,
    signal?: AbortSignal,
  ): Promise<SlackConversationDetailsView> {
    if (patch.name == null && patch.topic == null) {
      throw new ConfigError("Provide a conversation name or topic.");
    }
    const { client, connection } = await this.clientFor(actor.id, signal);
    const conversation = await this.authorizedConversation(
      actor.id,
      client,
      conversationId,
      supportsGroupDms(connection),
      signal,
    );
    if (conversationKind(conversation) !== "group-dm") {
      throw new ConfigError("Only Slack group-message details can be changed here.");
    }
    const metadata = this.deps.connections
      .conversations(actor.id)
      .find((candidate) => candidate.conversationId === conversationId);
    if (patch.name != null) {
      const name = patch.name.trim();
      if (!name || name.length > 80) {
        throw new ConfigError("Conversation name must contain between 1 and 80 characters.");
      }
      if (!connection.scopes.includes(SLACK_MPIM_WRITE_SCOPE)) {
        throw new ConfigError("Reconnect Slack with mpim:write to rename this conversation.");
      }
      await client.renameConversation(conversationId, name, signal);
      if (metadata) {
        this.deps.connections.upsertConversation(actor.id, { ...metadata, name });
      }
    }
    if (patch.topic != null) {
      const topic = patch.topic.trim();
      if (topic.length > 250) {
        throw new ConfigError("Conversation topic must be at most 250 characters.");
      }
      if (!connection.scopes.includes(SLACK_MPIM_TOPIC_SCOPE)) {
        throw new ConfigError(
          "Reconnect Slack with mpim:write.topic to edit this conversation topic.",
        );
      }
      await client.setConversationTopic(conversationId, topic, signal);
    }
    return this.conversationDetails(actor, conversationId, signal);
  }

  async searchConversation(
    actor: Actor,
    conversationId: string,
    query: string,
    page = 1,
    filters: SlackConversationSearchFilters = {},
    signal?: AbortSignal,
  ): Promise<SlackConversationSearchView> {
    validateConversationId(conversationId);
    const needle = query.trim();
    if (!needle || needle.length > 100) {
      throw new ConfigError("Slack message search must contain between 1 and 100 characters.");
    }
    if (!Number.isInteger(page) || page < 1 || page > 100) {
      throw new ConfigError("Slack message search page must be between 1 and 100.");
    }
    const { client, connection } = await this.clientFor(actor.id, signal);
    if (!connection.scopes.includes(SLACK_SEARCH_SCOPE)) {
      throw new ConfigError(
        "Your Slack connection is missing search:read. Reconnect under My provider access.",
      );
    }
    const conversation = await this.authorizedConversation(
      actor.id,
      client,
      conversationId,
      supportsGroupDms(connection),
      signal,
    );
    if (conversationKind(conversation) !== "group-dm") {
      throw new ConfigError("Conversation search is available for Slack group messages only.");
    }

    const metadata = this.deps.connections
      .conversations(actor.id)
      .find((candidate) => candidate.conversationId === conversationId);
    const conversationModifier = slackSearchInModifier(
      metadata?.name ?? conversation.name,
    );
    const rawConversationModifier = slackSearchInModifier(conversation.name);
    const filtersQuery = [
      ...(filters.fromMe ? [`from:<@${connection.slackUserId}>`] : []),
      ...(filters.includesMe ? [`with:<@${connection.slackUserId}>`] : []),
      ...(filters.hasLink ? ["has:link"] : []),
      ...(filters.threadsOnly ? ["is:thread"] : []),
    ];
    let search: Awaited<ReturnType<SlackClient["searchMessages"]>> | undefined;
    let matches: SlackSearchMatch[] = [];
    try {
      search = await client.searchMessages({
        query: [needle, conversationModifier, ...filtersQuery]
          .filter((part): part is string => part != null)
          .join(" "),
        limit: 100,
        page,
        signal,
      });
      matches = search.matches.filter(
        (match) => match.channel.id === conversationId,
      );
      // Slack's legacy search parser differs between named group DMs and older
      // generated MPIM names. Prefer the title users see, then retry with Slack's
      // raw MPIM name only when the first scope produced no matches.
      if (
        matches.length === 0 &&
        rawConversationModifier &&
        rawConversationModifier !== conversationModifier
      ) {
        search = await client.searchMessages({
          query: [needle, rawConversationModifier, ...filtersQuery].join(" "),
          limit: 100,
          page,
          signal,
        });
        matches = search.matches.filter(
          (match) => match.channel.id === conversationId,
        );
      }
    } catch (err) {
      this.deps.logger.warn(
        {
          userId: actor.id,
          conversation: conversationId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Slack message search failed; falling back to conversation history",
      );
    }
    if (matches.length === 0) {
      return this.searchConversationHistory(
        client,
        connection,
        conversationId,
        needle,
        page,
        filters,
        signal,
      );
    }
    const users = new Map<string, Promise<SlackUser | undefined>>();
    const results = await mapConcurrent(matches, 4, async (match) => {
      const user = match.user
        ? await this.cachedUser(client, match.user, users, signal)
        : undefined;
      const referencedUsers = await Promise.all(
        mentionIds(match.text).map(async (id) => ({
          id,
          user: await this.cachedUser(client, id, users, signal),
        })),
      );
      const mentions = Object.fromEntries(
        referencedUsers.map(({ id, user: referenced }) => [
          id,
          displayName(referenced) || id,
        ]),
      );
      return {
        ts: match.ts,
        at: slackTimestampDate(match.ts).toISOString(),
        ...(match.user ? { userId: match.user } : {}),
        userName: displayName(user) || match.username || "Slack app",
        ...(user?.profile?.image_48 ? { avatarUrl: user.profile.image_48 } : {}),
        text: match.text,
        ...(Object.keys(mentions).length > 0 ? { mentions } : {}),
        ...(match.thread_ts ? { threadTs: match.thread_ts } : {}),
      };
    });
    return {
      results,
      page: search!.page,
      pageCount: search!.pageCount,
      total: search!.total,
    };
  }

  async workspaceUsers(
    actor: Actor,
    query?: string,
    signal?: AbortSignal,
  ): Promise<SlackWorkspaceUsersView> {
    const needle = query?.trim().toLowerCase() ?? "";
    if (needle.length > 100) {
      throw new ConfigError("Slack user search must be at most 100 characters.");
    }
    const { client, connection } = await this.clientFor(actor.id, signal);
    const users = (await this.allUsers(client, signal)).filter(
      (user) =>
        user.id !== connection.slackUserId &&
        user.deleted !== true &&
        user.is_bot !== true &&
        user.id !== "USLACKBOT",
    );
    const matches = (
      needle
        ? users.filter((user) => {
            const haystack = [
              displayName(user),
              user.name ?? "",
              user.real_name ?? "",
            ]
              .join(" ")
              .toLowerCase();
            return haystack.includes(needle);
          })
        : users
    )
      .slice(0, 50)
      .map((user) => ({
        id: user.id,
        name: displayName(user) || user.id,
        ...(user.profile?.image_48 ? { avatarUrl: user.profile.image_48 } : {}),
      }));
    return { users: matches };
  }

  async userProfile(
    actor: Actor,
    userId: string,
    signal?: AbortSignal,
  ): Promise<SlackUserProfileView> {
    if (!/^U[A-Z0-9]+$/.test(userId)) {
      throw new ConfigError("Invalid Slack user ID.");
    }
    const { client, connection } = await this.clientFor(actor.id, signal);
    const user = await client.userInfo(userId, signal);
    if (!user || user.deleted === true) {
      throw new ConfigError("That Slack profile is no longer available.");
    }
    const presence = await client.userPresence(userId, signal);
    const avatarUrl =
      user.profile?.image_512 ||
      user.profile?.image_192 ||
      user.profile?.image_48;
    return {
      id: user.id,
      name: displayName(user) || user.id,
      ...(user.name ? { username: user.name } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(user.profile?.title?.trim() ? { title: user.profile.title.trim() } : {}),
      ...(user.profile?.status_text?.trim()
        ? { statusText: user.profile.status_text.trim() }
        : {}),
      ...(user.profile?.status_emoji?.trim()
        ? { statusEmoji: user.profile.status_emoji.trim() }
        : {}),
      ...(user.tz ? { timezone: user.tz } : {}),
      ...(user.tz_label ? { timezoneLabel: user.tz_label } : {}),
      ...(user.tz_offset != null ? { timezoneOffset: user.tz_offset } : {}),
      presence,
      self: user.id === connection.slackUserId,
    };
  }

  async openDirectMessage(
    actor: Actor,
    userId: string,
    signal?: AbortSignal,
  ): Promise<SlackConversationView> {
    if (!/^U[A-Z0-9]+$/.test(userId)) {
      throw new ConfigError("Invalid Slack user ID.");
    }
    const { client, connection } = await this.clientFor(actor.id, signal);
    if (userId === connection.slackUserId) {
      throw new ConfigError("Choose someone else to start a direct message.");
    }
    if (!connection.scopes.includes(SLACK_IM_WRITE_SCOPE)) {
      throw new ConfigError(
        "Your Slack connection is missing im:write. Add that user scope to the Slack app, " +
          "then reconnect under My provider access.",
      );
    }
    const opened = await client.openDirectMessage({ userId, ...(signal ? { signal } : {}) });
    if (!/^D[A-Z0-9]+$/.test(opened.channel)) {
      throw new ConfigError("Slack opened a conversation that is not a direct message.");
    }
    const user = await client.userInfo(userId, signal);
    const name = displayName(user) || userId;
    const avatarUrl = user?.profile?.image_48;
    this.deps.connections.upsertConversation(actor.id, {
      conversationId: opened.channel,
      kind: "dm",
      name,
      ...(avatarUrl ? { avatarUrl } : {}),
      peerUserId: userId,
      private: true,
    });
    return {
      id: opened.channel,
      kind: "dm",
      name,
      ...(avatarUrl ? { avatarUrl } : {}),
      private: true,
      unread: false,
    };
  }

  hideDirectMessage(actor: Actor, conversationId: string): boolean {
    validateConversationId(conversationId);
    const conversation = this.deps.connections
      .conversations(actor.id)
      .find((candidate) => candidate.conversationId === conversationId);
    if (!conversation) return false;
    if (conversation.kind === "channel") {
      throw new ConfigError("Only direct messages can be hidden from the inbox.");
    }
    return this.deps.connections.removeConversation(actor.id, conversationId);
  }

  async sendMessage(
    actor: Actor,
    conversationId: string,
    text: string,
    threadTs?: string,
    signal?: AbortSignal,
  ): Promise<SlackMessageSendResult> {
    if (!/^[CDG][A-Z0-9]+$/.test(conversationId)) {
      throw new ConfigError("Invalid Slack conversation ID.");
    }
    const message = text.trim();
    if (!message || message.length > 40_000) {
      throw new ConfigError("Slack message text must contain between 1 and 40000 characters.");
    }
    if (threadTs != null && !/^\d{1,16}\.\d{1,16}$/.test(threadTs)) {
      throw new ConfigError("Invalid Slack thread timestamp.");
    }

    const { client, connection } = await this.clientFor(actor.id, signal);
    if (!connection.scopes.includes(SLACK_WRITE_SCOPE)) {
      throw new ConfigError(
        "Your Slack connection is missing chat:write. Add that user scope to the Slack app, " +
          "then reconnect under My provider access.",
      );
    }
    await this.authorizedConversation(
      actor.id,
      client,
      conversationId,
      supportsGroupDms(connection),
      signal,
    );
    const posted = await client.postMessage({
      channel: conversationId,
      text: message,
      ...(threadTs ? { threadTs } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!posted.ts || !/^\d{1,16}\.\d{1,16}$/.test(posted.ts)) {
      throw new ConfigError("Slack posted the message but returned no valid timestamp.");
    }

    this.deps.connections.recordUserActivity(
      actor.id,
      conversationId,
      posted.ts,
      threadTs,
    );
    this.deps.connections.markRead(actor.id, conversationId, posted.ts);
    return {
      channel: conversationId,
      timestamp: posted.ts,
      ...(threadTs ? { threadTs } : {}),
    };
  }

  async updateMessage(
    actor: Actor,
    conversationId: string,
    timestamp: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<SlackMessageUpdateResult> {
    validateConversationId(conversationId);
    validateSlackTimestamp(timestamp, "message");
    const message = text.trim();
    if (!message || message.length > 40_000) {
      throw new ConfigError("Slack message text must contain between 1 and 40000 characters.");
    }

    const { client } = await this.writerFor(actor.id, conversationId, signal);
    const updated = await client.updateMessage({
      channel: conversationId,
      ts: timestamp,
      text: message,
      ...(signal ? { signal } : {}),
    });
    return {
      channel: conversationId,
      timestamp: updated.ts || timestamp,
    };
  }

  async deleteMessage(
    actor: Actor,
    conversationId: string,
    timestamp: string,
    signal?: AbortSignal,
  ): Promise<void> {
    validateConversationId(conversationId);
    validateSlackTimestamp(timestamp, "message");
    const { client } = await this.writerFor(actor.id, conversationId, signal);
    await client.deleteMessage({
      channel: conversationId,
      ts: timestamp,
      ...(signal ? { signal } : {}),
    });
  }

  async setReaction(
    actor: Actor,
    conversationId: string,
    timestamp: string,
    name: string,
    active: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    validateConversationId(conversationId);
    validateSlackTimestamp(timestamp, "message");
    const reaction = name.trim();
    if (!/^[+\-\w]{1,100}$/.test(reaction)) {
      throw new ConfigError("Invalid Slack emoji reaction name.");
    }

    const { client, connection } = await this.clientFor(actor.id, signal);
    if (!connection.scopes.includes(SLACK_REACTIONS_SCOPE)) {
      throw new ConfigError(
        "Your Slack connection is missing reactions:write. Add that user scope to the " +
          "Slack app, then reconnect under My provider access.",
      );
    }
    await this.authorizedConversation(
      actor.id,
      client,
      conversationId,
      supportsGroupDms(connection),
      signal,
    );
    await client.setReaction({
      channel: conversationId,
      timestamp,
      name: reaction,
      active,
      ...(signal ? { signal } : {}),
    });
  }

  async sendImages(
    actor: Actor,
    conversationId: string,
    files: readonly SlackUploadFile[],
    text?: string,
    threadTs?: string,
    signal?: AbortSignal,
  ): Promise<SlackMessageSendResult> {
    validateConversationId(conversationId);
    if (files.length < 1 || files.length > 4) {
      throw new ConfigError("Attach between 1 and 4 images.");
    }
    const comment = text?.trim();
    if (comment && comment.length > 40_000) {
      throw new ConfigError("Slack message text must be at most 40000 characters.");
    }
    if (threadTs != null) validateSlackTimestamp(threadTs, "thread");
    for (const file of files) {
      if (
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          file.mimeType,
        )
      ) {
        throw new ConfigError("Slack image attachments must be PNG, JPEG, GIF, or WebP.");
      }
      if (file.bytes.byteLength < 1 || file.bytes.byteLength > 10 * 1024 * 1024) {
        throw new ConfigError("Each Slack image attachment must be 10 MB or smaller.");
      }
    }

    const { client, connection } = await this.clientFor(actor.id, signal);
    const missingScopes = SLACK_FILE_SCOPES.filter(
      (scope) => !connection.scopes.includes(scope),
    );
    if (missingScopes.length > 0) {
      throw new ConfigError(
        `Your Slack connection is missing ${missingScopes.join(", ")}. Add those user ` +
          "scopes to the Slack app, then reconnect under My provider access.",
      );
    }
    await this.authorizedConversation(
      actor.id,
      client,
      conversationId,
      supportsGroupDms(connection),
      signal,
    );
    const posted = await client.uploadFiles({
      channel: conversationId,
      files,
      ...(comment ? { initialComment: comment } : {}),
      ...(threadTs ? { threadTs } : {}),
      ...(signal ? { signal } : {}),
    });
    validateSlackTimestamp(posted.ts, "message");
    this.deps.connections.recordUserActivity(
      actor.id,
      conversationId,
      posted.ts,
      threadTs,
    );
    this.deps.connections.markRead(actor.id, conversationId, posted.ts);
    return {
      channel: conversationId,
      timestamp: posted.ts,
      ...(threadTs ? { threadTs } : {}),
    };
  }

  async markRead(
    actor: Actor,
    conversationId: string,
    timestamp: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!/^[CDG][A-Z0-9]+$/.test(conversationId)) {
      throw new ConfigError("Invalid Slack conversation ID.");
    }
    if (!/^\d{1,16}\.\d{1,16}$/.test(timestamp)) {
      throw new ConfigError("Invalid Slack message timestamp.");
    }
    const seconds = Number(timestamp.split(".", 1)[0]);
    if (!Number.isFinite(seconds) || seconds * 1000 > Date.now() + 5 * 60_000) {
      throw new ConfigError("Slack read cursor cannot be in the future.");
    }
    if (
      conversationId.startsWith("C") &&
      !this.deps.connections.selectedChannels(actor.id).includes(conversationId)
    ) {
      throw new ConfigError("That Slack channel is not selected for your TALOS inbox.");
    }
    this.deps.connections.markRead(actor.id, conversationId, timestamp);
    if (!this.markReadInSlackEnabled(actor.id)) return;

    try {
      const { client, connection } = await this.clientFor(actor.id, signal);
      if (!supportsSlackReadSync(connection)) {
        this.deps.logger.warn(
          { userId: actor.id },
          "Slack read synchronization is enabled but its write scopes are missing",
        );
        return;
      }
      await client.markConversation({
        channel: conversationId,
        timestamp,
        signal,
      });
    } catch (err) {
      // Reading in TALOS must remain reliable when Slack is temporarily down.
      // The local cursor is already advanced; the warning explains why Slack's
      // own badge may lag without turning a read action into a page error.
      this.deps.logger.warn(
        {
          userId: actor.id,
          conversation: conversationId,
          err: err instanceof Error ? err.message : String(err),
        },
        "could not synchronize Slack read cursor",
      );
    }
  }

  private async writerFor(
    userId: string,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<{ client: SlackClient; connection: SlackConnectionCredential }> {
    const { client, connection } = await this.clientFor(userId, signal);
    if (!connection.scopes.includes(SLACK_WRITE_SCOPE)) {
      throw new ConfigError(
        "Your Slack connection is missing chat:write. Add that user scope to the Slack app, " +
          "then reconnect under My provider access.",
      );
    }
    await this.authorizedConversation(
      userId,
      client,
      conversationId,
      supportsGroupDms(connection),
      signal,
    );
    return { client, connection };
  }

  private async clientFor(
    userId: string,
    signal?: AbortSignal,
  ): Promise<{ client: SlackClient; connection: SlackConnectionCredential }> {
    let connection = this.deps.connections.credential(userId);
    if (!connection) throw new ConfigError("Connect your Slack account under My provider access.");
    const missingScopes = SLACK_REQUIRED_USER_SCOPES.filter(
      (scope) => !connection!.scopes.includes(scope),
    );
    if (missingScopes.length > 0) {
      throw new ConfigError(
        `Your Slack connection is missing ${missingScopes.join(", ")}. Add those user scopes ` +
          "to the Slack app, then reconnect under My provider access.",
      );
    }
    if (connection.expiresAt && connection.expiresAt.getTime() <= Date.now() + REFRESH_EARLY_MS) {
      await this.refreshConnection(userId, connection);
      connection = this.deps.connections.credential(userId);
      if (!connection) throw new ConfigError("Your Slack account was disconnected.");
    }
    return {
      connection,
      client: new SlackClient({
        token: connection.accessToken,
        logger: this.deps.logger,
        budgetKey: `workspace:${connection.teamId}`,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      }),
    };
  }

  private async syncRecentActivityForUser(
    userId: string,
    client: SlackClient,
    signal?: AbortSignal,
  ): Promise<void> {
    const after = new Date(Date.now() - 2 * 24 * 60 * 60_000)
      .toISOString()
      .slice(0, 10);
    const selected = new Set(this.deps.connections.selectedChannels(userId));
    const search = await client.searchMessages({
      query: `after:${after}`,
      limit: 100,
      signal,
    });
    for (const match of search.matches) {
      const type = searchConversationType(match);
      if (
        (type === "channel" || type === "group") &&
        !selected.has(match.channel.id)
      ) {
        continue;
      }
      this.deps.connections.recordUserActivity(
        userId,
        match.channel.id,
        match.ts,
      );
    }
  }

  private async refreshConnection(
    userId: string,
    connection: SlackConnectionCredential,
  ): Promise<void> {
    const existing = this.refreshes.get(userId);
    if (existing) return existing;
    if (!connection.refreshToken) {
      throw new ConfigError("Your Slack connection has expired. Reconnect it under My provider access.");
    }
    const refresh = (async () => {
      const refreshed = await refreshSlackUserToken({
        clientId: this.deps.secrets.require("SLACK_CLIENT_ID"),
        clientSecret: this.deps.secrets.require("SLACK_CLIENT_SECRET"),
        refreshToken: connection.refreshToken!,
        fallbackTeamId: connection.teamId,
        fallbackUserId: connection.slackUserId,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
      const expectedTeam = this.deps.secrets.require("SLACK_WORKSPACE_ID").trim();
      const refreshedTeam = refreshed.teamId ?? connection.teamId;
      const refreshedUser = refreshed.userId ?? connection.slackUserId;
      if (refreshedTeam !== expectedTeam) {
        throw new ConfigError("Slack refreshed a token for a different workspace.");
      }
      registerSecretValues([
        refreshed.accessToken,
        ...(refreshed.refreshToken ? [refreshed.refreshToken] : []),
      ]);
      this.deps.connections.saveIfUnchanged({
        userId,
        teamId: refreshedTeam,
        teamName: refreshed.teamName ?? connection.teamName,
        slackUserId: refreshedUser,
        slackUserName: connection.slackUserName,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        scopes: refreshed.scopes.length > 0 ? refreshed.scopes : connection.scopes,
      }, connection.connectionVersion);
    })();
    this.refreshes.set(userId, refresh);
    try {
      await refresh;
    } finally {
      if (this.refreshes.get(userId) === refresh) this.refreshes.delete(userId);
    }
  }

  private async summary(
    userId: string,
    slackUserId: string,
    client: SlackClient,
    conversation: SlackConversation,
    activity: SlackConversationActivity | undefined,
    users: Map<string, Promise<SlackUser | undefined>>,
    signal?: AbortSignal,
  ): Promise<SlackConversationView> {
    const observedTs = activity?.latestTs;
    const readTs = this.deps.connections.readCursor(userId, conversation.id);
    if (observedTs && !readTs) {
      // Catalog bootstrap is not new activity. Establish the local baseline
      // without making one history request per conversation.
      this.deps.connections.baselineReadCursor(userId, conversation.id, observedTs);
    }
    const effectiveReadTs = readTs ?? observedTs;
    const presentation = await this.conversationPresentation(
      client,
      conversation,
      slackUserId,
      users,
      signal,
    );
    return {
      id: conversation.id,
      kind: conversationKind(conversation),
      name: presentation.name,
      ...(presentation.avatarUrl ? { avatarUrl: presentation.avatarUrl } : {}),
      ...(presentation.app ? { app: true } : {}),
      private:
        conversation.is_private === true ||
        conversation.is_im === true ||
        conversation.is_mpim === true,
      unread:
        !!observedTs &&
        (!effectiveReadTs || compareSlackTs(observedTs, effectiveReadTs) > 0),
      ...(observedTs
        ? {
            latestTs: observedTs,
            latestAt: slackTimestampDate(observedTs).toISOString(),
          }
        : {}),
    };
  }

  private async authorizedConversation(
    userId: string,
    client: SlackClient,
    id: string,
    includeGroupDms: boolean,
    signal?: AbortSignal,
  ): Promise<SlackConversation> {
    const selected = new Set(this.deps.connections.selectedChannels(userId));
    if (selected.has(id)) {
      const channels = await this.allConversations(
        client,
        "public_channel,private_channel",
        MAX_CHANNELS,
        signal,
      );
      const found = channels.find((channel) => channel.id === id);
      if (found) return found;
    }
    const dms = await this.allConversations(
      client,
      includeGroupDms ? "im,mpim" : "im",
      MAX_DMS_FOR_AUTHORIZATION,
      signal,
    );
    const dm = dms.find(
      (conversation) =>
        conversation.id === id && (conversation.is_im || conversation.is_mpim),
    );
    if (dm) return dm;
    throw new ConfigError("That Slack conversation is not part of your TALOS inbox.");
  }

  private async allConversations(
    client: SlackClient,
    types: string,
    max: number,
    signal?: AbortSignal,
  ): Promise<SlackConversation[]> {
    const out: SlackConversation[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listConversations({
        types,
        cursor,
        limit: Math.min(200, max - out.length),
        signal,
      });
      out.push(...page.conversations);
      cursor = page.nextCursor;
    } while (cursor && out.length < max);
    return out.slice(0, max);
  }

  private async allUsers(
    client: SlackClient,
    signal?: AbortSignal,
  ): Promise<SlackUser[]> {
    const users: SlackUser[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listUsers({ cursor, limit: 200, signal });
      users.push(...page.users);
      cursor = page.nextCursor;
    } while (cursor && users.length < 5_000);
    return users.slice(0, 5_000);
  }

  private async allConversationMembers(
    client: SlackClient,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const members: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.conversationMembers({
        channel: conversationId,
        cursor,
        limit: 200,
        signal,
      });
      members.push(...page.members);
      cursor = page.nextCursor;
    } while (cursor && members.length < 5_000);
    return [...new Set(members.slice(0, 5_000))];
  }

  private async searchConversationHistory(
    client: SlackClient,
    connection: SlackConnectionCredential,
    conversationId: string,
    query: string,
    requestedPage: number,
    filters: SlackConversationSearchFilters,
    signal?: AbortSignal,
  ): Promise<SlackConversationSearchView> {
    const matching: SlackMessage[] = [];
    const needle = query.toLowerCase();
    let scanned = 0;
    let cursor: string | undefined;
    do {
      const history = await client.conversationHistory({
        channel: conversationId,
        cursor,
        limit: 200,
        signal,
      });
      for (const message of history.messages) {
        scanned += 1;
        const texts = slackMessageTexts(message);
        if (!texts.join("\n").toLowerCase().includes(needle)) continue;
        if (filters.fromMe && message.user !== connection.slackUserId) continue;
        if (
          filters.includesMe &&
          !texts.some((text) => text.includes(`<@${connection.slackUserId}>`))
        ) {
          continue;
        }
        if (
          filters.hasLink &&
          !texts.some((text) => /(?:https?:\/\/|<https?:\/\/)/i.test(text))
        ) {
          continue;
        }
        if (
          filters.threadsOnly &&
          !message.thread_ts &&
          (message.reply_count ?? 0) === 0
        ) {
          continue;
        }
        matching.push(message);
      }
      cursor = history.nextCursor;
    } while (cursor && scanned < MAX_SEARCH_HISTORY_MESSAGES);

    const pageSize = 100;
    const start = (requestedPage - 1) * pageSize;
    const pageMessages = matching.slice(start, start + pageSize);
    const users = new Map<string, Promise<SlackUser | undefined>>();
    const views = await this.messageViews(
      client,
      pageMessages,
      connection.slackUserId,
      users,
      connection.scopes.includes(SLACK_USERGROUPS_SCOPE),
      signal,
    );
    return {
      results: views.map((message) => ({
        ts: message.ts,
        at: message.at,
        ...(message.userId ? { userId: message.userId } : {}),
        userName: message.userName,
        ...(message.avatarUrl ? { avatarUrl: message.avatarUrl } : {}),
        text: message.text,
        ...(message.mentions ? { mentions: message.mentions } : {}),
        ...(message.threadTs ? { threadTs: message.threadTs } : {}),
      })),
      page: requestedPage,
      pageCount: Math.ceil(matching.length / pageSize),
      total: matching.length,
    };
  }

  private async conversationPresentation(
    client: SlackClient,
    conversation: SlackConversation,
    ownSlackUserId: string,
    users: Map<string, Promise<SlackUser | undefined>>,
    signal?: AbortSignal,
  ): Promise<{ name: string; avatarUrl?: string; app?: boolean }> {
    if (conversation.is_mpim && conversation.name) {
      return {
        name: conversation.name
          .replace(/^mpdm-/, "")
          .replace(/--/g, ", ")
          .replace(/-\d+$/, ""),
      };
    }
    if (conversation.is_mpim) {
      const members = await client.conversationMembers({
        channel: conversation.id,
        limit: 100,
        signal,
      });
      const memberUsers = await Promise.all(
        members.members
          .filter((member) => member !== ownSlackUserId)
          .map(async (member) => {
            const user = await this.cachedUser(client, member, users, signal);
            return { id: member, user };
          }),
      );
      if (memberUsers.length > 0) {
        const firstAvatar = memberUsers.find((member) => member.user?.profile?.image_48)
          ?.user?.profile?.image_48;
        return {
          name: memberUsers
            .map((member) => displayName(member.user) || member.id)
            .join(", "),
          ...(firstAvatar ? { avatarUrl: firstAvatar } : {}),
        };
      }
    }
    if (conversation.name) return { name: `#${conversation.name}` };
    if (!conversation.user) return { name: conversation.id };
    const user = await this.cachedUser(client, conversation.user, users, signal);
    return {
      name: displayName(user) || conversation.user,
      ...(user?.profile?.image_48 ? { avatarUrl: user.profile.image_48 } : {}),
      ...(user?.is_bot ? { app: true } : {}),
    };
  }

  private async messageViews(
    client: SlackClient,
    messages: readonly SlackMessage[],
    ownSlackUserId: string,
    users: Map<string, Promise<SlackUser | undefined>>,
    resolveUserGroups: boolean,
    signal?: AbortSignal,
  ): Promise<SlackMessageView[]> {
    const resolved = new Map<string, SlackUser | undefined>();
    const userIds = [
      ...new Set(
        messages.flatMap((message) => [
          ...(message.user ? [message.user] : []),
          ...slackMessageTexts(message).flatMap(mentionIds),
        ]),
      ),
    ];
    await mapConcurrent(
      userIds,
      4,
      async (id) => {
        resolved.set(id, await this.cachedUser(client, id, users, signal));
        return undefined;
      },
    );
    const userGroupAliases = new Map<string, string>();
    const userGroupIds = [
      ...new Set(
        messages.flatMap((message) =>
          slackMessageTexts(message).flatMap(userGroupMentionIds),
        ),
      ),
    ];
    if (resolveUserGroups && userGroupIds.length > 0) {
      try {
        const wanted = new Set(userGroupIds);
        for (const group of await client.listUserGroups(signal)) {
          const handle = group.handle.trim().replace(/^@/, "");
          if (wanted.has(group.id) && handle) userGroupAliases.set(group.id, handle);
        }
      } catch (err) {
        this.deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "could not resolve Slack user-group mentions",
        );
      }
    }
    return messages.map((message) => {
      const user = message.user ? resolved.get(message.user) : undefined;
      const messageTexts = slackMessageTexts(message);
      const mentions = Object.fromEntries(
        [
          ...messageTexts.flatMap(mentionIds).map(
            (id) => [id, displayName(resolved.get(id)) || id] as const,
          ),
          ...messageTexts.flatMap(userGroupMentionIds).flatMap((id) => {
            const alias = userGroupAliases.get(id);
            return alias ? [[id, alias] as const] : [];
          }),
        ],
      );
      const blocks = normalizeSlackMessageBlocks(message);
      return {
        ts: message.ts,
        at: slackTimestampDate(message.ts).toISOString(),
        ...(message.user ? { userId: message.user } : {}),
        userName:
          displayName(user) ||
          message.bot_profile?.name ||
          message.username ||
          message.bot_id ||
          "Slack",
        ...(user?.profile?.image_48 || message.bot_profile?.icons?.image_48
          ? {
              avatarUrl:
                user?.profile?.image_48 ?? message.bot_profile!.icons!.image_48!,
            }
          : {}),
        text: message.text,
        ...(blocks.length > 0 ? { blocks } : {}),
        ...(Object.keys(mentions).length > 0 ? { mentions } : {}),
        ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
        replyCount: message.reply_count ?? 0,
        ...(message.latest_reply ? { latestReplyTs: message.latest_reply } : {}),
        ...(message.reactions && message.reactions.length > 0
          ? {
              reactions: message.reactions.map((reaction) => ({
                name: reaction.name,
                count: reaction.count,
                reacted: reaction.users?.includes(ownSlackUserId) === true,
              })),
            }
          : {}),
        ...(message.files && message.files.length > 0
          ? {
              attachments: message.files.map((file) => ({
                id: file.id,
                name: file.name?.trim() || "Slack image",
                ...(file.mimetype ? { mimeType: file.mimetype } : {}),
              })),
            }
          : {}),
        mine: message.user === ownSlackUserId,
      };
    });
  }

  private cachedUser(
    client: SlackClient,
    userId: string,
    users: Map<string, Promise<SlackUser | undefined>>,
    signal?: AbortSignal,
  ): Promise<SlackUser | undefined> {
    let user = users.get(userId);
    if (!user) {
      user = client.userInfo(userId, signal);
      users.set(userId, user);
    }
    return user;
  }

  private async cachedPresence(
    talosUserId: string,
    client: SlackClient,
    slackUserId: string,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> {
    const key = `${talosUserId}:${slackUserId}`;
    const cached = this.presenceCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.online;
    try {
      const online = (await client.userPresence(slackUserId, signal)) === "active";
      this.presenceCache.set(key, {
        online,
        expiresAt: Date.now() + PRESENCE_CACHE_MS,
      });
      return online;
    } catch (err) {
      this.deps.logger.debug(
        {
          userId: talosUserId,
          slackUserId,
          err: err instanceof Error ? err.message : String(err),
        },
        "could not read Slack user presence",
      );
      return undefined;
    }
  }

  private markReadInSlackEnabled(userId: string): boolean {
    const raw = this.deps.preferences.all(userId)[SLACK_READ_SYNC_PREFERENCE];
    if (!raw) return false;
    try {
      return JSON.parse(raw) === true;
    } catch {
      return false;
    }
  }
}

function callbackUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/auth/slack/callback`;
}

function conversationKind(
  conversation: SlackConversation,
): "dm" | "group-dm" | "channel" {
  if (conversation.is_mpim) return "group-dm";
  return conversation.is_im ? "dm" : "channel";
}

function searchConversationType(
  match: SlackSearchMatch,
): "im" | "mpim" | "channel" | "group" {
  if (match.type === "im" || match.channel.id.startsWith("D")) return "im";
  if (match.channel.is_mpim) return "mpim";
  return match.channel.is_private ? "group" : "channel";
}

function sortConversationViews(
  conversations: SlackConversationView[],
): SlackConversationView[] {
  return conversations.sort((a, b) => {
    const kindOrder = Number(a.kind === "channel") - Number(b.kind === "channel");
    if (kindOrder !== 0) return kindOrder;
    return (b.latestTs ?? "").localeCompare(a.latestTs ?? "");
  });
}

function supportsGroupDms(connection: { scopes: readonly string[] }): boolean {
  return SLACK_GROUP_DM_SCOPES.every((scope) => connection.scopes.includes(scope));
}

function supportsSlackReadSync(connection: { scopes: readonly string[] }): boolean {
  return SLACK_MARK_READ_SCOPES.every((scope) => connection.scopes.includes(scope));
}

function privateConversationTypes(connection: { scopes: readonly string[] }): string {
  return supportsGroupDms(connection) ? "im,mpim" : "im";
}

function displayName(user?: SlackUser): string {
  return (
    user?.profile?.display_name?.trim() ||
    user?.profile?.real_name?.trim() ||
    user?.real_name?.trim() ||
    user?.name?.trim() ||
    ""
  );
}

function slackMessageTexts(message: SlackMessage): string[] {
  return [
    message.text,
    ...(message.blocks ?? []).flatMap((block) => [
      ...(block.text?.text ? [block.text.text] : []),
      ...(block.fields ?? []).map((field) => field.text),
      ...(block.elements ?? []).flatMap((element) => {
        const text = objectText(element);
        return text ? [text] : [];
      }),
    ]),
    ...(message.attachments ?? []).flatMap((attachment) => [
      ...(attachment.title ? [attachment.title] : []),
      ...(attachment.text ? [attachment.text] : []),
      ...(attachment.fields ?? []).flatMap((field) => [
        ...(field.title ? [field.title] : []),
        ...(field.value ? [field.value] : []),
      ]),
      ...(attachment.actions ?? []).flatMap((action) =>
        action.text ? [action.text] : [],
      ),
    ]),
  ];
}

function normalizeSlackMessageBlocks(message: SlackMessage): SlackMessageBlockView[] {
  const normalized: SlackMessageBlockView[] = [];
  for (const block of message.blocks ?? []) {
    if (block.type === "divider") {
      normalized.push({ type: "divider" });
      continue;
    }
    if (block.type === "header" && block.text?.text.trim()) {
      normalized.push({ type: "header", text: block.text.text });
      continue;
    }
    if (block.type === "section") {
      const text = block.text?.text.trim();
      const fields = (block.fields ?? [])
        .map((field) => field.text.trim())
        .filter(Boolean);
      if (text || fields.length > 0) {
        normalized.push({
          type: "section",
          ...(text ? { text } : {}),
          ...(fields.length > 0 ? { fields } : {}),
        });
      }
      continue;
    }
    if (block.type === "context") {
      const text = (block.elements ?? []).map(objectText).filter(Boolean).join(" · ");
      if (text) normalized.push({ type: "context", text });
      continue;
    }
    if (block.type === "actions") {
      const actions = (block.elements ?? []).flatMap(normalizeSlackAction);
      if (actions.length > 0) normalized.push({ type: "actions", actions });
    }
  }
  for (const attachment of message.attachments ?? []) {
    const text = [attachment.title, attachment.text].filter(Boolean).join("\n");
    const fields = (attachment.fields ?? [])
      .map((field) => [field.title, field.value].filter(Boolean).join("\n"))
      .filter(Boolean);
    if (text || fields.length > 0) {
      normalized.push({
        type: "section",
        ...(text ? { text } : {}),
        ...(fields.length > 0 ? { fields } : {}),
      });
    }
    const actions = (attachment.actions ?? []).flatMap(normalizeSlackAction);
    if (attachment.title && attachment.title_link) {
      const url = safeSlackActionUrl(attachment.title_link);
      if (url) actions.unshift({ text: attachment.title, url });
    }
    if (actions.length > 0) normalized.push({ type: "actions", actions });
  }
  return normalized;
}

function normalizeSlackAction(value: unknown): NonNullable<
  SlackMessageBlockView["actions"]
> {
  if (!value || typeof value !== "object") return [];
  const action = value as Record<string, unknown>;
  const url = typeof action.url === "string" ? safeSlackActionUrl(action.url) : undefined;
  const text = objectText(action.text) || (typeof action.text === "string" ? action.text : "");
  if (action.type !== "button" || !url || !text.trim()) return [];
  const style =
    action.style === "primary" || action.style === "danger"
      ? action.style
      : undefined;
  return [{ text: text.trim(), url, ...(style ? { style } : {}) }];
}

function objectText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

function safeSlackActionUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function mentionIds(text: string): string[] {
  return [...text.matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1]!);
}

function userGroupMentionIds(text: string): string[] {
  return [...text.matchAll(/<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g)].map(
    (match) => match[1]!,
  );
}

function validateConversationId(conversationId: string): void {
  if (!/^[CDG][A-Z0-9]+$/.test(conversationId)) {
    throw new ConfigError("Invalid Slack conversation ID.");
  }
}

function validateSlackTimestamp(timestamp: string, kind: "message" | "thread"): void {
  if (!/^\d{1,16}\.\d{1,16}$/.test(timestamp)) {
    throw new ConfigError(`Invalid Slack ${kind} timestamp.`);
  }
}

function slackTimestampDate(timestamp: string): Date {
  const seconds = Number(timestamp.split(".", 1)[0]);
  return new Date(Number.isFinite(seconds) ? seconds * 1000 : 0);
}

function slackSearchInModifier(name?: string): string | undefined {
  const normalized = name?.trim().replace(/^#/, "");
  if (!normalized) return undefined;
  const escaped = normalized.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return /\s/.test(escaped) ? `in:"${escaped}"` : `in:${escaped}`;
}

function compareSlackTs(left: string, right: string): number {
  const normalize = (value: string): [string, string] => {
    const [whole = "0", fraction = ""] = value.split(".", 2);
    return [whole.replace(/^0+(?=\d)/, ""), fraction];
  };
  const [leftWhole, leftFraction] = normalize(left);
  const [rightWhole, rightFraction] = normalize(right);
  if (leftWhole.length !== rightWhole.length) return leftWhole.length - rightWhole.length;
  const whole = leftWhole.localeCompare(rightWhole);
  if (whole !== 0) return whole;
  const width = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(width, "0").localeCompare(rightFraction.padEnd(width, "0"));
}

function fileSharedToConversation(
  shares: Record<string, Record<string, readonly unknown[]>> | undefined,
  conversationId: string,
): boolean {
  return Object.values(shares ?? {}).some(
    (byConversation) => (byConversation[conversationId]?.length ?? 0) > 0,
  );
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
