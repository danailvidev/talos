import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteJobQueue } from "../src/persistence/job-queue.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteOrchestrationStore } from "../src/persistence/orchestration-store.ts";
import { SqliteSubjectStore } from "../src/persistence/subject-store.ts";

function queueHarness() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, queue: new SqliteJobQueue(db) };
}

describe("job lease fencing", () => {
  test("does not re-lease a reclaimed job while its prior runtime may still exist", async () => {
    const { db, queue } = queueHarness();
    const job = queue.enqueue({
      kind: "handler",
      loopId: "loop",
      dedupeKey: "runtime-fenced",
    }).job!;
    const leased = queue.lease({ kinds: ["handler"], owner: "old", leaseMs: 1 })!;
    const attempts = new SqliteOrchestrationStore(db);
    const attempt = attempts.tryReserve(1, {
      jobId: job.id,
      executionId: "run-old",
      lane: "background",
      workloadKind: "agent",
      runtimeKind: "docker",
      runtimeId: "container-old",
    }, 30_000)!;

    await Bun.sleep(2);
    expect(queue.reclaimExpired()).toBe(1);
    expect(queue.get(job.id)?.status).toBe("queued");
    expect(queue.lease({ kinds: ["handler"], owner: "replacement", leaseMs: 30_000 }))
      .toBeNull();
    expect(queue.pendingKinds()).toEqual([]);
    expect(queue.queuePressure().ready).toBe(0);

    expect(attempts.finish(attempt.id, attempt.ownerToken, "cancelled")).toBe(true);
    expect(queue.lease({ kinds: ["handler"], owner: "replacement", leaseMs: 30_000 })?.id)
      .toBe(leased.id);
    db.close();
  });

  test("persists durable parent linkage for child jobs", () => {
    const { db, queue } = queueHarness();
    db.run(
      `INSERT INTO task_runs (execution_id, task_id, started_at, status, dry_run)
       VALUES ('parent-run', 'custom-instance', ?, 'success', 0)`,
      [new Date().toISOString()],
    );
    const child = queue.enqueue({
      kind: "custom-loop-target",
      loopId: "custom-instance",
      parentExecutionId: "parent-run",
      params: { prompt: "audit" },
    }).job!;
    expect(child.parentExecutionId).toBe("parent-run");
    expect(queue.byParent("parent-run").map((job) => job.id)).toEqual([child.id]);
    expect(queue.hasActiveChildren("custom-instance", "custom-loop-target")).toBe(true);
    expect(queue.cancelJob(child.id, "cancel parent")).toBe(true);
    expect(queue.hasActiveChildren("custom-instance", "custom-loop-target")).toBe(false);
    db.close();
  });

  test("lease selection uses its ordered partial index without a temporary sort", () => {
    const { db } = queueHarness();
    const insert = db.query(
      `INSERT INTO jobs
         (id, kind, loop_id, dedupe_key, params, status, available_at, enqueued_at)
       VALUES (?, ?, 'loop', ?, '{}', 'queued', ?, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        const at = new Date(Date.now() - i * 1_000).toISOString();
        insert.run(`plan-${i}`, i % 2 ? "handler" : "other", `plan-${i}`, at, at);
      }
    })();
    db.run("ANALYZE");
    const plan = db.query<{ detail: string }, [string, string]>(
      `EXPLAIN QUERY PLAN SELECT id FROM jobs
        WHERE status = 'queued' AND available_at <= ? AND kind IN (?)
        ORDER BY priority DESC, available_at ASC, enqueued_at ASC LIMIT 1`,
    ).all(new Date().toISOString(), "handler");
    expect(plan.some((row) => row.detail.includes("idx_jobs_lease_order"))).toBe(true);
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);

    const fairPlan = db.query<{ detail: string }, [string, string, number, string]>(
      `EXPLAIN QUERY PLAN SELECT id FROM jobs
        WHERE status = 'queued' AND available_at <= ? AND kind IN (?)
          AND priority = ? AND COALESCE(actor_id, '') NOT IN (?)
        ORDER BY priority DESC, available_at ASC, enqueued_at ASC LIMIT 1`,
    ).all(new Date().toISOString(), "handler", 0, "busy");
    expect(fairPlan.some((row) => row.detail.includes("idx_jobs_lease_order"))).toBe(true);
    expect(fairPlan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
    db.close();
  });

  test("leases the next job for the actor with the fewest jobs running", () => {
    const { db, queue } = queueHarness();
    let order = 0;
    const enqueue = (actorId: string | undefined, key: string, priority = 0) =>
      queue.enqueue({
        kind: "handler",
        loopId: "loop",
        dedupeKey: key,
        params: {},
        priority,
        availableAt: new Date(Date.now() - 60_000 + order++ * 1_000),
        ...(actorId ? { actorId } : {}),
      }).job!;
    const lease = () => queue.lease({ kinds: ["handler"], owner: "w", leaseMs: 60_000 });

    const a1 = enqueue("alice", "a1");
    enqueue("alice", "a2");
    enqueue("alice", "a3");
    const b1 = enqueue("bob", "b1");
    const system = enqueue(undefined, "s1");

    expect(lease()?.id).toBe(a1.id);
    // Alice has one running, so Bob's and the actorless job go before her second.
    expect(lease()?.id).toBe(b1.id);
    expect(lease()?.id).toBe(system.id);
    expect(lease()?.actorId).toBe("alice");

    // Priority still wins over fairness.
    const urgent = enqueue("alice", "a-urgent", 10);
    enqueue("carol", "c1");
    expect(lease()?.id).toBe(urgent.id);
    expect(lease()?.actorId).toBe("carol");
    db.close();
  });

  test("rejects a stale worker after its lease was reclaimed and reassigned", () => {
    const { db, queue } = queueHarness();
    const subjects = new SqliteSubjectStore(db);
    subjects.observe({ loopId: "loop", subjectKey: "subject", fingerprint: "v1" });
    const enqueued = queue.enqueue({ kind: "handler", loopId: "loop", params: {} });
    const first = queue.lease({ kinds: ["handler"], owner: "worker-a", leaseMs: -1 })!;
    expect(first.leaseToken).toBeString();

    queue.reclaimExpired();
    const second = queue.lease({ kinds: ["handler"], owner: "worker-b", leaseMs: 1_000 })!;
    expect(second.id).toBe(enqueued.job!.id);
    expect(second.leaseToken).not.toBe(first.leaseToken);

    expect(queue.attachExecution(first.id, first.leaseToken!, "stale-run")).toBe(false);
    expect(queue.complete(first.id, first.leaseToken!, { executionId: "stale-run" })).toBe(false);
    expect(queue.fail(first.id, first.leaseToken!, "stale failure")).toBe(false);
    expect(queue.release(first.id, first.leaseToken!)).toBe(false);

    const stillLeased = queue.get(first.id)!;
    expect(stillLeased.status).toBe("leased");
    expect(stillLeased.leaseOwner).toBe("worker-b");
    expect(stillLeased.executionId).toBeUndefined();

    expect(queue.attachExecution(second.id, second.leaseToken!, "worker-b-run")).toBe(true);
    expect(
      queue.complete(second.id, second.leaseToken!, {
        executionId: "worker-b-run",
        subject: { loopId: "loop", subjectKey: "subject", fingerprint: "v1" },
      }),
    ).toBe(true);
    expect(queue.get(second.id)).toMatchObject({ status: "done", executionId: "worker-b-run" });
    expect(subjects.findOpen("loop", "subject")?.fingerprint).toBe("v1");
    db.close();
  });
});

describe("job retention", () => {
  test("retains the newest dead job for a dedupe key as retry-suppression evidence", () => {
    const { db, queue } = queueHarness();
    const old = new Date("2020-01-01T00:00:00.000Z");
    const input = { kind: "handler", loopId: "loop", dedupeKey: "same", params: {}, maxAttempts: 1 };

    const first = queue.enqueue({ ...input, availableAt: old }).job!;
    const lease = queue.lease({ kinds: ["handler"], owner: "worker", leaseMs: 1_000 })!;
    expect(queue.fail(lease.id, lease.leaseToken!, "failed")).toBe(true);
    db.run("UPDATE jobs SET finished_at = ?, enqueued_at = ? WHERE id = ?", [
      old.toISOString(),
      old.toISOString(),
      first.id,
    ]);

    expect(queue.purgeFinished(new Date("2021-01-01T00:00:00.000Z"))).toBe(0);
    expect(queue.deadFor("same")?.id).toBe(first.id);
    db.close();
  });
});

describe("job attribution", () => {
  test("counts queue states for one actor without including another", () => {
    const { db, queue } = queueHarness();
    const queued = queue.enqueue({
      kind: "actor-handler",
      loopId: "loop",
      actorId: "user-a",
      dedupeKey: "user-a-queued",
      params: {},
    }).job!;
    queue.enqueue({
      kind: "other-handler",
      loopId: "loop",
      actorId: "user-b",
      dedupeKey: "user-b-queued",
      params: {},
    });

    const leased = queue.lease({ kinds: ["actor-handler"], owner: "worker", leaseMs: 1_000 })!;
    expect(leased.id).toBe(queued.id);
    expect(queue.countsByActor("user-a")).toEqual({
      queued: 0,
      leased: 1,
      done: 0,
      dead: 0,
    });
    expect(queue.countsByActor("user-b")).toEqual({
      queued: 1,
      leased: 0,
      done: 0,
      dead: 0,
    });
    expect(queue.countsByActor("unknown")).toEqual({
      queued: 0,
      leased: 0,
      done: 0,
      dead: 0,
    });
    db.close();
  });
});

describe("job management", () => {
  test("held jobs remain durable and ineligible until resumed", () => {
    const db = new Database(":memory:");
    migrate(db);
    const queue = new SqliteJobQueue(db);
    const { job } = queue.enqueue({ kind: "handler", loopId: "loop", dedupeKey: "held" });

    expect(queue.hold(job!.id, "maintenance")).toBe(true);
    expect(queue.controlState(job!.id)).toMatchObject({
      held: true,
      holdReason: "maintenance",
    });
    expect(queue.lease({ kinds: ["handler"], owner: "worker", leaseMs: 30_000 })).toBeNull();

    const reopened = new SqliteJobQueue(db);
    expect(reopened.lease({ kinds: ["handler"], owner: "worker", leaseMs: 30_000 })).toBeNull();
    expect(reopened.resume(job!.id)).toBe(true);
    expect(reopened.lease({ kinds: ["handler"], owner: "worker", leaseMs: 30_000 })?.id)
      .toBe(job!.id);
    db.close();
  });

  test("records cancellation, failure, and supersession as distinct outcomes", () => {
    const db = new Database(":memory:");
    migrate(db);
    const queue = new SqliteJobQueue(db);
    const cancelled = queue.enqueue({ kind: "handler", loopId: "loop", dedupeKey: "cancel" }).job!;
    expect(queue.cancelJob(cancelled.id, "operator")).toBe(true);
    expect(queue.controlState(cancelled.id)?.terminalOutcome).toBe("cancelled");

    const failed = queue.enqueue({
      kind: "handler",
      loopId: "loop",
      dedupeKey: "failed",
      maxAttempts: 1,
    }).job!;
    const leased = queue.lease({ kinds: ["handler"], owner: "worker", leaseMs: 30_000 })!;
    expect(leased.id).toBe(failed.id);
    expect(queue.fail(leased.id, leased.leaseToken!, "boom")).toBe(true);
    expect(queue.controlState(failed.id)?.terminalOutcome).toBe("failed");

    const oldJob = queue.enqueue({
      kind: "handler",
      loopId: "loop",
      subjectKey: "subject",
      fingerprint: "v1",
      dedupeKey: "old",
    }).job!;
    const replacement = queue.enqueue({
      kind: "handler",
      loopId: "loop",
      subjectKey: "subject",
      fingerprint: "v2",
      dedupeKey: "new",
    }).job!;
    const runningOld = queue.lease({
      kinds: ["handler"],
      owner: "worker",
      leaseMs: 30_000,
    })!;
    expect(runningOld.id).toBe(oldJob.id);
    expect(queue.supersede(oldJob.id, replacement.id, "new version", true)).toBe(true);
    expect(queue.complete(oldJob.id, runningOld.leaseToken!)).toBe(false);
    expect(queue.release(oldJob.id, runningOld.leaseToken!)).toBe(false);
    expect(queue.controlState(oldJob.id)).toMatchObject({
      terminalOutcome: "superseded",
      supersededByJobId: replacement.id,
    });
    db.close();
  });
});
