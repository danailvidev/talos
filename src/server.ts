#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { resolve } from "node:path";

import { createApp } from "./app.ts";
import { resolveAgentCapacityConfig } from "./config/agent-capacity.ts";
import { serve } from "./api/serve.ts";
import { startScheduler } from "./core/scheduler.ts";
import { startWorkers } from "./core/worker-pool.ts";
import { SlackSocketModeReceiver } from "./connectors/slack/socket-mode.ts";
import {
  activeAgentJobs,
  agentCapacitySnapshot,
  setAgentConcurrency,
  setAgentResourceLimits,
  setAgentWorkspaceCache,
  setInteractiveAgentReserve,
  stopAgentContainers,
  waitingAgentJobs,
} from "./infrastructure/agent/index.ts";
import {
  configureJobExecutor,
  shutdownConfiguredJobs,
} from "./infrastructure/agent/execution.ts";
import { KubernetesJobExecutor } from "./infrastructure/agent/kubernetes-executor.ts";
import { E2E_TEST_TASK_ID } from "./tasks/e2e-test/index.ts";

const port = integerEnv("PORT", 4317, { max: 65_535 });
const host = Bun.env.HOST?.trim() || "127.0.0.1";
const concurrency = integerEnv("TALOS_JOBS", 4);
const agentCapacity = resolveAgentCapacityConfig();
const interactiveAgentReserve = agentCapacity.interactiveReservation;
const totalAgentCapacity = agentCapacity.total;
const agentConcurrency = agentCapacity.background;
const e2eConcurrency = integerEnv("TALOS_E2E_JOBS", 1);
const retentionDays = positiveNumberEnv("TALOS_RETENTION_DAYS", 1);
const logRetentionDays = positiveNumberEnv("TALOS_LOG_RETENTION_DAYS", 1) ?? retentionDays;
const retentionBatchSize = integerEnv("TALOS_RETENTION_BATCH_SIZE", 250, { max: 5_000 });
const uiDir = resolve(Bun.env.TALOS_UI_DIR?.trim() || `${import.meta.dir}/../web/dist`);

setAgentConcurrency(agentConcurrency);
setInteractiveAgentReserve(interactiveAgentReserve);
setAgentWorkspaceCache(Bun.env.TALOS_AGENT_CACHE?.trim() !== "0");
setAgentResourceLimits({
  memory: Bun.env.TALOS_AGENT_MEMORY?.trim() || "2g",
  cpus: positiveNumberEnv("TALOS_AGENT_CPUS") ?? 1,
  pids: integerEnv("TALOS_AGENT_PIDS", 256),
});

const app = await createApp({
  config: Bun.env.TALOS_CONFIG?.trim() || undefined,
  envFile: Bun.env.TALOS_ENV_FILE?.trim() || undefined,
  backgroundLogWriter: true,
});
const jobExecutor = app.runtime.kubernetes
  ? new KubernetesJobExecutor(app.runtime.kubernetes)
  : undefined;
configureJobExecutor(jobExecutor);
if (jobExecutor) app.orchestration.addRuntime(jobExecutor);
const daemonOwner = randomUUID();
const daemonLeaseMs = 30_000;
let daemonLeaseHeld = false;
let shuttingDown = false;

if (!app.daemonLease.acquire(daemonOwner, daemonLeaseMs)) {
  app.close();
  throw new Error(
    "Another talos server owns this database. Stop it or wait up to 30 seconds for its lease to expire.",
  );
}
daemonLeaseHeld = true;

await app.orchestration.reconcile(true);
if (app.orchestration.resumeAfterShutdown()) {
  app.logger.warn("resumed agent admissions left draining by the previous process");
}
const orphans = app.sink.closeOrphanedRuns("server restarted before this run finished");
if (orphans > 0) {
  app.logger.warn({ closed: orphans }, `closed ${orphans} run(s) left open by a previous process`);
}

let server;
try {
  server = serve({
    app,
    port,
    host,
    uiDir,
    health: {
      live: () => true,
      ready: () => daemonLeaseHeld && !shuttingDown,
    },
  });
} catch (cause) {
  app.daemonLease.release(daemonOwner);
  app.close();
  throw cause;
}

const scheduler = startScheduler({
  logger: app.logger,
  executor: app.executor,
  taskRegistry: app.taskRegistry,
  refresh: app.refresh,
  scheduledTasks: app.scheduledTasks,
  scheduledTask: app.scheduledTask,
  actorForTask: app.actorForTask,
  triggers: app.webhooks,
});
const workers = startWorkers(
  {
    logger: app.logger,
    executor: app.executor,
    taskRegistry: app.taskRegistry,
    queue: app.jobs,
    actorFor: app.actorFor,
    refresh: app.refresh,
    notifications: app.notifications,
  },
  { concurrency, agentConcurrency, limits: { [E2E_TEST_TASK_ID]: e2eConcurrency } },
);
if (concurrency <= agentConcurrency) {
  app.logger.warn(
    { concurrency, agentConcurrency },
    "TALOS_JOBS is not above TALOS_AGENT_JOBS; agent jobs can occupy every worker and delay lightweight jobs",
  );
}
const slackSocket = new SlackSocketModeReceiver({
  secrets: app.secrets,
  connections: app.slackConnections,
  logger: app.logger,
});
slackSocket.start();
const slackSearchAbort = new AbortController();
let slackSearchRun: Promise<void> | undefined;
let slackSearchTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleSlackSearch = () => {
  if (slackSearchAbort.signal.aborted) return;
  // Keep the aggregate near Slack's Tier-2 method budget as active users grow:
  // ten users poll about twice a minute, twenty about once. Jitter avoids a
  // synchronized edge when several TALOS processes share a workspace.
  const activeUsers = app.slackActivityEvents.activeUserIds().length;
  const baseDelay = Math.max(30_000, activeUsers * 3_000);
  slackSearchTimer = setTimeout(
    pollSlackSearch,
    baseDelay + Math.random() * 10_000,
  );
};
const pollSlackSearch = () => {
  const activeUsers = app.slackActivityEvents.activeUserIds();
  if (slackSearchRun || activeUsers.length === 0) {
    scheduleSlackSearch();
    return;
  }
  slackSearchRun = app.slackInbox
    .pollRecentActivity(slackSearchAbort.signal, activeUsers)
    .finally(() => {
      slackSearchRun = undefined;
      scheduleSlackSearch();
    });
};
scheduleSlackSearch();

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
const telemetry = setInterval(() => {
  app.logger.info(
    {
      eventLoopDelayP50Ms: Math.round(eventLoopDelay.percentile(50) / 1e6 * 100) / 100,
      eventLoopDelayP99Ms: Math.round(eventLoopDelay.percentile(99) / 1e6 * 100) / 100,
      activeWorkers: workers.active(),
      activeAgents: activeAgentJobs(),
      agentCapacity: agentCapacitySnapshot(),
      waitingAgents: waitingAgentJobs(),
      queue: app.jobs.queuePressure(),
      logBuffer: app.sink.logBufferStats(),
      responseCache: app.responseCache.stats,
    },
    "runtime capacity telemetry",
  );
  eventLoopDelay.reset();
}, 30_000);
const reconciliation = setInterval(() => {
  void app.orchestration.reconcile().catch((cause) => {
    app.logger.error({ cause }, "periodic agent reconciliation failed");
  });
}, 30_000);

const runRetention = async () => {
  if (retentionDays == null && logRetentionDays == null) return;
  const before = retentionDays == null
    ? undefined
    : new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1_000);
  const e2eArtifacts = before
    ? await app.e2eArtifacts.purge(before, retentionBatchSize)
    : 0;
  const runs = before ? app.sink.purgeFinishedRuns(before, retentionBatchSize) : 0;
  const jobs = before ? app.jobs.purgeFinished(before, retentionBatchSize) : 0;
  const webhookDeliveries = before
    ? app.webhooks.purgeDeliveries(before, retentionBatchSize)
    : 0;
  const rawLogs = logRetentionDays == null
    ? 0
    : app.sink.purgeRawLogs(
        new Date(Date.now() - logRetentionDays * 24 * 60 * 60 * 1_000),
        retentionBatchSize,
      );
  if (runs > 0 || jobs > 0 || webhookDeliveries > 0 || rawLogs > 0 || e2eArtifacts > 0) {
    app.logger.info(
      { runs, jobs, webhookDeliveries, rawLogs, e2eArtifacts, before: before?.toISOString() },
      "retention batch completed",
    );
  }
};
void runRetention();
const retentionTimer = retentionDays == null && logRetentionDays == null
  ? undefined
  : setInterval(() => void runRetention(), 6 * 60 * 60 * 1_000);

app.logger.info(
  {
    url: server.url,
    database: app.loaded.databasePath,
    uiDir,
    workers: concurrency,
    agentJobs: agentConcurrency,
    totalAgentCapacity,
    interactiveAgentReserve,
    e2eJobs: e2eConcurrency,
  },
  "talos web server started",
);

let daemonHeartbeat: ReturnType<typeof setInterval> | undefined;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (daemonHeartbeat) clearInterval(daemonHeartbeat);
  clearInterval(telemetry);
  clearInterval(reconciliation);
  if (retentionTimer) clearInterval(retentionTimer);
  if (slackSearchTimer) clearTimeout(slackSearchTimer);
  slackSearchAbort.abort();
  eventLoopDelay.disable();
  app.orchestration.stopAdmissions();
  scheduler.stop();
  await slackSocket.stop();
  await slackSearchRun;
  app.executor.cancelAll();
  await workers.stop();
  await Promise.all([
    stopAgentContainers({ pruneDanglingImages: true }),
    shutdownConfiguredJobs(),
  ]);
  configureJobExecutor(undefined);
  await server.stop();
  app.daemonLease.release(daemonOwner);
  daemonLeaseHeld = false;
  app.close();
  // `bun --watch` keeps its file watcher alive after application cleanup.
  // Exit explicitly so the dev supervisor can observe that shutdown completed.
  process.exit(0);
};
daemonHeartbeat = setInterval(() => {
  if (!app.daemonLease.renew(daemonOwner, daemonLeaseMs)) {
    daemonLeaseHeld = false;
    app.logger.error("lost daemon database ownership; shutting down");
    void shutdown();
  }
}, 10_000);
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function integerEnv(
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = Bun.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  const min = bounds.min ?? 1;
  if (!Number.isInteger(value) || value < min || (bounds.max != null && value > bounds.max)) {
    const range = bounds.max == null
      ? min === 1 ? "a positive integer" : `an integer of at least ${min}`
      : `an integer from ${min} to ${bounds.max}`;
    throw new Error(`${name} must be ${range}; received '${raw}'.`);
  }
  return value;
}

function positiveNumberEnv(name: string, minimum = Number.MIN_VALUE): number | undefined {
  const raw = Bun.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    const expectation = minimum === 1 ? "a number of at least 1" : "a positive number";
    throw new Error(`${name} must be ${expectation}; received '${raw}'.`);
  }
  return value;
}
