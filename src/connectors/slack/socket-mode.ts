import type { SlackConnectionRepository } from "../../application/ports.ts";
import type { Logger } from "../../logging/logger.ts";
import type { SecretStore } from "../../secrets/secret-store.ts";
import type { FetchLike } from "../http.ts";
import { SlackAppClient } from "./app-client.ts";
import {
  SlackEventCallbackSchema,
  SlackSocketEnvelopeSchema,
} from "./types.ts";

interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

interface SlackSocketModeOptions {
  secrets: SecretStore;
  connections: SlackConnectionRepository;
  logger: Logger;
  fetch?: FetchLike;
  socketFactory?: (url: string) => SocketLike;
  reconnectDelayMs?: number;
}

/**
 * Slack Events API over an outbound WebSocket.
 *
 * Event text is deliberately absent from the parsed schema and never reaches
 * persistence. The receiver records only which authorized user's conversation
 * changed and at which Slack timestamp; opening the conversation still fetches
 * message bodies live through that user's OAuth token.
 */
export class SlackSocketModeReceiver {
  private running = false;
  private socket?: SocketLike;
  private loop?: Promise<void>;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: SlackSocketModeOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.socket?.close();
    await this.loop;
    await Promise.allSettled([...this.pending]);
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      const token = this.options.secrets.get("SLACK_APP_TOKEN")?.trim();
      if (!token) {
        await delay(this.options.reconnectDelayMs ?? 5_000);
        continue;
      }
      try {
        const client = new SlackAppClient({
          token,
          logger: this.options.logger,
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
        const url = await client.openSocket();
        if (!this.running) return;
        failures = 0;
        await this.consumeSocket(url, token, client);
      } catch (err) {
        if (!this.running) return;
        failures += 1;
        this.options.logger.warn(
          { err: err instanceof Error ? err.message : String(err), failures },
          "Slack Socket Mode connection failed; retrying",
        );
      }
      if (this.running) {
        await delay(
          Math.min(this.options.reconnectDelayMs ?? 5_000, 30_000),
        );
      }
    }
  }

  private consumeSocket(
    url: string,
    token: string,
    client: SlackAppClient,
  ): Promise<void> {
    const factory =
      this.options.socketFactory ??
      ((socketUrl: string) => new WebSocket(socketUrl) as unknown as SocketLike);
    const socket = factory(url);
    this.socket = socket;

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(tokenCheck);
        if (this.socket === socket) this.socket = undefined;
        resolve();
      };
      const tokenCheck = setInterval(() => {
        if (!this.running || this.options.secrets.get("SLACK_APP_TOKEN")?.trim() !== token) {
          socket.close();
        }
      }, 5_000);

      socket.onopen = () => this.options.logger.info("Slack Socket Mode connected");
      socket.onerror = finish;
      socket.onclose = finish;
      socket.onmessage = (event) => {
        const text = socketText(event.data);
        if (!text) return;
        const envelope = SlackSocketEnvelopeSchema.safeParse(parseJson(text));
        if (!envelope.success) return;

        // Slack retries envelopes until acknowledged. Ack before the optional
        // authorization lookup; the metadata write itself is monotonic and
        // idempotent if a duplicate still arrives.
        socket.send(JSON.stringify({ envelope_id: envelope.data.envelope_id }));
        if (envelope.data.type !== "events_api") return;
        const work = this.handleEvent(envelope.data.payload, client).finally(() => {
          this.pending.delete(work);
        });
        this.pending.add(work);
      };
    });
  }

  private async handleEvent(payload: unknown, client: SlackAppClient): Promise<void> {
    const parsed = SlackEventCallbackSchema.safeParse(payload);
    if (!parsed.success) return;
    const callback = parsed.data;
    if (
      callback.event.subtype &&
      !["bot_message", "thread_broadcast", "me_message"].includes(callback.event.subtype)
    ) {
      return;
    }

    let slackUserIds = callback.authorizations
      .filter((authorization) => authorization.is_bot !== true)
      .map((authorization) => authorization.user_id)
      .filter((userId): userId is string => !!userId);
    const conversationType =
      callback.event.channel_type ?? inferConversationType(callback.event.channel);
    const privateConversation =
      conversationType === "im" || conversationType === "mpim";
    if (callback.event_context && !privateConversation) {
      try {
        const all = await client.eventAuthorizations(callback.event_context);
        if (all.length > 0) slackUserIds = all;
      } catch (err) {
        this.options.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "could not expand Slack event authorizations; using envelope authorization",
        );
      }
    }
    if (slackUserIds.length === 0) return;

    const changed = this.options.connections.recordWorkspaceActivity({
      teamId: callback.team_id,
      slackUserIds,
      conversationId: callback.event.channel,
      conversationType,
      latestTs: callback.event.ts,
      ...(callback.event.thread_ts ? { threadTs: callback.event.thread_ts } : {}),
    });
    if (changed.length > 0) {
      this.options.logger.debug(
        {
          conversation: callback.event.channel,
          recipients: changed.length,
          event: callback.event_id,
        },
        "recorded Slack conversation activity",
      );
    }
  }
}

function inferConversationType(channelId: string): "im" | "mpim" | "channel" | "group" {
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "mpim";
  return "channel";
}

function socketText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  return undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
