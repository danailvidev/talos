import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type {
  DatadogIssue,
  DatadogIssueRepository,
  LogRocketIssue,
  LogRocketIssueRepository,
  NotificationRepository,
  RegressionTestRepository,
  RegressionTestSource,
} from "../../application/ports.ts";
import type { FetchLike } from "../../connectors/http.ts";
import type { MergeRequest } from "../../connectors/gitlab/types.ts";
import { ConfigError } from "../../core/errors.ts";
import { mutate } from "../../core/step.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import {
  WRITE_REGRESSION_TEST_PROMPT_ID,
  runRegressionTestAgent,
  type RegressionTestAgentResult,
  type RegressionTestContext,
} from "./agent.ts";
import { regressionTestBranchName } from "./branch.ts";

/**
 * One production error to one merge request adding the test that covers it.
 *
 * A queue handler with no loop in front of it, like `fix-jira-issue-one`: the
 * button on the Datadog or LogRocket page enqueues it, so it inherits retry with
 * backoff, the dead-job brake and a row the graph can draw.
 *
 * The error is read from the store here rather than carried in the job's params.
 * A stack trace is thousands of characters and the queue is not a document store,
 * but the real reason is that a job leased twenty minutes later should work from
 * what the row says then — including the Jira key a click may have added in the
 * meantime.
 */

const DEFAULT_COMMIT = { name: "Talos", email: "talos@talos.local" };

const CommitSchema = z
  .object({
    name: z.string().min(1).default(DEFAULT_COMMIT.name),
    email: z.email().default(DEFAULT_COMMIT.email),
  })
  .default(DEFAULT_COMMIT);

const ConfigSchema = z.object({
  /** Which tracker the error came from, and which store to read it out of. */
  source: z.enum(["datadog", "logrocket"]),
  issueId: z.string().min(1),
  gitlab: z.object({
    /** `group/project` the test belongs in. Required — there is nothing to guess. */
    projectId: z.string().min(1),
    /** Branch to write the test against and merge into. */
    targetBranch: z.string().min(1).default("develop"),
  }),
  commit: CommitSchema,
});

type Config = z.infer<typeof ConfigSchema>;

export const WRITE_REGRESSION_TEST_TASK_ID = "write-regression-test";

/** How much stack trace the agent is shown. Enough to place the fault. */
const MAX_STACK_CHARS = 20_000;

/** Marks the merge requests this path opens, so they are findable as a set. */
const MR_LABEL = "regression test";

export interface WriteRegressionTestDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  notifications?: NotificationRepository;
  datadogIssues?: DatadogIssueRepository;
  logRocketIssues?: LogRocketIssueRepository;
  regressionTests?: RegressionTestRepository;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: typeof runRegressionTestAgent;
}

export function createWriteRegressionTestTask(
  deps: WriteRegressionTestDeps = {},
): Task<Config> {
  return {
    id: WRITE_REGRESSION_TEST_TASK_ID,
    name: "Write a regression test",
    description:
      "Reads one production error, finds the code path that produces it, and opens a merge request adding the test the repository is missing for it — as a draft when the test is red, because that means the bug is still live.",
    kind: "job",
    agent: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

async function run(
  ctx: TaskContext,
  config: Config,
  deps: WriteRegressionTestDeps,
): Promise<TaskResult> {
  const connectors = requireConnectorFactory(deps);
  const gitlab = connectors.gitlab(ctx, deps.fetch);
  const { source, issueId } = config;
  const projectId = config.gitlab.projectId;
  const targetBranch = config.gitlab.targetBranch;

  const error = await ctx.step("error", () => errorContext(deps, source, issueId));
  const branch = regressionTestBranchName(source, issueId, error.title);

  // A previous attempt may have pushed the branch, opened the merge request, or
  // both, and died before recording it — the same recovery `fix-jira-issue` does,
  // in the same order and for the same reason: the merge request is the expensive
  // half, so it is checked first and never duplicated.
  const existingMr = await ctx.step("existing-merge-request", () =>
    gitlab.listMergeRequests(projectId, {
      state: "all",
      sourceBranch: branch,
      limit: 1,
      signal: ctx.signal,
    }),
  );
  if (existingMr[0]) return adopt(ctx, deps, error, existingMr[0], branch);

  if (ctx.dryRun) {
    ctx.logger.info(
      { source, issueId, branch, title: error.title },
      `[dry-run] would attempt a regression test for ${error.title} and open a merge request from ${branch}`,
    );
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: { source, issueId, branch, title: error.title },
    };
  }

  await ctx.step("ensure-agent-image", () =>
    (deps.ensureImage ?? ensureAgentImage)(ctx.logger),
  );

  const agent = await ctx.step("write-test", () =>
    (deps.runAgent ?? runRegressionTestAgent)({
      executionId: ctx.executionId,
      project: projectId,
      baseBranch: targetBranch,
      pushBranch: branch,
      token: ctx.secrets.require("GITLAB_TOKEN"),
      error,
      commitName: ctx.actor?.name ?? config.commit.name,
      commitEmail: ctx.actor?.email ?? config.commit.email,
      ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
      ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
      promptTemplate: ctx.prompts[WRITE_REGRESSION_TEST_PROMPT_ID],
      signal: ctx.signal,
      logger: ctx.logger,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    }),
  );

  // The push decides whether there is anything to open, exactly as it does for
  // the fix agents: an agent that reports a verdict but wrote nothing has, in
  // fact, produced no test.
  if (!agent.pushedBranch) {
    return noChange(ctx, deps, error, agent);
  }

  const draft = agent.verdict !== "already-fixed";
  const mr = await mutate(
    ctx,
    `open a ${draft ? "draft " : ""}merge request from ${branch} in ${projectId}`,
    () =>
      gitlab.createMergeRequest(projectId, {
        sourceBranch: branch,
        targetBranch,
        title: agent.title ?? defaultTitle(error),
        description: mergeRequestDescription(error, agent),
        draft,
        removeSourceBranch: true,
        labels: [MR_LABEL, error.source],
        signal: ctx.signal,
      }),
    { source, issueId, branch, targetBranch, verdict: agent.verdict },
  );
  if (!mr) throw new ConfigError("merge request creation was unexpectedly suppressed");

  deps.regressionTests?.record({
    source,
    issueId,
    fingerprint: error.fingerprint,
    verdict: agent.verdict,
    summary: agent.summary,
    ...(agent.howVerified ? { howVerified: agent.howVerified } : {}),
    ...(agent.testFile ? { testFile: agent.testFile } : {}),
    mrIid: mr.iid,
    mrUrl: mr.web_url,
    branch,
    taskRunId: ctx.executionId,
  });

  ctx.logger.info(
    { source, issueId, verdict: agent.verdict, mrIid: mr.iid, webUrl: mr.web_url, branch },
    `opened ${draft ? "draft " : ""}!${mr.iid} with a regression test for ${error.title} (${agent.verdict})`,
  );

  deps.notifications?.create({
    kind: WRITE_REGRESSION_TEST_TASK_ID,
    title:
      agent.verdict === "reproduced"
        ? `Reproduced in a test: ${error.title}`
        : agent.verdict === "already-fixed"
          ? `Regression guard ready: ${error.title}`
          : `Needs a look: ${error.title}`,
    body: notificationBody(agent),
    link: mr.web_url,
    taskRunId: ctx.executionId,
  });

  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    notifiedIndividually: true,
    details: {
      source,
      issueId,
      action: "opened",
      verdict: agent.verdict,
      draft,
      mrIid: mr.iid,
      mrUrl: mr.web_url,
      branch,
      ...(agent.testFile ? { testFile: agent.testFile } : {}),
      commitSha: agent.commitSha,
    },
  };
}

/**
 * The agent wrote nothing — usually `not-reachable`, which is the answer this
 * feature exists to be able to give.
 *
 * A success, and recorded: the row is what stops the same button being pressed
 * every week on an error nothing in this repository can reach, and it carries the
 * agent's account of why so the next person does not repeat the search.
 */
function noChange(
  ctx: TaskContext,
  deps: WriteRegressionTestDeps,
  error: ErrorContext,
  agent: RegressionTestAgentResult,
): TaskResult {
  if (agent.verdict !== "not-reachable") {
    // Reported a test it did not leave behind. Worth a warning rather than a
    // failure: the run reached a conclusion, it just is not the one it claims.
    ctx.logger.warn(
      { source: error.source, issueId: error.issueId, verdict: agent.verdict },
      `agent reported "${agent.verdict}" but left no changes to push — treating it as no test written`,
    );
  }
  deps.regressionTests?.record({
    source: error.source,
    issueId: error.issueId,
    fingerprint: error.fingerprint,
    verdict: "not-reachable",
    summary: agent.summary,
    ...(agent.howVerified ? { howVerified: agent.howVerified } : {}),
    taskRunId: ctx.executionId,
  });
  ctx.logger.info(
    { source: error.source, issueId: error.issueId, summary: agent.summary },
    `no regression test written for ${error.title} — ${agent.summary}`,
  );
  deps.notifications?.create({
    kind: WRITE_REGRESSION_TEST_TASK_ID,
    title: `No test written: ${error.title}`,
    body: agent.summary,
    ...(error.source === "datadog" ? { link: "/datadog?tab=activity" } : {}),
    taskRunId: ctx.executionId,
  });
  // No test written means nothing was produced, so the run is a skip — a success
  // that says so, rather than a success claiming one processed item. `agentErrors`
  // records how much of the investigation behind that verdict failed.
  return {
    itemsSeen: 1,
    itemsProcessed: 0,
    itemsSkipped: 1,
    notifiedIndividually: true,
    details: {
      source: error.source,
      issueId: error.issueId,
      action: "no-change",
      verdict: "not-reachable",
      summary: agent.summary,
      ...(agent.toolErrors ? { agentErrors: agent.toolErrors } : {}),
    },
  };
}

/**
 * Reports the merge request a previous attempt already opened rather than running
 * the agent again — and a success, because the run's purpose is already true.
 */
function adopt(
  ctx: TaskContext,
  deps: WriteRegressionTestDeps,
  error: ErrorContext,
  mr: MergeRequest,
  branch: string,
): TaskResult {
  ctx.logger.info(
    { source: error.source, issueId: error.issueId, mrIid: mr.iid, state: mr.state, branch },
    `${error.title} already has !${mr.iid} from ${branch}; nothing to do`,
  );
  // Recorded even though this run wrote nothing: the merge request exists, and a
  // row that does not mention it would have the page offering the button again.
  // The verdict is whatever the earlier attempt stored, or the safe reading of an
  // open branch nobody has judged.
  const existing = deps.regressionTests?.get(error.source, error.issueId);
  deps.regressionTests?.record({
    source: error.source,
    issueId: error.issueId,
    fingerprint: error.fingerprint,
    verdict: existing?.verdict ?? "reproduced",
    ...(existing?.summary ? { summary: existing.summary } : {}),
    ...(existing?.howVerified ? { howVerified: existing.howVerified } : {}),
    ...(existing?.testFile ? { testFile: existing.testFile } : {}),
    mrIid: mr.iid,
    mrUrl: mr.web_url,
    branch,
    taskRunId: ctx.executionId,
  });
  return {
    itemsSeen: 1,
    itemsProcessed: 0,
    itemsSkipped: 1,
    details: {
      source: error.source,
      issueId: error.issueId,
      action: "adopted",
      mrIid: mr.iid,
      mrUrl: mr.web_url,
    },
  };
}

/** The agent's context plus the identity the record is keyed on. */
interface ErrorContext extends RegressionTestContext {
  fingerprint: string;
}

/**
 * The error, read out of whichever store owns it.
 *
 * The two sources are not equivalent and the shape says so. A Datadog row carries
 * a normalised signature and usually a stack trace; a LogRocket row carries a
 * title, a category and prose. Rather than pad LogRocket into looking like
 * Datadog, the absent fields are simply absent, and the prompt is written so an
 * agent with nothing to go on says `not-reachable` instead of guessing.
 */
async function errorContext(
  deps: WriteRegressionTestDeps,
  source: RegressionTestSource,
  issueId: string,
): Promise<ErrorContext> {
  if (source === "datadog") {
    const store = deps.datadogIssues;
    if (!store) {
      throw new ConfigError(
        `${WRITE_REGRESSION_TEST_TASK_ID} needs the Datadog issue store; the composition root must provide it.`,
      );
    }
    const issue = store.get(issueId);
    if (!issue) throw new ConfigError(`No Datadog issue ${issueId}.`);
    return fromDatadog(issue);
  }

  const store = deps.logRocketIssues;
  if (!store) {
    throw new ConfigError(
      `${WRITE_REGRESSION_TEST_TASK_ID} needs the LogRocket issue store; the composition root must provide it.`,
    );
  }
  const issue = store.get(issueId);
  if (!issue) throw new ConfigError(`No LogRocket issue ${issueId}.`);
  return fromLogRocket(issue);
}

function fromDatadog(issue: DatadogIssue): ErrorContext {
  return {
    source: "datadog",
    issueId: issue.id,
    fingerprint: issue.fingerprint,
    title: issue.problemTitle ?? issue.title,
    signature: issue.signature,
    ...(issue.service ? { service: issue.service } : {}),
    ...(issue.env ? { env: issue.env } : {}),
    ...(issue.sampleMessage ? { sampleMessage: issue.sampleMessage } : {}),
    ...(issue.sampleStack ? { sampleStack: clampStack(issue.sampleStack) } : {}),
    // Labelled as an estimate on purpose: these counts are extrapolated from a
    // sample, and an agent handed "1,709,618" as a fact will reason about a
    // number talos made up.
    occurrences:
      `≈${(issue.problemEventCount ?? issue.eventCount).toLocaleString()} in the scan window — ` +
      `estimated from ${issue.sampleCount} of ${issue.sampleSize} sampled log bodies`,
    firstSeenAt: issue.firstSeenAt.toISOString(),
    lastSeenAt: issue.lastSeenAt.toISOString(),
    ...(issue.jiraIssueKey ? { jiraIssueKey: issue.jiraIssueKey } : {}),
  };
}

function fromLogRocket(issue: LogRocketIssue): ErrorContext {
  const notes = [issue.description, issue.summary, issue.userImpact].filter(
    (note): note is string => !!note,
  );
  return {
    source: "logrocket",
    issueId: issue.id,
    fingerprint: issue.fingerprint,
    title: issue.title,
    ...(issue.issueType ? { service: issue.issueType } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(issue.sessionCount != null
      ? { occurrences: `${issue.sessionCount.toLocaleString()} affected session(s)` }
      : {}),
    ...(issue.firstSeenAt ? { firstSeenAt: issue.firstSeenAt.toISOString() } : {}),
    lastSeenAt: issue.lastAlertAt.toISOString(),
    ...(issue.url ? { url: issue.url } : {}),
    ...(issue.jiraIssueKey ? { jiraIssueKey: issue.jiraIssueKey } : {}),
  };
}

function defaultTitle(error: ErrorContext): string {
  const title = `test: cover ${error.title}`;
  return title.length > 200 ? `${title.slice(0, 199)}…` : title;
}

/**
 * The merge request body.
 *
 * The verdict goes at the top in plain words, because it is the only thing a
 * reviewer must not misread: a draft whose test is red on purpose looks exactly
 * like a broken branch until somebody says which it is.
 */
function mergeRequestDescription(
  error: ErrorContext,
  agent: RegressionTestAgentResult,
): string {
  const lines: string[] = [];
  lines.push(
    agent.verdict === "reproduced"
      ? "**This test fails on purpose.** It reproduces an error still happening in " +
          "production, so it is red against the current target branch. Fix the bug on " +
          "this branch, or merge the test only once the fix lands — do not merge it as is."
      : agent.verdict === "already-fixed"
        ? "**This test passes.** The error it covers is not reproducible against the " +
          "current target branch, so this is a guard against it coming back rather than " +
          "a bug report."
        : "**The agent could not tie this error to a code path**, but left changes " +
          "behind anyway. Read the diff before anything else — the verdict and the " +
          "contents disagree, and that is worth knowing about.",
  );
  lines.push("");
  if (agent.description) lines.push(agent.description.trim(), "");
  lines.push(`Error: ${error.title}`);
  if (error.service) lines.push(`Service: ${error.service}`);
  if (error.occurrences) lines.push(`Seen: ${error.occurrences}`);
  if (error.url) lines.push(`In ${error.source === "datadog" ? "Datadog" : "LogRocket"}: ${error.url}`);
  if (agent.testFile) lines.push(`Test file: ${agent.testFile}`);
  if (agent.howVerified) lines.push("", `Verified: ${agent.howVerified.trim()}`);
  lines.push(
    "",
    "---",
    "",
    `Written by Talos from ${error.source === "datadog" ? "Datadog" : "LogRocket"} ` +
      `error ${error.issueId}. It adds a test and changes no production code; every line ` +
      "of it still needs a human review.",
  );
  return lines.join("\n");
}

function notificationBody(agent: RegressionTestAgentResult): string {
  return agent.testFile ? `${agent.testFile} — ${agent.summary}` : agent.summary;
}

function clampStack(stack: string): string {
  return stack.length > MAX_STACK_CHARS ? `${stack.slice(0, MAX_STACK_CHARS)}\n…` : stack;
}

function requireConnectorFactory(deps: WriteRegressionTestDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${WRITE_REGRESSION_TEST_TASK_ID} requires connector gateways; the composition root must provide them.`,
    );
  }
  return deps.connectors;
}
