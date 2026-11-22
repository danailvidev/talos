import {
  buildDeployWatchFindingSlackMessage,
  buildReleaseSlackMessage,
} from "../../shared/release-format.ts";
import { createSlackClient, slackReleaseChannel } from "../connectors/slack/client.ts";
import type { Logger } from "../logging/logger.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import type {
  DeployWatchFindingAnnouncement,
  ReleaseAnnouncement,
  ReleaseNotifier,
} from "./ports.ts";

export interface SlackReleaseNotifierDeps {
  /**
   * The **instance-wide** secret store, deliberately not a per-actor one.
   *
   * `SLACK_BOT_TOKEN` is in `ACTOR_SECRETS`, so an actor-scoped store would
   * silently prefer whichever developer's personal Slack token happened to be
   * saved — and which app posts to the team channel should not depend on who
   * clicked Upload. The person is named in the message body instead.
   */
  secrets: SecretStore;
  logger: Logger;
}

/**
 * Posts release announcements to a Slack channel.
 *
 * The client is built per call rather than once in the constructor, for the same
 * reason `OverlaySecretStore` re-reads on every lookup: a token saved in Settings
 * has to be the one the next release uses, not the one that existed at process
 * start. Constructing it also *validates* the token's shape, which is why
 * `configured()` does not attempt it — a malformed token should surface as a
 * failed announcement naming the problem, not as a toggle that quietly
 * disappears from the dialog.
 */
export class SlackReleaseNotifier implements ReleaseNotifier {
  constructor(private readonly deps: SlackReleaseNotifierDeps) {}

  configured(): boolean {
    const token = this.deps.secrets.get("SLACK_BOT_TOKEN");
    return token != null && token !== "" && slackReleaseChannel(this.deps.secrets) != null;
  }

  async announce(input: ReleaseAnnouncement, signal?: AbortSignal): Promise<void> {
    const channel = slackReleaseChannel(this.deps.secrets);
    if (!channel) {
      // Reached only if a caller skipped `configured()`. Worth an explicit
      // throw: the caller reports it as a warning, and "no channel set" is a
      // sentence an operator can act on.
      throw new Error("No Slack release channel is set — set SLACK_RELEASE_CHANNEL.");
    }

    const client = createSlackClient(this.deps.secrets, { logger: this.deps.logger });
    const posted = await client.postMessage({
      channel,
      text: buildReleaseSlackMessage(input),
      ...(signal ? { signal } : {}),
    });

    this.deps.logger.info(
      {
        environment: input.environment,
        channel: posted.channel,
        ts: posted.ts,
        author: input.author,
      },
      "announced release in slack",
    );
  }

  async announceFinding(
    input: DeployWatchFindingAnnouncement,
    signal?: AbortSignal,
  ): Promise<void> {
    const channel = slackReleaseChannel(this.deps.secrets);
    if (!channel) {
      throw new Error("No Slack release channel is set — set SLACK_RELEASE_CHANNEL.");
    }

    const client = createSlackClient(this.deps.secrets, { logger: this.deps.logger });
    const posted = await client.postMessage({
      channel,
      text: buildDeployWatchFindingSlackMessage(input),
      ...(signal ? { signal } : {}),
    });

    this.deps.logger.info(
      {
        environment: input.environment,
        service: input.service,
        channel: posted.channel,
        ts: posted.ts,
      },
      "announced a post-deploy finding in slack",
    );
  }
}
