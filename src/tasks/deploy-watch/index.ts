/**
 * Watches one production release merge request, then samples Datadog error logs
 * against a pre-merge baseline and checks newly first-seen LogRocket issues so a
 * regression is noticed within hours instead of whenever somebody happens to look.
 *
 * A queue handler with no discoverer in front of it, but unlike every other
 * handler in this codebase it requeues *itself* — `ReleaseApplicationService`
 * enqueues the first run when a production release opens, and every run after
 * that schedules its own successor with `availableAt`, carrying nothing but the
 * watch's id. All the state that matters — which phase, when the merge
 * happened, the baseline set — lives on the `deploy_watches` row, not in the
 * job, so a run started twenty minutes late still knows exactly what to do.
 *
 * Two phases:
 *
 *  1. **pending-merge** — poll the merge request. Still open: check again later,
 *     or give up after `GIVE_UP_HOURS`. Merged: capture the baseline (the
 *     signature set from the `BASELINE_HOURS` before the merge) and move to
 *     watching.
 *  2. **watching** — sample prod logs for the bumped services and read LogRocket
 *     issues first seen since the merge. Record new Datadog signatures that are
 *     numerous enough to matter and every newly introduced LogRocket issue.
 *     Repeats every `CHECK_MINUTES` until `watch_until`, then stops.
 *
 * Attribution is deliberately coarse: a finding names the release, the bumped
 * service and the uploader, not the individual commit that caused it. Mapping a
 * service version bump to the merge requests behind it needs a service→repo map
 * that does not exist yet.
 */
import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type {
  DeployWatch,
  DeployWatchFinding,
  DeployWatchRepository,
  JobRepository,
  LogRocketIssueRepository,
  NotificationRepository,
  ReleaseNotifier,
} from "../../application/ports.ts";
import { createDatadogClient, datadogLogQuery } from "../../connectors/datadog/client.ts";
import { clusterSamples, fingerprintOf } from "../../connectors/datadog/signature.ts";
import type { LogSample } from "../../connectors/datadog/types.ts";
import type { FetchLike } from "../../connectors/http.ts";
import { ConfigError, describeError } from "../../core/errors.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";

export const DEPLOY_WATCH_TASK_ID = "deploy-watch";

/**
 * Not a real discoverer — this loop id only exists so the job queue's
 * subject/fingerprint dedupe has something to key on. See `requeue`.
 */
export const DEPLOY_WATCH_LOOP_ID = "deploy-watch";

/** How often an unmerged release MR is checked. */
const POLL_MINUTES = 10;
/** A release that never merges stops being watched after this long. */
const GIVE_UP_HOURS = 24;
/** How long after the merge the watch keeps sampling for new signatures. */
const WATCH_HOURS = 6;
/** The pre-merge window the baseline signature set is drawn from. */
const BASELINE_HOURS = 24;
/** How often the watch re-samples once it is running. */
const CHECK_MINUTES = 30;
/** A signature needs at least this many sampled occurrences to be worth a Slack post. */
const MIN_EVENTS = 3;
/** Log bodies read per sample, in either window. */
const SAMPLES_PER_WINDOW = 500;
/** How much of a sample's message or stack is kept on the finding row. */
const MAX_TEXT_CHARS = 6000;

const ConfigSchema = z.object({ watchId: z.string().min(1) });
type Config = z.infer<typeof ConfigSchema>;

export interface DeployWatchDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  deployWatches?: DeployWatchRepository;
  logRocketIssues?: LogRocketIssueRepository;
  jobs?: JobRepository;
  notifications?: NotificationRepository;
  notifier?: ReleaseNotifier;
}

export function createDeployWatchTask(deps: DeployWatchDeps = {}): Task<Config> {
  return {
    id: DEPLOY_WATCH_TASK_ID,
    name: "Post-deploy regression watch",
    description:
      "Watches a production release's merge request, then checks Datadog logs and " +
      "LogRocket issues to notice a new failure before somebody else does.",
    kind: "job",
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

async function run(
  ctx: TaskContext,
  config: Config,
  deps: DeployWatchDeps,
): Promise<TaskResult> {
  const watches = requireStore(deps);
  const watch = watches.get(config.watchId);
  if (!watch) {
    // Nothing to clean up: a watch is never deleted, only closed. Reaching this
    // means the id itself was wrong, which is a bug worth a log line, not a page.
    ctx.logger.warn({ watchId: config.watchId }, "deploy watch no longer exists; nothing to do");
    return {
      itemsSeen: 0,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: { action: "missing", watchId: config.watchId },
    };
  }

  if (watch.state === "done" || watch.state === "abandoned") {
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: { action: "closed", watchId: watch.id, state: watch.state },
    };
  }

  if (ctx.dryRun) {
    ctx.logger.info(
      { watchId: watch.id, state: watch.state },
      `[dry-run] would advance deploy watch ${watch.id} (currently ${watch.state})`,
    );
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: { action: "dry-run", watchId: watch.id, state: watch.state },
    };
  }

  return watch.state === "pending-merge"
    ? pollForMerge(ctx, watch, deps)
    : checkForRegressions(ctx, watch, deps);
}

async function pollForMerge(
  ctx: TaskContext,
  watch: DeployWatch,
  deps: DeployWatchDeps,
): Promise<TaskResult> {
  const watches = requireStore(deps);
  if (watch.releaseKind !== "merge-request" || watch.mrIid == null) {
    throw new ConfigError(
      `Pending deploy watch ${watch.id} has no merge request to poll.`,
    );
  }
  const mrIid = watch.mrIid;
  const gitlab = requireConnectorFactory(deps).gitlab(ctx, deps.fetch);
  const mr = await ctx.step("poll-merge-request", () =>
    gitlab.mergeRequest(watch.projectId, mrIid, ctx.signal),
  );

  if (mr.state === "merged") {
    const mergedAt = mr.merged_at ? new Date(mr.merged_at) : new Date();
    watches.update(watch.id, {
      state: "watching",
      mergedAt,
      watchUntil: new Date(mergedAt.getTime() + WATCH_HOURS * 3_600_000),
    });
    await captureBaseline(ctx, watch, mergedAt, deps);
    requeue(ctx, deps, watch.id, "watching", CHECK_MINUTES);
    ctx.logger.info(
      { watchId: watch.id, mrIid: watch.mrIid },
      `${watch.environment} release !${watch.mrIid} merged; watching for ${WATCH_HOURS}h`,
    );
    return {
      itemsSeen: 1,
      itemsProcessed: 1,
      itemsSkipped: 0,
      details: { action: "merged", watchId: watch.id, mergedAt: mergedAt.toISOString() },
    };
  }

  if (mr.state === "closed" || mr.state === "locked") {
    watches.update(watch.id, { state: "abandoned" });
    ctx.logger.info(
      { watchId: watch.id, mrIid: watch.mrIid, state: mr.state },
      `${watch.environment} release !${watch.mrIid} closed without merging; abandoning the watch`,
    );
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: { action: "abandoned", watchId: watch.id, reason: mr.state },
    };
  }

  const ageHours = (Date.now() - watch.openedAt.getTime()) / 3_600_000;
  if (ageHours > GIVE_UP_HOURS) {
    watches.update(watch.id, { state: "abandoned" });
    ctx.logger.warn(
      { watchId: watch.id, mrIid: watch.mrIid, ageHours },
      `${watch.environment} release !${watch.mrIid} still open after ${GIVE_UP_HOURS}h; giving up on the watch`,
    );
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: { action: "abandoned", watchId: watch.id, reason: "timed-out" },
    };
  }

  requeue(ctx, deps, watch.id, "pending-merge", POLL_MINUTES);
  return {
    itemsSeen: 1,
    itemsProcessed: 0,
    itemsSkipped: 1,
    details: { action: "still-open", watchId: watch.id },
  };
}

/**
 * Samples the `BASELINE_HOURS` before the merge and stores the signature set
 * found in them — "what was already broken", so watching can tell a pre-existing
 * error apart from one the release actually caused.
 */
async function captureBaseline(
  ctx: TaskContext,
  watch: DeployWatch,
  mergedAt: Date,
  deps: DeployWatchDeps,
): Promise<void> {
  const client = createDatadogClient(ctx.secrets, {
    logger: ctx.logger,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const query = watchQuery(ctx, watch);
  const from = new Date(mergedAt.getTime() - BASELINE_HOURS * 3_600_000);

  const samples = await ctx.step("baseline-sample", () =>
    client.sampleLogs(
      { query, from, to: mergedAt, signal: ctx.signal },
      SAMPLES_PER_WINDOW,
    ),
  );
  const fingerprints = clusterSamples(samples).map((cluster) =>
    fingerprintOf(cluster.sample.service, cluster.signature),
  );
  requireStore(deps).setBaseline(watch.id, fingerprints, mergedAt);
  ctx.logger.info(
    { watchId: watch.id, signatures: fingerprints.length, samples: samples.length },
    `captured a ${BASELINE_HOURS}h baseline of ${fingerprints.length} distinct signature(s) before the merge`,
  );
}

async function checkForRegressions(
  ctx: TaskContext,
  watch: DeployWatch,
  deps: DeployWatchDeps,
): Promise<TaskResult> {
  const now = new Date();
  const through =
    watch.watchUntil && now > watch.watchUntil ? watch.watchUntil : now;
  const errors: unknown[] = [];
  const findings: DeployWatchFinding[] = [];
  let itemsSeen = 0;

  // LogRocket is persisted from webhook alerts, so it can still make progress
  // while Datadog is unavailable. The shared finding constraint makes retries
  // harmless: a successful source will not notify twice when the other retries.
  try {
    const result = await checkLogRocket(ctx, watch, through, deps);
    itemsSeen += result.itemsSeen;
    findings.push(...result.findings);
  } catch (err) {
    errors.push(err);
    ctx.logger.warn(
      { watchId: watch.id, err: describeError(err) },
      "could not check LogRocket during the post-deploy watch",
    );
  }

  try {
    // A failed baseline capture leaves the watch in `watching`; retry it before
    // sampling so an empty baseline can never turn every old error into news.
    if (!watch.baselineAt) {
      await captureBaseline(ctx, watch, watch.mergedAt ?? watch.openedAt, deps);
    }
    const result = await checkDatadog(ctx, watch, through, deps);
    itemsSeen += result.itemsSeen;
    findings.push(...result.findings);
  } catch (err) {
    errors.push(err);
    ctx.logger.warn(
      { watchId: watch.id, err: describeError(err) },
      "could not check Datadog during the post-deploy watch",
    );
  }

  for (const finding of findings) {
    await announce(ctx, watch, finding, deps);
  }

  // Let the queue retry a partial failure. Findings already recorded by the
  // healthy source are deduplicated when the retry reaches them again.
  if (errors.length > 0) throw errors[0];

  const elapsed = watch.watchUntil != null && now >= watch.watchUntil;
  if (elapsed) {
    requireStore(deps).update(watch.id, { state: "done" });
    ctx.logger.info(
      { watchId: watch.id },
      `${watch.environment} release ${releaseLabel(watch)}: watch window elapsed`,
    );
  } else {
    requeue(ctx, deps, watch.id, "watching", CHECK_MINUTES);
  }

  return {
    itemsSeen,
    itemsProcessed: findings.length,
    itemsSkipped: 0,
    details: {
      action: elapsed ? "done" : "checked",
      watchId: watch.id,
      newFindings: findings.map((finding) => ({
        source: finding.source,
        service: finding.service,
        signature: finding.signature,
        eventCount: finding.eventCount,
      })),
    },
  };
}

async function checkDatadog(
  ctx: TaskContext,
  watch: DeployWatch,
  through: Date,
  deps: DeployWatchDeps,
): Promise<{ itemsSeen: number; findings: DeployWatchFinding[] }> {
  const client = createDatadogClient(ctx.secrets, {
    logger: ctx.logger,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const from = watch.mergedAt ?? watch.openedAt;
  const samples = await ctx.step("watch-datadog", () =>
    client.sampleLogs(
      { query: watchQuery(ctx, watch), from, to: through, signal: ctx.signal },
      SAMPLES_PER_WINDOW,
    ),
  );
  const watches = requireStore(deps);
  const baseline = watches.baseline(watch.id);
  const findings: DeployWatchFinding[] = [];

  for (const cluster of clusterSamples(samples)) {
    if (cluster.count < MIN_EVENTS) continue;
    const service = cluster.sample.service;
    const fingerprint = fingerprintOf(service, cluster.signature);
    if (baseline.has(fingerprint)) continue;

    const body = bodyOf(cluster.sample);
    const recorded = watches.addFinding({
      watchId: watch.id,
      source: "datadog",
      ...(service ? { service } : {}),
      signature: cluster.signature,
      fingerprint,
      eventCount: cluster.count,
      ...(body ? { sampleMessage: clamp(body) } : {}),
      ...(cluster.sample.errorStack ? { sampleStack: clamp(cluster.sample.errorStack) } : {}),
      firstSeenAt: cluster.firstSeenAt ?? from,
    });
    if (recorded) findings.push(recorded);
  }

  return { itemsSeen: samples.length, findings };
}

async function checkLogRocket(
  ctx: TaskContext,
  watch: DeployWatch,
  through: Date,
  deps: DeployWatchDeps,
): Promise<{ itemsSeen: number; findings: DeployWatchFinding[] }> {
  if (!deps.logRocketIssues) return { itemsSeen: 0, findings: [] };
  const from = watch.mergedAt ?? watch.openedAt;
  const issues = await ctx.step("watch-logrocket", async () =>
    deps.logRocketIssues!.firstSeenBetween(from, through),
  );
  const watches = requireStore(deps);
  const findings: DeployWatchFinding[] = [];

  for (const issue of issues) {
    const recorded = watches.addFinding({
      watchId: watch.id,
      source: "logrocket",
      signature: issue.title,
      fingerprint: `logrocket:${issue.fingerprint}`,
      eventCount: issue.sessionCount ?? issue.alertCount,
      ...(issue.url ? { externalUrl: issue.url } : {}),
      ...(issue.issueType ? { issueType: issue.issueType } : {}),
      ...(issue.summary || issue.description
        ? { sampleMessage: clamp(issue.summary ?? issue.description!) }
        : {}),
      firstSeenAt: issue.firstSeenAt ?? issue.lastAlertAt,
    });
    if (recorded) findings.push(recorded);
  }

  return { itemsSeen: issues.length, findings };
}

/**
 * Tells whoever is watching: the bell, and Slack when it is configured.
 *
 * The Slack post is a soft failure, the same stance `ReleaseApplicationService`
 * takes on its own announcement — a token revoked since the release opened must
 * not stop the watch from recording what it found.
 */
async function announce(
  ctx: TaskContext,
  watch: DeployWatch,
  finding: DeployWatchFinding,
  deps: DeployWatchDeps,
): Promise<void> {
  ctx.logger.warn(
    {
      watchId: watch.id,
      release: releaseLabel(watch),
      source: finding.source,
      service: finding.service,
      signature: finding.signature,
    },
    `new ${finding.source} error since the ${watch.environment} release: ${finding.signature}`,
  );

  deps.notifications?.create({
    kind: DEPLOY_WATCH_TASK_ID,
    title: `New ${finding.source === "logrocket" ? "LogRocket issue" : "error"} since the ${watch.environment.toUpperCase()} release`,
    body: finding.service
      ? `${finding.service}: ${finding.signature}`
      : finding.signature,
    link: finding.externalUrl ?? releaseUrl(watch),
  });

  if (!deps.notifier?.configured()) return;
  try {
    await deps.notifier.announceFinding(
      {
        source: finding.source,
        environment: watch.environment,
        ...(finding.service ? { service: finding.service } : {}),
        signature: finding.signature,
        eventCount: finding.eventCount,
        releaseUrl: releaseUrl(watch),
        releaseLabel: releaseLabel(watch),
        ...(finding.externalUrl ? { externalUrl: finding.externalUrl } : {}),
        ...(finding.issueType ? { issueType: finding.issueType } : {}),
        ...(ctx.actor?.email ? { author: ctx.actor.email } : {}),
      },
      ctx.signal,
    );
  } catch (err) {
    ctx.logger.warn(
      { watchId: watch.id, err },
      "found a new post-deploy error but could not announce it in slack",
    );
  }
}

/**
 * Reschedules this same watch for its next check.
 *
 * `subjectKey`/`fingerprint` rather than a hand-rolled dedupe key: the default
 * dedupe formula already keys on both, and giving the fingerprint the phase and
 * the target time makes each requeue distinct from the job currently running
 * (still `leased` under its *previous* phase's fingerprint) without needing a
 * fresh id every time.
 */
function requeue(
  ctx: TaskContext,
  deps: DeployWatchDeps,
  watchId: string,
  phase: DeployWatch["state"],
  delayMinutes: number,
): void {
  const availableAt = new Date(Date.now() + delayMinutes * 60_000);
  requireJobs(deps).enqueue({
    kind: DEPLOY_WATCH_TASK_ID,
    loopId: DEPLOY_WATCH_LOOP_ID,
    subjectKey: `deploy-watch:${watchId}`,
    fingerprint: `${phase}:${availableAt.getTime()}`,
    ...(ctx.actor?.id ? { actorId: ctx.actor.id } : {}),
    params: { watchId },
    availableAt,
  });
}

/** `status:error env:prod service:(a OR b)` — the base query narrowed to the bumped services. */
function watchQuery(ctx: TaskContext, watch: DeployWatch): string {
  const base = datadogLogQuery(ctx.secrets);
  if (watch.services.length === 0) return base;
  const values = watch.services.map(quoteIfNeeded).join(" OR ");
  return `${base} service:(${values})`;
}

function quoteIfNeeded(value: string): string {
  const trimmed = value.trim();
  return /[\s"]/.test(trimmed) ? `"${trimmed.replace(/"/g, '\\"')}"` : trimmed;
}

function bodyOf(sample: LogSample): string | undefined {
  return sample.errorMessage ?? sample.message;
}

function clamp(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…` : text;
}

function releaseLabel(watch: DeployWatch): string {
  return watch.releaseKind === "merge-request" && watch.mrIid != null
    ? `!${watch.mrIid}`
    : `commit ${(watch.commitSha ?? "").slice(0, 8)}`;
}

function releaseUrl(watch: DeployWatch): string {
  const url = watch.releaseKind === "merge-request" ? watch.mrUrl : watch.commitUrl;
  if (!url) throw new ConfigError(`Deploy watch ${watch.id} has no release URL.`);
  return url;
}

function requireStore(deps: DeployWatchDeps): DeployWatchRepository {
  if (!deps.deployWatches) {
    throw new ConfigError(
      `${DEPLOY_WATCH_TASK_ID} requires the deploy-watch store; the composition root must provide it.`,
    );
  }
  return deps.deployWatches;
}

function requireJobs(deps: DeployWatchDeps): JobRepository {
  if (!deps.jobs) {
    throw new ConfigError(
      `${DEPLOY_WATCH_TASK_ID} requires the job queue to reschedule itself; the composition root must provide it.`,
    );
  }
  return deps.jobs;
}

function requireConnectorFactory(deps: DeployWatchDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${DEPLOY_WATCH_TASK_ID} requires connector gateways; the composition root must provide them.`,
    );
  }
  return deps.connectors;
}
