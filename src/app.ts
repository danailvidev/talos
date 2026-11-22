import { LoopApplicationService } from "./application/loop-service.ts";
import { createAppAbility } from "../shared/authorization.ts";
import { dirname, join } from "node:path";

import type {
  AgentAccountRepository,
  AgentUsageRepository,
  AutomationAiTriageRepository,
  AutomationConfigRepository,
  AutomationFailureAssigneeRepository,
  AutomationRepository,
  CredentialRepository,
  E2eTestConfigRepository,
  FixIssueDefaultsRepository,
  PreferenceRepository,
  GeneralConfigRepository,
  InstanceRepository,
  IntegrationConfigRepository,
  JobRepository,
  DatadogIssueRepository,
  DatadogAiTriageRepository,
  DatadogRoutingRepository,
  DatadogServiceTargetRepository,
  DeploymentVerifier,
  DeployWatchRepository,
  FeedbackRepository,
  LogRocketIssueRepository,
  NotificationRepository,
  PlanRepository,
  PromptTemplateRepository,
  PullRequestRepoFilterRepository,
  RegressionTestRepository,
  ReleaseConfigRepository,
  ReviewRepository,
  RunRepository,
  ScheduleRepository,
  SlackConnectionRepository,
  TestRunHistoryRepository,
  SubjectRepository,
  WebhookRepository,
} from "./application/ports.ts";
import { AssignedTicketService } from "./application/assigned-tickets.ts";
import { AgentRunPreferences } from "./application/agent-run-preferences.ts";
import { AssistantApplicationService } from "./application/assistant-service.ts";
import { DashboardApplicationService } from "./application/dashboards/service.ts";
import { AssistantCapabilityStore } from "./application/assistant-capabilities.ts";
import { TicketDetailService } from "./application/ticket-detail.ts";
import { CancellationService } from "./application/cancellation-service.ts";
import { AgentOrchestrationService } from "./application/agent-orchestration-service.ts";
import { CheckpointSuspensionService } from "./application/checkpoint-suspension-service.ts";
import { PromptsApplicationService } from "./application/prompts-service.ts";
import { PullRequestApplicationService } from "./application/pull-request-service.ts";
import { SlackReleaseNotifier } from "./application/release-notifier.ts";
import { ReleaseApplicationService } from "./application/release-service.ts";
import { SlackInboxService } from "./application/slack-inbox-service.ts";
import { SlackActivityEventHub } from "./application/slack-activity-events.ts";
import { SettingsApplicationService } from "./application/settings-service.ts";
import { AuthService } from "./auth.ts";
import { RoleService } from "./roles.ts";
import type { Actor } from "./core/actor.ts";
import { TaskApplicationService } from "./application/task-service.ts";
import { TaskExecutor } from "./core/executor.ts";
import { loadInstances } from "./core/instantiate.ts";
import { TaskRegistry } from "./core/registry.ts";
import { TtlCache } from "./core/ttl-cache.ts";
import { loadConfig, type LoadedConfig } from "./config/load.ts";
import { loadRuntimeConfig, type RuntimeConfig } from "./config/runtime.ts";
import {
  resolveAllScheduledTasks,
  type ScheduledTask,
} from "./config/resolve-schedule.ts";
import { importLegacyWorkflows } from "./config/import-legacy-workflows.ts";
import {
  resolveGeneralSettings,
  type GeneralSettings,
} from "./config/resolve-settings.ts";
import {
  resolvePromptTemplates,
  type ResolvedPromptTemplates,
} from "./config/resolve-prompts.ts";
import {
  createLogger,
  registerSecretValues,
  type LogLevel,
  type Logger,
} from "./logging/logger.ts";
import { createExecutionLogCapture } from "./logging/capture.ts";
import { ApplicationLogBuffer } from "./logging/application-logs.ts";
import { taskConnectorFactory } from "./connectors/task-factory.ts";
import { PULL_REQUEST_PROVIDERS } from "./connectors/pull-request-registry.ts";
import { createGitLabClient, type GitLabClient } from "./connectors/gitlab/client.ts";
import {
  GitLabIssuePublisher,
  type FeedbackIssuePublisher,
} from "./connectors/gitlab/issues.ts";
import { createJiraClient, type JiraClient } from "./connectors/jira/client.ts";
import { createKubernetesDeploymentVerifier } from "./connectors/kubernetes/client.ts";
import { runClaudeChat, type ClaudeChatOptions } from "./infrastructure/agent/chat.ts";
import { stopAgentContainers } from "./infrastructure/agent/index.ts";
import { cancelConfiguredJob } from "./infrastructure/agent/execution.ts";
import {
  E2eArtifactStore,
  S3E2eArtifactStore,
  type E2eArtifactRepository,
} from "./infrastructure/e2e/artifacts.ts";
import { openDatabase } from "./persistence/database.ts";
import { SqliteConfigStore } from "./persistence/config-store.ts";
import {
  DisabledCredentialStore,
  SqliteCredentialStore,
} from "./persistence/credential-store.ts";
import { AgentLoginManager } from "./infrastructure/agent/login.ts";
import { setAgentRuntimeAuth } from "./infrastructure/agent/run.ts";
import { setAgentUsageRecorder } from "./infrastructure/agent/usage.ts";
import { SqliteAgentAccountStore } from "./persistence/agent-account-store.ts";
import { SqliteAgentUsageStore } from "./persistence/agent-usage-store.ts";
import { SqliteGeneralConfigStore } from "./persistence/general-config-store.ts";
import { SqliteInstanceStore } from "./persistence/instance-store.ts";
import { SqliteIntegrationConfigStore } from "./persistence/integration-config-store.ts";
import { SqliteJobQueue } from "./persistence/job-queue.ts";
import { SqliteDaemonLease } from "./persistence/daemon-lease.ts";
import { SqliteNotificationStore } from "./persistence/notification-store.ts";
import { SqliteSlackConnectionStore } from "./persistence/slack-connection-store.ts";
import { SqlitePromptTemplateStore } from "./persistence/prompt-template-store.ts";
import { SqliteFixIssueDefaultsStore } from "./persistence/fix-issue-defaults-store.ts";
import { SqlitePreferenceStore } from "./persistence/preference-store.ts";
import { SqlitePullRequestRepoFilterStore } from "./persistence/pull-request-repo-filter-store.ts";
import { SqliteLogRocketIssueStore } from "./persistence/logrocket-issue-store.ts";
import { SqliteDatadogIssueStore } from "./persistence/datadog-issue-store.ts";
import { SqliteDatadogAiTriageStore } from "./persistence/datadog-ai-triage-store.ts";
import { SqliteDatadogRoutingStore } from "./persistence/datadog-routing-store.ts";
import { SqliteDatadogServiceTargetStore } from "./persistence/datadog-service-target-store.ts";
import { SqliteFeedbackStore } from "./persistence/feedback-store.ts";
import { SqliteDashboardStore } from "./persistence/dashboard-store.ts";
import { SqliteReleaseConfigStore } from "./persistence/release-config-store.ts";
import { SqlitePlanStore } from "./persistence/plan-store.ts";
import { SqliteRegressionTestStore } from "./persistence/regression-test-store.ts";
import { SqliteDeployWatchStore } from "./persistence/deploy-watch-store.ts";
import { SqliteE2eTestConfigStore } from "./persistence/e2e-test-config-store.ts";
import { SqliteTestRunHistoryStore } from "./persistence/test-run-history-store.ts";
import { SqliteSubjectStore } from "./persistence/subject-store.ts";
import { SqliteWebhookStore } from "./persistence/webhook-store.ts";
import {
  SqliteAutomationConfigStore,
  SqliteAutomationStore,
} from "./persistence/automation-store.ts";
import { SqliteAutomationAiTriageStore } from "./persistence/automation-ai-triage-store.ts";
import { SqliteAutomationFailureAssigneeStore } from "./persistence/automation-failure-assignee-store.ts";
import { SqliteTaskSink } from "./persistence/sqlite-task-sink.ts";
import { SqliteOrchestrationStore } from "./persistence/orchestration-store.ts";
import { SqliteCheckpointStore } from "./persistence/checkpoint-store.ts";
import { configureAgentHostCapacity } from "./infrastructure/agent/index.ts";
import {
  configureAgentInstallation,
  DockerAgentRuntime,
} from "./infrastructure/agent/containers.ts";
import { HostProcessRuntime } from "./infrastructure/agent/host-runtime.ts";
import { SqliteStateStore } from "./persistence/sqlite-state-store.ts";
import type { StateStore } from "./persistence/state-store.ts";
import { ReviewLedger } from "./persistence/review-ledger.ts";
import { actorIdentitySecretStore } from "./secrets/actor-secrets.ts";
import { createCipher } from "./secrets/crypto.ts";
import { loadEnvFile } from "./secrets/env-file.ts";
import { OverlaySecretStore } from "./secrets/integration-secrets.ts";
import {
  EnvSecretStore,
  type PresenceSecretStore,
  type SecretStore,
} from "./secrets/secret-store.ts";
import {
  registerBuiltInTasks,
} from "./tasks/index.ts";

export interface GlobalFlags {
  config?: string;
  /** Overrides `config/.env`. */
  envFile?: string;
  logLevel?: LogLevel;
  dryRun?: boolean;
}

interface CreateAppOptions extends GlobalFlags {
  /** Long-lived daemons move log writes off the request/heartbeat event loop. */
  backgroundLogWriter?: boolean;
  /** Test seam; production creates an actor-scoped publisher for each submission. */
  feedbackIssuePublisher?: FeedbackIssuePublisher;
  /** Test seam for public-origin and executor behavior without mutating process.env. */
  runtime?: RuntimeConfig;
}

/** The application services and repositories used by the web API and workers. */
export interface App {
  loaded: LoadedConfig;
  runtime: RuntimeConfig;
  logger: Logger;
  /** Bounded, already-redacted process logs exposed only by the admin API. */
  applicationLogs: ApplicationLogBuffer;
  /**
   * The shared, non-per-user secrets: the stored integration settings layered
   * over `config/.env` (see `secrets/integration-secrets.ts`). A run on a
   * developer's behalf layers their own tokens on top of this again.
   */
  secrets: PresenceSecretStore;
  /** Just the environment layer, for reporting what the *file* provides. */
  env: EnvSecretStore;
  state: StateStore;
  sink: RunRepository;
  configStore: ScheduleRepository;
  generalConfigStore: GeneralConfigRepository;
  promptTemplateStore: PromptTemplateRepository;
  automationConfig: AutomationConfigRepository;
  automation: AutomationRepository;
  /** Latest read-only AI verdict for each Automation failure cluster. */
  automationAiTriage: AutomationAiTriageRepository;
  /** Talos owner for each durable Automation failure signature. */
  automationFailureAssignees: AutomationFailureAssigneeRepository;
  /** User-created named instances of an "instantiable" task definition. */
  instances: InstanceRepository;
  /**
   * Pending and finished units of work. A loop enqueues; the worker pool in
   * `serve` leases and runs. Distinct from `instances`, which is configuration a
   * human created — see `core/job.ts` for why conflating the two was the problem.
   */
  jobs: JobRepository;
  /** Screenshots and browser diagnostics produced by QA E2E jobs. */
  e2eArtifacts: E2eArtifactRepository;
  /** Instance-wide file and instruction overrides for QA E2E jobs. */
  e2eTestConfig: E2eTestConfigRepository;
  daemonLease: SqliteDaemonLease;
  /** What each loop has already seen and acted on, and at what version. */
  subjects: SubjectRepository;
  /**
   * Registered GitLab webhook endpoints, their deliveries, and the queue of
   * loops a delivery has given news to. The scheduler drains that queue; see
   * `api/webhooks.ts` for what fills it.
   */
  webhooks: WebhookRepository;
  /** Backs the topbar Bell — see `application/ports.ts`. */
  notifications: NotificationRepository;
  /**
   * Per-developer GitLab/Jira tokens, encrypted. Disabled — empty and refusing
   * writes — when TALOS_SECRET_KEY is unset.
   */
  credentials: CredentialRepository;
  /** Per-developer Slack OAuth identity and inbox-local selections/read state. */
  slackConnections: SlackConnectionRepository;
  slackActivityEvents: SlackActivityEventHub;
  /**
   * The AI agent accounts each developer has connected — their ChatGPT plan, their
   * Claude subscription, an API key they pay for themselves. Usable without
   * TALOS_SECRET_KEY for the accounts whose credential stays with the vendor;
   * see `SqliteAgentAccountStore`.
   */
  agentAccounts: AgentAccountRepository;
  /** Immutable provider-reported token usage for actor-attributed invocations. */
  agentUsage: AgentUsageRepository;
  /** Vendor logins in flight — the vendor CLI's output, relayed to the browser. */
  agentLogins: AgentLoginManager;
  /** Which repositories each developer's Team MRs tab is narrowed to. */
  pullRequestRepoFilters: PullRequestRepoFilterRepository;
  /** Where each developer's "Fix this issue" click opens its merge request. */
  fixIssueDefaults: FixIssueDefaultsRepository;
  /**
   * How each developer has set the console up — the sprint the graph opens on, the
   * merge request states the list shows, and their agent-run defaults. Typed
   * server-side preferences are read through adapters such as `AgentRunPreferences`.
   */
  preferences: PreferenceRepository;
  /** Per-developer model and effort defaults for manually initiated agent work. */
  agentRunPreferences: AgentRunPreferences;
  /** Instance-wide repo/manifest/branch the Releases page reads and edits. */
  releaseConfig: ReleaseConfigRepository;
  /**
   * Instance-wide GitLab/Jira/LogRocket settings that override `config/.env`,
   * as edited under Settings → Integrations.
   */
  integrationConfig: IntegrationConfigRepository;
  /**
   * Frontend issues LogRocket pushed to `/webhooks/logrocket`. A table rather
   * than a client call because LogRocket has no endpoint that lists issues —
   * see `LogRocketIssueRepository`.
   */
  logRocketIssues: LogRocketIssueRepository;
  /**
   * Problems the daily Datadog scan clustered out of the error logs. A table
   * because deriving it costs a fan-out over millions of log lines, and because
   * it carries state Datadog does not hold — see `DatadogIssueRepository`.
   */
  datadogIssues: DatadogIssueRepository;
  /** Saved, explainable AI classifications for Datadog errors. */
  datadogAiTriage: DatadogAiTriageRepository;
  /** How a Datadog issue gets an owning team, and how known noise is dropped. */
  datadogRouting: DatadogRoutingRepository;
  /** GitLab repository and base branch for each Datadog service. */
  datadogServiceTargets: DatadogServiceTargetRepository;
  /**
   * Per-test pass/fail history, shared by every producer that reports test
   * results -- how `gitlab-ci-failure` tells a flake from a regression, see
   * `TestRunHistoryRepository`. Also backs the Flaky specs page, which is the
   * same data read the other way round.
   */
  testRunHistory: TestRunHistoryRepository;
  /**
   * Attempts at turning a production error into a test in the repository -- the
   * link from "this error" to "the branch that covers it", which nothing else
   * records. See `RegressionTestRepository`.
   */
  regressionTests: RegressionTestRepository;
  /**
   * Implementation plans an agent wrote and a human decides on before any code is
   * written -- the quality gate in front of `fix-jira-issue`. See `PlanRepository`.
   */
  plans: PlanRepository;
  /**
   * One row per production release, and the error signatures the post-deploy
   * watch found in it that were not there beforehand. See `DeployWatchRepository`.
   */
  deployWatches: DeployWatchRepository;
  /** Live, read-only Kubernetes status used by the Releases page. */
  deploymentVerifier: DeploymentVerifier;
  /** Messages submitted from the footer's feedback link. */
  feedback: FeedbackRepository;
  /** Creates an issue publisher that can use only this developer's GitLab PAT. */
  feedbackIssuesFor(actor: Actor): FeedbackIssuePublisher;
  taskRegistry: TaskRegistry;
  loops: LoopApplicationService;
  executor: TaskExecutor;
  tasks: TaskApplicationService;
  cancellations: CancellationService;
  orchestration: AgentOrchestrationService;
  checkpointSuspension: CheckpointSuspensionService;
  settingsAdmin: SettingsApplicationService;
  promptsAdmin: PromptsApplicationService;
  /**
   * Open pull/merge requests across every configured forge, read as whoever
   * asked. Backs the console's Pull requests page — no persistence, because a
   * pull request's home is the forge.
   */
  pullRequests: PullRequestApplicationService;
  /**
   * The tickets assigned to whoever asked, read live from Jira with their own
   * token. The roots of the ticket graph — see `application/assigned-tickets.ts`.
   */
  assignedTickets: AssignedTicketService;
  /**
   * One of those tickets in full, when a developer clicks it: description,
   * conversation, links, subtasks, attachments. Its own service rather than a
   * method on the list for the reason in `application/ticket-detail.ts` — the list
   * is one bulk search and this is a call per ticket.
   */
  ticketDetails: TicketDetailService;
  /** Live Slack inbox scoped to the requesting developer's OAuth connection. */
  slackInbox: SlackInboxService;
  /** Private dashboard specs and the query engine behind them. */
  dashboards: DashboardApplicationService;
  /** Read-only, actor-scoped data surface exposed to the connected chat agent. */
  assistant: AssistantApplicationService;
  /** Ephemeral bearer capabilities used only by the internal assistant MCP route. */
  assistantCapabilities: AssistantCapabilityStore;
  /** Connected-account Claude runner; exposed for API-level dependency injection in tests. */
  runAssistantChat(options: ClaudeChatOptions): Promise<void>;
  /**
   * Reads and edits the releases manifest in the configured repo, as whoever
   * asked. Backs the console's Releases page — a direct GitLab API sequence,
   * not a queued agent run.
   */
  releases: ReleaseApplicationService;
  auth: AuthService;
  roles: RoleService;
  /**
   * Short-lived coalescing in front of the forge reads the console's GET routes
   * make. Read only through `api/cached.ts`, which is what keeps every key scoped
   * to the caller — see the note on `CacheScope` for why that is not optional.
   *
   * An instance rather than a module singleton on purpose: the API tests build an
   * app per suite, and a singleton would carry one suite's entries into the next
   * and produce cross-test flakes that read like real bugs.
   */
  responseCache: TtlCache;
  /**
   * Shared-credential clients are reserved for install-originated actions such
   * as filing an issue from an inbound Datadog/LogRocket alert. User-facing
   * reads and pickers use the strict per-user factories below.
   */
  sharedGitLab(): GitLabClient;
  sharedJira(): JiraClient;
  /** Strict per-user clients for interactive API reads and pickers. */
  gitLabFor(actor: Actor): GitLabClient;
  jiraFor(actor: Actor): JiraClient;
  /** Called by `PUT /api/settings/integrations`, after the new values are stored. */
  resetSharedClients(): void;
  dryRun: boolean;
  schemaVersion: number;
  scheduledTasks(): ScheduledTask[];
  scheduledTask(id: string): ScheduledTask | undefined;
  /** An account as a run's actor, by id. Null for an account since removed. */
  actorFor(userId: string): Actor | undefined;
  /**
   * Whose identity a scheduled tick of this loop uses: the owner of the
   * instance. Undefined for a code-registered loop or a public instance nobody
   * owns, which then runs on the shared credentials.
   */
  actorForTask(taskId: string): Actor | undefined;
  /** The effective general settings — DB overrides layered over the YAML defaults. */
  settings(): GeneralSettings;
  /**
   * Re-reads stored schedule config after a write, so output reflects the
   * change. Also re-scans `instances` so a task instance created moments ago
   * (e.g. via the API) shows up without restarting the process, and re-applies
   * `settings().logLevel` to the live logger so a settings edit takes effect
   * without a restart.
   */
  refresh(): void;
  close(): void;
}

export async function createApp(flags: CreateAppOptions = {}): Promise<App> {
  const loaded = await loadConfig(flags.config);

  // Before the store snapshots the environment: Bun only auto-loads a root .env,
  // and the plan keeps secrets in config/.
  const env = await loadEnvFile(flags.envFile);
  const runtime = flags.runtime ?? loadRuntimeConfig();

  // Secrets are constructed before the logger so their values seed the scrubber.
  const envSecrets = new EnvSecretStore();

  const { db, applied, version } = openDatabase(loaded.databasePath);
  const orchestrationStore = new SqliteOrchestrationStore(db);
  const checkpointStore = new SqliteCheckpointStore(db);

  // No key, no encrypted values at rest. Deriving one from something always
  // present would produce values that look encrypted and are not; see
  // `DisabledCredentialStore` and `crypto.ts`.
  const masterKey = envSecrets.get("TALOS_SECRET_KEY");
  const cipher = masterKey ? createCipher(masterKey) : null;

  // Before the logger, like the environment store: a token an operator saved in
  // the UI has to seed the scrubber too, or it appears verbatim in a log line.
  const integrationConfig = new SqliteIntegrationConfigStore(db, cipher);
  const secrets = new OverlaySecretStore(envSecrets, () => integrationConfig.all());

  const notifications = new SqliteNotificationStore(db);
  // The registry does not exist yet — `taskRegistry` is assigned below, and the
  // sink only calls this closure once a run finishes, well after that happens.
  let taskRegistry: TaskRegistry | undefined;
  const sink = new SqliteTaskSink(
    db,
    notifications,
    (taskId) => taskRegistry?.get(taskId)?.name,
    flags.backgroundLogWriter ? loaded.databasePath : undefined,
  );

  // Logger is created after the sink so its tee can persist per-run lines.
  const applicationLogs = new ApplicationLogBuffer();
  const logger = createLogger({
    level: flags.logLevel ?? loaded.config.logLevel,
    secretValues: secrets.values(),
    tee: [createExecutionLogCapture(sink), applicationLogs.stream],
  });
  const orchestration = new AgentOrchestrationService(
    orchestrationStore,
    logger,
    {
      runtimes: [
        new HostProcessRuntime(),
        ...(runtime.executor === "docker" ? [new DockerAgentRuntime()] : []),
      ],
    },
  );
  configureAgentInstallation(orchestration.installationId());
  configureAgentHostCapacity(orchestration);
  const checkpointSuspension = new CheckpointSuspensionService(
    checkpointStore,
    orchestration,
    { providers: [] },
  );

  // Names only — the scrubber protects log *values*, but a name list needs no
  // protection and is what makes "why is my token missing" answerable.
  logger.debug(
    {
      path: env.path,
      found: env.found,
      applied: env.applied,
      overrode: env.overrode,
      skipped: env.skipped,
    },
    env.found
      ? `loaded ${env.applied.length} variable(s) from ${env.path}`
      : `no env file at ${env.path}`,
  );

  // Louder than debug, because this is the case that cost an afternoon: the
  // environment and the file disagreed, and the resulting 401 pointed at neither.
  // The file wins, so say which names it took over rather than leaving the
  // operator to wonder why a token they exported had no effect.
  if (env.overrode.length > 0) {
    logger.info(
      { path: env.path, names: env.overrode },
      `${env.path} overrode ${env.overrode.length} environment variable(s): ` +
        env.overrode.join(", "),
    );
  }

  for (const migration of applied) {
    logger.info(
      { version: migration.version, name: migration.name },
      `applied migration ${migration.version}: ${migration.name}`,
    );
  }

  const state = new SqliteStateStore(db);
  const configStore = new SqliteConfigStore(db);
  const generalConfigStore = new SqliteGeneralConfigStore(db);
  const promptTemplateStore = new SqlitePromptTemplateStore(db);
  const automationConfig = new SqliteAutomationConfigStore(db);
  const automation = new SqliteAutomationStore(db);
  const automationAiTriage = new SqliteAutomationAiTriageStore(db);
  const automationFailureAssignees = new SqliteAutomationFailureAssigneeStore(db);
  const instances = new SqliteInstanceStore(db);
  const reviews = new ReviewLedger(db);
  const jobs = new SqliteJobQueue(db);
  const daemonLease = new SqliteDaemonLease(db);
  const subjects = new SqliteSubjectStore(db);
  const webhooks = new SqliteWebhookStore(db);
  const roles = new RoleService(db);
  const auth = new AuthService(db, roles, runtime.secureCookies);

  const credentials: CredentialRepository = cipher
    ? new SqliteCredentialStore(db, cipher)
    : new DisabledCredentialStore();
  const slackActivityEvents = new SlackActivityEventHub();
  const slackConnections = new SqliteSlackConnectionStore(
    db,
    cipher,
    (userId, conversationId) =>
      slackActivityEvents.publish({
        userId,
        ...(conversationId ? { conversationId } : {}),
      }),
  );
  if (!cipher) {
    logger.debug(
      "TALOS_SECRET_KEY is not set; runs use the shared credentials and " +
        "per-developer tokens cannot be stored",
    );
  }
  // Beside the database rather than under the operator's own home: these are the
  // vendors' credential directories for accounts this install manages, so they
  // belong with the install's state and move with it.
  const agentAccounts = new SqliteAgentAccountStore(db, cipher);
  const agentUsage = new SqliteAgentUsageStore(db);
  const agentLogins = new AgentLoginManager(
    agentAccounts,
    join(dirname(loaded.databasePath), "agent-homes"),
    logger,
  );
  // Resolved per run rather than captured here, so connecting an account or
  // rotating its key takes effect on the next run instead of the next restart --
  // the same reason the credential store decrypts on read.
  // Keyed by the run's actor: each developer's work runs on the agent account they
  // connected, and a loop nobody owns runs on the account of whichever user owns it
  // -- the dedicated system account, for the system's own loops.
  setAgentRuntimeAuth((provider, userId) =>
    userId ? agentAccounts.runtimeCredential(userId, provider) : undefined,
  );
  setAgentUsageRecorder((record) => {
    const usage = record.usage;
    agentUsage.record({
      userId: record.userId,
      ...(record.accountId ? { accountId: record.accountId } : {}),
      accountLabel: record.accountLabel,
      ...(record.optionId ? { optionId: record.optionId } : {}),
      authSource: record.authSource,
      provider: record.provider,
      ...(usage?.model ? { model: usage.model } : {}),
      source: record.source,
      ...(record.executionId ? { executionId: record.executionId } : {}),
      ...(record.invocationLabel ? { invocationLabel: record.invocationLabel } : {}),
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      ...(usage?.durationMs != null ? { durationMs: usage.durationMs } : {}),
      ...(usage?.turns != null ? { turns: usage.turns } : {}),
      ...(usage
        ? {
            tokens: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadInputTokens: usage.cacheReadInputTokens,
              cacheCreationInputTokens: usage.cacheCreationInputTokens,
            },
          }
        : {}),
    });
  });
  const pullRequestRepoFilters = new SqlitePullRequestRepoFilterStore(db);
  const fixIssueDefaults = new SqliteFixIssueDefaultsStore(db);
  const preferences = new SqlitePreferenceStore(db);
  const agentRunPreferences = new AgentRunPreferences(preferences, (userId) => {
    const account = agentAccounts.runtimeAccount(userId, "claude");
    return account
      ? { provider: "claude", optionId: account.optionId }
      : undefined;
  });
  const releaseConfig = new SqliteReleaseConfigStore(db);
  const logRocketIssues = new SqliteLogRocketIssueStore(db);
  const datadogIssues = new SqliteDatadogIssueStore(db);
  const datadogAiTriage = new SqliteDatadogAiTriageStore(db);
  const datadogRouting = new SqliteDatadogRoutingStore(db);
  const datadogServiceTargets = new SqliteDatadogServiceTargetStore(db);
  const testRunHistory = new SqliteTestRunHistoryStore(db);
  const regressionTests = new SqliteRegressionTestStore(db);
  const plans = new SqlitePlanStore(db);
  const deployWatches = new SqliteDeployWatchStore(db);
  const e2eTestConfig = new SqliteE2eTestConfigStore(db, cipher);
  const e2eArtifacts: E2eArtifactRepository = runtime.s3
    ? new S3E2eArtifactStore(runtime.s3)
    : new E2eArtifactStore(join(dirname(loaded.databasePath), "e2e-artifacts"));
  const deploymentVerifier = createKubernetesDeploymentVerifier();
  // Instance-wide, not the acting developer's — see `SlackReleaseNotifierDeps`
  // for why, and shared by the release upload path and the deploy-watch job so
  // both post as the same app under the same discipline.
  const releaseNotifier = new SlackReleaseNotifier({ secrets, logger });
  const feedback = new SqliteFeedbackStore(db);

  const actorFor = (userId: string): Actor | undefined =>
    auth.byId(userId) ?? undefined;

  /**
   * Work with an actor must never borrow another account's provider identity.
   * Instance-wide endpoints and board configuration still come from `secrets`;
   * GitLab/Jira credentials come only from this developer's encrypted rows.
   */
  const identitySecretsForActor = (actor: Actor): SecretStore => {
    const own = credentials.all(actor.id);
    registerSecretValues(Object.values(own));
    return actorIdentitySecretStore(secrets, actor, own);
  };
  const feedbackIssuesFor = (actor: Actor): FeedbackIssuePublisher =>
    flags.feedbackIssuePublisher ??
    new GitLabIssuePublisher({
      secrets: identitySecretsForActor(actor),
      project: Bun.env.TALOS_FEEDBACK_GITLAB_PROJECT?.trim() || "example-org/tools/talos",
      logger,
    });

  taskRegistry = registerBuiltInTasks(new TaskRegistry(), {
    automationAiTriage,
    automationConfig,
    automation,
    reviews,
    connectors: taskConnectorFactory,
    subjects,
    jobs,
    runs: sink,
    notifications,
    datadogIssues,
    datadogAiTriage,
    datadogRouting,
    datadogServiceTargets,
    testRunHistory,
    logRocketIssues,
    regressionTests,
    plans,
    deployWatches,
    releaseNotifier,
    releaseConfig: () => releaseConfig.get(),
    e2eArtifacts,
    e2eTestConfig: () => e2eTestConfig.get(),
    // Repository archives require read_repository/api scope. The UI-stored
    // integration token may intentionally be read_api-only, so checkout uses
    // the installation credential that was configured for host automation.
    e2eCheckoutToken: () => envSecrets.require("GITLAB_TOKEN"),
  });
  loadInstances(taskRegistry, instances);
  const dryRun = flags.dryRun ?? false;

  let generalSettings: GeneralSettings = resolveGeneralSettings(
    loaded,
    generalConfigStore.get(),
  );
  let promptTemplates: ResolvedPromptTemplates = resolvePromptTemplates(
    promptTemplateStore.get(),
  );

  const executor = new TaskExecutor({
    logger,
    state,
    secrets,
    sink,
    getLlm: (actor, scope) =>
      agentRunPreferences.resolve(generalSettings.llm, actor, scope),
    getPrompts: (taskId: string) => {
      // Check if this is a task instance with a prompt override
      const instance = instances.get(taskId);
      if (instance?.promptTemplate) {
        // Find which prompt ID this definition uses
        const { promptIdForDefinition } = require("./tasks/prompt-registry.ts");
        const promptId = promptIdForDefinition(instance.definitionId);
        if (promptId) {
          // Return the global templates with this one overridden
          return { ...promptTemplates, [promptId]: instance.promptTemplate };
        }
      }
      return promptTemplates;
    },
    secretsFor: (actor) => identitySecretsForActor(actor),
  });

  // Resolution is cached rather than recomputed per lookup, so a single command
  // cannot report two different effective values. `refresh()` is the one way to
  // invalidate it.
  let resolved: ScheduledTask[] = [];
  let byId = new Map<string, ScheduledTask>();

  // Configuration-table triggers increment this one scalar for local and CLI
  // writes alike. Logs, jobs and run-history writes deliberately do not.
  let lastRefreshRevision: number | undefined;
  const configurationRevision = (): number =>
    db.query<{ revision: number }, []>(
      "SELECT revision FROM configuration_revision WHERE singleton = 1",
    ).get()?.revision ?? 0;
  const refresh = () => {
    const revision = configurationRevision();
    if (revision === lastRefreshRevision) return;
    loadInstances(taskRegistry, instances);
    resolved = resolveAllScheduledTasks(taskRegistry, configStore);
    byId = new Map(resolved.map((t) => [t.id, t]));

    generalSettings = resolveGeneralSettings(loaded, generalConfigStore.get());
    promptTemplates = resolvePromptTemplates(promptTemplateStore.get());
    // Pino's level is a plain writable property, so a settings edit takes
    // effect on the very next log call — no restart, no re-creating the logger.
    if (logger.level !== generalSettings.logLevel) {
      logger.level = generalSettings.logLevel;
    }
    // Read this after refresh work in case instance loading performed a local
    // migration/import write; otherwise the next request would rebuild once.
    lastRefreshRevision = configurationRevision();
  };
  importLegacyWorkflows({
    db,
    schedules: configStore,
    registry: taskRegistry,
    workflows: loaded.config.workflows,
    logger,
  });
  refresh();
  const tasks = new TaskApplicationService({
    jobs,
    registry: taskRegistry,
    executor,
    runs: sink,
    schedules: configStore,
    instances,
    subjects,
    state,
    scheduledTask: (id) => byId.get(id),
    refresh,
    dryRun,
  });
  const cancellations = new CancellationService({
    runs: sink,
    jobs,
    executor,
    logger,
    notifications,
    cleanup: {
      stop: async (executionId) => {
        await Promise.all([
          orchestration.stopExecution(executionId),
          stopAgentContainers({
            executionId,
            pruneDanglingImages: true,
          }),
          cancelConfiguredJob(executionId),
        ]);
      },
    },
  });
  const settingsAdmin = new SettingsApplicationService(
    generalConfigStore,
    refresh,
  );
  const promptsAdmin = new PromptsApplicationService(promptTemplateStore, refresh);
  const pullRequests = new PullRequestApplicationService({
    providers: PULL_REQUEST_PROVIDERS,
    secretsFor: identitySecretsForActor,
    repoFilterFor: (actor) => pullRequestRepoFilters.list(actor.id),
    logger,
  });
  const assignedTickets = new AssignedTicketService({
    secretsFor: identitySecretsForActor,
    logger,
  });
  const ticketDetails = new TicketDetailService({
    secretsFor: identitySecretsForActor,
    logger,
  });
  const slackInbox = new SlackInboxService({
    connections: slackConnections,
    preferences,
    secrets,
    logger,
  });
  const releases = new ReleaseApplicationService({
    secretsFor: identitySecretsForActor,
    config: () => releaseConfig.get(),
    // `secrets`, not the actor's store: the announcing app and channel are a team
    // setting, and SLACK_BOT_TOKEN being in ACTOR_SECRETS would otherwise let a
    // personal token decide who the channel sees posting.
    notifier: releaseNotifier,
    logger,
    deployWatches,
    jobs,
  });
  const loops = new LoopApplicationService({
    registry: taskRegistry, instances, tasks,
    scheduledTask: (id) => byId.get(id), refresh,
    transaction: (work) => db.transaction(work)(),
    access: (actor) => {
      const user = auth.byId(actor.id);
      const ability = createAppAbility(user?.permissions ?? []);
      return {
        read: Boolean(user && auth.profile(actor.id)?.accountStatus === "active" && ability.can("read", "Loop")),
        manage: ability.can("manage", "Task"),
      };
    },
  });
  const gitLabFor = (actor: Actor) => createGitLabClient(identitySecretsForActor(actor));
  const jiraFor = (actor: Actor) => createJiraClient(identitySecretsForActor(actor));
  const dashboards = new DashboardApplicationService(new SqliteDashboardStore(db), {
    jiraFor,
    gitLabFor,
    pullRequests,
    automationConfig,
    automation,
    instances,
    runs: sink,
    scheduledTasks: () => resolved,
    taskName: (id) => taskRegistry.get(id)?.name,
    agentUsage,
    datadogIssues,
    logRocketIssues,
    testRunHistory,
  });
  const assistant = new AssistantApplicationService({
    loops,
    secretsFor: identitySecretsForActor,
    sharedSecrets: secrets,
    logger,
    pullRequests,
    assignedTickets,
    ticketDetails,
    releases,
    taskRegistry,
    scheduledTasks: () => resolved,
    instances,
    runs: sink,
    datadogIssues,
    logRocketIssues,
    notifications,
    dashboards,
    permissionsFor: (actor) => auth.byId(actor.id)?.permissions ?? [],
  });
  const assistantCapabilities = new AssistantCapabilityStore();

  /**
   * A loop's own owner, never a fallback to some other account. A public loop
   * nobody owns runs on the shared credentials, which is honest; picking an
   * arbitrary developer's token would not be.
   */
  const actorForTask = (taskId: string): Actor | undefined => {
    const ownerId = instances.get(taskId)?.ownerId;
    return ownerId ? actorFor(ownerId) : undefined;
  };

  // Bounded because its keys are per user and per merge request: an unbounded map
  // in a process that runs for weeks is a slow leak. 500 is roughly "every open
  // merge request of every developer on a team", which is the working set.
  const responseCache = new TtlCache({ max: 500 });

  // Lazily built and held until the integration settings change — see the docblock
  // on `sharedGitLab` for why this is not the response cache in disguise.
  let sharedGitLab: GitLabClient | undefined;
  let sharedJira: JiraClient | undefined;
  return {
    loaded,
    runtime,
    logger,
    applicationLogs,
    secrets,
    env: envSecrets,
    state,
    sink,
    configStore,
    generalConfigStore,
    promptTemplateStore,
    automationConfig,
    automation,
    automationAiTriage,
    automationFailureAssignees,
    instances,
    jobs,
    e2eArtifacts,
    e2eTestConfig,
    daemonLease,
    subjects,
    webhooks,
    notifications,
    credentials,
    slackConnections,
    slackActivityEvents,
    agentAccounts,
    agentUsage,
    agentLogins,
    pullRequestRepoFilters,
    fixIssueDefaults,
    preferences,
    agentRunPreferences,
    releaseConfig,
    integrationConfig,
    logRocketIssues,
    datadogIssues,
    datadogAiTriage,
    datadogRouting,
    datadogServiceTargets,
    testRunHistory,
    regressionTests,
    plans,
    deployWatches,
    deploymentVerifier,
    feedback,
    feedbackIssuesFor,
    taskRegistry,
    executor,
    tasks,
    cancellations,
    orchestration,
    checkpointSuspension,
    settingsAdmin,
    promptsAdmin,
    pullRequests,
    assignedTickets,
    ticketDetails,
    slackInbox,
    releases,
    dashboards,
    assistant,
    assistantCapabilities,
    loops,
    runAssistantChat: runClaudeChat,
    auth,
    roles,
    responseCache,
    gitLabFor,
    jiraFor,
    sharedGitLab: () => (sharedGitLab ??= createGitLabClient(secrets)),
    sharedJira: () => (sharedJira ??= createJiraClient(secrets)),
    resetSharedClients: () => {
      sharedGitLab = undefined;
      sharedJira = undefined;
    },
    dryRun,
    schemaVersion: version,
    scheduledTasks: () => resolved,
    scheduledTask: (id) => byId.get(id),
    actorFor,
    actorForTask,
    settings: () => generalSettings,
    refresh,
    close: () => {
      // Before the database, and not only for tidiness: an entry holds a promise
      // that may still be reading, and leaving them behind an app that has closed
      // its database is how a test suite ends up serving the previous suite's data.
      responseCache.clear();
      assistantCapabilities.clear();
      sink.close();
      configureAgentHostCapacity(undefined);
      configureAgentInstallation(undefined);
      db.close();
    },
  };
}
