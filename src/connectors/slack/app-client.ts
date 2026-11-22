import { AuthenticationError, ConfigError, ConnectorError } from "../../core/errors.ts";
import type { Logger } from "../../logging/logger.ts";
import { HttpClient, type FetchLike } from "../http.ts";
import {
  EventAuthorizationsResponseSchema,
  SocketOpenResponseSchema,
  type SlackEnvelope,
} from "./types.ts";

export class SlackAppClient {
  private readonly http: HttpClient;

  constructor(options: { token: string; logger?: Logger; fetch?: FetchLike }) {
    const token = options.token.trim();
    if (!token.startsWith("xapp-")) {
      throw new ConfigError("SLACK_APP_TOKEN must be an app-level token starting with `xapp-`.");
    }
    this.http = new HttpClient({
      baseUrl: "https://slack.com/api",
      connector: "slack",
      headers: { authorization: `Bearer ${token}` },
      budgetKey: "socket-mode-app",
      maxConcurrency: 2,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async openSocket(signal?: AbortSignal): Promise<string> {
    const { data } = await this.http.postJson(
      SocketOpenResponseSchema,
      "/apps.connections.open",
      {},
      { signal },
    );
    this.assertOk(data, "apps.connections.open");
    if (!data.url) throw new ConnectorError("Slack Socket Mode returned no WebSocket URL.");
    return data.url;
  }

  async eventAuthorizations(
    eventContext: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const { data } = await this.http.postJson(
      EventAuthorizationsResponseSchema,
      "/apps.event.authorizations.list",
      { event_context: eventContext },
      { signal },
    );
    this.assertOk(data, "apps.event.authorizations.list");
    return data.authorizations
      .filter((authorization) => authorization.is_bot !== true)
      .map((authorization) => authorization.user_id)
      .filter((userId): userId is string => !!userId);
  }

  private assertOk(data: SlackEnvelope, method: string): void {
    if (data.ok) return;
    const message = `Slack ${method} failed (${data.error ?? "unknown_error"}).`;
    if (
      data.error === "invalid_auth" ||
      data.error === "not_authed" ||
      data.error === "token_revoked"
    ) {
      throw new AuthenticationError(message, { connector: "slack" });
    }
    throw new ConnectorError(message, { connector: "slack" });
  }
}
