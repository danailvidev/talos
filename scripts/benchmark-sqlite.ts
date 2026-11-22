/**
 * Reproducible persistence baseline. It creates a unique temporary database,
 * applies the production migrations, measures the adapters used by the task
 * list, and removes the fixture before exit. It never opens an operator DB.
 *
 * `bun run bench` measures a representative 100-task / 10k-history fixture.
 * `bun run bench --small` covers the 10-task shape used by small installs.
 * `bun run bench --large` raises that to 1,000 tasks / 100k-history rows.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { z } from "zod";
import { HttpClient } from "../src/connectors/http.ts";
import { SqliteJobQueue } from "../src/persistence/job-queue.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteTaskSink } from "../src/persistence/sqlite-task-sink.ts";
import { SqliteSubjectStore } from "../src/persistence/subject-store.ts";

const large = Bun.argv.includes("--large");
const xlarge = Bun.argv.includes("--xlarge");
const small = Bun.argv.includes("--small");
const activeRatioArg = Bun.argv.find((arg) => arg.startsWith("--active-ratio="))?.split("=")[1];
const activeJobRatio = activeRatioArg == null ? 0.1 : Number(activeRatioArg);
if (!Number.isFinite(activeJobRatio) || activeJobRatio < 0 || activeJobRatio > 1) {
  throw new Error("--active-ratio must be a number between 0 and 1");
}
const taskCount = xlarge || large ? 1_000 : small ? 10 : 100;
const historyRows = xlarge ? 500_000 : large ? 100_000 : small ? 10_000 : 10_000;
const logRows = xlarge ? 100_000 : large ? 10_000 : 1_000;
const samples = 25;
const fixtureDir = mkdtempSync(join(tmpdir(), "talos-bench-"));
const databasePath = join(fixtureDir, "benchmark.sqlite");
const db = new Database(databasePath);

try {
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = WAL");
  migrate(db);
  seed(db, taskCount, historyRows, logRows, activeJobRatio);

  const taskIds = Array.from({ length: taskCount }, (_, i) => `bench-task-${i}`);
  const sink = new SqliteTaskSink(db);
  const jobs = new SqliteJobQueue(db);
  const subjects = new SqliteSubjectStore(db);
  const visibleTaskIds = taskIds.slice(0, 100);
  const memoryBefore = process.memoryUsage();
  const taskListRead = () => ({
    metrics: Object.fromEntries(sink.metricsFor(visibleTaskIds)),
    activeJobs: Object.fromEntries(jobs.activeCounts(visibleTaskIds)),
    openSubjects: Object.fromEntries(subjects.openCounts(visibleTaskIds)),
  });
  const measurements = {
    taskListPayload: measure(taskListRead),
    systemStatusPayload: measure(() => ({
      counts: jobs.counts(),
      queue: jobs.queuePressure(),
      logBuffer: sink.logBufferStats(),
    })),
    graphBatchPayload: measure(() => ({
      runs: Object.fromEntries(sink.recentRunsFor(visibleTaskIds, 25)),
      subjects: Object.fromEntries(subjects.openSubjectsFor(visibleTaskIds)),
      jobs: Object.fromEntries(jobs.bySubjectsForLoops(visibleTaskIds, 4)),
    })),
    incrementalLogPayload: measure(() => sink.logTail("run-0", undefined, 200)),
    fullLogPayload: measure(() => sink.logs("run-0")),
    multiClientTaskListBurst: await measureBurst(taskListRead, 8, 7),
    providerFixture: await measureProviderFixture(),
  };
  const memoryAfter = process.memoryUsage();
  db.run("PRAGMA wal_checkpoint(PASSIVE)");
  console.log(JSON.stringify({
    scenario: xlarge ? "xlarge" : large ? "large" : small ? "small" : "default",
    taskCount,
    historyRows,
    logRows,
    activeJobRatio,
    visiblePageTasks: visibleTaskIds.length,
    samples,
    host: {
      runtime: `Bun ${Bun.version}`,
      platform: `${platform()} ${release()} ${arch()}`,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      ramBytes: totalmem(),
      filesystem: fixtureDir.startsWith("/tmp/") ? "temporary filesystem" : fixtureDir,
      databaseBytes: statSync(databasePath).size,
      journalMode: db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
      synchronous: db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous,
      memory: {
        rssBeforeBytes: memoryBefore.rss,
        rssAfterBytes: memoryAfter.rss,
        rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
        heapUsedBeforeBytes: memoryBefore.heapUsed,
        heapUsedAfterBytes: memoryAfter.heapUsed,
        heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      },
    },
    measurements,
  }, null, 2));
} finally {
  db.close();
  rmSync(fixtureDir, { recursive: true, force: true });
}

function seed(database: Database, tasks: number, rows: number, logs: number, activeRatio: number): void {
  const now = Date.now();
  const insertRun = database.query(
    `INSERT INTO task_runs
       (execution_id, task_id, started_at, finished_at, duration_ms, status, dry_run,
        items_seen, items_processed, items_skipped)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, 0)`,
  );
  const insertJob = database.query(
    `INSERT INTO jobs
       (id, kind, loop_id, dedupe_key, params, priority, status, attempts, max_attempts,
        available_at, enqueued_at, finished_at)
     VALUES (?, 'bench-handler', ?, ?, '{}', 0, ?, 1, 3, ?, ?, ?)`,
  );
  const insertSubject = database.query(
    `INSERT INTO work_subjects
       (loop_id, subject_key, state, first_seen_at, updated_at, last_seen_at)
     VALUES (?, ?, 'open', ?, ?, ?)`,
  );
  const insertLog = database.query(
    `INSERT INTO task_run_logs (execution_id, ts, level, message) VALUES (?, ?, 'info', ?)`,
  );
  database.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const task = `bench-task-${i % tasks}`;
      const at = new Date(now - i * 1_000).toISOString();
      insertRun.run(`run-${i}`, task, at, at, 25, i % 10 === 0 ? "failure" : "success");
      const active = i % 100 < Math.round(activeRatio * 100);
      insertJob.run(`job-${i}`, task, `dedupe-${i}`, active ? "queued" : "done", at, at, active ? null : at);
      if (i < tasks * 10) insertSubject.run(task, `subject-${i}`, at, at, at);
    }
    for (let i = 0; i < logs; i++) {
      const at = new Date(now + i).toISOString();
      insertLog.run("run-0", at, `benchmark log line ${i} ${"x".repeat(180)}`);
    }
  })();
}

function measure(read: () => unknown): {
  coldMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  approxOpsPerSecond: number;
  responseBytes: number;
} {
  const coldStarted = performance.now();
  const warm = JSON.stringify(read());
  const coldMs = performance.now() - coldStarted;
  const times = Array.from({ length: samples }, () => {
    const started = performance.now();
    JSON.stringify(read());
    return performance.now() - started;
  }).sort((a, b) => a - b);
  const percentile = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))]!;
  const p50 = percentile(0.5);
  return {
    coldMs: round(coldMs),
    p50Ms: round(p50),
    p95Ms: round(percentile(0.95)),
    p99Ms: round(percentile(0.99)),
    approxOpsPerSecond: round(1_000 / Math.max(p50, 0.001)),
    responseBytes: Buffer.byteLength(warm),
  };
}

/**
 * Models several tabs becoming ready in the same event-loop turn. SQLite is
 * synchronous, so this intentionally reports both wall latency for the burst
 * and the timer lag experienced by unrelated work sharing the daemon.
 */
async function measureBurst(
  read: () => unknown,
  clients: number,
  burstSamples: number,
): Promise<{
  clients: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  eventLoopDelayP99Ms: number;
  aggregateResponseBytes: number;
}> {
  const times: number[] = [];
  const delays: number[] = [];
  let aggregateResponseBytes = 0;
  let expected = performance.now() + 1;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - expected));
    expected = now + 1;
  }, 1);
  await Bun.sleep(5);
  for (let sample = 0; sample < burstSamples; sample++) {
    const started = performance.now();
    const payloads = await Promise.all(Array.from({ length: clients }, () =>
      new Promise<string>((resolve) => setTimeout(() => resolve(JSON.stringify(read())), 0))
    ));
    times.push(performance.now() - started);
    if (sample === 0) {
      aggregateResponseBytes = payloads.reduce((total, payload) => total + Buffer.byteLength(payload), 0);
    }
    await Bun.sleep(1);
  }
  await Bun.sleep(5);
  clearInterval(heartbeat);
  times.sort((a, b) => a - b);
  delays.sort((a, b) => a - b);
  const percentile = (values: number[], p: number) =>
    values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
  return {
    clients,
    p50Ms: round(percentile(times, 0.5)),
    p95Ms: round(percentile(times, 0.95)),
    p99Ms: round(percentile(times, 0.99)),
    eventLoopDelayP99Ms: round(percentile(delays, 0.99)),
    aggregateResponseBytes,
  };
}

/** Credential-free slow-provider and shared-cooldown fixture. */
async function measureProviderFixture(): Promise<{
  requests: number;
  configuredConcurrency: number;
  observedConcurrency: number;
  slowBurstMs: number;
  retryAfterMs: number;
  observedCooldownMs: number;
}> {
  const configuredConcurrency = 3;
  const requests = 12;
  let active = 0;
  let observedConcurrency = 0;
  const slow = new HttpClient({
    baseUrl: "https://slow-fixture.example.test",
    connector: "benchmark-slow-provider",
    headers: { authorization: "fixture-only" },
    maxConcurrency: configuredConcurrency,
    fetch: async () => {
      active += 1;
      observedConcurrency = Math.max(observedConcurrency, active);
      await Bun.sleep(10);
      active -= 1;
      return Response.json({ ok: true });
    },
  });
  const slowStarted = performance.now();
  await Promise.all(Array.from({ length: requests }, () =>
    slow.getJson(z.object({ ok: z.boolean() }), "/items")
  ));
  const slowBurstMs = performance.now() - slowStarted;

  const retryAfterMs = 25;
  let calls = 0;
  const limited = new HttpClient({
    baseUrl: "https://rate-fixture.example.test",
    connector: "benchmark-rate-provider",
    headers: { authorization: "fixture-only" },
    maxConcurrency: 1,
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("{}", { status: 429, headers: { "retry-after": String(retryAfterMs / 1_000) } })
        : Response.json({ ok: true });
    },
  });
  await limited.getJson(z.object({ ok: z.boolean() }), "/items").catch(() => undefined);
  const cooldownStarted = performance.now();
  await limited.getJson(z.object({ ok: z.boolean() }), "/items");

  return {
    requests,
    configuredConcurrency,
    observedConcurrency,
    slowBurstMs: round(slowBurstMs),
    retryAfterMs,
    observedCooldownMs: round(performance.now() - cooldownStarted),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
