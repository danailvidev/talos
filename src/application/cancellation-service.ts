import type { JobRepository, NotificationRepository, RunRepository, TaskRunSummary } from "./ports.ts";
import type { TaskExecutor } from "../core/executor.ts";
import type { Logger } from "../logging/logger.ts";

export interface CancellationCleanup {
  stop(executionId: string): Promise<void>;
}

export interface CancelResult {
  executionId: string;
  taskId: string;
  live: boolean;
  alreadyFinished: boolean;
  status: "cancelling" | "cancelled" | TaskRunSummary["status"];
}

export interface CancelJobResult {
  jobId: string;
  /** What the job was, so a caller can report it without a second read. */
  kind: string;
  /** The run that was aborted alongside the job, when one had started. */
  run?: CancelResult;
  /** False when the job had already finished, and nothing was cancelled. */
  cancelled: boolean;
  status: "cancelled" | "already-finished" | "unknown";
}

export class CancellationService {
  constructor(
    private readonly deps: {
      runs: RunRepository;
      jobs: JobRepository;
      executor: TaskExecutor;
      logger: Logger;
      cleanup: CancellationCleanup;
      notifications?: NotificationRepository;
    },
  ) {}

  /**
   * Cancels one queued or leased job, and the run it had started.
   *
   * The order is the whole substance of this method. Killing the row first means
   * the worker pool's response to a cancelled run — `queue.release(job.id)`,
   * which only matches a still-`leased` row — finds nothing to requeue. Aborting
   * the run first would work exactly once and then hand the job to the next
   * worker, which reads as the cancel button doing nothing.
   *
   * A queued job has no run yet, so cancelling it is only the row: nothing is
   * executing, and the point is that nothing ever will.
   */
  async cancelJob(jobId: string): Promise<CancelJobResult> {
    const job = this.deps.jobs.get(jobId);
    if (!job) return { jobId, kind: "unknown", cancelled: false, status: "unknown" };

    if (!this.deps.jobs.cancelJob(jobId, "cancelled by operator")) {
      return { jobId, kind: job.kind, cancelled: false, status: "already-finished" };
    }
    this.deps.logger.warn(
      { job: jobId, kind: job.kind, status: job.status },
      `cancelling job ${jobId}`,
    );

    // The notification exists to say "this work is in progress". It is not, and
    // will not be, so leaving it would point at a run that never happens.
    this.deps.notifications?.deleteByJob(jobId);

    const run = job.executionId ? await this.cancelRun(job.executionId) : undefined;
    return {
      jobId,
      kind: job.kind,
      ...(run ? { run } : {}),
      cancelled: true,
      status: "cancelled",
    };
  }

  async cancelRun(executionId: string): Promise<CancelResult | undefined> {
    const run = this.deps.runs.getRun(executionId);
    if (!run) return undefined;

    // A custom-loop parent may already have finished admitting its durable
    // children. Cancelling the invocation still means none of those children
    // should remain queued or running.
    for (const child of this.deps.jobs.byParent(executionId)) {
      if (child.status === "queued" || child.status === "leased") {
        await this.cancelJob(child.id);
      }
    }

    if (run.status !== "running") {
      return {
        executionId: run.executionId,
        taskId: run.taskId,
        live: false,
        alreadyFinished: true,
        status: run.status,
      };
    }

    const live = this.deps.executor.cancel(executionId);
    this.deps.logger.warn(
      { executionId, task: run.taskId, live },
      `cancelling run ${executionId}`,
    );
    await this.deps.cleanup.stop(executionId);

    if (!live && !this.deps.executor.isActive(executionId)) {
      this.deps.runs.closeOpenRun(executionId, {
        status: "cancelled",
        error: "cancelled by operator",
      });
      return {
        executionId,
        taskId: run.taskId,
        live: false,
        alreadyFinished: false,
        status: "cancelled",
      };
    }

    return {
      executionId,
      taskId: run.taskId,
      live: true,
      alreadyFinished: false,
      status: "cancelling",
    };
  }

  async cancelTask(taskId: string): Promise<CancelResult[]> {
    const liveIds = new Set(this.deps.executor.cancelTask(taskId));
    const last = this.deps.runs.lastRun(taskId);
    const ids = new Set(liveIds);
    if (last?.status === "running") ids.add(last.executionId);

    const results: CancelResult[] = [];
    for (const executionId of ids) {
      const result = await this.cancelRun(executionId);
      if (result) results.push(result);
    }
    return results;
  }
}
