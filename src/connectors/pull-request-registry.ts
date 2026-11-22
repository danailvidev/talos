import type { PullRequestProviderFactory } from "../application/pull-requests.ts";
import { gitlabPullRequestProvider } from "./gitlab/pull-requests.ts";

/**
 * Forges that can answer "what pull requests are open".
 *
 * The one list a second forge has to appear in. Lazy for the same reason
 * `CONNECTORS` is: a developer with only a GitLab token must not be told that
 * an unconfigured GitHub is broken, so nothing here is constructed until a
 * request has confirmed its secrets are present.
 */
export const PULL_REQUEST_PROVIDERS: readonly PullRequestProviderFactory[] = [
  gitlabPullRequestProvider,
];
