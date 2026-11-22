import { z } from "zod";
import type {
  TestRunOutcome,
  TestRunHistoryRepository,
  SubjectRepository,
  WorkSubject,
} from "../../application/ports.ts";
import type {
  GitLabGateway,
  JiraGateway,
  TaskConnectorFactory,
} from "../../application/gateways.ts";
import {
  DEFAULT_MAX_TRACE_BYTES,
  GitLabConfigSchema,
} from "../../connectors/gitlab/client.ts";
import { analyseTrace } from "../../connectors/gitlab/trace-format.ts";
import type { FetchLike } from "../../connectors/http.ts";
import {
  JiraConfigSchema,
  looksLikeEmail,
} from "../../connectors/jira/client.ts";
import { isResolved } from "../../connectors/jira/types.ts";
import { ConfigError } from "../../core/errors.ts";
import { describeError } from "../../core/executor.ts";
import { NO_RETRY } from "../../core/retry.ts";
import { advanceWatermark, resolveWindow } from "../../core/watermark.ts";
import { mutate } from "../../core/step.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import type { Job, PipelineDetail } from "../../connectors/gitlab/types.ts";
import {
  diffSignatures,
  groupByFile,
  signatureOf,
  subjectKeyOf,
  titleOf,
  type FailureGroup,
} from "./group.ts";
import {
  assess,
  DEFAULT_FLAKE_OPTIONS,
  describeAssessment,
  type FlakeAssessment,
  type FlakeOptions,
} from "../../application/flake.ts";
import { buildChangeComment, buildDescription, type TicketContext } from "./ticket.ts";

/**
 * GitLab CI failures to Jira tickets. One ticket per failing spec file.
 *
 * The whole design turns on one question: what identity does a ticket track? Not
 * the pipeline — there is a new one every night, so keying on it refiles every
 * ticket daily. Not the individual test — a rename would orphan the ticket, and
 * 13 failures across 4 files would file 13 tickets. The *spec file*: it survives
 * every pipeline, maps to one owner and one fix, and is what a human means by
 * "that test is broken".
 *
 * So the rule is: at most one open ticket per spec file. A file already ticketed
 * is not refiled. A file whose failures changed shape gets a comment on its
 * existing ticket. A file whose ticket has been closed becomes fileable again.
 * The uniqueness half of that is a partial unique index in SQLite, not a check in
 * this file, so two concurrent runs cannot both decide to file.
 *
 * No LLM is involved. Titles and descriptions are derived deterministically from
 * the runner's own output, which is Phase 6 by design — the AI analysis step in
 * Phase 8 adds to this, and this must remain useful without it.
 */

/** Registry id of this loop, for the console's Flaky specs page. */
export const CI_FAILURE_TASK_ID = "gitlab-ci-failure";

/**
 * This loop's identity in the shared `TestRunHistoryRepository` — the same
 * table a future test-result producer would write to under its own source, so
 * two producers' rows never collide on `(project, testId, runId)`.
 */
export const CI_FAILURE_SOURCE = "gitlab-ci-failure";

/** The repo this loop was built against — same default the code-review UI offers. */
export const DEFAULT_GITLAB_PROJECT = "example-org/webapp";

export function defaultGitLabProject(): string {
  return Bun.env.TALOS_DEFAULT_GITLAB_PROJECT?.trim() || DEFAULT_GITLAB_PROJECT;
}
/** Jira project/board this loop files into when nothing is stored in the DB. */
export const DEFAULT_JIRA = { project: "PROJ", labels: ["talos", "ci-failure"] } as const;
/** One MiB leaves enough tail budget for large Jest failure recaps. */
export const DEFAULT_CI_TRACE_BYTES = DEFAULT_MAX_TRACE_BYTES;

const ConfigSchema = z.object({
  gitlab: z.preprocess(
    (value) => value ?? {
      projectId: defaultGitLabProject(),
      maxTraceBytes: DEFAULT_CI_TRACE_BYTES,
    },
    GitLabConfigSchema,
  ),
  jira: JiraConfigSchema.default(() => JiraConfigSchema.parse(DEFAULT_JIRA)),
  /**
   * Pipelines of one GitLab pipeline schedule, by its description in the UI. The
   * usual way to target a nightly test run — a pipeline's `name` is not its
   * schedule's description, and is null on most projects.
   *
   * Named `pipelineSchedule` and not `schedule` because a task's own schedule
   * config already has a `trigger`/cron expression deciding when *this task*
   * runs. Two unrelated meanings under one key would silently make one of
   * them a cron validation error.
   */
  pipelineSchedule: z.string().min(1).optional(),
  /** Pipeline source filter, e.g. `schedule`. */
  source: z.string().min(1).optional(),
  /**
   * Consider pipelines whatever their status.
   *
   * Needed more often than it looks: a test job marked `allow_failure: true` so it
   * never blocks a deploy leaves the pipeline **green** while the tests are
   * broken, and the default filter would find nothing at all.
   */
  anyStatus: z.boolean().default(true),
  /** Treat `allow_failure` jobs as failures. Same reason as above. */
  includeAllowedFailures: z.boolean().default(true),
  /** Only these jobs, by name, when a pipeline has several failing jobs. */
  jobNames: z.array(z.string().min(1)).default([]),
  /** Prefix for every ticket title, so the board shows where they came from. */
  titlePrefix: z.string().default("Unit test failure"),
  /**
   * How many consecutive failures a spec needs before a ticket is filed.
   *
   * The one field here that changes behaviour rather than tuning it. `1` is what
   * this loop did before flake detection existed: file the first time anything
   * goes red, flakes included. The default of `2` costs one night's delay on a
   * genuine regression and removes most of the noise. A suite that fails to *run*
   * ignores this and files immediately — see `flake.ts`.
   */
  failuresBeforeFiling: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_FLAKE_OPTIONS.failuresBeforeFiling),
  /** How many recent conclusive pipelines a verdict is judged over. */
  historyWindow: z.number().int().min(2).default(DEFAULT_FLAKE_OPTIONS.historyWindow),
  /** Failure rate at or above which a flake earns a quarantine suggestion. */
  quarantineFlakeRate: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_FLAKE_OPTIONS.quarantineFlakeRate),
  /** Conclusive runs needed before a flake rate is quoted at all. */
  minObservations: z
    .number()
    .int()
    .min(2)
    .default(DEFAULT_FLAKE_OPTIONS.minObservations),
});

type Config = z.infer<typeof ConfigSchema>;

/** How many pipelines to consider per run before the item cap applies. */
const PIPELINE_SCAN_LIMIT = 20;

export interface CiFailureDeps {
  /**
   * Replaces the `fetch` both connectors use.
   *
   * The same seam the connectors expose, lifted to the task: the interesting
   * behaviour here — not refiling a ticket that already exists — can only be
   * tested by running the task twice, and that is impossible if it reaches the
   * real GitLab and Jira. Both clients share one double because their paths
   * (`/api/v4`, `/rest/api/3`) never collide.
   */
  fetch?: FetchLike;
  /** Durable per-loop subject state, supplied by the composition root. */
  subjects?: SubjectRepository;
  /**
   * Per-spec pass/fail history, which is what makes flake detection possible.
   *
   * Optional, unlike `subjects`: an instance wired without it keeps the original
   * behaviour of filing on the first failure, and the tests that exercise the
   * ticketing rules do not have to grow a second store to keep passing.
   */
  testRunHistory?: TestRunHistoryRepository;
  connectors?: TaskConnectorFactory;
}

export function createCiFailureTask(deps: CiFailureDeps = {}): Task<Config> {
  return {
    id: CI_FAILURE_TASK_ID,
    name: "GitLab CI failures to Jira",
    description:
      "Files one Jira ticket per failing spec file, in the active sprint, and never refiles one that is already open.",
    kind: "loop",
    instantiable: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

export const ciFailureTask: Task<Config> = createCiFailureTask();

async function run(
  ctx: TaskContext,
  config: Config,
  deps: CiFailureDeps,
): Promise<TaskResult> {
  const startedAt = new Date();
  const { since, seeded } = await resolveWindow(ctx, startedAt);

  const subjects = requireSubjectRepository(deps);
  const connectors = requireConnectorFactory(deps);
  const gitlab = connectors.gitlab(ctx, deps.fetch);
  const jira = connectors.jira(ctx, deps.fetch);

  // Static target fields and the fixed/fallback account are resolved before any
  // ticket is created. Automatic author lookup stays per file because each spec
  // maps to its own implementation file and a failed lookup safely falls back.
  const target = await ctx.step("resolve-jira-target", () =>
    resolveTarget(jira, config, ctx),
  );

  const pipelines = await ctx.step("poll-pipelines", () => {
    // A click of Rerun is "look at what just failed", not "continue the
    // watermark". A prior run that examined the wrong pipelines still
    // advances `since` to now, which would hide the nightly scheduled
    // pipeline the operator is staring at.
    const explicit = ctx.force;
    if (explicit) {
      ctx.logger.info(
        { watermark: since.toISOString(), pipelineSchedule: config.pipelineSchedule },
        "explicit rerun: ignoring watermark, taking the latest matching pipeline",
      );
    }
    const query = {
      project: config.gitlab.projectId,
      ref: config.gitlab.ref,
      scheduleDescription: config.pipelineSchedule,
      source: config.source,
      updatedAfter: explicit ? undefined : since,
      limit: explicit ? 1 : PIPELINE_SCAN_LIMIT,
      newestFirst: explicit,
      signal: ctx.signal,
    };
    return config.anyStatus
      ? gitlab.listPipelines(query)
      : gitlab.listFailedPipelines(query);
  });

  if (pipelines.length === 0) {
    ctx.logger.info(
      { since: since.toISOString() },
      "no pipelines to examine in this window",
    );
    if (!seeded) await advanceWatermark(ctx, startedAt, { failures: 0 });
    return { itemsSeen: 0, itemsProcessed: 0, itemsSkipped: 0 };
  }

  let groupsSeen = 0;
  let filed = 0;
  let commented = 0;
  let skipped = 0;
  let failures = 0;
  let held = 0;
  const results: FileOutcome[] = [];
  const parserIssues: {
    pipelineId: number;
    jobId: number;
    jobName: string;
    jobUrl: string;
    traceTruncated: boolean;
    unresolvedCount: number;
    failures: string[];
  }[] = [];
  const flakeOptions = flakeOptionsOf(config);
  const attributionCache: AssigneeAttributionCache = {
    sourceAuthors: new Map(),
    jiraAccounts: new Map(),
    jiraUsers: new Map(),
  };

  for (const pipeline of pipelines) {
    if (ctx.signal.aborted) {
      ctx.logger.warn("shutdown requested, stopping early");
      // Counted as a failure so the watermark holds and the remainder is
      // re-polled rather than skipped.
      failures++;
      break;
    }

    const jobs = await ctx.step(`jobs:${pipeline.id}`, async () => {
      const failed = await gitlab.listFailedJobs(
        config.gitlab.projectId,
        pipeline.id,
        {
          includeAllowedFailures: config.includeAllowedFailures,
          signal: ctx.signal,
        },
      );
      return config.jobNames.length === 0
        ? failed
        : failed.filter((job) => config.jobNames.includes(job.name));
    });

    if (jobs.length === 0) {
      // The pipeline everything hinges on. A green run is the only proof we get
      // that a spec passed — the trace of a failed job names what failed and
      // nothing else — so recording it is what turns "this spec failed tonight"
      // into "this spec has failed 2 of the last 10 runs".
      deps.testRunHistory?.recordTestRun({
        source: CI_FAILURE_SOURCE,
        project: String(config.gitlab.projectId),
        runId: String(pipeline.id),
        sha: pipeline.sha,
        ref: pipeline.ref,
        status: pipeline.status,
        outcome: "green",
        testsFailed: 0,
        finishedAt: pipeline.updated_at,
      });
      continue;
    }

    const detail = await ctx.step(`pipeline:${pipeline.id}`, () =>
      gitlab.pipeline(config.gitlab.projectId, pipeline.id, ctx.signal),
    );

    const finishedAt = detail.finished_at ?? pipeline.updated_at;
    // Running totals across this pipeline's jobs. The pipeline row is re-upserted
    // after every job rather than once at the end, because the *current* failure
    // has to be in the history before `handleGroup` reads it — a verdict computed
    // without tonight's run in it would be a night behind.
    let specsFailed = 0;
    let conclusive = false;
    let attributionComplete = true;

    for (const job of jobs) {
      const groups = await ctx.step(`analyse:${job.id}`, async () => {
        const trace = await gitlab.jobTrace(config.gitlab.projectId, job, {
          maxBytes: config.gitlab.maxTraceBytes,
          signal: ctx.signal,
        });
        const analysis = analyseTrace(trace.text);
        const unresolved = [
          ...analysis.failedTests
            .filter((test) => !test.file)
            .map((test) => test.name),
          ...analysis.failedSuites
            .filter((suite) => !suite.file)
            .map((suite) => `Suite failed to run: ${suite.detail.split("\n")[0] ?? "unknown"}`),
        ];
        return {
          groups: groupByFile(analysis),
          unresolved,
          summary: analysis.summary,
          truncated: trace.truncated,
          // Nothing about the runner parsed: the job died of something that is not
          // a test result — no runner, a timeout, an OOM. Recording that as "every
          // spec passed" would break a real regression's streak and relabel it a
          // flake, so it is recorded as proving nothing instead.
          runner: analysis.runner,
          jobError: analysis.jobError,
        };
      });

      groupsSeen += groups.groups.length;
      specsFailed += groups.groups.length;
      if (groups.runner !== "unknown") conclusive = true;
      if (groups.unresolved.length > 0) {
        attributionComplete = false;
        const issue = {
          pipelineId: pipeline.id,
          jobId: job.id,
          jobName: job.name,
          jobUrl: job.web_url,
          traceTruncated: groups.truncated,
          unresolvedCount: groups.unresolved.length,
          failures: groups.unresolved.slice(0, 50),
        };
        parserIssues.push(issue);
        ctx.logger.warn(
          issue,
          `could not attribute ${groups.unresolved.length} Jest failure(s) in ` +
            `${job.name} to spec files; excluded them from spec history and ticketing`,
        );
      }

      if (deps.testRunHistory) {
        const outcome: TestRunOutcome = conclusive && attributionComplete
          ? specsFailed > 0
            ? "failures"
            : "green"
          : "inconclusive";
        if (outcome === "inconclusive" && !conclusive) {
          ctx.logger.warn(
            { pipeline: pipeline.id, job: job.name, jobError: groups.jobError },
            `no complete test results parsed from ${job.name}; pipeline #${pipeline.id} ` +
              `proves nothing about any spec and is excluded from flake history`,
          );
        }
        deps.testRunHistory.recordTestRun({
          source: CI_FAILURE_SOURCE,
          project: String(config.gitlab.projectId),
          runId: String(pipeline.id),
          sha: pipeline.sha,
          ref: pipeline.ref,
          status: pipeline.status,
          outcome,
          testsFailed: specsFailed,
          finishedAt,
        });
        for (const group of groups.groups) {
          deps.testRunHistory.recordTestFailure({
            source: CI_FAILURE_SOURCE,
            project: String(config.gitlab.projectId),
            runId: String(pipeline.id),
            testId: group.file,
            signature: signatureOf(group),
            suiteFailedToRun: group.suiteFailedToRun,
            tests: group.tests,
            finishedAt,
          });
        }
      }

      // The cap counts *tickets*, not pipelines: it exists to bound how many
      // external writes one run can perform, and a single pipeline can carry a
      // hundred failing files.
      const remaining = ctx.maxItemsPerRun - (filed + commented);
      if (remaining <= 0) {
        skipped += groups.groups.length;
        ctx.logger.warn(
          { cap: ctx.maxItemsPerRun, deferred: groups.groups.length },
          `reached the ${ctx.maxItemsPerRun}-item cap; the rest wait for the next run`,
        );
        // The watermark must not advance past a pipeline whose files were never
        // examined, or they are lost.
        failures++;
        break;
      }

      const ticketContext = (
        group: FailureGroup,
        assessment?: FlakeAssessment,
      ): TicketContext => ({
        project: config.gitlab.projectId,
        pipelineId: pipeline.id,
        pipelineUrl: pipeline.web_url,
        jobId: job.id,
        jobName: job.name,
        jobUrl: job.web_url,
        ref: pipeline.ref,
        commitTitle: detail.commit?.title,
        commitAuthor: detail.commit?.author_name,
        summary: groups.summary,
        traceTruncated: groups.truncated,
        ...(assessment ? { assessment } : {}),
      });

      // Whatever the cap leaves behind is deferred, not handled — and saying so
      // is what keeps the watermark from advancing past it. Slicing alone would
      // drop these files silently and they would never be examined again.
      const deferred = groups.groups.slice(remaining);
      if (deferred.length > 0) {
        skipped += deferred.length;
        failures++;
        ctx.logger.warn(
          { cap: ctx.maxItemsPerRun, deferred: deferred.map((g) => g.file) },
          `reached the ${ctx.maxItemsPerRun}-item cap; ${deferred.length} file(s) ` +
            `wait for the next run`,
        );
      }

      for (const group of groups.groups.slice(0, remaining)) {
        // An operator who clicked "File a ticket anyway" outranks the classifier.
        // Cleared here rather than after filing, so a Jira outage cannot turn one
        // override into a ticket filed every night from now on.
        const forced =
          deps.testRunHistory?.forceFilePending(
            CI_FAILURE_SOURCE,
            String(config.gitlab.projectId),
            group.file,
          ) ?? false;
        if (forced) {
          deps.testRunHistory?.setForceFile(
            CI_FAILURE_SOURCE,
            String(config.gitlab.projectId),
            group.file,
            false,
          );
          ctx.logger.info(
            { file: group.file },
            `filing ${group.file} despite its verdict: an operator asked for it`,
          );
        }

        const testHistory = deps.testRunHistory?.history(
          CI_FAILURE_SOURCE,
          String(config.gitlab.projectId),
          group.file,
          flakeOptions.historyWindow,
        );
        const assessment = testHistory ? assess(testHistory, flakeOptions) : undefined;

        if (assessment?.quarantine) {
          deps.testRunHistory?.suggestQuarantine(
            CI_FAILURE_SOURCE,
            String(config.gitlab.projectId),
            group.file,
          );
        }

        const outcome = await fileStep({
          ctx,
          gitlab,
          jira,
          subjects,
          config,
          target,
          group,
          ticketContext: ticketContext(group, assessment),
          job,
          pipeline: detail,
          attributionCache,
          // Withheld when forced: `handleGroup` gates on the assessment's presence,
          // so an override is expressed by simply not handing it one.
          ...(assessment && !forced ? { assessment } : {}),
        });

        results.push(outcome);
        if (outcome.action === "filed") filed++;
        else if (outcome.action === "commented") commented++;
        else if (outcome.action === "failed") failures++;
        else if (outcome.action === "held") {
          held++;
          skipped++;
        } else skipped++;
      }
    }
  }

  if (!seeded) await advanceWatermark(ctx, startedAt, { failures });

  return {
    itemsSeen: groupsSeen,
    itemsProcessed: filed + commented,
    itemsSkipped: skipped,
    details: {
      since: since.toISOString(),
      pipelines: pipelines.length,
      filed,
      commented,
      // What the run chose *not* to file, which is the interesting number now that
      // holding is a decision: a run reporting 0 filed and 6 held has worked
      // correctly, and without this it would look like a run that did nothing.
      held,
      sprint: target.sprintId ?? null,
      sprintSkipped: target.sprintReason ?? null,
      issues: results
        .filter((r) => r.issueKey)
        .map((r) => `${r.action} ${r.issueKey} ${r.file}`),
      ticketOutcomes: results.flatMap((result) =>
        result.issueKey
          ? [
              {
                action: result.action,
                issueKey: result.issueKey,
                issueUrl: jira.issueUrl(result.issueKey),
                file: result.file,
                ...(result.assignee ? { assignee: result.assignee } : {}),
              },
            ]
          : [],
      ),
      ...(held > 0
        ? {
            heldSpecs: results
              .filter((r) => r.action === "held")
              .map((r) => `${r.file} (${r.reason})`),
          }
        : {}),
      ...(parserIssues.length > 0 ? { parserIssues } : {}),
    },
  };
}

/** What a run decided about one spec file. */
interface FileOutcome {
  file: string;
  /**
   * `held` is a spec that failed but has not earned a ticket yet — a flake, or a
   * first sighting. Distinct from `suppressed` (a dry run) and from `failed` (we
   * could not do the work): the run examined it and decided not to file.
   */
  action: "filed" | "commented" | "unchanged" | "failed" | "suppressed" | "held";
  issueKey?: string;
  /** Human-readable Jira assignee captured when this run saw or filed the ticket. */
  assignee?: string;
  reason?: string;
}

interface ResolvedTarget {
  projectKey: string;
  issueType: string;
  automaticAssignee: boolean;
  /** Fixed assignee, or the integration account used as Automatic's fallback. */
  assigneeAccountId?: string;
  sprintId?: number;
  /** Why there is no sprint, when there is none. */
  sprintReason?: string;
  labels: string[];
  extraFields: Record<string, unknown>;
}

/**
 * Resolves every Jira id the run will need, before it needs them.
 *
 * This is the difference between a misconfiguration failing at `connector test`
 * and failing at 3am after three tickets have already been filed. An unknown
 * issue type or fixed/fallback assignee is fatal here; an automatically inferred
 * author is allowed to fall back. A missing sprint is not fatal — see below.
 */
async function resolveTarget(
  jira: JiraGateway,
  config: Config,
  ctx: TaskContext,
): Promise<ResolvedTarget> {
  const projectKey = config.jira.project;

  // Throws with the valid type names listed if the configured one is wrong.
  await jira.issueTypeId(projectKey, config.jira.issueType, ctx.signal);

  const automaticAssignee =
    config.jira.assigneeMode === "automatic" ||
    (config.jira.assigneeMode == null && config.jira.assignee == null);
  if (config.jira.assigneeMode === "fixed" && !config.jira.assignee) {
    throw new ConfigError("A fixed Jira assignee requires an account id or email.");
  }

  const assignee = automaticAssignee
    ? ctx.secrets.get("JIRA_EMAIL")
    : config.jira.assignee ?? ctx.secrets.get("JIRA_EMAIL");
  let assigneeAccountId: string | undefined;
  if (assignee) {
    assigneeAccountId = looksLikeEmail(assignee)
      ? await jira.accountIdForEmail(assignee, ctx.signal)
      : // Already an account id; using it as given avoids a lookup that would
        // fail for the wrong reason.
        assignee;
  }

  let sprintId: number | undefined;
  let sprintReason: string | undefined;

  if (config.jira.useActiveSprint) {
    const fieldId = await jira.findSprintFieldId(ctx.signal);
    if (!fieldId) {
      sprintReason = "this Jira site has no sprint field";
    } else {
      const { sprint, reason } = await jira.resolveActiveSprint({
        projectKey,
        boardId: config.jira.boardId,
        signal: ctx.signal,
      });
      sprintId = sprint?.id;
      sprintReason = reason;
    }

    // Not fatal, and deliberately so: a broken test is worth a ticket even when
    // the sprint cannot be determined, and failing here would mean a board
    // misconfiguration silently stops all reporting. Logged at warn so it is
    // visible rather than discovered on the board.
    if (sprintId == null) {
      ctx.logger.warn(
        { reason: sprintReason },
        `no active sprint (${sprintReason}); issues will be filed to the backlog`,
      );
    }
  }

  const extraFields = await jira.extraSelectFields(
    [
      { name: "Bug found by", value: config.jira.bugFoundBy },
      { name: "FE/BE/UX", value: config.jira.feBeUx },
    ],
    ctx.signal,
  );

  return {
    projectKey,
    issueType: config.jira.issueType,
    automaticAssignee,
    assigneeAccountId,
    sprintId,
    sprintReason,
    labels: config.jira.labels,
    extraFields,
  };
}

/**
 * `handleGroup` as a recorded step, isolated per spec file.
 *
 * Two things this adds, both of which were missing while ticket work happened
 * inside the `analyse:*` step's shadow:
 *
 * Visibility. Filing is the part of this task an operator cares about, and
 * it was the only part with no step record — so `task logs` showed how long
 * it took to *read* a trace and nothing about the Jira calls that followed.
 *
 * Isolation. One file's Jira failure used to abort the entire run, discarding
 * the tickets already filed for other files. A 400 on a malformed summary is a
 * per-file problem; the remaining files can still be filed. The error is caught
 * here, reported as an outcome, and counted as a failure by the caller — which
 * holds the watermark open so the run is retried rather than skipped.
 *
 * Retry is disabled deliberately. `createIssue` is not idempotent and the guard
 * against double-filing (the open subject row) is written only *after* it returns, so
 * a retry of a create that actually succeeded would file a second ticket. The
 * HTTP layer already retries what is safely retryable at the request level.
 */
async function fileStep(args: {
  ctx: TaskContext;
  gitlab: GitLabGateway;
  jira: JiraGateway;
  subjects: SubjectRepository;
  config: Config;
  target: ResolvedTarget;
  group: FailureGroup;
  ticketContext: TicketContext;
  job: Job;
  pipeline: PipelineDetail;
  attributionCache: AssigneeAttributionCache;
  assessment?: FlakeAssessment;
}): Promise<FileOutcome> {
  const { ctx, group } = args;

  try {
    return await ctx.step(`file:${group.file}`, () => handleGroup(args), {
      retry: NO_RETRY,
      meta: { file: group.file, tests: group.tests.length },
    });
  } catch (err) {
    // An abort is a shutdown, not a per-file fault: let it end the run.
    if (ctx.signal.aborted) throw err;

    ctx.logger.error(
      { file: group.file, err: describeError(err) },
      `could not file or update a ticket for ${group.file}; continuing with the ` +
        `remaining files`,
    );
    return { file: group.file, action: "failed", reason: describeError(err) };
  }
}

/**
 * Decides and performs the one action a spec file's failures earn.
 *
 * The order of the checks is the persistence guarantee. 'work_subjects' is
 * consulted first because it is local and authoritative about what this tool has filed;
 * Jira is consulted second, to catch a ticket filed by hand or one created in the
 * instant before a crash. Only when both say there is nothing is a ticket filed.
 */
async function handleGroup(args: {
  ctx: TaskContext;
  gitlab: GitLabGateway;
  jira: JiraGateway;
  subjects: SubjectRepository;
  config: Config;
  target: ResolvedTarget;
  group: FailureGroup;
  ticketContext: TicketContext;
  job: Job;
  pipeline: PipelineDetail;
  attributionCache: AssigneeAttributionCache;
  assessment?: FlakeAssessment;
}): Promise<FileOutcome> {
  const { ctx, jira, subjects, config, target, group, ticketContext, assessment } = args;
  const subjectKey = subjectKeyOf(config.gitlab.projectId, group);
  const signature = signatureOf(group);

  const existing = subjects.findOpen(ctx.taskId, subjectKey);

  // The flake gate only ever blocks opening a *new* ticket. A spec that already
  // has one keeps getting its comments whatever the verdict: somebody is reading
  // that ticket, and a changed failure shape is news to them.
  const hold =
    assessment && assessment.verdict !== "regression"
      ? heldOutcome(ctx, config, group, assessment)
      : undefined;

  if (!existing && hold) return hold;

  if (existing) {
    const reconciled = await reconcile(ctx, jira, subjects, existing);
    if (reconciled) {
      return await updateExisting({ ...args, existing: reconciled, signature });
    }
    // The ticket was closed or deleted, so the file is fileable again — fall
    // through to filing. This is the "refile after close" half of the rule.
    ctx.logger.info(
      { subject: subjectKey, previous: existing.externalRef },
      `previous ticket ${existing.externalRef} is closed; filing a new one`,
    );
    // Refiling is opening a new ticket, so it is gated like one. Without this, a
    // flake whose ticket was closed as "cannot reproduce" would be refiled by the
    // very next flaky night — which is exactly the loop somebody closed it to end.
    if (hold) return hold;
  }

  // Jira is asked even when no subject is open, because our own table cannot know
  // about a ticket a human filed or one we created and crashed before recording.
  const orphan = await findExistingIssue(ctx, jira, target, group, subjectKey);
  if (orphan) {
    ctx.logger.info(
      { subject: subjectKey, issue: orphan.issueKey },
      `adopting existing Jira issue ${orphan.issueKey} for ${group.file}`,
    );
    subjects.open({
      loopId: ctx.taskId,
      subjectKey,
      fingerprint: signature,
      externalRef: orphan.issueKey,
      externalUrl: jira.issueUrl(orphan.issueKey),
      metadata: auditMetadata(args, "adopted"),
    });
    return {
      file: group.file,
      action: "unchanged",
      issueKey: orphan.issueKey,
      assignee: orphan.assignee,
      reason: "adopted",
    };
  }

  return await fileNew({ ...args, subjectKey, signature });
}

/** An open subject together with the Jira key it was filed as. */
interface TrackedTicket {
  subject: WorkSubject;
  issueKey: string;
  assignee?: string;
}

/**
 * Checks whether an open subject's ticket is still open in Jira.
 *
 * Returns the subject when the ticket is live, null when it is resolved or gone.
 * This is the only thing that closes a subject here: a green test run is *not*
 * used as the signal, because whether a ticket is accepted and closed is its
 * owner's decision, not an inference from our own test results.
 */
async function reconcile(
  ctx: TaskContext,
  jira: JiraGateway,
  subjects: SubjectRepository,
  existing: WorkSubject,
): Promise<TrackedTicket | null> {
  const issueKey = existing.externalRef;

  // Only reachable if a row was written by something other than this loop: every
  // path here opens a subject with the ticket it filed. Releasing the key is the
  // recoverable direction — the JQL adoption search runs next and finds the
  // ticket if there is one.
  if (!issueKey) {
    ctx.logger.warn(
      { subject: existing.subjectKey },
      `${existing.subjectKey} is tracked with no Jira key; releasing its subject`,
    );
    subjects.close(ctx.taskId, existing.subjectKey, "no external ref");
    return null;
  }

  const issue = await jira.issue(issueKey, ctx.signal);

  if (issue == null) {
    ctx.logger.warn(
      { issue: issueKey },
      `${issueKey} no longer exists in Jira; releasing its subject`,
    );
    subjects.close(ctx.taskId, existing.subjectKey, `${issueKey} deleted`);
    return null;
  }

  if (isResolved(issue)) {
    subjects.close(ctx.taskId, existing.subjectKey, `${issueKey} resolved`);
    return null;
  }

  return {
    subject: existing,
    issueKey,
    assignee: jiraAssigneeLabel(issue),
  };
}

/** Comments when the failure changed; otherwise notes the sighting and stops. */
async function updateExisting(args: {
  ctx: TaskContext;
  jira: JiraGateway;
  subjects: SubjectRepository;
  group: FailureGroup;
  ticketContext: TicketContext;
  existing: TrackedTicket;
  signature: string;
  config: Config;
  target: ResolvedTarget;
  job: Job;
  pipeline: PipelineDetail;
}): Promise<FileOutcome> {
  const { ctx, jira, subjects, group, ticketContext, existing, signature } = args;
  const { subject, issueKey, assignee } = existing;

  // Recorded on every sighting, changed or not: a months-old ticket for a
  // still-red test has to be distinguishable from one nobody has re-run.
  //
  // Metadata is passed here too (not just on file/comment) so a ticket filed
  // before this loop tracked `title` gets backfilled on its very next sighting,
  // rather than showing its raw subject key in the Tracked table forever.
  subjects.observe({
    loopId: ctx.taskId,
    subjectKey: subject.subjectKey,
    fingerprint: signature,
    metadata: auditMetadata(args, "seen"),
  });

  const diff = diffSignatures(subject.fingerprint ?? "", group);

  if (!diff) {
    // The overwhelmingly common case on a second run: same tests, same file,
    // nothing to say. No Jira call at all — which is the entire point.
    ctx.logger.debug(
      { subject: subject.subjectKey, issue: issueKey },
      `${group.file} still failing identically; ${issueKey} left alone`,
    );
    return {
      file: group.file,
      action: "unchanged",
      issueKey,
      assignee,
      reason: "same failures",
    };
  }

  const posted = await mutate(
    ctx,
    `comment on ${issueKey} (${group.file} failures changed)`,
    async () => {
      await jira.addComment(
        issueKey,
        buildChangeComment(group, diff, ticketContext),
        ctx.signal,
      );
      return true;
    },
    { added: diff.added.length, removed: diff.removed.length },
  );

  if (posted == null) {
    // Dry run. The fingerprint is deliberately *not* advanced: recording it would
    // make the next real run believe the comment had been posted.
    return {
      file: group.file,
      action: "suppressed",
      issueKey,
      assignee,
      reason: "dry run: would comment",
    };
  }

  subjects.markActedOn(ctx.taskId, subject.subjectKey, signature, {
    metadata: auditMetadata(args, "commented"),
  });

  return { file: group.file, action: "commented", issueKey, assignee };
}

/**
 * Creates the ticket and records it.
 *
 * The order is create-then-record, and it matters. A crash between the two leaves
 * a ticket with no subject row, which the next run finds through JQL and adopts —
 * recoverable. Recording first would leave a row pointing at a ticket that does
 * not exist, permanently suppressing the real one.
 */
async function fileNew(args: {
  ctx: TaskContext;
  gitlab: GitLabGateway;
  jira: JiraGateway;
  subjects: SubjectRepository;
  config: Config;
  target: ResolvedTarget;
  group: FailureGroup;
  ticketContext: TicketContext;
  subjectKey: string;
  signature: string;
  job: Job;
  pipeline: PipelineDetail;
  attributionCache: AssigneeAttributionCache;
}): Promise<FileOutcome> {
  const { ctx, jira, subjects, config, target, group, ticketContext, subjectKey, signature } =
    args;

  const summary = titleOf(group, config.titlePrefix);
  const description = buildDescription(group, ticketContext);
  const assigneeAccountId = target.automaticAssignee
    ? await resolveAutomaticAssignee(args)
    : target.assigneeAccountId;
  const assignee = assigneeAccountId
    ? await jiraAssigneeName(ctx, jira, assigneeAccountId, args.attributionCache)
    : undefined;

  const created = await mutate(
    ctx,
    `file a Jira ${target.issueType} in ${target.projectKey} for ${group.file}`,
    () =>
      jira.createIssue({
        projectKey: target.projectKey,
        issueType: target.issueType,
        summary,
        description,
        assigneeAccountId,
        sprintId: target.sprintId,
        labels: [...target.labels, fileLabel(group.file)],
        extraFields: target.extraFields,
        signal: ctx.signal,
      }),
    {
      summary,
      file: group.file,
      tests: group.tests.length,
      sprint: target.sprintId,
      assignee: assigneeAccountId,
    },
  );

  if (created == null) {
    // Dry run: nothing recorded, so a following real run still files it.
    return { file: group.file, action: "suppressed", reason: "dry run: would file" };
  }

  const recorded = subjects.open({
    loopId: ctx.taskId,
    subjectKey,
    fingerprint: signature,
    externalRef: created.key,
    externalUrl: jira.issueUrl(created.key),
    metadata: auditMetadata(args, "filed"),
  });

  if (!recorded) {
    // A concurrent run won the partial unique index between our Jira call and
    // this insert. Both tickets exist and one is now untracked — say so loudly,
    // because a human has to merge them and nothing else will surface it.
    ctx.logger.error(
      { subject: subjectKey, issue: created.key },
      `filed ${created.key} but another run already holds the open ticket for ` +
        `${group.file}; ${created.key} is a duplicate and needs closing by hand`,
    );
  }

  ctx.logger.info(
    { issue: created.key, file: group.file, tests: group.tests.length },
    `filed ${created.key} for ${group.file} (${group.tests.length} failing test(s))`,
  );

  return { file: group.file, action: "filed", issueKey: created.key, assignee };
}

interface AssigneeAttributionCache {
  sourceAuthors: Map<string, Promise<SourceAuthor>>;
  jiraAccounts: Map<string, Promise<string | undefined>>;
  jiraUsers: Map<string, Promise<string>>;
}

/**
 * Resolve Jira's opaque account id once per run for the human-facing outcome.
 * A label lookup is presentation metadata, so failure falls back to the id and
 * never turns a successfully filed ticket into a failed task.
 */
async function jiraAssigneeName(
  ctx: TaskContext,
  jira: JiraGateway,
  accountId: string,
  cache: AssigneeAttributionCache,
): Promise<string> {
  let read = cache.jiraUsers.get(accountId);
  if (!read) {
    read = jira
      .userByAccountId(accountId, ctx.signal)
      .then((user) => user.displayName?.trim() || user.emailAddress?.trim() || accountId)
      .catch((err) => {
        ctx.logger.warn(
          { accountId, err: describeError(err) },
          "could not resolve the Jira assignee's display name",
        );
        return accountId;
      });
    cache.jiraUsers.set(accountId, read);
  }
  return await read;
}

interface SourceAuthor {
  email?: string;
  reason: string;
}

async function resolveAutomaticAssignee(args: {
  ctx: TaskContext;
  gitlab: GitLabGateway;
  jira: JiraGateway;
  config: Config;
  target: ResolvedTarget;
  group: FailureGroup;
  pipeline: PipelineDetail;
  attributionCache: AssigneeAttributionCache;
}): Promise<string | undefined> {
  const {
    ctx,
    gitlab,
    jira,
    config,
    target,
    group,
    pipeline,
    attributionCache,
  } = args;
  const sourceFile = sourceFileForSpec(group.file);

  if (!sourceFile) {
    ctx.logger.info(
      { file: group.file },
      `automatic assignee fell back for ${group.file}: no matching .ts implementation file`,
    );
    return target.assigneeAccountId;
  }

  const cacheKey = `${config.gitlab.projectId}\0${pipeline.sha}\0${sourceFile}`;
  let authorRead = attributionCache.sourceAuthors.get(cacheKey);
  if (!authorRead) {
    authorRead = latestSourceAuthor(
      gitlab,
      config.gitlab.projectId,
      sourceFile,
      pipeline.sha,
      ctx.signal,
    );
    attributionCache.sourceAuthors.set(cacheKey, authorRead);
  }
  const author = await authorRead;

  if (!author.email) {
    ctx.logger.info(
      { file: group.file, reason: author.reason },
      `automatic assignee fell back for ${group.file}: ${author.reason}`,
    );
    return target.assigneeAccountId;
  }

  let accountRead = attributionCache.jiraAccounts.get(author.email);
  if (!accountRead) {
    accountRead = jira
      .accountIdForEmail(author.email, ctx.signal)
      .catch((err) => {
        ctx.logger.warn(
          { file: group.file, authorEmail: author.email, err: describeError(err) },
          `automatic assignee could not resolve ${author.email} in Jira; using the integration account`,
        );
        return undefined;
      });
    attributionCache.jiraAccounts.set(author.email, accountRead);
  }

  const accountId = await accountRead;
  if (!accountId) return target.assigneeAccountId;

  ctx.logger.info(
    { file: group.file, sourceFile, authorEmail: author.email },
    `automatically assigned ${group.file} to the last person who touched ${sourceFile}`,
  );
  return accountId;
}

function sourceFileForSpec(file: string): string | undefined {
  return file.endsWith(".spec.ts") ? file.slice(0, -".spec.ts".length) + ".ts" : undefined;
}

async function latestSourceAuthor(
  gitlab: GitLabGateway,
  project: string | number,
  sourceFile: string,
  ref: string,
  signal?: AbortSignal,
): Promise<SourceAuthor> {
  try {
    const commits = await gitlab.listCommits(project, {
      ref,
      path: sourceFile,
      limit: 1,
      signal,
    });
    const email = commits[0]?.author_email?.trim().toLowerCase();
    if (!commits[0]) return { reason: `no commits were found for ${sourceFile}` };
    if (!email) return { reason: `the latest commit for ${sourceFile} has no author email` };
    return {
      email,
      reason: `the latest commit touching ${sourceFile} was found`,
    };
  } catch (err) {
    return {
      reason: `GitLab history for ${sourceFile} could not be read (${describeError(err)})`,
    };
  }
}

/**
 * Looks for a ticket that already covers this file, filed by anyone.
 *
 * Matched on a label carrying the file path rather than on summary text: a summary
 * is edited by whoever picks the ticket up, and a text search would then stop
 * matching and file a duplicate. A label survives editing and is exact.
 */
async function findExistingIssue(
  ctx: TaskContext,
  jira: JiraGateway,
  target: ResolvedTarget,
  group: FailureGroup,
  subjectKey: string,
): Promise<{ issueKey: string; assignee?: string } | undefined> {
  const label = fileLabel(group.file);
  const jql =
    `project = "${target.projectKey}" AND labels = "${label}" ` +
    `AND statusCategory != Done ORDER BY created DESC`;

  try {
    const issues = await jira.searchIssues(jql, {
      limit: 5,
      fields: ["summary", "status", "assignee"],
      signal: ctx.signal,
    });
    const issue = issues[0];
    return issue
      ? { issueKey: issue.key, assignee: jiraAssigneeLabel(issue) }
      : undefined;
  } catch (err) {
    // A failed search must not block filing: the subject row is the primary guard, and
    // refusing to file because a reconciliation query failed would mean a JQL
    // permission problem silently stops all reporting.
    ctx.logger.warn(
      { subject: subjectKey, err: String(err) },
      "could not search Jira for an existing ticket; relying on our own subject table",
    );
    return undefined;
  }
}

function jiraAssigneeLabel(issue: {
  fields?: {
    assignee?: {
      accountId?: string;
      displayName?: string;
      emailAddress?: string;
    } | null;
  };
}): string | undefined {
  const assignee = issue.fields?.assignee;
  return (
    assignee?.displayName?.trim() ||
    assignee?.emailAddress?.trim() ||
    assignee?.accountId?.trim() ||
    undefined
  );
}

/**
 * A file path as a Jira label.
 *
 * Jira rejects whitespace in labels and treats `/` awkwardly in JQL, so the path
 * is flattened. Prefixed so it cannot collide with a label someone applies by
 * hand.
 */
export function fileLabel(file: string): string {
  return `spec:${file.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
}

/** The flake thresholds, as configured on this instance. */
function flakeOptionsOf(config: Config): FlakeOptions {
  return {
    failuresBeforeFiling: config.failuresBeforeFiling,
    historyWindow: config.historyWindow,
    quarantineFlakeRate: config.quarantineFlakeRate,
    minObservations: config.minObservations,
  };
}

/**
 * The decision not to file, said out loud.
 *
 * Logged at info rather than debug: "nothing was filed tonight" is a claim an
 * operator will want to check, and the run row's `held` count points here.
 */
function heldOutcome(
  ctx: TaskContext,
  config: Config,
  group: FailureGroup,
  assessment: FlakeAssessment,
): FileOutcome {
  const reason =
    assessment.verdict === "flaky"
      ? `flaky: ${describeAssessment(assessment)}`
      : `${assessment.verdict}: needs ${config.failuresBeforeFiling} consecutive ` +
        `failure(s), has ${assessment.consecutiveFailures}`;

  ctx.logger.info(
    {
      file: group.file,
      verdict: assessment.verdict,
      consecutiveFailures: assessment.consecutiveFailures,
      observed: assessment.observed,
      failed: assessment.failed,
      quarantine: assessment.quarantine,
    },
    `not filing ${group.file} — ${reason}`,
  );

  return { file: group.file, action: "held", reason };
}

/** The audit trail the plan requires (§14): what we acted on, and from where. */
function auditMetadata(
  args: { group: FailureGroup; job: Job; pipeline: PipelineDetail; config: Config },
  action: string,
): Record<string, unknown> {
  return {
    action,
    // Shown as the Tracked table's "Title" column: the ticket's own summary,
    // not the raw subject key.
    title: titleOf(args.group, args.config.titlePrefix),
    file: args.group.file,
    tests: args.group.tests,
    suiteFailedToRun: args.group.suiteFailedToRun,
    pipelineId: args.pipeline.id,
    pipelineUrl: args.pipeline.web_url,
    jobId: args.job.id,
    jobName: args.job.name,
    jobUrl: args.job.web_url,
    ref: args.pipeline.ref,
    commit: args.pipeline.commit?.id,
  };
}

/**
 * Durable subject state, which the StateStore interface has no way to express —
 * it exposes claims and watermarks only. So the requirement is stated plainly
 * here rather than degraded silently: an in-memory store would let every run
 * refile every ticket, which is the exact failure this task exists to prevent.
 *
 * The full repository and not just `SubjectTracker`: this loop both closes
 * subjects (a resolved ticket frees its file) and opens them with the ticket it
 * just filed, neither of which a discoverer's narrow surface allows.
 */
function requireSubjectRepository(deps: CiFailureDeps): SubjectRepository {
  if (!deps.subjects) {
    throw new ConfigError(
      "gitlab-ci-failure requires a durable subject repository; the composition root " +
        "must provide one before the task can run.",
    );
  }
  return deps.subjects;
}

function requireConnectorFactory(deps: CiFailureDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      "gitlab-ci-failure requires connector gateways; the composition root must " +
        "provide them before the task can run.",
    );
  }
  return deps.connectors;
}
