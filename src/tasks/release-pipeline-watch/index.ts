import { z } from "zod";

import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type {
  JobRepository,
  NotificationRepository,
} from "../../application/ports.ts";
import { ConfigError } from "../../core/errors.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";

export const RELEASE_PIPELINE_WATCH_TASK_ID = "release-pipeline-watch";
export const RELEASE_PIPELINE_WATCH_LOOP_ID = "release-pipeline-watch";

const POLL_MINUTES = 2;
const GIVE_UP_HOURS = 24;
const FAILED_STATUSES = new Set(["failed", "canceled"]);

const ConfigSchema = z.object({
  projectId: z.string().min(1),
  mrIid: z.number().int().positive(),
  mrUrl: z.string().min(1),
  environment: z.string().min(1),
  services: z.array(z.string().min(1)).default([]),
  openedAt: z.string().min(1),
});
type Config = z.infer<typeof ConfigSchema>;

export interface ReleasePipelineWatchDeps {
  connectors?: TaskConnectorFactory;
  jobs?: JobRepository;
  notifications?: NotificationRepository;
}

/**
 * Follows the pipeline GitLab attaches to a release MR. The job reschedules
 * itself while GitLab is still preparing/running the pipeline and after a
 * successful pipeline while auto-merge is settling. It stops only once the MR
 * merges, or raises one durable Bell notification when the release needs human
 * attention.
 */
export function createReleasePipelineWatchTask(
  deps: ReleasePipelineWatchDeps = {},
): Task<Config> {
  return {
    id: RELEASE_PIPELINE_WATCH_TASK_ID,
    name: "Release pipeline watch",
    description:
      "Watches an uploaded release merge request and reports a failed pipeline.",
    kind: "job",
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

async function run(
  ctx: TaskContext,
  config: Config,
  deps: ReleasePipelineWatchDeps,
): Promise<TaskResult> {
  const gitlab = requireConnectorFactory(deps).gitlab(ctx);
  const mr = await ctx.step("read-release-merge-request", () =>
    gitlab.mergeRequest(config.projectId, config.mrIid, ctx.signal),
  );

  if (mr.state === "merged") {
    return result("merged");
  }

  if (mr.state === "closed" || mr.state === "locked") {
    notify(
      deps,
      ctx,
      config,
      `${config.environment} release MR !${config.mrIid} did not merge`,
      `GitLab reports the merge request as ${mr.state}. The release was not deployed.`,
      config.mrUrl,
    );
    return result("closed", true, { mrState: mr.state });
  }

  const pipeline = mr.head_pipeline;
  if (pipeline && FAILED_STATUSES.has(pipeline.status)) {
    notify(
      deps,
      ctx,
      config,
      `${config.environment} release pipeline ${pipeline.status}`,
      `Pipeline #${pipeline.id} for release MR !${config.mrIid} ${pipeline.status}. The release needs attention.`,
      pipeline.web_url ?? config.mrUrl,
    );
    return result("pipeline-failed", true, {
      pipelineId: pipeline.id,
      pipelineStatus: pipeline.status,
    });
  }

  // A successful pipeline with an open MR and no auto-merge is not progress:
  // it is the exact state left behind when GitLab declined, ignored, or lost
  // the upload request. Repair it here instead of polling the same completed
  // pipeline for 24 hours while the environment stays "K8s pending".
  if (
    pipeline?.status === "success" &&
    mr.merge_when_pipeline_succeeds !== true
  ) {
    const updated = await ctx.step("enable-release-auto-merge", () =>
      gitlab.mergeMergeRequest(config.projectId, config.mrIid, {
        autoMerge: true,
        signal: ctx.signal,
      }),
    );
    if (updated.state === "merged") {
      return result("merged", false, {
        pipelineId: pipeline.id,
        pipelineStatus: pipeline.status,
      });
    }
    if (updated.merge_when_pipeline_succeeds !== true) {
      notify(
        deps,
        ctx,
        config,
        `${config.environment} release did not enable auto-merge`,
        `Pipeline #${pipeline.id} succeeded, but release MR !${config.mrIid} is still open and GitLab did not enable auto-merge.`,
        config.mrUrl,
      );
      return result("auto-merge-disabled", true, {
        pipelineId: pipeline.id,
        pipelineStatus: pipeline.status,
      });
    }
  }

  const openedAt = new Date(config.openedAt);
  if (
    Number.isNaN(openedAt.getTime()) ||
    Date.now() - openedAt.getTime() > GIVE_UP_HOURS * 3_600_000
  ) {
    notify(
      deps,
      ctx,
      config,
      `${config.environment} release is still waiting`,
      `Release MR !${config.mrIid} has not produced a successful pipeline or merged within ${GIVE_UP_HOURS} hours.`,
      config.mrUrl,
    );
    return result("timed-out", true);
  }

  requeue(ctx, deps, config);
  return result(
    pipeline?.status === "success" ? "waiting-for-merge" : "pipeline-pending",
    false,
    {
      pipelineId: pipeline?.id,
      pipelineStatus: pipeline?.status ?? "not-created",
    },
  );
}

function notify(
  deps: ReleasePipelineWatchDeps,
  ctx: TaskContext,
  config: Config,
  title: string,
  body: string,
  link: string,
): void {
  requireNotifications(deps).create({
    kind: RELEASE_PIPELINE_WATCH_TASK_ID,
    title,
    body,
    link,
    taskRunId: ctx.executionId,
  });
}

function requeue(
  ctx: TaskContext,
  deps: ReleasePipelineWatchDeps,
  config: Config,
): void {
  const availableAt = new Date(Date.now() + POLL_MINUTES * 60_000);
  requireJobs(deps).enqueue({
    kind: RELEASE_PIPELINE_WATCH_TASK_ID,
    loopId: RELEASE_PIPELINE_WATCH_LOOP_ID,
    subjectKey: `release-mr:${config.projectId}!${config.mrIid}`,
    fingerprint: `poll:${availableAt.getTime()}`,
    ...(ctx.actor?.id ? { actorId: ctx.actor.id } : {}),
    params: config,
    availableAt,
  });
}

function result(
  action: string,
  notified = false,
  details: Record<string, unknown> = {},
): TaskResult {
  return {
    itemsSeen: 1,
    itemsProcessed: notified ? 1 : 0,
    itemsSkipped: notified ? 0 : 1,
    notifiedIndividually: true,
    details: { action, ...details },
  };
}

function requireConnectorFactory(
  deps: ReleasePipelineWatchDeps,
): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${RELEASE_PIPELINE_WATCH_TASK_ID} requires connector gateways.`,
    );
  }
  return deps.connectors;
}

function requireJobs(deps: ReleasePipelineWatchDeps): JobRepository {
  if (!deps.jobs) {
    throw new ConfigError(
      `${RELEASE_PIPELINE_WATCH_TASK_ID} requires the job queue.`,
    );
  }
  return deps.jobs;
}

function requireNotifications(
  deps: ReleasePipelineWatchDeps,
): NotificationRepository {
  if (!deps.notifications) {
    throw new ConfigError(
      `${RELEASE_PIPELINE_WATCH_TASK_ID} requires notifications.`,
    );
  }
  return deps.notifications;
}
