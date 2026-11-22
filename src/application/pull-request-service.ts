import { jiraBrowseUrl } from "../connectors/jira/client.ts";
import type { Actor } from "../core/actor.ts";
import { ConfigError, ValidationError } from "../core/errors.ts";
import type { Logger } from "../logging/logger.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import {
  byNewestFirst,
  DEFAULT_PULL_REQUEST_STATES,
  type FailedProvider,
  parsePullRequestId,
  type PullRequest,
  type PullRequestAsset,
  type PullRequestAuthor,
  type PullRequestChanges,
  type PullRequestDetail,
  type PullRequestListing,
  type PullRequestProvider,
  type PullRequestProviderFactory,
  type PullRequestRef,
  type PullRequestScope,
  type PullRequestState,
  PULL_REQUEST_STATES,
  type UnavailableProvider,
} from "./pull-requests.ts";

export interface PullRequestServiceDeps {
  providers: readonly PullRequestProviderFactory[];
  /**
   * The asking developer's provider identity. Instance configuration such as a
   * self-hosted API URL is shared, but credentials never fall back to another
   * account: "mine" must mean the person signed into TALOS.
   */
  secretsFor(actor: Actor): SecretStore;
  /**
   * The developer's own Team MRs repository filter — `group/project` paths,
   * empty meaning unfiltered. Passed in for the same reason `secretsFor` is:
   * one answer to "whose setting is this" in `app.ts`, not a second one here.
   */
  repoFilterFor(actor: Actor): readonly string[];
  logger: Logger;
}

/**
 * Reads pull requests as the logged-in developer, from every configured forge.
 *
 * Answers a question rather than owning state: there is nothing to *persist*,
 * because a pull request's home is the forge and a stored copy would be a second
 * source of truth that is wrong within minutes.
 *
 * That is a statement about persistence, not about coalescing. `src/api/cached.ts`
 * holds each listing for 60s and each detail for 30s in memory, which is a
 * different thing: shorter than a person notices, dropped when the refresh button
 * sends `Cache-Control: no-store`, and gone when the process exits. It lives in the
 * HTTP layer precisely so this class stays the live read — the agent and loop code
 * paths call straight through and always reach the forge.
 */
export class PullRequestApplicationService {
  constructor(private readonly deps: PullRequestServiceDeps) {}

  /**
   * The forge identity behind one provider's credentials. This uses the same
   * provider and user-scoped secret resolution as pull-request reads, so the
   * avatar cannot drift from the account that performs those reads.
   */
  async authenticatedUser(
    actor: Actor,
    providerName: string,
    signal?: AbortSignal,
  ): Promise<PullRequestAuthor | undefined> {
    const factory = this.deps.providers.find((provider) => provider.name === providerName);
    if (!factory) return undefined;

    const secrets = this.deps.secretsFor(actor);
    if (factory.requiredSecrets.some((name) => !secrets.get(name))) return undefined;

    const provider = factory.create({ secrets, logger: this.deps.logger });
    return provider.authenticatedUser?.({ signal });
  }

  async list(
    actor: Actor,
    scope: PullRequestScope,
    options: {
      states?: readonly PullRequestState[];
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<PullRequestListing> {
    const secrets = this.deps.secretsFor(actor);
    const states = normalizeStates(options.states);
    // Never applied to "mine": the filter narrows what the team is doing, not
    // what the developer is responsible for — their own work stays visible
    // even in a repository they forgot to add.
    const repositoryFilter = scope === "team" ? normalizeRepos(this.deps.repoFilterFor(actor)) : [];
    const matcher = repositoryMatcher(repositoryFilter);

    const unavailable: UnavailableProvider[] = [];
    const failed: FailedProvider[] = [];
    const ready: PullRequestProviderFactory[] = [];

    for (const factory of this.deps.providers) {
      const missing = factory.requiredSecrets.filter((name) => !secrets.get(name));
      if (missing.length > 0) {
        unavailable.push({ provider: factory.name, label: factory.label, missing });
        continue;
      }
      ready.push(factory);
    }

    // Concurrent and independent: one forge timing out must still let the
    // others render, which is also why this collects failures instead of
    // rejecting.
    const results = await Promise.all(
      ready.map(async (factory): Promise<PullRequest[]> => {
        try {
          const provider = factory.create({ secrets, logger: this.deps.logger });
          return await provider.list({ ...options, scope, states, repositoryFilter });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.logger.warn(
            { provider: factory.name, actor: actor.email, scope, err: message },
            `listing ${scope} pull requests from ${factory.name} failed`,
          );
          failed.push({ provider: factory.name, label: factory.label, message });
          return [];
        }
      }),
    );

    return {
      scope,
      states,
      repositoryFilter,
      // A provider is trusted to have honoured `states` server-side where its
      // API can, but filtered again here: a forge with no equivalent query
      // would otherwise leak rows past a filter the user set. The repository
      // filter is entirely a post-filter — a provider has no query for "just
      // these projects" cheap enough to ask for, so it always fetches its own
      // idea of "the team" and this narrows the answer afterward.
      pullRequests: results
        .flat()
        .filter((pr) => states.includes(pr.state))
        .filter(matcher)
        .sort(byNewestFirst),
      unavailable,
      failed,
    };
  }

  /**
   * One pull request in full, for the detail pane.
   *
   * Throws rather than collecting failures the way `list` does: a listing with
   * one forge missing is still a useful page, but a detail request names exactly
   * one pull request, and there is nothing to render if it cannot be read.
   */
  async detail(
    actor: Actor,
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PullRequestDetail> {
    const secrets = this.deps.secretsFor(actor);
    const { provider, ref } = this.resolve(secrets, id);
    const detail = await provider.detail(ref, options);

    // The connector recovered the issue key from the branch name but has no
    // business knowing where Jira lives; the link is attached here, against the
    // asking developer's own configured site.
    if (!detail.issue) return detail;
    const url = jiraBrowseUrl(secrets, detail.issue.key);
    return url ? { ...detail, issue: { ...detail.issue, url } } : detail;
  }

  async changes(
    actor: Actor,
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PullRequestChanges> {
    const secrets = this.deps.secretsFor(actor);
    const { provider, ref } = this.resolve(secrets, id);
    return await provider.changes(ref, options);
  }

  async asset(
    actor: Actor,
    id: string,
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PullRequestAsset> {
    const secrets = this.deps.secretsFor(actor);
    const { provider, ref } = this.resolve(secrets, id);
    if (!provider.asset) {
      throw new ConfigError(`${provider.name} cannot read pull request images.`);
    }
    return provider.asset(ref, path, options);
  }

  /**
   * The diff of one commit on this pull request.
   *
   * Takes the sha on trust from its caller, which is the route — the check that it
   * is a commit *on this pull request* belongs there, where the merge request has
   * already been fetched to authorize the read at all. Doing it here would mean a
   * second detail fetch per file diff.
   */
  async commitChanges(
    actor: Actor,
    id: string,
    sha: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PullRequestChanges> {
    const secrets = this.deps.secretsFor(actor);
    const { provider, ref } = this.resolve(secrets, id);
    if (!provider.commitChanges) {
      throw new ConfigError(`${provider.name} cannot diff a single commit.`);
    }
    return await provider.commitChanges(ref, sha, options);
  }

  /**
   * Turns an opaque pull request id from a URL into a provider that can be asked
   * about it. Every failure here is the caller's fault rather than the forge's —
   * a malformed id, a provider that is not installed, a token that was never
   * stored — so each gets its own message instead of one "not found".
   */
  private resolve(
    secrets: SecretStore,
    id: string,
  ): { provider: PullRequestProvider; ref: PullRequestRef } {
    const ref = parsePullRequestId(id);
    if (!ref) throw new ValidationError(`not a pull request id: ${id}`);

    const factory = this.deps.providers.find((candidate) => candidate.name === ref.provider);
    if (!factory) throw new ConfigError(`no pull request provider named ${ref.provider}`);

    const missing = factory.requiredSecrets.filter((name) => !secrets.get(name));
    if (missing.length > 0) {
      throw new ConfigError(
        `${factory.label} is not connected — missing ${missing.join(", ")}`,
      );
    }

    return {
      provider: factory.create({ secrets, logger: this.deps.logger }),
      ref,
    };
  }
}

/**
 * Deduped and in a fixed order, so two requests for the same filter produce the
 * same response — and an empty selection means the default rather than "nothing",
 * because a list that renders nothing until you tick a box is a broken page, not
 * a filter.
 */
function normalizeStates(states?: readonly PullRequestState[]): PullRequestState[] {
  if (!states || states.length === 0) return [...DEFAULT_PULL_REQUEST_STATES];
  return PULL_REQUEST_STATES.filter((state) => states.includes(state));
}

/** Trimmed and deduplicated; case is preserved in the response but ignored when matching. */
function normalizeRepos(repos: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of repos) {
    const trimmed = raw.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Empty means "let everything through" — a developer with no filter set sees
 * their groups' whole output, not nothing. A pull request with no repository
 * (a forge that cannot say which project it's from) also passes: it can't be
 * matched against the filter, so excluding it would be a guess.
 */
function repositoryMatcher(repositoryFilter: readonly string[]): (pr: PullRequest) => boolean {
  if (repositoryFilter.length === 0) return () => true;
  const allowed = new Set(repositoryFilter.map((repo) => repo.toLowerCase()));
  return (pr) => !pr.repository || allowed.has(pr.repository.toLowerCase());
}
