/**
 * The slices of Slack's Web API this connector uses, as zod schemas.
 *
 * Every schema here carries `ok` and an optional `error`, because that pair —
 * not the HTTP status — is how Slack reports failure. See the note on
 * `SlackClient.call` in `client.ts`: a `chat.postMessage` to a channel the app
 * was never invited to answers `200 {"ok":false,"error":"not_in_channel"}`, and
 * a schema that omitted `ok` would validate that body perfectly and hand the
 * caller a "success" with nothing in it.
 *
 * Loose about everything else. A message response carries the full posted
 * message echoed back, and none of it is read here.
 */
import { z } from "zod";

/**
 * The envelope every Web API method shares.
 *
 * `error` is Slack's machine-readable code (`invalid_auth`, `channel_not_found`,
 * `not_in_channel`, …) — short, stable, and the only part of a failure worth
 * putting in front of an operator.
 */
export const SlackEnvelopeSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  /** Present on some failures, e.g. a deprecation or a missing-scope hint. */
  warning: z.string().optional(),
});

export type SlackEnvelope = z.infer<typeof SlackEnvelopeSchema>;

/**
 * `chat.postMessage`. `channel` comes back as the resolved channel **ID** even
 * when the request named `#releases`, and `ts` is the message timestamp that
 * doubles as its identifier — the two together are what a later `chat.update`
 * would need to edit this message in place.
 */
export const PostMessageResponseSchema = SlackEnvelopeSchema.extend({
  channel: z.string().optional(),
  ts: z.string().optional(),
});

/** `auth.test` — the health check's probe. Identifies the token's own bot. */
export const AuthTestResponseSchema = SlackEnvelopeSchema.extend({
  team: z.string().optional(),
  team_id: z.string().optional(),
  user: z.string().optional(),
  user_id: z.string().optional(),
  bot_id: z.string().optional(),
  url: z.string().optional(),
});

const SlackTextObjectSchema = z.object({
  type: z.string().optional(),
  text: z.string(),
});

const SlackMessageBlockSchema = z.object({
  type: z.string(),
  text: SlackTextObjectSchema.optional(),
  fields: z.array(SlackTextObjectSchema).optional(),
  // Context and action blocks may contain many element types. Keep them loose
  // here and normalize only safe text and URL buttons at the application edge.
  elements: z.array(z.unknown()).optional(),
});

const SlackLegacyAttachmentSchema = z.object({
  title: z.string().optional(),
  title_link: z.string().optional(),
  text: z.string().optional(),
  fields: z
    .array(
      z.object({
        title: z.string().optional(),
        value: z.string().optional(),
      }),
    )
    .optional(),
  actions: z
    .array(
      z.object({
        type: z.string().optional(),
        text: z.string().optional(),
        url: z.string().optional(),
        // Slack apps can emit legacy or non-standard style values. Preserve
        // them here; normalization only forwards the supported UI variants.
        style: z.string().optional(),
      }),
    )
    .optional(),
});

const SlackFileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  mimetype: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  url_private: z.string().optional(),
  url_private_download: z.string().optional(),
  thumb_360: z.string().optional(),
});

export const SlackMessageSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  app_id: z.string().optional(),
  bot_profile: z
    .object({
      name: z.string().optional(),
      icons: z
        .object({
          image_48: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  username: z.string().optional(),
  text: z.string().default(""),
  blocks: z.array(SlackMessageBlockSchema).optional(),
  attachments: z.array(SlackLegacyAttachmentSchema).optional(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  reply_count: z.number().int().nonnegative().optional(),
  latest_reply: z.string().optional(),
  reactions: z
    .array(
      z.object({
        name: z.string(),
        count: z.number().int().nonnegative(),
        users: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  files: z.array(SlackFileSchema).optional(),
});
export type SlackMessage = z.infer<typeof SlackMessageSchema>;

export const SlackConversationSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  is_channel: z.boolean().optional(),
  is_group: z.boolean().optional(),
  is_im: z.boolean().optional(),
  is_mpim: z.boolean().optional(),
  is_private: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  is_open: z.boolean().optional(),
  is_user_deleted: z.boolean().optional(),
  user: z.string().optional(),
  priority: z.number().optional(),
  last_read: z.string().optional(),
  unread_count: z.number().int().nonnegative().optional(),
  unread_count_display: z.number().int().nonnegative().optional(),
  topic: z.object({ value: z.string().default("") }).optional(),
});
export type SlackConversation = z.infer<typeof SlackConversationSchema>;

const CursorMetadataSchema = z.object({
  next_cursor: z.string().optional(),
});

export const ConversationsResponseSchema = SlackEnvelopeSchema.extend({
  channels: z.array(SlackConversationSchema).default([]),
  response_metadata: CursorMetadataSchema.optional(),
});

export const ConversationInfoResponseSchema = SlackEnvelopeSchema.extend({
  channel: SlackConversationSchema.extend({
    latest: z.object({ ts: z.string() }).nullable().optional(),
  }).optional(),
});

/** `conversations.open` — returns an existing IM or creates one. */
export const OpenConversationResponseSchema = SlackEnvelopeSchema.extend({
  channel: z.object({ id: z.string() }).optional(),
  already_open: z.boolean().optional(),
});

export const HistoryResponseSchema = SlackEnvelopeSchema.extend({
  messages: z.array(SlackMessageSchema).default([]),
  has_more: z.boolean().optional(),
  response_metadata: CursorMetadataSchema.optional(),
});

export const UploadUrlResponseSchema = SlackEnvelopeSchema.extend({
  upload_url: z.string().optional(),
  file_id: z.string().optional(),
});

const SlackFileShareSchema = z.object({
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
});

export const FileInfoResponseSchema = SlackEnvelopeSchema.extend({
  file: z
    .object({
      ...SlackFileSchema.shape,
      shares: z
        .record(
          z.string(),
          z.record(z.string(), z.array(SlackFileShareSchema)),
        )
        .optional(),
    })
    .optional(),
});
export type SlackFileInfo = NonNullable<
  z.infer<typeof FileInfoResponseSchema>["file"]
>;

export const ConversationMembersResponseSchema = SlackEnvelopeSchema.extend({
  members: z.array(z.string()).default([]),
  response_metadata: CursorMetadataSchema.optional(),
});

export const UserInfoResponseSchema = SlackEnvelopeSchema.extend({
  user: z
    .object({
      id: z.string(),
      name: z.string().optional(),
      real_name: z.string().optional(),
      deleted: z.boolean().optional(),
      is_bot: z.boolean().optional(),
      tz: z.string().optional(),
      tz_label: z.string().optional(),
      tz_offset: z.number().int().optional(),
      profile: z
        .object({
          display_name: z.string().optional(),
          real_name: z.string().optional(),
          image_48: z.string().optional(),
          image_192: z.string().optional(),
          image_512: z.string().optional(),
          title: z.string().optional(),
          status_text: z.string().optional(),
          status_emoji: z.string().optional(),
          email: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type SlackUser = NonNullable<z.infer<typeof UserInfoResponseSchema>["user"]>;

export const UsersListResponseSchema = SlackEnvelopeSchema.extend({
  members: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        real_name: z.string().optional(),
        deleted: z.boolean().optional(),
        is_bot: z.boolean().optional(),
        tz: z.string().optional(),
        tz_label: z.string().optional(),
        tz_offset: z.number().int().optional(),
        profile: z
          .object({
            display_name: z.string().optional(),
            real_name: z.string().optional(),
            image_48: z.string().optional(),
            image_192: z.string().optional(),
            image_512: z.string().optional(),
            title: z.string().optional(),
            status_text: z.string().optional(),
            status_emoji: z.string().optional(),
            email: z.string().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  response_metadata: CursorMetadataSchema.optional(),
});

export const UserGroupsListResponseSchema = SlackEnvelopeSchema.extend({
  usergroups: z
    .array(
      z.object({
        id: z.string(),
        handle: z.string(),
        name: z.string().optional(),
      }),
    )
    .default([]),
});
export type SlackUserGroup = z.infer<
  typeof UserGroupsListResponseSchema
>["usergroups"][number];

export const UserPresenceResponseSchema = SlackEnvelopeSchema.extend({
  presence: z.enum(["active", "away"]).optional(),
});

export const OAuthUserAccessResponseSchema = SlackEnvelopeSchema.extend({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  authed_user: z
    .object({
      id: z.string(),
      scope: z.string().optional(),
      access_token: z.string().optional(),
      refresh_token: z.string().optional(),
      expires_in: z.number().int().positive().optional(),
      team: z
        .object({
          id: z.string(),
          name: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  team: z
    .object({
      id: z.string(),
      name: z.string().optional(),
    })
    .optional(),
});

export const SocketOpenResponseSchema = SlackEnvelopeSchema.extend({
  url: z.string().optional(),
});

export const EventAuthorizationsResponseSchema = SlackEnvelopeSchema.extend({
  authorizations: z
    .array(
      z.object({
        team_id: z.string().optional(),
        user_id: z.string().optional(),
        is_bot: z.boolean().optional(),
      }),
    )
    .default([]),
});

export const SlackSocketEnvelopeSchema = z.object({
  envelope_id: z.string(),
  type: z.string(),
  payload: z.unknown().optional(),
});

export const SlackEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string(),
  event_id: z.string().optional(),
  event_context: z.string().optional(),
  authorizations: z
    .array(
      z.object({
        team_id: z.string().optional(),
        user_id: z.string().optional(),
        is_bot: z.boolean().optional(),
      }),
    )
    .default([]),
  event: z.object({
    type: z.literal("message"),
    channel: z.string(),
    channel_type: z.enum(["im", "mpim", "channel", "group"]).optional(),
    user: z.string().optional(),
    ts: z.string(),
    thread_ts: z.string().optional(),
    subtype: z.string().optional(),
  }),
});

export const SearchMessagesResponseSchema = SlackEnvelopeSchema.extend({
  messages: z
    .object({
      matches: z
        .array(
          z.object({
            ts: z.string(),
            type: z.string().optional(),
            user: z.string().nullable().optional(),
            username: z.string().optional(),
            text: z.string().default(""),
            thread_ts: z.string().optional(),
            channel: z.object({
              id: z.string(),
              name: z.string().optional(),
              is_mpim: z.boolean().optional(),
              is_private: z.boolean().optional(),
            }),
          }),
        )
        .default([]),
      paging: z
        .object({
          count: z.number().int().nonnegative().optional(),
          page: z.number().int().positive().optional(),
          pages: z.number().int().nonnegative().optional(),
          total: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type SlackSearchMatch = NonNullable<
  z.infer<typeof SearchMessagesResponseSchema>["messages"]
>["matches"][number];

export interface SlackSearchPage {
  matches: SlackSearchMatch[];
  page: number;
  pageCount: number;
  total: number;
}
