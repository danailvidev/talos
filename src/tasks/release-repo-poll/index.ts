/**
 * Discovers production manifest changes that landed outside Talos and opens
 * the same six-hour observability watch an Upload action would have opened.
 */
import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type {
  DeployWatchRepository,
  JobRepository,
  ReleaseConfig,
} from "../../application/ports.ts";
import {
  environmentOfManifestPath,
  isProductionEnvironment,
  parseManifestVersionDiff,
} from "../../application/releases.ts";
import type { FetchLike } from "../../connectors/http.ts";
import type {
  MergeRequest,
  RepositoryCommit,
} from "../../connectors/gitlab/types.ts";
import { ConfigError, describeError } from "../../core/errors.ts";
import { advanceWatermark, resolveWindow } from "../../core/watermark.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import {
  DEPLOY_WATCH_LOOP_ID,
  DEPLOY_WATCH_TASK_ID,
} from "../deploy-watch/index.ts";

export const RELEASE_REPO_POLL_TASK_ID = "release-repo-poll";
export const RELEASE_REPO_POLL_DEFAULT_CRON = "*/10 * * * *";

const WATCH_HOURS = 6;
const MAX_COMMITS = 200;
const ParamsSchema = z.object({});

export interface ReleaseRepoPollDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  releaseConfig?: () => ReleaseConfig | null;
  deployWatches?: DeployWatchRepository;
  jobs?: JobRepository;
}

export function createReleaseRepoPollTask(
  deps: ReleaseRepoPollDeps = {},
): Task<Record<string, never>> {
  return {
    id: RELEASE_REPO_POLL_TASK_ID,
    name: "External production releases",
    description:
      "Polls the configured release repository and opens post-deploy watches for PROD changes made directly in GitLab.",
    kind: "loop",
    instantiable: true,
    defaultTrigger: { type: "cron", expression: RELEASE_REPO_POLL_DEFAULT_CRON },
    paramsSchema: ParamsSchema,
    run: (ctx) => run(ctx, deps),
  };
}

async function run(
  ctx: TaskContext,
  deps: ReleaseRepoPollDeps,
): Promise<TaskResult> {
  const config = deps.releaseConfig?.();
  if (!config) {
    throw new ConfigError(
      "External release polling requires Settings → Releases to be configured.",
    );
  }
  const window = await resolveWindow(ctx);
  if (window.seeded) {
    return {
      itemsSeen: 0,
      itemsProcessed: 0,
      itemsSkipped: 0,
      details: { action: "seeded", projectId: config.projectId },
    };
  }

  const through = new Date();
  const gitlab = requireConnectors(deps).gitlab(ctx, deps.fetch);
  const commits = await ctx.step("list-release-commits", () =>
    gitlab.listCommits(config.projectId, {
      ref: config.targetBranch,
      since: window.since,
      limit: MAX_COMMITS,
      signal: ctx.signal,
    }),
  );
  const candidates = commits
    .filter((commit) => (commit.parent_ids?.length ?? 1) <= 1)
    .sort((a, b) => commitTime(a).getTime() - commitTime(b).getTime());

  let created = 0;
  let skipped = commits.length - candidates.length;
  let failures = 0;
  for (const commit of candidates) {
    try {
      const deployments = await deploymentsOf(ctx, gitlab, config, commit);
      if (deployments.length === 0) {
        skipped += 1;
        continue;
      }
      const mergeRequest = await mergedRequestOf(ctx, gitlab, config, commit);
      for (const deployment of deployments) {
        const eventId = `${config.projectId}:${commit.id}:${deployment.environment}`;
        if (
          !(await ctx.state.claimEvent(
            ctx.taskId,
            eventId,
            "external-production-release",
          ))
        ) {
          skipped += 1;
          continue;
        }
        try {
          const mergedAt = mergeRequest?.merged_at
            ? new Date(mergeRequest.merged_at)
            : commitTime(commit);
          const watchUntil = new Date(
            mergedAt.getTime() + WATCH_HOURS * 3_600_000,
          );
          if (watchUntil <= through) {
            skipped += 1;
            await ctx.state.completeEvent(ctx.taskId, eventId, {
              action: "stale",
              mergedAt: mergedAt.toISOString(),
            });
            continue;
          }
          const commitUrl = commit.web_url;
          if (!commitUrl) {
            throw new ConfigError(
              `GitLab did not return a URL for release commit ${commit.id}.`,
            );
          }
          const result = requireWatches(deps).createDetected({
            environment: deployment.environment,
            projectId: config.projectId,
            branch: config.targetBranch,
            services: deployment.services,
            mergedAt,
            watchUntil,
            commitSha: commit.id,
            commitUrl,
            ...(mergeRequest
              ? {
                  releaseKind: "merge-request" as const,
                  mrIid: mergeRequest.iid,
                  mrUrl: mergeRequest.web_url,
                }
              : { releaseKind: "commit" as const }),
          });
          if (result.created) {
            requireJobs(deps).enqueue({
              kind: DEPLOY_WATCH_TASK_ID,
              loopId: DEPLOY_WATCH_LOOP_ID,
              subjectKey: `deploy-watch:${result.watch.id}`,
              fingerprint: `watching:${result.watch.createdAt.getTime()}`,
              params: { watchId: result.watch.id },
            });
            created += 1;
          } else {
            skipped += 1;
          }
          await ctx.state.completeEvent(ctx.taskId, eventId, {
            action: result.created ? "watch-opened" : "already-watched",
            watchId: result.watch.id,
          });
        } catch (err) {
          failures += 1;
          await ctx.state.failEvent(ctx.taskId, eventId, describeError(err));
          ctx.logger.warn(
            { commit: commit.id, environment: deployment.environment, err },
            "could not open a watch for an external production release",
          );
        }
      }
    } catch (err) {
      failures += 1;
      ctx.logger.warn(
        { commit: commit.id, err },
        "could not inspect a release repository commit",
      );
    }
  }

  await advanceWatermark(ctx, through, { failures });
  return {
    itemsSeen: commits.length,
    itemsProcessed: created,
    itemsSkipped: skipped,
    itemsFailed: failures,
    details: {
      action: "polled",
      projectId: config.projectId,
      branch: config.targetBranch,
      watchesOpened: created,
    },
  };
}

async function deploymentsOf(
  ctx: TaskContext,
  gitlab: ReturnType<TaskConnectorFactory["gitlab"]>,
  config: ReleaseConfig,
  commit: RepositoryCommit,
): Promise<Array<{ environment: string; services: string[] }>> {
  const files = await ctx.step(`diff-${commit.id.slice(0, 8)}`, () =>
    gitlab.commitDiff(config.projectId, commit.id, ctx.signal),
  );
  const byEnvironment = new Map<string, Set<string>>();
  for (const file of files) {
    const environment = environmentOfManifestPath(
      file.new_path,
      config.manifestPath,
    );
    if (!environment || !isProductionEnvironment(environment)) continue;
    if (!file.diff || file.too_large) continue;
    const changes = parseManifestVersionDiff(file.diff);
    if (changes.length === 0) continue;
    const services = byEnvironment.get(environment) ?? new Set<string>();
    for (const change of changes) services.add(change.service);
    byEnvironment.set(environment, services);
  }
  return [...byEnvironment].map(([environment, services]) => ({
    environment,
    services: [...services],
  }));
}

async function mergedRequestOf(
  ctx: TaskContext,
  gitlab: ReturnType<TaskConnectorFactory["gitlab"]>,
  config: ReleaseConfig,
  commit: RepositoryCommit,
): Promise<MergeRequest | undefined> {
  const mergeRequests = await ctx.step(`mrs-${commit.id.slice(0, 8)}`, () =>
    gitlab.commitMergeRequests(config.projectId, commit.id, ctx.signal),
  );
  return mergeRequests
    .filter(
      (mr) =>
        mr.state === "merged" &&
        mr.target_branch === config.targetBranch &&
        mr.merged_at != null,
    )
    .sort(
      (a, b) =>
        new Date(b.merged_at!).getTime() - new Date(a.merged_at!).getTime(),
    )[0];
}

function commitTime(commit: RepositoryCommit): Date {
  const value = commit.committed_date ?? commit.created_at;
  const parsed = value ? new Date(value) : new Date(0);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function requireConnectors(deps: ReleaseRepoPollDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(`${RELEASE_REPO_POLL_TASK_ID} requires GitLab connectors.`);
  }
  return deps.connectors;
}

function requireWatches(deps: ReleaseRepoPollDeps): DeployWatchRepository {
  if (!deps.deployWatches) {
    throw new ConfigError(`${RELEASE_REPO_POLL_TASK_ID} requires the deploy-watch store.`);
  }
  return deps.deployWatches;
}

function requireJobs(deps: ReleaseRepoPollDeps): JobRepository {
  if (!deps.jobs) {
    throw new ConfigError(`${RELEASE_REPO_POLL_TASK_ID} requires the job queue.`);
  }
  return deps.jobs;
}
