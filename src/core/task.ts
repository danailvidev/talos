import type { z } from "zod";
import type { Actor } from "./actor.ts";
import type { Trigger } from "../config/schema.ts";
import type { Logger } from "../logging/logger.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import type { StateStore } from "../persistence/state-store.ts";
import type { StepOptions } from "./step.ts";

/**
 * A task is the one unit of work in this system. It runs ad hoc from the API
 * with params supplied at invocation time, validated against
 * `paramsSchema`. "Scheduling" is not a different kind of task — it is an
 * optional, stored configuration (enabled/trigger/maxItemsPerRun/params) that
 * can be attached to any task by id; see `config/resolve-schedule.ts`. A task
 * with that configuration attached is a ScheduledTask: the resolved, effective
 * view of a task plus its schedule, not a separate type.
 */
export interface Task<P = unknown> {
  id: string;
  name: string;
  description?: string;
  /**
   * Product-level classification, not an execution difference — the executor
   * runs all three identically. "task" is ad-hoc, one-off work, shown on the
   * Tasks page. "loop" is meant to run repeatedly on a schedule, shown on the
   * Loops page.
   *
   * "job" is a handler: it is invoked once per queued job by the worker pool
   * (`core/worker-pool.ts`) and never scheduled or run by hand in normal use, so
   * it is hidden from both pages. Declaring it is what makes the pool willing to
   * lease that kind — the pool only runs kinds it can resolve to a `"job"` task,
   * so a typo'd kind waits in the queue rather than being handed to the wrong
   * handler.
   */
  kind: "task" | "loop" | "job";
  /**
   * The handler runs a coding-agent container. The worker pool bounds how many
   * of these it holds at once by the agent concurrency, so jobs waiting for an
   * agent slot never occupy every worker and starve lightweight kinds.
   */
  agent?: boolean;
  /**
   * True only for definitions the UI may create new, separately-configured,
   * named instances of (e.g. "GitLab CI failures → Jira" for a second GitLab
   * project). An instance is registered at runtime as an ordinary Task with
   * its own id — see `core/instantiate.ts` — so everything downstream
   * (executor, CLI, API) treats it exactly like a code-registered one.
   */
  instantiable?: boolean;
  /**
   * Cron (or once) used when the loop is turned on without a schedule of its
   * own. Activating a manual loop otherwise stores `enabled` and never fires.
   */
  defaultTrigger?: Trigger;
  /** Validates invocation params, whether they arrived ad-hoc or from a stored schedule. */
  paramsSchema: z.ZodType<P>;
  run(ctx: TaskContext, params: P): Promise<TaskResult>;
}

export interface TaskResult {
  /** Optional: not every task processes a "feed" of items. */
  itemsSeen?: number;
  itemsProcessed?: number;
  itemsSkipped?: number;
  /**
   * Items that were attempted and failed. A non-zero count fails the run even
   * though the task returned — so a batch can finish the remaining items and
   * still show as a failure in the list, instead of "success" with a failed
   * step buried in the log.
   */
  itemsFailed?: number;
  /** Free-form detail surfaced in CLI output and execution history. */
  details?: Record<string, unknown>;
  /**
   * Set when the run already posted its own per-item notification(s) — see
   * `review-requested/index.ts`. Tells the sink to skip the generic "X
   * completed" notice, so a single queued item does not produce two.
   */
  notifiedIndividually?: boolean;
}

export const EMPTY_RESULT: TaskResult = {
  itemsSeen: 0,
  itemsProcessed: 0,
  itemsSkipped: 0,
};

/** Which stored defaults an agent-capable execution should receive. */
export type LlmDefaultsScope = "actor" | "instance";

export interface TaskContext {
  taskId: string;
  executionId: string;
  logger: Logger;
  state: StateStore;
  /**
   * Already scoped to `actor`, when there is one. A task asks for
   * `GITLAB_TOKEN` and gets that developer's token if they have stored one, or
   * the shared environment token if not — see `secrets/actor-secrets.ts`. This is
   * why per-developer identity needed no changes in any task.
   */
  secrets: SecretStore;
  /**
   * The developer this run is for: whoever clicked Run, the owner of the loop
   * that ticked, or the owner of the loop that enqueued this job. Read it to
   * *attribute* work — a commit author, a mention in a comment. Do not read it
   * to pick credentials; `secrets` already did.
   */
  actor?: Actor;
  /** When true, connector writes are suppressed. See `mutate`. */
  dryRun: boolean;
  /**
   * Cap on items to act on this run. Bounds blast radius. Always present —
   * the executor supplies it, defaulting to 10 when the caller does not set
   * one — so both ad-hoc and scheduled runs can rely on it.
   */
  maxItemsPerRun: number;
  /**
   * True for an explicit run (UI rerun, CLI `task run`, POST /run). False on
   * a cron tick. Tasks that skip already-processed items honour this so a
   * rerun is not a no-op.
   */
  force: boolean;
  /** Cooperative cancellation — CLI SIGINT, UI/API cancel, or serve shutdown. */
  signal: AbortSignal;
  /**
   * Effective LLM defaults (DB override layered over YAML). Code review reads
   * `model` and `effort` from here and passes them to Claude Code.
   */
  llm: {
    provider: string;
    model?: string;
    effort?: string;
    maxTokens: number;
  };
  /**
   * Effective LLM prompt templates (DB override layered over the hardcoded
   * default), keyed by prompt id — see `tasks/prompt-registry.ts`. A task
   * that sends an agent a prompt reads its own id from here and passes the
   * template into its prompt builder, instead of using the hardcoded string
   * directly.
   */
  prompts: Record<string, string>;

  /**
   * Wraps a unit of work: logs start and finish, records duration and attempt
   * count, persists a step record, and applies the retry policy.
   */
  step<T>(id: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T>;
}
