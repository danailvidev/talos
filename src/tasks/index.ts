import type { TaskConnectorFactory } from "../application/gateways.ts";
import type {
  AutomationAiTriageRepository,
  AutomationConfigRepository,
  AutomationRepository,
  DatadogIssueRepository,
  DatadogAiTriageRepository,
  DatadogRoutingRepository,
  DatadogServiceTargetRepository,
  DeployWatchRepository,
  E2eTestConfig,
  JobRepository,
  NotificationRepository,
  LogRocketIssueRepository,
  PlanRepository,
  ReleaseConfig,
  ReleaseNotifier,
  RegressionTestRepository,
  ReviewRepository,
  RunRepository,
  TestRunHistoryRepository,
  SubjectRepository,
} from "../application/ports.ts";
import type { E2eArtifactRepository } from "../infrastructure/e2e/artifacts.ts";
import type { TaskRegistry } from "../core/registry.ts";
import { createCiFailureTask } from "./ci-failure/index.ts";
import { createDatadogScanTask } from "./datadog-scan/index.ts";
import { createCodeReviewTask } from "./code-review/index.ts";
import { createCustomLoopTargetTask, createCustomLoopTask } from "./custom-loop/index.ts";
import { createReviewJobTask } from "./code-review/review-job.ts";
import { exampleTask } from "./example.ts";
import {
  createFixJiraIssueTask,
  createFixJiraIssueWorkerTask,
} from "./fix-jira-issue/index.ts";
import {
  createJiraTicketToMrTask,
  createJiraTicketToMrWorkerTask,
} from "./jira-ticket-to-mr/index.ts";
import { createPlanJiraIssueTask } from "./plan-jira-issue/index.ts";
import { createResolveConflictsWorkerTask } from "./resolve-conflicts/index.ts";
import { createReviewRequestedTask } from "./review-requested/index.ts";
import {
  createMrFollowUpTask,
  createMrFollowUpWorkerTask,
} from "./mr-follow-up/index.ts";
import { createMrRevisionWorkerTask } from "./mr-revision/index.ts";
import { createReviewTicketTask } from "./review-ticket/index.ts";
import { createWriteRegressionTestTask } from "./write-regression-test/index.ts";
import { createDeployWatchTask } from "./deploy-watch/index.ts";
import { createTriageDatadogErrorTask } from "./triage-datadog-error/index.ts";
import { createReleaseRepoPollTask } from "./release-repo-poll/index.ts";
import { createReleasePipelineWatchTask } from "./release-pipeline-watch/index.ts";
import { createAutomationReportSyncTask } from "./automation-report-sync/index.ts";
import { createTriageAutomationFailureTask } from "./triage-automation-failure/index.ts";
import { createE2eTestTask } from "./e2e-test/index.ts";
import { createWriteE2eTestTask } from "./write-e2e-test/index.ts";

export interface TaskCatalogDeps {
  automationAiTriage?: AutomationAiTriageRepository;
  automationConfig?: AutomationConfigRepository;
  automation?: AutomationRepository;
  reviews?: ReviewRepository;
  connectors?: TaskConnectorFactory;
  /**
   * What each loop has already handled, and at what version.
   *
   * The full repository rather than `SubjectTracker`: `ci-failure` owns its
   * subjects' whole lifecycle (it closes one when Jira resolves the ticket), and
   * the discoverers take the narrow tracker view of the same object.
   */
  subjects?: SubjectRepository;
  /** Where a discoverer puts the work it found. */
  jobs?: JobRepository;
  /** Completed source runs used by follow-up jobs such as E2E test export. */
  runs?: RunRepository;
  /** Backs the topbar Bell — see `application/ports.ts`. */
  notifications?: NotificationRepository;
  /** Where the Datadog scan writes the issues it clusters out of the logs. */
  datadogIssues?: DatadogIssueRepository;
  /** Saved verdicts from optional Datadog AI triage runs. */
  datadogAiTriage?: DatadogAiTriageRepository;
  /** The rules that give those issues an owner, or drop them as noise. */
  datadogRouting?: DatadogRoutingRepository;
  /** Team repository/base-branch mappings for Datadog services. */
  datadogServiceTargets?: DatadogServiceTargetRepository;
  /**
   * Per-test pass/fail history, shared by every producer that reports test
   * results. Without it `gitlab-ci-failure` keeps its original behaviour of
   * filing on a spec's first failure, flakes included.
   */
  testRunHistory?: TestRunHistoryRepository;
  /** The issues a LogRocket alert recorded — read by the regression-test agent. */
  logRocketIssues?: LogRocketIssueRepository;
  /** Where an attempt at a regression test records what it established. */
  regressionTests?: RegressionTestRepository;
  /**
   * Implementation plans awaiting a human decision.
   *
   * The planning agent's whole product is a row here: the container writes
   * nothing, and approving the row is what queues the fix.
   */
  plans?: PlanRepository;
  /** One row per production release, and the signatures the watch found. */
  deployWatches?: DeployWatchRepository;
  /** Posts a found-a-new-error message to the team's release channel. */
  releaseNotifier?: ReleaseNotifier;
  /** The one instance-wide manifest repository external release polling reads. */
  releaseConfig?: () => ReleaseConfig | null;
  /** Execution-scoped screenshots and browser diagnostics. */
  e2eArtifacts?: E2eArtifactRepository;
  /** Live instance-wide file and instruction overrides for E2E runs. */
  e2eTestConfig?: () => E2eTestConfig;
  /** Shared read-only GitLab credential for E2E repository snapshots. */
  e2eCheckoutToken?: () => string;
}

/** Explicit code-first task manifest and the only built-in registration list. */
export function registerBuiltInTasks(
  registry: TaskRegistry,
  deps: TaskCatalogDeps = {},
): TaskRegistry {
  registry
    .register(exampleTask)
    .register(
      createAutomationReportSyncTask({
        connectors: deps.connectors,
        automationConfig: deps.automationConfig,
        automation: deps.automation,
      }),
    )
    .register(
      createTriageAutomationFailureTask({
        config: deps.automationConfig,
        automation: deps.automation,
        triage: deps.automationAiTriage,
        notifications: deps.notifications,
      }),
    )
    .register(
      createCiFailureTask({
        subjects: deps.subjects,
        testRunHistory: deps.testRunHistory,
        connectors: deps.connectors,
      }),
    )
    // The only definition a user can shape entirely from the console: everything
    // it does comes from the prompt and repositories they picked, so it needs no
    // dependency beyond the forge it checks out from.
    .register(createCustomLoopTask({ connectors: deps.connectors, jobs: deps.jobs }))
    .register(createCustomLoopTargetTask({ connectors: deps.connectors, jobs: deps.jobs }))
    .register(createCodeReviewTask({ reviews: deps.reviews, connectors: deps.connectors }))
    .register(createReviewJobTask({ reviews: deps.reviews, connectors: deps.connectors }))
    .register(
      createReviewRequestedTask({
        connectors: deps.connectors,
        subjects: deps.subjects,
        jobs: deps.jobs,
        notifications: deps.notifications,
      }),
    )
    .register(
      createMrFollowUpTask({
        connectors: deps.connectors,
        subjects: deps.subjects,
        jobs: deps.jobs,
      }),
    )
    .register(createMrFollowUpWorkerTask({ connectors: deps.connectors, jobs: deps.jobs }))
    // Human-driven, conversational revisions of an existing MR. Every turn is a
    // fresh queue job and container against the branch's latest head.
    .register(createMrRevisionWorkerTask({ connectors: deps.connectors }))
    // Handler only, with no discoverer in front of it: nothing rewrites a branch
    // on a timer, so the only thing that queues this is a developer's click.
    .register(
      createResolveConflictsWorkerTask({
        connectors: deps.connectors,
        notifications: deps.notifications,
      }),
    )
    .register(
      createJiraTicketToMrTask({
        connectors: deps.connectors,
        subjects: deps.subjects,
        jobs: deps.jobs,
      }),
    )
    // No subjects: the worker pool marks the ticket acted on when the job
    // succeeds, under the *loop's* id, which is the only place that knows it.
    .register(createJiraTicketToMrWorkerTask({ connectors: deps.connectors }))
    // Reads production Datadog logs and files confirmed regressions to Jira.
    // It never starts an agent: branches and merge requests remain explicit.
    .register(
      createDatadogScanTask({
        issues: deps.datadogIssues,
        routing: deps.datadogRouting,
        serviceTargets: deps.datadogServiceTargets,
        subjects: deps.subjects,
        connectors: deps.connectors,
      }),
    )
    .register(
      createFixJiraIssueTask({
        connectors: deps.connectors,
        notifications: deps.notifications,
        plans: deps.plans,
      }),
    )
    // The queued half of the same pipeline, for the graph's "Fix this issue"
    // button — see `createFixJiraIssueWorkerTask`. Also what an approved plan
    // queues, which is why it needs the plan store: to close the row it came from.
    .register(
      createFixJiraIssueWorkerTask({
        connectors: deps.connectors,
        notifications: deps.notifications,
        plans: deps.plans,
      }),
    )
    // The gated half of the same pipeline: writes a plan and stops. Handler only,
    // for the same reason as the fix — a plan is written when somebody asks for one
    // or when a loop configured to require one finds a ticket, never on a timer.
    .register(
      createPlanJiraIssueTask({
        connectors: deps.connectors,
        notifications: deps.notifications,
        plans: deps.plans,
      }),
    )
    // The ticket node's other action, and the only agent here that clones nothing:
    // it reads a Jira ticket and comments with the questions its requirements
    // leave open. Handler only — nothing should comment on a backlog on a timer.
    .register(
      createReviewTicketTask({
        connectors: deps.connectors,
        notifications: deps.notifications,
      }),
    )
    // Handler only, like the conflict resolver: a production error becomes a test
    // when somebody decides it should, never on a timer. An unattended loop over
    // an error list would open a merge request per signature.
    .register(
      createWriteRegressionTestTask({
        connectors: deps.connectors,
        notifications: deps.notifications,
        datadogIssues: deps.datadogIssues,
        logRocketIssues: deps.logRocketIssues,
        regressionTests: deps.regressionTests,
      }),
    )
    .register(
      createE2eTestTask({
        connectors: deps.connectors,
        artifacts: deps.e2eArtifacts,
        checkoutToken: deps.e2eCheckoutToken,
        config: deps.e2eTestConfig,
      }),
    )
    .register(
      createWriteE2eTestTask({
        connectors: deps.connectors,
        jobs: deps.jobs,
        runs: deps.runs,
        notifications: deps.notifications,
      }),
    )
    .register(
      createTriageDatadogErrorTask({
        issues: deps.datadogIssues,
        triage: deps.datadogAiTriage,
        notifications: deps.notifications,
      }),
    )
    // Handler only, and the one that requeues itself — see
    // `createDeployWatchTask`. `ReleaseApplicationService` raises the first job
    // when a production release opens; nothing else ever enqueues this kind.
    .register(
      createDeployWatchTask({
        connectors: deps.connectors,
        jobs: deps.jobs,
        notifications: deps.notifications,
        deployWatches: deps.deployWatches,
        logRocketIssues: deps.logRocketIssues,
        notifier: deps.releaseNotifier,
      }),
    )
    .register(
      createReleasePipelineWatchTask({
        connectors: deps.connectors,
        jobs: deps.jobs,
        notifications: deps.notifications,
      }),
    )
    .register(
      createReleaseRepoPollTask({
        connectors: deps.connectors,
        jobs: deps.jobs,
        deployWatches: deps.deployWatches,
        releaseConfig: deps.releaseConfig,
      }),
    );
  return registry;
}
