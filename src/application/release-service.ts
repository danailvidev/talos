import { createGitLabClient } from "../connectors/gitlab/client.ts";
import type { Actor } from "../core/actor.ts";
import { ConfigError, ConnectorError, ValidationError } from "../core/errors.ts";
import type { Logger } from "../logging/logger.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import type { DeployWatchRepository, JobRepository, ReleaseConfig, ReleaseNotifier } from "./ports.ts";
import {
  buildReleaseDescription,
  buildReleaseRevertDescription,
  buildReleaseRevertTitle,
  buildReleaseTitle,
  environmentLabel,
  type FormatChange,
} from "../../shared/release-format.ts";
import {
  applyChanges,
  environmentOfManifestPath,
  type EnvironmentVersions,
  isProductionEnvironment,
  type ManifestVersionChange,
  parseClusterManifest,
  parseManifestVersionDiff,
  type ServiceVersionChange,
} from "./releases.ts";

/**
 * Kept as string literals rather than imported from `tasks/deploy-watch`:
 * `application/` sits below `tasks/` in this codebase's layering (tasks depend
 * on application ports, never the reverse), and these two strings are the whole
 * surface `upload()` needs from that task.
 */
const DEPLOY_WATCH_TASK_ID = "deploy-watch";
const DEPLOY_WATCH_LOOP_ID = "deploy-watch";
const RELEASE_PIPELINE_WATCH_TASK_ID = "release-pipeline-watch";
const RELEASE_PIPELINE_WATCH_LOOP_ID = "release-pipeline-watch";

/**
 * How far back the history tab looks by default, in commits — not in days, since
 * a repo that gets one release a week and one that gets thirty a day both want
 * "the last few dozen deployments" rather than the same calendar window.
 */
const HISTORY_COMMIT_LIMIT = 50;

/** Diff requests in flight at once. One per commit, so the window sets the total. */
const HISTORY_DIFF_CONCURRENCY = 6;

export interface ReleaseServiceDeps {
  /**
   * The acting developer's own provider identity plus shared endpoint
   * configuration. Interactive release reads and writes never borrow the
   * instance-wide GitLab identity.
   */
  secretsFor(actor: Actor): SecretStore;
  /** The instance-wide releases config, or null until an operator sets it. */
  config(): ReleaseConfig | null;
  /**
   * Announces an opened release to the team channel. Instance-wide, unlike
   * `secretsFor` — see `SlackReleaseNotifierDeps` for why the announcing identity
   * is not the acting developer's.
   */
  notifier: ReleaseNotifier;
  logger: Logger;
  /**
   * Where a production release's watch is recorded, and the queue it raises the
   * watch's first job on. Both optional so a deployment without either keeps
   * uploading releases exactly as before — the watch is additive, never a
   * condition of the upload succeeding.
   */
  deployWatches?: DeployWatchRepository;
  jobs?: JobRepository;
}

export interface ReleaseManifestSource {
  environments: EnvironmentVersions[];
  projectId: string;
  /** The per-environment manifest filename, e.g. `cluster.yaml`. */
  manifestPath: string;
  targetBranch: string;
}

/** One past deployment: a commit on the manifest, and the versions it moved. */
export interface ReleaseDeployment {
  environment: string;
  sha: string;
  shortSha: string;
  /** The commit subject, which for an uploaded release is the MR title. */
  title: string;
  /** Who committed it, as the forge recorded them. */
  authorName: string;
  authorEmail: string | null;
  committedAt: Date;
  webUrl: string | null;
  changes: ManifestVersionChange[];
}

export interface ReleaseHistorySource {
  projectId: string;
  targetBranch: string;
  /** Newest first, one entry per (commit, environment) pair that moved a version. */
  deployments: ReleaseDeployment[];
  /** Every environment the returned window mentions, for the filter. */
  environments: string[];
  /** How many commits were examined — what the window covers, for the UI to say. */
  commitsScanned: number;
}

export interface ReleaseUploadInput {
  environment: string;
  changes: ServiceVersionChange[];
  /** Overrides the generated MR title, when the developer edited the prefilled one. */
  title?: string;
  /** Overrides the generated MR description. */
  description?: string;
  /**
   * Announce the release in the team's Slack channel. Defaults to off here even
   * though the dialog's toggle defaults to on: an omitted flag from any other
   * caller should not post to a channel.
   */
  notifySlack?: boolean;
  /** Internal action wording; public uploads always use the default deploy behavior. */
  kind?: "deploy" | "revert";
  /** Prevent a revert from overwriting a service that moved after its preview was loaded. */
  expectedVersions?: { service: string; section: ServiceVersionChange["section"]; version: string }[];
}

export interface ReleaseRevertInput {
  environment: string;
  /** SHA shown in the confirmation dialog; a newer deployment makes the request stale. */
  sha: string;
  notifySlack?: boolean;
}

export interface ReleaseRevertPreview {
  projectId: string;
  targetBranch: string;
  deployment: ReleaseDeployment;
  changes: ServiceVersionChange[];
}

export interface ReleaseUploadResult {
  mrUrl: string;
  mrIid: number;
  branch: string;
  /**
   * Whether the merge request was approved. False when approval was attempted
   * but GitLab declined it (e.g. approvals are a paid-tier feature the project
   * does not have) — the MR is still open, so this is a warning, not a failure.
   */
  approved: boolean;
  /**
   * Whether the merge request merged immediately. Normally false — `upload`
   * sets auto-merge rather than merging outright, so this is only true for the
   * rare MR that GitLab merges synchronously (no pipeline configured).
   */
  merged: boolean;
  /**
   * Whether GitLab accepted "merge when pipeline succeeds" — the MR will merge
   * itself once its pipeline passes, with no further action. False when
   * requesting it was declined (conflicts, an unresolved discussion, missing
   * approvals) — the MR is still open and approved, so this is a warning, not
   * a failure.
   */
  autoMergeEnabled: boolean;
  /**
   * Whether the team channel was told. False both when the caller did not ask
   * for it and when it was asked for but failed — `notifyError` distinguishes
   * those, and is the only one of the two worth showing a developer.
   */
  notified: boolean;
  /**
   * Why the announcement failed, when one was attempted and did not land. The
   * release itself succeeded regardless, so this is a warning, not a failure.
   */
  notifyError?: string;
}

/**
 * Reads and edits the per-environment `cluster.yaml` files in the releases repo
 * as the acting developer.
 *
 * The repo's top-level folders are the environments; each holds a `cluster.yaml`
 * listing its `applications` and `services`. Reading scans those folders; an
 * upload edits one environment's file in place and opens a merge request. A
 * direct GitLab API sequence, not a queued agent run (the user's choice). There
 * is nothing to *persist* — the manifests' home is the repo, and a stored copy
 * would be a second source of truth that is wrong within minutes.
 *
 * Persistence, not coalescing: `GET /api/releases` holds one read per user for 120s
 * in memory via `src/api/cached.ts`, bypassed by the refresh button's
 * `Cache-Control: no-store` and gone with the process. The cache is in the HTTP
 * layer so this class remains the live read for everything else.
 */
export class ReleaseApplicationService {
  constructor(private readonly deps: ReleaseServiceDeps) {}

  /** Every environment and its service versions, from each folder's manifest at HEAD. */
  async read(actor: Actor, signal?: AbortSignal): Promise<ReleaseManifestSource> {
    const { config, client } = this.resolve(actor);

    const tree = await client.listTree(config.projectId, {
      ref: config.targetBranch,
      signal,
    });
    const folders = tree.filter((entry) => entry.type === "tree");

    // Concurrent: a repo with a dozen environments should not read them one at
    // a time. A folder with no `cluster.yaml` is not an environment — skip it
    // rather than failing, since the repo root can hold other directories.
    const environments = (
      await Promise.all(
        folders.map(async (folder): Promise<EnvironmentVersions | null> => {
          const filePath = `${folder.path}/${config.manifestPath}`;
          let content: string;
          try {
            ({ content } = await client.getFileRaw(
              config.projectId,
              filePath,
              config.targetBranch,
              signal,
            ));
          } catch (err) {
            if (isNotFound(err)) return null;
            throw err;
          }
          return { name: folder.name, services: parseClusterManifest(content, filePath) };
        }),
      )
    )
      .filter((env): env is EnvironmentVersions => env != null)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      environments,
      projectId: config.projectId,
      manifestPath: config.manifestPath,
      targetBranch: config.targetBranch,
    };
  }

  /**
   * The deployment history: recent commits on the manifests, newest first, each
   * with the versions it moved and who moved them.
   *
   * Read from the repo's own history rather than from a table of uploads, because
   * the repo is where the answer actually lives — a manifest edited from an IDE,
   * or from before this console existed, is a deployment too, and a table would
   * only know the ones that went through the upload dialog.
   *
   * Merge commits are skipped: the commit they bring in is in the same listing,
   * and counting both would show every release twice.
   */
  async history(
    actor: Actor,
    options: {
      limit?: number;
      environment?: string;
      /** Only inspect commits at or after this instant. */
      since?: Date;
      signal?: AbortSignal;
    } = {},
  ): Promise<ReleaseHistorySource> {
    const { config, client } = this.resolve(actor);
    const limit = Math.min(Math.max(options.limit ?? HISTORY_COMMIT_LIMIT, 1), 200);

    const commits = await client.listCommits(config.projectId, {
      ref: config.targetBranch,
      // One environment at a time is GitLab filtering by path; without it the
      // whole repo's history is the window, which is what the combined timeline
      // wants.
      ...(options.environment ? { path: `${options.environment}/${config.manifestPath}` } : {}),
      ...(options.since ? { since: options.since } : {}),
      limit,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const candidates = commits.filter((commit) => (commit.parent_ids?.length ?? 1) <= 1);

    // One diff request per commit, a few at a time: a 50-commit window must not
    // open 50 connections to GitLab at once, and must not take 50 round trips
    // in series either.
    const deployments: ReleaseDeployment[] = [];
    for (let i = 0; i < candidates.length; i += HISTORY_DIFF_CONCURRENCY) {
      const batch = candidates.slice(i, i + HISTORY_DIFF_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (commit) => {
          const files = await client.commitDiff(config.projectId, commit.id, options.signal);
          const committedAt = commit.committed_date ?? commit.created_at;
          return files.flatMap((file): ReleaseDeployment[] => {
            const environment = environmentOfManifestPath(file.new_path, config.manifestPath);
            if (!environment) return [];
            if (options.environment && environment !== options.environment) return [];
            if (!file.diff || file.too_large) return [];
            const changes = parseManifestVersionDiff(file.diff);
            if (changes.length === 0) return [];
            return [
              {
                environment,
                sha: commit.id,
                shortSha: commit.short_id ?? commit.id.slice(0, 8),
                title: commit.title ?? commit.message?.split("\n")[0] ?? "(no title)",
                authorName: commit.author_name ?? "unknown",
                authorEmail: commit.author_email ?? null,
                committedAt: committedAt ? new Date(committedAt) : new Date(0),
                webUrl: commit.web_url ?? null,
                changes,
              },
            ];
          });
        }),
      );
      deployments.push(...results.flat());
    }

    // Newest first. GitLab already returns the commits that way, but a commit
    // touching two environments produces two entries, and the sort keeps those
    // adjacent whatever order the batches finished in.
    deployments.sort((a, b) => b.committedAt.getTime() - a.committedAt.getTime());

    return {
      projectId: config.projectId,
      targetBranch: config.targetBranch,
      deployments,
      environments: [...new Set(deployments.map((d) => d.environment))].sort((a, b) =>
        a.localeCompare(b),
      ),
      commitsScanned: commits.length,
    };
  }

  /**
   * Resolves the newest version-changing commit for one environment and verifies
   * that its inverse still applies to the current manifest.
   */
  async previewRevert(
    actor: Actor,
    environment: string,
    signal?: AbortSignal,
  ): Promise<ReleaseRevertPreview> {
    const name = environment.trim();
    if (!name) throw new ValidationError("An environment is required.");

    const { config, client } = this.resolve(actor);
    const deployment = await this.latestDeployment(client, config, name, signal);
    if (!deployment) {
      throw new ValidationError(`No deployment was found for '${name}'.`);
    }

    const filePath = `${name}/${config.manifestPath}`;
    const current = await client.getFileRaw(config.projectId, filePath, config.targetBranch, signal);
    const services = parseClusterManifest(current.content, filePath);
    const changes = revertChanges(name, deployment, services);

    return {
      projectId: config.projectId,
      targetBranch: config.targetBranch,
      deployment,
      changes,
    };
  }

  /** Opens, approves and auto-merges a new MR that reverses the previewed deployment. */
  async revert(actor: Actor, input: ReleaseRevertInput): Promise<ReleaseUploadResult> {
    const preview = await this.previewRevert(actor, input.environment);
    if (preview.deployment.sha !== input.sha) {
      throw new ValidationError(
        `A newer ${input.environment} deployment landed after this confirmation was opened. Review the latest deployment and try again.`,
      );
    }

    const described: FormatChange[] = preview.changes.map((change) => {
      const deployed = preview.deployment.changes.find(
        (candidate) =>
          candidate.service === change.service &&
          (candidate.section == null || candidate.section === change.section),
      );
      return {
        service: change.service,
        section: change.section,
        version: change.version,
        ...(deployed ? { previousVersion: deployed.to } : {}),
      };
    });

    return this.upload(actor, {
      environment: input.environment,
      changes: preview.changes,
      title: buildReleaseRevertTitle(input.environment, preview.deployment.shortSha),
      description: buildReleaseRevertDescription({
        environment: input.environment,
        shortSha: preview.deployment.shortSha,
        commitUrl: preview.deployment.webUrl,
        changes: described,
      }),
      notifySlack: input.notifySlack,
      kind: "revert",
      expectedVersions: described.map((change) => ({
        service: change.service,
        section: change.section,
        version: change.previousVersion!,
      })),
    });
  }

  /**
   * Applies version changes to one environment's `cluster.yaml` and opens a
   * merge request.
   *
   * If an MR from the branch we would push already exists it is returned rather
   * than treated as an error — "already exists is a fact, not a failure", the
   * same stance `createMergeRequest` takes.
   */
  async upload(actor: Actor, input: ReleaseUploadInput): Promise<ReleaseUploadResult> {
    const { config, client } = this.resolve(actor);

    if (input.changes.length === 0) {
      throw new ValidationError("No version changes to upload.");
    }
    // Every change belongs to the chosen environment — one env per MR, and
    // letting a change name a different env would edit its file silently.
    for (const change of input.changes) {
      if (change.environment !== input.environment) {
        throw new ValidationError(
          `Change for '${change.environment}/${change.service}' does not belong to environment '${input.environment}'.`,
        );
      }
    }

    const filePath = `${input.environment}/${config.manifestPath}`;
    const current = await client.getFileRaw(config.projectId, filePath, config.targetBranch);
    const updated = applyChanges(current.content, filePath, input.changes);
    if (updated === current.content) {
      throw new ValidationError("No version changes to upload — every value already matches.");
    }

    // Title and description default to the generated wording but yield to the
    // caller's own text when they edited the prefilled fields. The `env::<ENV>`
    // label is always derived, matching the repo's existing convention.
    const before = parseClusterManifest(current.content, filePath);
    for (const expected of input.expectedVersions ?? []) {
      const actual = before.find(
        (service) =>
          service.section === expected.section && service.name === expected.service,
      );
      if (!actual || actual.version !== expected.version) {
        throw new ValidationError(
          `Cannot revert '${expected.service}': the current version is ${actual?.version ?? "missing"}, expected ${expected.version}. Refresh and review the latest deployment.`,
        );
      }
    }
    const described: FormatChange[] = input.changes.map((change) => {
      const previous = before.find(
        (s) => s.section === change.section && s.name === change.service,
      );
      return {
        service: change.service,
        version: change.version,
        section: change.section,
        ...(previous ? { previousVersion: previous.version } : {}),
      };
    });
    const title = input.title?.trim()
      ? input.title.trim()
      : buildReleaseTitle(input.environment, input.changes);
    const description = input.description?.trim()
      ? input.description.trim()
      : buildReleaseDescription(input.environment, described);
    const label = environmentLabel(input.environment);

    const branch = `${input.kind === "revert" ? "revert" : "release"}/${slug(input.environment)}-${timestamp()}`;

    // Reuse an already-open MR from this exact branch rather than failing on a
    // retry of the same request.
    const existing = await client.listMergeRequests(config.projectId, {
      sourceBranch: branch,
      state: "opened",
    });
    const open = existing[0];
    if (open?.web_url && open.iid != null) {
      const approved = await this.approve(client, config.projectId, open.iid, actor);
      const { merged, autoMergeEnabled } = await this.merge(
        client,
        config.projectId,
        open.iid,
        actor,
      );
      const notification = await this.notify(input, actor, {
        described,
        mrUrl: open.web_url,
        merged,
        autoMergeEnabled,
      });
      this.openWatch(input, actor, config.projectId, open.iid, open.web_url, branch);
      this.openPipelineWatch(
        input,
        actor,
        config.projectId,
        open.iid,
        open.web_url,
        open.created_at,
        merged,
      );
      return {
        mrUrl: open.web_url,
        mrIid: open.iid,
        branch,
        approved,
        merged,
        autoMergeEnabled,
        ...notification,
      };
    }

    await client.createCommit(config.projectId, {
      branch,
      startBranch: config.targetBranch,
      commitMessage: title,
      actions: [{ action: "update", filePath, content: updated }],
    });

    const mr = await client.createMergeRequest(config.projectId, {
      sourceBranch: branch,
      targetBranch: config.targetBranch,
      title,
      description,
      labels: [label],
      removeSourceBranch: true,
    });

    const approved = await this.approve(client, config.projectId, mr.iid, actor);
    const { merged, autoMergeEnabled } = await this.merge(client, config.projectId, mr.iid, actor);
    const notification = await this.notify(input, actor, {
      described,
      mrUrl: mr.web_url,
      merged,
      autoMergeEnabled,
    });

    this.deps.logger.info(
      {
        actor: actor.email,
        environment: input.environment,
        branch,
        mrIid: mr.iid,
        approved,
        merged,
        autoMergeEnabled,
        notified: notification.notified,
      },
      "opened release merge request",
    );
    this.openWatch(input, actor, config.projectId, mr.iid, mr.web_url, branch);
    this.openPipelineWatch(
      input,
      actor,
      config.projectId,
      mr.iid,
      mr.web_url,
      mr.created_at,
      merged,
    );
    return {
      mrUrl: mr.web_url,
      mrIid: mr.iid,
      branch,
      approved,
      merged,
      autoMergeEnabled,
      ...notification,
    };
  }

  /**
   * Every uploaded release, not only production, gets a short-lived pipeline
   * watcher. It is a soft follow-up because the MR already exists; queue trouble
   * must not turn a successful upload response into a failure.
   */
  private openPipelineWatch(
    input: ReleaseUploadInput,
    actor: Actor,
    projectId: string,
    mrIid: number,
    mrUrl: string,
    createdAt: Date | undefined,
    merged: boolean,
  ): void {
    if (merged || !this.deps.jobs) return;

    try {
      this.deps.jobs.enqueue({
        kind: RELEASE_PIPELINE_WATCH_TASK_ID,
        loopId: RELEASE_PIPELINE_WATCH_LOOP_ID,
        subjectKey: `release-mr:${projectId}!${mrIid}`,
        fingerprint: `opened:${mrIid}`,
        actorId: actor.id,
        params: {
          projectId,
          mrIid,
          mrUrl,
          environment: input.environment,
          services: [...new Set(input.changes.map((change) => change.service))],
          openedAt: (createdAt ?? new Date()).toISOString(),
        },
      });
    } catch (err) {
      this.deps.logger.warn(
        { actor: actor.email, environment: input.environment, mrIid, err },
        "opened a release but could not start its pipeline watch",
      );
    }
  }

  /**
   * Opens (or resumes) a post-deploy watch for a production release. A soft
   * failure like `notify` and for the same reason: the merge request already
   * exists, so a store or queue hiccup here must not turn a successful upload
   * into a thrown error.
   *
   * Idempotent on `(projectId, mrIid)` — the "reuse an already-open MR" branch
   * above calls this on every retry of the same request, and a second watch on
   * the same release would double the findings the team sees.
   */
  private openWatch(
    input: ReleaseUploadInput,
    actor: Actor,
    projectId: string,
    mrIid: number,
    mrUrl: string,
    branch: string,
  ): void {
    if (!isProductionEnvironment(input.environment)) return;
    if (!this.deps.deployWatches || !this.deps.jobs) return;

    try {
      if (this.deps.deployWatches.getByMr(projectId, mrIid)) return;

      const services = [...new Set(input.changes.map((change) => change.service))];
      const watch = this.deps.deployWatches.create({
        environment: input.environment,
        projectId,
        mrIid,
        mrUrl,
        branch,
        actorId: actor.id,
        services,
      });
      this.deps.jobs.enqueue({
        kind: DEPLOY_WATCH_TASK_ID,
        loopId: DEPLOY_WATCH_LOOP_ID,
        subjectKey: `deploy-watch:${watch.id}`,
        fingerprint: `pending-merge:${watch.createdAt.getTime()}`,
        actorId: actor.id,
        params: { watchId: watch.id },
      });
      this.deps.logger.info(
        { watchId: watch.id, environment: input.environment, mrIid, services },
        `opened a post-deploy watch for the ${input.environment} release !${mrIid}`,
      );
    } catch (err) {
      this.deps.logger.warn(
        { actor: actor.email, environment: input.environment, mrIid, err },
        "opened a production release but could not start its post-deploy watch",
      );
    }
  }

  /**
   * Announces the release in the team channel, treating a failure as a soft
   * warning — the third member of the `approve`/`merge` family, and for the same
   * reason: the merge request exists by the time this runs, and throwing here
   * would report a release that already happened as a failure. So a Slack outage,
   * a revoked token or an uninvited app comes back as `notified: false` with the
   * reason attached.
   *
   * Not asked for, or no token and channel configured, is not a failure at all:
   * `notified: false` with no error, which is how the toast stays quiet about a
   * feature the developer switched off.
   */
  private async notify(
    input: ReleaseUploadInput,
    actor: Actor,
    outcome: {
      described: FormatChange[];
      mrUrl: string;
      merged: boolean;
      autoMergeEnabled: boolean;
    },
  ): Promise<{ notified: boolean; notifyError?: string }> {
    if (input.notifySlack !== true) return { notified: false };
    if (!this.deps.notifier.configured()) {
      // Asked for but impossible: worth naming, because from the dialog this can
      // only happen if the token was cleared between load and submit.
      return {
        notified: false,
        notifyError: "Slack is not connected — set a bot token and channel in Settings.",
      };
    }

    try {
      await this.deps.notifier.announce({
        environment: input.environment,
        changes: outcome.described,
        mrUrl: outcome.mrUrl,
        author: actor.email,
        merged: outcome.merged,
        autoMergeEnabled: outcome.autoMergeEnabled,
        kind: input.kind ?? "deploy",
      });
      return { notified: true };
    } catch (err) {
      this.deps.logger.warn(
        { actor: actor.email, environment: input.environment, err },
        "opened release merge request but could not announce it in slack",
      );
      return { notified: false, notifyError: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Approves the merge request, treating a refusal as a soft warning.
   *
   * An MR that opened but could not be approved is a better outcome than
   * throwing after the branch, commit and MR already exist — the developer can
   * approve it by hand. So a failure here is logged and reported as
   * `approved: false`, not raised.
   */
  private async approve(
    client: ReturnType<typeof createGitLabClient>,
    projectId: string,
    mrIid: number,
    actor: Actor,
  ): Promise<boolean> {
    try {
      await client.approveMergeRequest(projectId, mrIid);
      return true;
    } catch (err) {
      this.deps.logger.warn(
        { actor: actor.email, mrIid, err },
        "opened release merge request but could not approve it",
      );
      return false;
    }
  }

  /**
   * Sets the merge request to merge automatically once its pipeline succeeds,
   * treating a refusal as a soft warning.
   *
   * Merging outright here would skip a pipeline that has not run yet rather
   * than wait for it, so `upload` always asks for auto-merge instead of an
   * immediate merge. GitLab still merges synchronously when the MR has
   * nothing to wait on, which is what `merged` reports. An MR that opened and
   * was approved but could not be queued to auto-merge (conflicts, an
   * unresolved discussion, missing approvals) is still a better outcome than
   * throwing after all of that already happened — the developer can merge it
   * by hand. So a failure here is logged and reported as `autoMergeEnabled:
   * false`, not raised.
   */
  private async merge(
    client: ReturnType<typeof createGitLabClient>,
    projectId: string,
    mrIid: number,
    actor: Actor,
  ): Promise<{ merged: boolean; autoMergeEnabled: boolean }> {
    try {
      const mr = await client.mergeMergeRequest(projectId, mrIid, { autoMerge: true });
      return {
        merged: mr.state === "merged",
        autoMergeEnabled: mr.merge_when_pipeline_succeeds === true,
      };
    } catch (err) {
      this.deps.logger.warn(
        { actor: actor.email, mrIid, err },
        "opened release merge request but could not set it to auto-merge",
      );
      return { merged: false, autoMergeEnabled: false };
    }
  }

  /** The first non-merge commit with a version diff for this environment. */
  private async latestDeployment(
    client: ReturnType<typeof createGitLabClient>,
    config: ReleaseConfig,
    environment: string,
    signal?: AbortSignal,
  ): Promise<ReleaseDeployment | null> {
    const filePath = `${environment}/${config.manifestPath}`;
    const commits = await client.listCommits(config.projectId, {
      ref: config.targetBranch,
      path: filePath,
      limit: HISTORY_COMMIT_LIMIT,
      ...(signal ? { signal } : {}),
    });

    for (const commit of commits) {
      if ((commit.parent_ids?.length ?? 1) > 1) continue;
      const files = await client.commitDiff(config.projectId, commit.id, signal);
      const file = files.find(
        (candidate) =>
          environmentOfManifestPath(candidate.new_path, config.manifestPath) === environment,
      );
      if (!file?.diff || file.too_large) continue;
      const changes = parseManifestVersionDiff(file.diff);
      if (changes.length === 0) continue;
      const committedAt = commit.committed_date ?? commit.created_at;
      return {
        environment,
        sha: commit.id,
        shortSha: commit.short_id ?? commit.id.slice(0, 8),
        title: commit.title ?? commit.message?.split("\n")[0] ?? "(no title)",
        authorName: commit.author_name ?? "unknown",
        authorEmail: commit.author_email ?? null,
        committedAt: committedAt ? new Date(committedAt) : new Date(0),
        webUrl: commit.web_url ?? null,
        changes,
      };
    }
    return null;
  }

  /**
   * Resolves the config and a GitLab client for the acting developer, or throws
   * a `ConfigError` with a message the page can render — an unset config or a
   * missing token is a setup gap to guide through, not a crash.
   */
  private resolve(actor: Actor): {
    config: ReleaseConfig;
    client: ReturnType<typeof createGitLabClient>;
  } {
    const config = this.deps.config();
    if (!config) {
      throw new ConfigError("Releases are not configured — set the repository in Settings.");
    }
    const secrets = this.deps.secretsFor(actor);
    if (!secrets.get("GITLAB_TOKEN")) {
      throw new ConfigError("GitLab is not connected — a GITLAB_TOKEN with 'api' scope is required.");
    }
    return { config, client: createGitLabClient(secrets, { logger: this.deps.logger }) };
  }
}

/** A folder with no manifest, distinguished from a real failure (auth, network). */
function isNotFound(err: unknown): boolean {
  return err instanceof ConnectorError && (err.status === 404 || / returned 404\b/.test(err.message));
}

/** A branch-safe slug of an environment name. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "env";
}

/** `20260901-1423` — enough to keep concurrent uploads to one env on distinct branches. */
function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
}

/**
 * Builds the inverse of a deployment only when the manifest still contains the
 * versions that deployment introduced. This makes stale confirmations fail
 * closed instead of rolling a newer deployment back accidentally.
 */
export function revertChanges(
  environment: string,
  deployment: ReleaseDeployment,
  current: EnvironmentVersions["services"],
): ServiceVersionChange[] {
  const changes: ServiceVersionChange[] = [];
  const seen = new Set<string>();

  for (const deployed of deployment.changes) {
    if (deployed.from == null) {
      throw new ValidationError(
        `Deployment ${deployment.shortSha} added '${deployed.service}', which cannot be reverted as a version change.`,
      );
    }

    const candidates = current.filter(
      (service) =>
        service.name === deployed.service &&
        (deployed.section == null || service.section === deployed.section),
    );
    if (candidates.length !== 1) {
      throw new ValidationError(
        candidates.length === 0
          ? `Cannot revert '${deployed.service}': it is no longer present in ${environment}.`
          : `Cannot revert '${deployed.service}': its manifest section is ambiguous.`,
      );
    }
    const service = candidates[0]!;
    if (service.version !== deployed.to) {
      throw new ValidationError(
        `Cannot revert '${deployed.service}': the current version is ${service.version}, but deployment ${deployment.shortSha} set ${deployed.to}.`,
      );
    }

    const key = `${service.section}\u0000${service.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push({
      environment,
      service: service.name,
      section: service.section,
      version: deployed.from,
    });
  }

  if (changes.length === 0) {
    throw new ValidationError(`Deployment ${deployment.shortSha} has no reversible version changes.`);
  }
  return changes;
}
