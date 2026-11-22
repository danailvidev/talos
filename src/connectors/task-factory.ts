import type { TaskConnectorFactory } from "../application/gateways.ts";
import { createGitLabClient } from "./gitlab/client.ts";
import { createJiraClient } from "./jira/client.ts";

/** Outbound adapter factory shared by every connector-backed task. */
export const taskConnectorFactory: TaskConnectorFactory = {
  // Via the create* helpers rather than the constructors, so an instance-wide
  // `GITLAB_API_URL` (a self-hosted host) applies to tasks as well as to the
  // console's own reads — see `secrets/integration-secrets.ts`.
  gitlab: (ctx, fetch) => createGitLabClient(ctx.secrets, {
    logger: ctx.logger, fetch, priority: "background",
  }),
  jira: (ctx, fetch) => createJiraClient(ctx.secrets, {
    logger: ctx.logger, fetch, priority: "background",
  }),
};
