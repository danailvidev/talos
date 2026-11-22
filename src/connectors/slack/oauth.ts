import { AuthenticationError, ConfigError } from "../../core/errors.ts";
import type { FetchLike } from "../http.ts";
import { OAuthUserAccessResponseSchema } from "./types.ts";

export const SLACK_REQUIRED_USER_SCOPES = [
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "users:read",
] as const;

export const SLACK_GROUP_DM_SCOPES = ["mpim:read", "mpim:history"] as const;
export const SLACK_SEARCH_SCOPE = "search:read";
export const SLACK_USERGROUPS_SCOPE = "usergroups:read";
export const SLACK_USERS_EMAIL_SCOPE = "users:read.email";
export const SLACK_MPIM_TOPIC_SCOPE = "mpim:write.topic";
export const SLACK_WRITE_SCOPE = "chat:write";
export const SLACK_IM_WRITE_SCOPE = "im:write";
export const SLACK_MPIM_WRITE_SCOPE = "mpim:write";
export const SLACK_REACTIONS_SCOPE = "reactions:write";
export const SLACK_FILE_READ_SCOPE = "files:read";
export const SLACK_FILE_WRITE_SCOPE = "files:write";
export const SLACK_FILE_SCOPES = [
  SLACK_FILE_READ_SCOPE,
  SLACK_FILE_WRITE_SCOPE,
] as const;
export const SLACK_MARK_READ_SCOPES = [
  "channels:write",
  "groups:write",
  "im:write",
  SLACK_MPIM_WRITE_SCOPE,
] as const;

export const SLACK_USER_SCOPES = [
  ...SLACK_REQUIRED_USER_SCOPES,
  ...SLACK_GROUP_DM_SCOPES,
  SLACK_SEARCH_SCOPE,
  SLACK_USERGROUPS_SCOPE,
  SLACK_USERS_EMAIL_SCOPE,
  SLACK_MPIM_TOPIC_SCOPE,
  SLACK_WRITE_SCOPE,
  SLACK_REACTIONS_SCOPE,
  ...SLACK_FILE_SCOPES,
  ...SLACK_MARK_READ_SCOPES,
] as const;

export interface SlackOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  teamId?: string;
  teamName?: string;
  userId?: string;
}

export function slackAuthorizeUrl(input: {
  clientId: string;
  workspaceId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://slack.com/oauth/v2_user/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", SLACK_USER_SCOPES.join(","));
  url.searchParams.set("team", input.workspaceId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeSlackUserCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}): Promise<SlackOAuthTokens> {
  return exchange(
    {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    },
    input.fetch,
    input.signal,
  );
}

export async function refreshSlackUserToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fallbackTeamId: string;
  fallbackUserId: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}): Promise<SlackOAuthTokens> {
  return exchange(
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    },
    input.fetch,
    input.signal,
    { teamId: input.fallbackTeamId, userId: input.fallbackUserId },
  );
}

async function exchange(
  values: Record<string, string>,
  injectedFetch?: FetchLike,
  signal?: AbortSignal,
  fallback?: { teamId: string; userId: string },
): Promise<SlackOAuthTokens> {
  const doFetch = injectedFetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const timeout = AbortSignal.timeout(10_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await doFetch("https://slack.com/api/oauth.v2.user.access", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values).toString(),
    signal: combined,
  });
  if (!response.ok) {
    throw new AuthenticationError(
      `Slack OAuth token exchange returned ${response.status} ${response.statusText}.`,
      { connector: "slack" },
    );
  }
  const parsed = OAuthUserAccessResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AuthenticationError("Slack OAuth returned an unexpected response.", {
      connector: "slack",
      cause: parsed.error,
    });
  }
  const data = parsed.data;
  if (!data.ok) {
    throw new AuthenticationError(
      `Slack OAuth rejected the connection (${data.error ?? "unknown_error"}).`,
      { connector: "slack" },
    );
  }
  const accessToken = data.access_token ?? data.authed_user?.access_token;
  const refreshToken = data.refresh_token ?? data.authed_user?.refresh_token;
  const expiresIn = data.expires_in ?? data.authed_user?.expires_in;
  const team = data.team ?? data.authed_user?.team;
  const teamId = team?.id ?? fallback?.teamId;
  const userId = data.authed_user?.id ?? fallback?.userId;
  if (!accessToken) throw new ConfigError("Slack OAuth response did not include a user access token.");
  const expiresAt =
    expiresIn != null ? new Date(Date.now() + expiresIn * 1000) : undefined;
  const scopes = (data.scope ?? data.authed_user?.scope ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    scopes,
    ...(teamId ? { teamId } : {}),
    ...(team?.name ? { teamName: team.name } : {}),
    ...(userId ? { userId } : {}),
  };
}
