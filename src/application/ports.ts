import type { FormatChange } from "../../shared/release-format.ts";
import type { FeedbackType } from "../../shared/api-contract.ts";
import type { Trigger } from "../config/schema.ts";
import type {
  TaskExecutionRecord,
  TaskExecutionSink,
} from "../core/executor.ts";
import type { Job, JobQueue, JobStatus } from "../core/job.ts";
import type { JobControlState } from "../core/orchestration.ts";
import type { RunStatus, StepRecord } from "../core/step.ts";
import type { TriggerQueue } from "../core/webhook.ts";
import type {
  OpenSubjectInput,
  SubjectTracker,
  WorkSubject,
  WorkSubjectState,
} from "../core/subject.ts";
import type { ExecutionLogLine } from "../logging/capture.ts";
import type { LogLevel } from "../logging/logger.ts";

// `IssueRepository` used to live here: one table per feature, `filed_issues`,
// answering "is there already a ticket for this spec file". It answered the same
// question `work_subjects` answers for every loop, so it is gone and
// `SubjectRepository` below is what `ci-failure` files against. See migration 20.

export interface ReviewedMergeRequest {
  taskId: string;
  projectId: string;
  mrIid: number;
  sha: string;
  noteUrl?: string;
  reviewedAt: Date;
}

export interface RecordReviewInput {
  taskId: string;
  projectId: string;
  mrIid: number;
  sha: string;
  noteUrl?: string;
}

export interface ReviewRepository {
  lastReviewedSha(taskId: string, projectId: string, mrIid: number): string | null;
  record(input: RecordReviewInput): ReviewedMergeRequest;
  all(taskId: string): ReviewedMergeRequest[];
}

// Re-exported so callers that already depend on this module do not need to know
// which of the two files a subject type is declared in.
export type {
  ObserveSubjectInput,
  OpenSubjectInput,
  WorkSubject,
  WorkSubjectState,
} from "../core/subject.ts";

/**
 * `SubjectTracker` plus the reads and the lifecycle transition that only an
 * owner should reach. See `core/subject.ts` for why the write surface is split.
 */
export interface SubjectRepository extends SubjectTracker {
  findOpen(loopId: string, subjectKey: string): WorkSubject | null;
  /** Finds the live subject that produced one external Jira/MR reference. */
  findOpenByExternalRef(loopId: string, externalRef: string): WorkSubject | null;
  /**
   * Opens a subject for something that already exists outside — a filed Jira
   * ticket, an adopted one. Returns null when another run already holds the open
   * subject for that key: the partial unique index refused the insert, which is
   * a fact the caller has to act on rather than an error to raise.
   */
  open(input: OpenSubjectInput): WorkSubject | null;
  /**
   * Always an observation of the outside world — the MR was merged, the ticket
   * was resolved — never inferred from our own success, which is why the worker
   * pool cannot call it.
   */
  close(loopId: string, subjectKey: string, reason?: string): void;
  history(loopId: string, subjectKey: string): WorkSubject[];
  openSubjects(loopId: string, limit?: number, offset?: number): WorkSubject[];
  openSubjectsFor(loopIds: readonly string[], limitPerLoop?: number): Map<string, WorkSubject[]>;
  countByState(loopId: string): Record<WorkSubjectState, number>;
  /** Open-subject counts for a visible task-list page. */
  openCounts(loopIds: readonly string[]): Map<string, number>;
  clearLoop(loopId: string): void;
}

/** A stored credential, described without its value. */
export interface StoredCredential {
  userId: string;
  name: string;
  updatedAt: Date;
}

/**
 * Per-developer credentials, encrypted at rest.
 *
 * The read surface is split by intent rather than by convenience: `all` returns
 * decrypted values and exists solely to build one run's `SecretStore`, while
 * `list` returns names and timestamps and is what the API and CLI show. Keeping
 * them separate means "let the operator see whose tokens are stored" can never
 * accidentally become "let the operator read them".
 */
export interface CredentialRepository {
  /** Decrypted, for building an actor's secret store. Never send this anywhere. */
  all(userId: string): Record<string, string>;
  get(userId: string, name: string): string | undefined;
  /** Names and timestamps only — safe to serialise. */
  list(userId: string): StoredCredential[];
  set(userId: string, name: string, value: string): void;
  /** False when there was nothing stored under that name. */
  delete(userId: string, name: string): boolean;
  /** Whether values can be stored at all — false without an encryption key. */
  readonly enabled: boolean;
}

/** A Slack OAuth connection as it is safe to return to the browser. */
export interface StoredSlackConnection {
  userId: string;
  /** Monotonic store version used to reject stale token refreshes. */
  connectionVersion: number;
  teamId: string;
  teamName?: string;
  slackUserId: string;
  slackUserName?: string;
  scopes: string[];
  connectedAt: Date;
  updatedAt: Date;
  unreadable?: boolean;
}

/** The same connection with the credentials needed for a live Slack read. */
export interface SlackConnectionCredential extends StoredSlackConnection {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface SaveSlackConnectionInput {
  userId: string;
  teamId: string;
  teamName?: string;
  slackUserId: string;
  slackUserName?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

export interface SlackConversationActivity {
  conversationId: string;
  latestTs: string;
  threadTs?: string;
  updatedAt: Date;
}

export interface SlackConversationMetadata {
  conversationId: string;
  kind: "dm" | "group-dm" | "channel";
  name: string;
  avatarUrl?: string;
  /** The other Slack user in a 1:1 DM. Absent for group DMs and channels. */
  peerUserId?: string;
  app?: boolean;
  private: boolean;
  updatedAt: Date;
}

/**
 * Per-user Slack identity, inbox choices and TALOS-only read positions.
 *
 * Message bodies deliberately do not appear here: the inbox reads them live
 * from Slack and retains only enough local state to know what each user selected
 * and has already reviewed.
 */
export interface SlackConnectionRepository {
  readonly secretsEnabled: boolean;
  connectedUserIds(): string[];
  describe(userId: string): StoredSlackConnection | undefined;
  credential(userId: string): SlackConnectionCredential | undefined;
  save(input: SaveSlackConnectionInput): StoredSlackConnection;
  saveIfUnchanged(
    input: SaveSlackConnectionInput,
    expectedVersion: number,
  ): StoredSlackConnection | undefined;
  delete(userId: string): boolean;
  selectedChannels(userId: string): string[];
  setSelectedChannels(userId: string, channelIds: readonly string[]): void;
  conversations(userId: string): SlackConversationMetadata[];
  replaceConversations(
    userId: string,
    conversations: readonly Omit<SlackConversationMetadata, "updatedAt">[],
  ): void;
  upsertConversation(
    userId: string,
    conversation: Omit<SlackConversationMetadata, "updatedAt">,
  ): void;
  removeConversation(userId: string, conversationId: string): boolean;
  clearConversations(userId: string): void;
  activities(userId: string): Map<string, SlackConversationActivity>;
  recordUserActivity(
    userId: string,
    conversationId: string,
    latestTs: string,
    threadTs?: string,
  ): boolean;
  seedUserActivity(userId: string, conversationId: string, latestTs: string): void;
  recordWorkspaceActivity(input: {
    teamId: string;
    slackUserIds: readonly string[];
    conversationId: string;
    conversationType: "im" | "mpim" | "channel" | "group";
    latestTs: string;
    threadTs?: string;
  }): string[];
  activityRevision(userId: string): number;
  unreadActivityCount(userId: string): number;
  clearActivities(userId: string): void;
  readCursors(userId: string): Map<string, string>;
  readCursor(userId: string, conversationId: string): string | undefined;
  baselineReadCursor(userId: string, conversationId: string, timestamp: string): void;
  markRead(userId: string, conversationId: string, timestamp: string): void;
  createOAuthState(userId: string, browserNonce: string, ttlMs?: number): string;
  consumeOAuthState(state: string, browserNonce: string): string | undefined;
}

/** One connected AI agent account, described without its credential. */
export interface StoredAgentAccount {
  id: string;
  userId: string;
  provider: string;
  /** What the developer called it — "work ChatGPT", "personal Max plan". */
  label: string;
  method: "key" | "cli";
  /** The catalog option it was created through, e.g. `claude:key-oauth`. */
  optionId: string;
  /**
   * For `key` accounts: which variables are set, without their values — the
   * names alone (`AWS_REGION`, `AWS_ACCESS_KEY_ID`) say what was filled in.
   */
  envNames?: string[];
  /** For `cli` accounts: the config directory the vendor's CLI wrote into. */
  homeDir?: string;
  /** The identity the vendor reported, when it reported one. */
  account?: string;
  /** A stored secret this process can no longer decrypt. See `StoredIntegrationSetting`. */
  unreadable?: boolean;
  /**
   * Whether this developer's agent runs use this account: at most one per
   * (developer, provider). Not install-wide — a run authenticates as whoever it
   * is for. See migration 48.
   */
  usedForRuns?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** What a run needs to actually use one connected account. */
export interface AgentAccountCredential {
  /**
   * For `key` accounts — every variable the option asked for, ready to hand to
   * the agent: `{ OPENAI_API_KEY: "sk-…" }` for one that needs a key,
   * `{ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: …, … }` for one that needs a
   * cloud endpoint. Empty for `cli` ones, whose credential is in `homeDir`.
   */
  env: Record<string, string>;
  /** For `cli` accounts — the directory to mount as the agent's home. */
  homeDir?: string;
}

/**
 * The AI agent accounts each developer has connected — their ChatGPT plan, their
 * Claude subscription, an API key they pay for themselves.
 *
 * Split by intent like `CredentialRepository`, and for the same reason:
 * `credential` decrypts and exists only to set up one run, while `list` returns
 * metadata and is what the API and the loop form show. Nothing that serialises
 * can reach a token.
 *
 * Why this is not just `CredentialRepository` with more names: that table is
 * keyed by secret name, so it holds exactly one `OPENAI_API_KEY` per person and
 * has nowhere to put a label. Someone with a personal and a work plan is the
 * normal case here. See migration 47.
 */
export interface AgentAccountRepository {
  list(userId: string): StoredAgentAccount[];
  get(userId: string, id: string): StoredAgentAccount | undefined;
  /** Decrypted, for building one run's environment. Never send this anywhere. */
  credential(userId: string, id: string): AgentAccountCredential | undefined;
  /**
   * The account *this developer's* runs should use for this provider, decrypted —
   * their row flagged `usedForRuns`. Undefined when they have connected nothing,
   * which is what makes the runner fall back to the host's own login.
   *
   * Per developer because that is what a run is: whoever clicked Run, or the owner
   * of the loop that ticked, and their work bills to their own plan. A shared
   * account is expressed by pointing the system user's loops at one, not by a
   * global setting.
   *
   * Throws rather than returning undefined when the flagged account cannot be
   * decrypted: falling back would quietly bill the wrong account, which is worse
   * than a run that fails saying so.
   */
  runtimeCredential(
    userId: string,
    provider: string,
  ): (AgentAccountCredential & { id: string; label: string; optionId: string }) | undefined;
  /**
   * The same account as metadata, without decrypting anything — for a page that
   * needs to know whether this developer's runs still fall back to the host's
   * login.
   */
  runtimeAccount(userId: string, provider: string): StoredAgentAccount | undefined;
  /** Moves this developer's `usedForRuns` flag for the provider onto this account. */
  useForRuns(userId: string, id: string): StoredAgentAccount | undefined;
  /**
   * Creates or replaces the account with this label. `values` is the whole set of
   * variables the option asked for, encrypted together; passing any without an
   * encryption key throws, rather than storing a token in plaintext beside the
   * agent that uses it.
   */
  save(account: {
    userId: string;
    provider: string;
    label: string;
    method: "key" | "cli";
    optionId: string;
    values?: Record<string, string>;
    homeDir?: string;
    account?: string;
  }): StoredAgentAccount;
  /** False when there was no such account. */
  delete(userId: string, id: string): boolean;
  /** Whether credentials can be stored at all — false without an encryption key. */
  readonly secretsEnabled: boolean;
}

export type AgentUsageSource = "task" | "assistant" | "e2e";
export type AgentUsageStatus = "success" | "failed" | "cancelled";
export type AgentUsageAuthSource = "connected" | "host";

export interface AgentUsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** One immutable invocation record. No prompt, response, tool input, or credential is retained. */
export interface AgentUsageEvent {
  id: string;
  userId: string;
  accountId?: string;
  accountLabel: string;
  optionId?: string;
  authSource: AgentUsageAuthSource;
  provider: string;
  model?: string;
  source: AgentUsageSource;
  executionId?: string;
  invocationLabel?: string;
  status: AgentUsageStatus;
  startedAt: Date;
  finishedAt: Date;
  durationMs?: number;
  turns?: number;
  tokens?: AgentUsageTokens;
}

export interface AgentUsageBreakdown {
  key: string;
  label: string;
  invocations: number;
  knownUsageInvocations: number;
  tokens: AgentUsageTokens;
}

export interface AgentUsageReport {
  totals: AgentUsageBreakdown;
  daily: Array<{ date: string; tokens: AgentUsageTokens; invocations: number }>;
  accounts: AgentUsageBreakdown[];
  models: AgentUsageBreakdown[];
  sources: AgentUsageBreakdown[];
  events: AgentUsageEvent[];
  eventCount: number;
}

export interface AgentUsageRepository {
  record(event: Omit<AgentUsageEvent, "id">): AgentUsageEvent;
  report(
    /** Undefined is the administrator-only global report; API routes enforce that boundary. */
    userId: string | undefined,
    filter: {
      from: Date;
      to: Date;
      account?: string;
      source?: AgentUsageSource;
      limit: number;
      offset: number;
    },
  ): AgentUsageReport;
}

/** One stored integration setting, described without its value when it is secret. */
export interface StoredIntegrationSetting {
  name: string;
  updatedAt: Date;
  /**
   * The stored value, for non-secret fields only (a site URL, an account
   * email). Undefined for a token — the read surface simply cannot produce one,
   * so no handler can leak one by forgetting to strip it.
   */
  value?: string;
  /**
   * A secret this process cannot decrypt — `TALOS_SECRET_KEY` has changed or
   * gone since it was saved. Reported rather than hidden: the value is stored
   * and yet not in effect, and "set it again" is the only fix.
   */
  unreadable?: boolean;
}

/**
 * Instance-wide overrides for the integration settings that otherwise come from
 * `config/.env` — the GitLab token, the Jira site/account/token, the LogRocket
 * API key.
 *
 * Instance-wide rather than per-user (that is `CredentialRepository`): these are
 * the shared account the whole install falls back to, and what an operator
 * edits in Settings → Integrations instead of shelling into the host to edit a
 * file and restart.
 *
 * Split by intent exactly like `CredentialRepository`: `all` returns decrypted
 * values and exists only to back a `SecretStore`, while `list` is what the API
 * shows. Secret values are encrypted with `TALOS_SECRET_KEY`; without it
 * `secretsEnabled` is false and only the non-secret fields can be written,
 * because storing a token in plaintext beside the loop that uses it is worse
 * than refusing to store it.
 */
export interface IntegrationConfigRepository {
  /** Decrypted, by secret name. Never send this anywhere. */
  all(): Record<string, string>;
  /** Names, timestamps, and non-secret values — safe to serialise. */
  list(): StoredIntegrationSetting[];
  /** An empty or whitespace-only value clears the override instead of storing it. */
  set(name: string, value: string): void;
  /** False when there was nothing stored under that name. */
  delete(name: string): boolean;
  /** Whether *secret* fields can be stored — false without an encryption key. */
  readonly secretsEnabled: boolean;
}

/**
 * One frontend issue LogRocket alerted us about.
 *
 * Most fields are optional because every one of them is LogRocket's to omit —
 * the alert payload is a webhook body, not a typed API response, and an issue
 * with a title and nothing else is still worth showing.
 */
export interface LogRocketIssue {
  id: string;
  /** Stable across re-alerts for the same issue. Derived, not sent — see the store. */
  fingerprint: string;
  appId?: string;
  /** LogRocket's category, e.g. `Error`, `Rage Click`, `Network Failure`. */
  issueType?: string;
  title: string;
  label?: string;
  description?: string;
  /** LogRocket's own AI summary of the issue, when the plan includes one. */
  summary?: string;
  userImpact?: string;
  /** Deep link into LogRocket. The one thing a person always wants from a row. */
  url?: string;
  screenshotUrl?: string;
  sessionCount?: number;
  /** Sessions per minute, as LogRocket measured it at alert time. */
  sessionRate?: number;
  firstSeenAt?: Date;
  lastAlertAt: Date;
  /** How many alerts have landed for this issue, including the first. */
  alertCount: number;
  state: "open" | "linked" | "dismissed";
  jiraIssueKey?: string;
  jiraFiledAt?: Date;
}

/** An Issue Alert delivery, already parsed out of the webhook body. */
export interface RecordLogRocketIssueInput {
  appId?: string;
  issueType?: string;
  title: string;
  label?: string;
  description?: string;
  summary?: string;
  userImpact?: string;
  url?: string;
  screenshotUrl?: string;
  sessionCount?: number;
  sessionRate?: number;
  firstSeenAt?: Date;
  /** The raw delivery, kept verbatim. */
  payload: unknown;
}

/**
 * The LogRocket issues talos has been told about.
 *
 * This is a list because LogRocket has no endpoint that returns one: there is no
 * "list issues" or "list sessions" API, only alerts pushed to a webhook. So the
 * page reads this table rather than LogRocket, and an issue exists here from the
 * moment it first alerts.
 */
export interface LogRocketIssueRepository {
  /** Inserts, or folds a repeat alert into the row it belongs to. */
  record(input: RecordLogRocketIssueInput): LogRocketIssue;
  /** Newest alert first. Dismissed issues are excluded unless asked for. */
  list(options?: { includeDismissed?: boolean; limit?: number }): LogRocketIssue[];
  /**
   * Issues first seen in this inclusive window, regardless of their triage state.
   *
   * The deploy watcher needs first occurrence rather than latest alert: a known
   * issue firing again after a release is not a newly introduced regression.
   */
  firstSeenBetween(from: Date, to: Date): LogRocketIssue[];
  get(id: string): LogRocketIssue | undefined;
  /** Records the Jira ticket filed for an issue and moves it to `linked`. */
  link(id: string, jiraIssueKey: string): LogRocketIssue | undefined;
  setState(id: string, state: "open" | "dismissed"): LogRocketIssue | undefined;
}

/** How urgent a Datadog issue is, worst first. Computed — see `datadog-triage.ts`. */
export type DatadogSeverity = "critical" | "high" | "medium" | "low";

/**
 * Which kind of thing broke, and therefore roughly who fixes it.
 *
 * Coarse on purpose. A precise taxonomy would need a source of truth this
 * install does not have (there is no `team` tag in the logs), and "is this ours
 * or the platform's" is the question a triage list actually has to answer.
 */
export type DatadogArea = "frontend" | "backend" | "infrastructure" | "data" | "unknown";

/**
 * One clustered problem found in Datadog logs: a service plus an error shape.
 *
 * Not a log line, and not a Datadog object either — there is no id in Datadog to
 * point at. Error Tracking would have supplied one, but it indexes nothing for
 * this org, so a row here is the result of our own aggregation and clustering
 * (`connectors/datadog/signature.ts`) and the fingerprint is derived.
 *
 * The counts deserve care. `eventCount` is an *estimate*: the scan counts every
 * matching log for a service exactly, then samples a bounded page of bodies to
 * find out what shapes they take, and scales. So "≈1.7M" is honest and "1,709,618
 * occurrences of this exact error" would not be. `sampleCount` keeps the number
 * the estimate was extrapolated from, because a cluster seen twice in 200 samples
 * is a much weaker claim than one seen 180 times.
 */
export interface DatadogIssue {
  id: string;
  /** sha256 of service + signature. Stable across scans, which is what folds them. */
  fingerprint: string;
  /** Datadog `service` facet. Undefined for logs that carry none. */
  service?: string;
  /** The normalised error shape, with ids and paths replaced by placeholders. */
  signature: string;
  title: string;
  /**
   * The root cause this signature belongs to, shared with the other log lines one
   * failure emits. See `application/datadog-problems.ts`.
   *
   * Recomputed every scan and not stable across them: it groups a scan's rows and
   * identifies nothing. Undefined on rows written before problem grouping existed.
   */
  problemKey?: string;
  /** The member signature that best describes the whole problem. */
  problemTitle?: string;
  /**
   * The problem's estimate: the largest member's count, never the sum.
   *
   * Members are one failure seen from several frames, so adding them counts it
   * several times.
   */
  problemEventCount?: number;
  severity: DatadogSeverity;
  area: DatadogArea;
  /** Owning team, when a routing rule named one. */
  team?: string;
  /**
   * Which rule or heuristic decided `area`/`team`, e.g. `rule:service=csi-*` or
   * `heuristic:infra-source`. Shown in the UI: routing that cannot be explained
   * is routing nobody trusts, and this is the difference between fixing the rule
   * and arguing with the list.
   */
  routedBy?: string;
  /** Estimated occurrences in the scan window. See the note above. */
  eventCount: number;
  /** Occurrences among the sampled log bodies — the basis for the estimate. */
  sampleCount: number;
  /** Log bodies sampled for the whole service, the estimate's denominator. */
  sampleSize: number;
  /** Datadog log status of the sample: `error`, `emergency`, `warn`, … */
  status?: string;
  env?: string;
  /** Datadog `source` facet — `tomcat`, `nodejs`, `browser`, … */
  source?: string;
  host?: string;
  kubeNamespace?: string;
  /** Datadog id of the quoted log, so a person can find that exact line. */
  sampleLogId?: string;
  /** The complete sample message body, verbatim. What a ticket quotes. */
  sampleMessage?: string;
  sampleStack?: string;
  /** The log search that isolates this issue, for the deep link and the ticket. */
  query: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** When a scan last saw it. Distinct from `lastSeenAt`, which is the log's own. */
  lastScanAt: Date;
  /** How many scans have found it. 1 means "new today". */
  scanCount: number;
  /** Estimate from the previous scan, so the page can show a trend. */
  previousEventCount?: number;
  state: "open" | "linked" | "dismissed";
  jiraIssueKey?: string;
  jiraFiledAt?: Date;
}

/** One clustered issue as a scan found it, before it meets the stored row. */
export interface RecordDatadogIssueInput {
  service?: string;
  signature: string;
  title: string;
  problemKey?: string;
  problemTitle?: string;
  problemEventCount?: number;
  severity: DatadogSeverity;
  area: DatadogArea;
  team?: string;
  routedBy?: string;
  eventCount: number;
  sampleCount: number;
  sampleSize: number;
  status?: string;
  env?: string;
  source?: string;
  host?: string;
  kubeNamespace?: string;
  sampleLogId?: string;
  sampleMessage?: string;
  sampleStack?: string;
  query: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * The issues the Datadog scans have found.
 *
 * A table rather than a live query, for a different reason than LogRocket's: the
 * data *is* available on demand, but deriving it costs a fan-out of aggregations
 * and sampled reads over millions of log lines, and it carries state Datadog does
 * not hold — dismissals, the Jira ticket filed, whether this is the first day we
 * have seen it. So the scan writes here and every reader reads here.
 */
export interface DatadogIssueRepository {
  /**
   * Inserts, or folds a re-sighting into the row it belongs to on `fingerprint`.
   *
   * Folding keeps `firstSeenAt` and the Jira link, moves the counts and
   * `lastSeenAt`, and increments `scanCount`. A dismissed issue that recurs stays
   * dismissed: undismissing it every night would make dismissal meaningless.
   */
  record(input: RecordDatadogIssueInput): DatadogIssue;
  /**
   * The stored row for a fingerprint, if any.
   *
   * The scan needs it *before* recording: severity depends on whether this is new
   * and on how the count moved, and both are gone the moment `record` folds the
   * sighting in.
   */
  findByFingerprint(fingerprint: string): DatadogIssue | undefined;
  /** Severity first, then volume. Dismissed issues are excluded unless asked for. */
  list(options?: {
    includeDismissed?: boolean;
    /** Only issues a scan has seen since this instant — the "still happening" filter. */
    seenSince?: Date;
    team?: string;
    area?: DatadogArea;
    limit?: number;
  }): DatadogIssue[];
  get(id: string): DatadogIssue | undefined;
  /**
   * Every signature belonging to one root cause, loudest first.
   *
   * What the problem-level actions work through: a ticket is filed once for the
   * problem and linked to all of its members, and dismissing a problem dismisses
   * every log line it is made of. Dismissed members are included — the caller is
   * acting on the problem, not reading a list.
   */
  listByProblem(problemKey: string): DatadogIssue[];
  /** Distinct teams and areas present, for the page's filter chips. */
  facets(): { teams: string[]; areas: DatadogArea[] };
  link(id: string, jiraIssueKey: string): DatadogIssue | undefined;
  setState(id: string, state: "open" | "dismissed"): DatadogIssue | undefined;
  /**
   * Forgets open, unticketed rows no scan has seen since `before`. Returns the count.
   *
   * Without this the page only ever grows: nothing tells a stored row that its error
   * stopped happening, and a triage list that still shows last month's fixed bugs is
   * one nobody trusts. It matters more than it looks, because severity is decided
   * from the trend — a row that stopped being re-scanned keeps whatever severity it
   * had on its last sighting, forever.
   *
   * Deletes rather than marking resolved, and that is the honest option here: these
   * rows are a *sample-derived estimate* of one window, not a history. Keeping them
   * would imply a timeline the scan never measured. Anything a person acted on — has
   * a ticket, or was dismissed — is kept regardless, because that is a decision and
   * not a measurement.
   */
  pruneStale(before: Date): number;
}

/**
 * One rule mapping a log facet to an owning team, or to the bin.
 *
 * Rules exist because the logs carry no ownership. There is no `team` tag in this
 * org's Datadog, so "which team is this" cannot be read — it has to be declared,
 * and declared somewhere an operator can change without a deploy.
 *
 * `ignore` is the same mechanism pointed at noise: `csi-node-driver-registrar`
 * emitting 250k lines a day is not a bug anyone will fix, and a triage list that
 * leads with it is a list nobody opens. Ignoring is a rule rather than a hidden
 * constant so that the decision is visible and reversible.
 */
export interface DatadogRoutingRule {
  id: string;
  /** Lower runs first. The first matching rule decides. */
  priority: number;
  /** Which log facet the pattern is matched against. */
  facet: "service" | "source" | "kube_namespace" | "env" | "host" | "signature";
  /** Glob: `csi-*`, `*-worker`, `exact-name`. Case-insensitive. */
  pattern: string;
  /** `route` assigns team/area; `ignore` drops the issue from the scan entirely. */
  action: "route" | "ignore";
  team?: string;
  area?: DatadogArea;
  /** Files this team's tickets in a different Jira project than the default. */
  jiraProject?: string;
  /** Why this rule exists. Shown in the routing table. */
  note?: string;
  updatedAt: Date;
}

export interface DatadogRoutingRuleInput {
  priority?: number;
  facet: DatadogRoutingRule["facet"];
  pattern: string;
  action: DatadogRoutingRule["action"];
  team?: string;
  area?: DatadogArea;
  jiraProject?: string;
  note?: string;
}

/**
 * An edit to one rule.
 *
 * The optional fields take `null` as well as a value, and the difference carries
 * meaning: an absent key leaves the field alone, `null` clears it. Without that
 * distinction a team could be added to a rule but never removed from it.
 */
export interface DatadogRoutingRulePatch {
  priority?: number;
  facet?: DatadogRoutingRule["facet"];
  pattern?: string;
  action?: DatadogRoutingRule["action"];
  team?: string | null;
  area?: DatadogArea | null;
  jiraProject?: string | null;
  note?: string | null;
}

/** The routing rules, in the order they are evaluated. */
export interface DatadogRoutingRepository {
  list(): DatadogRoutingRule[];
  get(id: string): DatadogRoutingRule | undefined;
  create(input: DatadogRoutingRuleInput): DatadogRoutingRule;
  update(id: string, input: DatadogRoutingRulePatch): DatadogRoutingRule | undefined;
  delete(id: string): boolean;
}

/**
 * The repository boundary for one Datadog service.
 *
 * Team-wide rather than per developer: a service has one source repository even
 * when several people can ask an agent to work on it. A per-run branch override
 * does not mutate this default.
 */
export interface DatadogServiceTarget {
  service: string;
  projectId: string;
  targetBranch: string;
  updatedAt: Date;
}

export interface DatadogServiceTargetInput {
  projectId: string;
  targetBranch: string;
}

export interface DatadogServiceTargetRepository {
  list(): DatadogServiceTarget[];
  get(service: string): DatadogServiceTarget | undefined;
  set(service: string, input: DatadogServiceTargetInput): DatadogServiceTarget;
  delete(service: string): boolean;
}

export type DatadogAiTriageVerdict =
  | "code"
  | "bad-data"
  | "infrastructure"
  | "unknown";

export interface DatadogAiTriageRecord {
  id: string;
  issueId: string;
  fingerprint: string;
  verdict: DatadogAiTriageVerdict;
  confidence: number;
  rationale: string;
  recommendation: string;
  taskRunId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DatadogAiTriageRepository {
  get(issueId: string): DatadogAiTriageRecord | undefined;
  list(): DatadogAiTriageRecord[];
  record(
    input: Omit<DatadogAiTriageRecord, "id" | "createdAt" | "updatedAt">,
  ): DatadogAiTriageRecord;
}

/**
 * What one test run proved about the tests in it.
 *
 * `green` and `failures` are both conclusive: in either case every test that ran
 * either failed (and has a `test_run_failures` row) or passed. `inconclusive` is
 * a run that proved nothing — a runner failure, a job that never started, a
 * trace no test runner was recognised in — and it is excluded from every history
 * window rather than counted as a pass, because counting it as a pass would
 * break a real regression's streak and relabel it a flake.
 */
export type TestRunOutcome = "green" | "failures" | "inconclusive";

/**
 * Identifies who is recording history and reading it back — `gitlab-ci-failure`
 * today, and whatever else reports test results in the future (a backend unit
 * test runner, say). Free-form rather than a closed union: a new producer must
 * not need a change to this file just to name itself, only its own constant.
 */
export type TestRunSource = string;

/** One test run as its producer observed it. */
export interface RecordTestRunInput {
  source: TestRunSource;
  project: string;
  /** The producer's own identifier for the run — a pipeline number, a build id, a commit sha. */
  runId: string;
  sha?: string;
  ref?: string;
  status?: string;
  outcome: TestRunOutcome;
  testsFailed: number;
  finishedAt: Date;
}

/** One test's failure inside one run. */
export interface RecordTestFailureInput {
  source: TestRunSource;
  project: string;
  runId: string;
  /** Whatever the producer calls one test — a spec file path, a test class name. */
  testId: string;
  /** `signatureOf(group)` — the sorted failing test names. */
  signature: string;
  suiteFailedToRun: boolean;
  tests: string[];
  finishedAt: Date;
}

/**
 * One conclusive run, and whether a given test failed in it.
 *
 * `failed: false` is derived, not stored: the run was observed and carries no
 * failure row for this test. See the `test-run-history` migration.
 */
export interface TestObservation {
  runId: string;
  sha?: string;
  ref?: string;
  finishedAt: Date;
  failed: boolean;
  /** Only present when `failed` — the failure as that run reported it. */
  signature?: string;
  suiteFailedToRun?: boolean;
  tests?: string[];
}

/** A test with an intermittent history, for the Flaky specs page. */
export interface FlakyTestRow {
  source: TestRunSource;
  project: string;
  testId: string;
  /** Conclusive runs this test was observed in, within the window. */
  observed: number;
  failed: number;
  /** Failures in a row, newest-first. 0 when the latest run passed. */
  consecutiveFailures: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
  lastFailedRunId: string;
  lastPassedRunId?: string;
  lastSignature?: string;
  lastSuiteFailedToRun: boolean;
  state: "open" | "dismissed";
  quarantineSuggestedAt?: Date;
  /** An operator asked for a ticket despite the verdict; the next run obeys. */
  forceFile: boolean;
}

export interface ListFlakyTestsOptions {
  source?: TestRunSource;
  project?: string;
  includeDismissed?: boolean;
  /** How many recent conclusive runs each test is judged over. */
  window?: number;
  limit?: number;
}

/**
 * Per-test pass/fail history across runs, shared by every producer that reports
 * test results — one row per (source, project, test), overwritten, is what
 * `SubjectRepository` answers ("have we filed a ticket for this"); this answers
 * "how has this test behaved over the last ten runs", which needs every
 * sighting kept and is the only way to tell an intermittent failure from a
 * broken one.
 */
export interface TestRunHistoryRepository {
  /** Idempotent per (source, project, run). A re-scan of the same run is not a second observation. */
  recordTestRun(input: RecordTestRunInput): void;
  recordTestFailure(input: RecordTestFailureInput): void;
  /** Newest-first, conclusive runs only, at most `limit` of them. */
  history(source: TestRunSource, project: string, testId: string, limit: number): TestObservation[];
  listFlaky(options?: ListFlakyTestsOptions): FlakyTestRow[];
  setState(source: TestRunSource, project: string, testId: string, state: "open" | "dismissed"): void;
  /** Records that the quarantine threshold is met, keeping the first date it was. */
  suggestQuarantine(source: TestRunSource, project: string, testId: string): void;
  /**
   * "File a ticket anyway", from the Flaky specs page.
   *
   * Set by the console and cleared by the producer the moment it acts on it, so
   * an override files one ticket rather than exempting the test forever.
   */
  setForceFile(source: TestRunSource, project: string, testId: string, force: boolean): void;
  /** True when an override is outstanding for this test. */
  forceFilePending(source: TestRunSource, project: string, testId: string): boolean;
  /** Drops observations older than `before`, across every source. Returns rows deleted. */
  prune(before: Date): number;
}

/** Which error tracker a regression test was written from. */
export type RegressionTestSource = "datadog" | "logrocket";

/**
 * What the agent established about a production error it was asked to cover.
 *
 * The distinction is the whole value of the feature. `reproduced` means the new
 * test fails against the current head, so it demonstrates a live bug; the merge
 * request is a draft, because merging a red test breaks the pipeline for
 * everybody. `already-fixed` means the test passes, so it is a guard against the
 * error coming back and can be merged normally. `not-reachable` means the agent
 * could not tie the error to a code path at all — nothing is opened, because a
 * test written to pass against code nobody identified is worse than no test.
 */
export type RegressionTestVerdict = "reproduced" | "already-fixed" | "not-reachable";

/**
 * One attempt at turning a production error into a test in the repository.
 *
 * This row is the link nothing else records. A Datadog or LogRocket issue can
 * name the Jira ticket it was filed as, and the ticket's merge request is found
 * by a person reading Jira — the chain from "this error" to "the branch that
 * covers it" exists nowhere. Keyed on the issue id and its fingerprint, never on
 * `problemKey`, which is recomputed on every scan and identifies nothing.
 */
export interface RegressionTestRecord {
  id: string;
  source: RegressionTestSource;
  /** The `datadog_issues` / `logrocket_issues` row this was written from. */
  issueId: string;
  /** Survives the issue row being pruned, and folds re-sightings onto one attempt. */
  fingerprint: string;
  verdict: RegressionTestVerdict;
  /** The agent's own account of what it did or why it could not. */
  summary?: string;
  /** How it checked the test's verdict — which command, against which head. */
  howVerified?: string;
  /** The spec file it wrote, as the agent reported it. */
  testFile?: string;
  mrIid?: number;
  mrUrl?: string;
  branch?: string;
  /** The run that produced this, so the logs are one click from the row. */
  taskRunId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type RecordRegressionTestInput = Omit<
  RegressionTestRecord,
  "id" | "createdAt" | "updatedAt"
>;

/**
 * Regression tests written from production errors, at most one row per issue.
 *
 * At most one because the row answers "has anybody already tried this?", and a
 * history of attempts would answer a question nobody is asking while making the
 * page ambiguous. A re-run overwrites, which is what makes clicking the button
 * again after a `not-reachable` verdict useful.
 */
export interface RegressionTestRepository {
  record(input: RecordRegressionTestInput): RegressionTestRecord;
  get(source: RegressionTestSource, issueId: string): RegressionTestRecord | undefined;
  /** Every attempt, newest first. The page joins these onto its rows. */
  list(): RegressionTestRecord[];
}

/**
 * Where one implementation plan is in its review.
 *
 * `awaiting-review` is the only state a human acts on, and the only one the unique
 * index restricts to one row per ticket. `superseded` exists so re-planning keeps
 * the earlier attempt rather than overwriting it — "what did the agent propose the
 * first time" is a question worth being able to answer. `implemented` is set once
 * the fix the approval authorised has actually opened a merge request, which is
 * what separates "somebody approved this" from "this shipped".
 */
export type PlanStatus =
  | "awaiting-review"
  | "approved"
  | "rejected"
  | "superseded"
  | "implemented";

/**
 * An implementation plan an agent wrote and a human decides on, before any code
 * is written.
 *
 * The row is the whole point of the feature: it lives on the host, outside the
 * container that produced it and outside the container that will implement it.
 * A planning container exits as soon as it has written this, so a plan can wait
 * for a human for days without holding any of the (two, by default) agent slots.
 */
export interface Plan {
  id: string;
  issueKey: string;
  /** `group/project` the plan is written against — needed to clone for the fix. */
  projectId: string;
  targetBranch: string;
  status: PlanStatus;
  /** What the agent wrote. Never mutated, so an edit stays visible as an edit. */
  draftBody: string;
  /**
   * What the human approved — the only text ever mounted into the implementing
   * container. Absent until approval, and equal to `draftBody` when nobody edited.
   */
  approvedBody?: string;
  /** The agent's one-line account of what it is proposing. */
  summary?: string;
  /** `ticketFingerprint` at planning time; drives the staleness refusal. */
  ticketFingerprint?: string;
  /** Base branch head at planning time. Drives the advisory drift warning. */
  baseSha?: string;
  /** The planning run, so its log is one click from the plan. */
  planRunId?: string;
  /** The fix job the approval enqueued. */
  implementJobId?: string;
  requestedBy?: string;
  reviewerId?: string;
  /** Why it was rejected, in the reviewer's words. */
  reviewNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CreatePlanInput = Omit<
  Plan,
  | "id"
  | "status"
  | "approvedBody"
  | "implementJobId"
  | "reviewerId"
  | "reviewNote"
  | "createdAt"
  | "updatedAt"
>;

/**
 * Implementation plans and their review state.
 *
 * Unlike `RegressionTestRepository` this keeps history: `create` supersedes the
 * open plan for the ticket rather than replacing it, because a plan somebody
 * rejected is evidence about what the agent understood, and the next plan is
 * usually best read against it.
 */
export interface PlanRepository {
  /**
   * Records a new plan, moving any `awaiting-review` plan for the same ticket to
   * `superseded` in the same transaction — the unique index permits only one, and
   * doing it in two statements leaves a window where the insert fails.
   */
  create(input: CreatePlanInput): Plan;
  get(id: string): Plan | undefined;
  /** The review inbox, oldest first: the plan that has waited longest is the one to do. */
  awaitingReview(): Plan[];
  /** Every plan for one ticket, newest first. */
  forIssue(issueKey: string): Plan[];
  /** The plan a reviewer would act on for this ticket, if there is one. */
  openForIssue(issueKey: string): Plan | undefined;
  /**
   * Every plan still in play — `awaiting-review` or `approved` — for the given
   * tickets, newest first.
   *
   * One query for a whole page of tickets: the graph is polled every few seconds
   * with dozens of clusters in it, and a per-ticket read there is a per-ticket read
   * multiplied by that.
   */
  unresolvedForIssues(issueKeys: readonly string[]): Plan[];
  /**
   * Approves with the body the reviewer signed off and the job it enqueued.
   * Returns false when the plan was no longer `awaiting-review` — two reviewers
   * on the same plan must not both queue a fix.
   */
  approve(id: string, args: { reviewerId: string; body: string; implementJobId: string }): boolean;
  reject(id: string, args: { reviewerId: string; note?: string }): boolean;
  /** Set once the authorised fix has actually opened a merge request. */
  markImplemented(id: string): boolean;
}

/** One structured issue submitted from the footer's feedback link. */
export type FeedbackPublicationReason =
  | "missing_token"
  | "invalid_token"
  | "insufficient_access"
  | "temporary_failure";

export interface FeedbackAttachment {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface Feedback {
  id: string;
  userId: string;
  type: FeedbackType;
  title: string;
  description: string;
  labels: string[];
  publicationStatus: "pending" | "published";
  publicationReason?: FeedbackPublicationReason;
  externalIssueUrl?: string;
  externalIssueNumber?: number;
  createdAt: Date;
}

/** An append-only mailbox -- there is no read/resolve workflow yet. */
export interface FeedbackRepository {
  create(
    userId: string,
    input: {
      type: FeedbackType;
      title: string;
      description: string;
      attachments?: readonly FeedbackAttachment[];
    },
  ): Feedback;
  get(id: string): Feedback | undefined;
  pendingForUser(userId: string): Feedback[];
  attachments(id: string): FeedbackAttachment[];
  markPublicationPending(id: string, reason: FeedbackPublicationReason): void;
  linkExternalIssue(id: string, issue: { number: number; url: string }): void;
  delete(id: string): boolean;
  list(): Feedback[];
}

/**
 * Which repositories a developer's Team MRs tab is narrowed to.
 *
 * Unencrypted — a list of `group/project` paths is not a secret the way a
 * token is — and unlike `CredentialRepository` there is no disabled mode: it
 * needs no encryption key, so it is always available.
 */
export interface PullRequestRepoFilterRepository {
  /** Empty means unfiltered — every repository the person's groups turn up. */
  list(userId: string): string[];
  /** Replaces the whole set. Empty clears the filter rather than deleting a first row and leaving the rest. */
  set(userId: string, repositories: readonly string[]): void;
}

/** One GitLab pipeline schedule selected for the Automation page. */
export interface AutomationAutoRetryConfig {
  enabled: boolean;
  /** Hard safety cap for one pipeline retry wave. */
  maxJobsPerPipeline: number;
}

export interface AutomationConfiguredSchedule {
  scheduleId: number;
  /** Operator-facing label. The GitLab description is used when this is absent. */
  displayName?: string;
  autoRetry?: AutomationAutoRetryConfig;
}

/** Instance-wide Jira defaults used by Automation ticketing. */
export interface AutomationJiraConfig {
  projectKey: string;
  /** Optional Jira issue placed in the parent field for new Automation tickets. */
  parentKey?: string;
  issueType: string;
  boardId?: number;
  useActiveSprint: boolean;
  labels: string[];
  assigneeMode: "automatic" | "fixed";
  /** Jira account id or email. Present only for fixed assignment. */
  fixedAssignee?: string;
}

/** Instance-wide source, ordered allowlist, and optional ticketing defaults. */
export interface AutomationConfig {
  /** A numeric GitLab project id, represented as a string at the application boundary. */
  projectId: string;
  schedules: AutomationConfiguredSchedule[];
  /** Absent until an operator opts Automation into Jira ticketing. */
  jira?: AutomationJiraConfig;
}

export interface AutomationConfigRepository {
  /** Null until an operator selects a project and at least zero schedules. */
  get(): AutomationConfig | null;
  /** Replaces the complete Automation configuration atomically. */
  set(config: AutomationConfig): void;
}

/** Metadata copied from one configured GitLab pipeline schedule. */
export interface AutomationSchedule {
  projectId: string;
  scheduleId: number;
  description: string;
  ref: string;
  cron?: string;
  cronTimezone?: string;
  nextRunAt?: Date;
  active: boolean;
  /** Last successful metadata/pipeline sync for this schedule. */
  syncedAt: Date;
}

export type AutomationReportState = "pending" | "complete" | "missing" | "error";

/** Aggregate fields common to GitLab pipeline, job, and suite test reports. */
export interface AutomationTestReportCounts {
  totalTime: number;
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  errorCount: number;
  suiteError?: string;
}

export interface AutomationPipelineJob {
  jobId: number;
  name: string;
  stage: string;
  status: string;
  failureReason?: string;
  allowFailure: boolean;
  webUrl: string;
  duration?: number;
  createdAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  /** Present when the job can be mapped to one reported test-suite aggregate. */
  report?: AutomationTestReportCounts;
}

export interface AutomationTestSuite extends AutomationTestReportCounts {
  /** Stable position in the GitLab report, used to associate failed cases. */
  index: number;
  name: string;
  buildIds: number[];
}

/**
 * A failed/error case only. `classname` plus `name` is the stable identity used
 * for fingerprints; `caseIndex` disambiguates duplicate names in one suite.
 */
export interface AutomationFailedTestCase {
  suiteIndex: number;
  /** Stable position within a suite; the store derives it from input order when omitted. */
  caseIndex?: number;
  jobId?: number;
  status: "failed" | "error";
  name: string;
  classname?: string;
  executionTime: number;
  systemOutput?: string;
  stackTrace?: string;
  /** Source file reported by GitLab's parsed JUnit case. */
  testFile?: string;
  /** Validated GitLab build id embedded in the attachment URL. */
  attachmentJobId?: number;
  /** Safe path relative to that build's artifact archive; never a URL. */
  attachmentPath?: string;
  attachmentName?: string;
  /** Deterministic, source-independent root-cause key. */
  signatureKey: string;
  /** Human-readable normalized error shape used to explain the key. */
  signatureTitle: string;
}

/** One durable, fully collected scheduled-pipeline snapshot. */
export interface AutomationPipelineStatusRow {
  projectId: string;
  pipelineId: number;
  status: string;
  ref: string;
  webUrl: string;
  createdAt?: Date;
  updatedAt: Date;
}

export interface AutomationPipelineSnapshot {
  projectId: string;
  pipelineId: number;
  scheduleId: number;
  status: string;
  ref: string;
  sha: string;
  webUrl: string;
  createdAt?: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  duration?: number;
  /** Null while no report fetch has been attempted. */
  reportState: AutomationReportState | null;
  /** Parser/storage format used for this report aggregate. */
  reportVersion: number;
  report?: AutomationTestReportCounts;
  jobs: AutomationPipelineJob[];
  suites: AutomationTestSuite[];
  /** The store discards any input case whose status is not failed/error. */
  failedTests: AutomationFailedTestCase[];
}

/** Tie-safe high-water mark for schedule polling. */
export interface AutomationPipelineCursor {
  updatedAt: Date;
  pipelineId: number;
}

export interface ListAutomationPipelinesOptions {
  projectId: string;
  scheduleId?: number;
  status?: string;
  reportStates?: readonly AutomationReportState[];
  /** Selects snapshots written before a parser/storage format upgrade. */
  reportVersionBelow?: number;
  /** Inclusive pipeline update-time lower bound. */
  from?: Date;
  /** Inclusive pipeline update-time upper bound. */
  to?: Date;
  limit?: number;
}

export type AutomationClusterTriageState =
  | "untriaged"
  | "ticketed"
  | "active-mr";

/** Durable external-work state for one schedule-scoped failure signature. */
export interface AutomationFailureClusterWork {
  projectId: string;
  scheduleId: number;
  signatureKey: string;
  identity: string;
  state: "creating" | "ticketed" | "active-mr";
  jiraKey?: string;
  jiraUrl?: string;
  mrIid?: number;
  mrUrl?: string;
  claimedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type AutomationAiTriageVerdict =
  | "bad-data"
  | "service-breaking-change"
  | "ui-change"
  | "test-bug"
  | "infrastructure"
  | "unknown";

/** Latest AI classification for one schedule-scoped normalized failure. */
export interface AutomationAiTriageRecord {
  id: string;
  projectId: string;
  scheduleId: number;
  signatureKey: string;
  /** The normalized signature text at classification time; guards stale reads. */
  signature: string;
  verdict: AutomationAiTriageVerdict;
  confidence: number;
  rationale: string;
  recommendation: string;
  taskRunId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationAiTriageRepository {
  get(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
  ): AutomationAiTriageRecord | undefined;
  /** One bounded query for a cluster page; keyed by signature key. */
  listFor(
    projectId: string,
    scheduleId: number,
    signatureKeys: readonly string[],
  ): Map<string, AutomationAiTriageRecord>;
  record(
    input: Omit<AutomationAiTriageRecord, "id" | "createdAt" | "updatedAt">,
  ): AutomationAiTriageRecord;
}

/** Talos ownership for one schedule-scoped normalized failure. */
export interface AutomationFailureAssignee {
  projectId: string;
  scheduleId: number;
  signatureKey: string;
  userId: string;
  assignedByUserId: string;
  assignedAt: Date;
  updatedAt: Date;
}

export interface AutomationFailureAssigneeRepository {
  get(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
  ): AutomationFailureAssignee | undefined;
  listFor(
    projectId: string,
    scheduleId: number,
    signatureKeys: readonly string[],
  ): Map<string, AutomationFailureAssignee>;
  set(input: {
    projectId: string;
    scheduleId: number;
    signatureKey: string;
    userId: string;
    assignedByUserId: string;
    now: Date;
  }): AutomationFailureAssignee;
  clear(projectId: string, scheduleId: number, signatureKey: string): boolean;
}

export interface AutomationFailureClusterSummary {
  projectId: string;
  pipelineId: number;
  scheduleId: number;
  signatureKey: string;
  title: string;
  severity: "failed" | "error";
  occurrenceCount: number;
  affectedTestCount: number;
  sampleTestName: string;
  sampleClassname?: string;
  jobIds: number[];
  suiteIndexes: number[];
  triageState: AutomationClusterTriageState;
  creating: boolean;
  work?: AutomationFailureClusterWork;
}

export interface AutomationFailureClusterMember {
  suiteIndex: number;
  suiteName: string;
  caseIndex: number;
  jobId?: number;
  jobName?: string;
  jobUrl?: string;
  status: "failed" | "error";
  name: string;
  classname?: string;
  executionTime: number;
  testFile?: string;
  attachmentJobId?: number;
  attachmentPath?: string;
  attachmentName?: string;
}

export interface AutomationFailureClusterDetail
  extends AutomationFailureClusterSummary {
  pipelineUrl: string;
  members: AutomationFailureClusterMember[];
  membersTruncated: boolean;
  representative: {
    systemOutput?: string;
    stackTrace?: string;
    suiteIndex: number;
    caseIndex: number;
  };
}

export interface ListAutomationFailureClustersOptions {
  projectId: string;
  pipelineId: number;
  search?: string;
  jobId?: number;
  suiteIndex?: number;
  triageState?: AutomationClusterTriageState;
  limit: number;
  offset: number;
}

export interface AutomationFailureClusterFacets {
  states: Record<AutomationClusterTriageState, number>;
  jobs: Array<{ jobId: number; name: string; count: number }>;
  suites: Array<{ suiteIndex: number; name: string; count: number }>;
}

export interface AutomationFailureClusterPage {
  items: AutomationFailureClusterSummary[];
  total: number;
  facets: AutomationFailureClusterFacets;
}

export type AutomationFailurePresence = "current" | "recent";

/** One schedule-scoped signature aggregated across every retained pipeline. */
export interface AutomationFailureInboxItem {
  projectId: string;
  scheduleId: number;
  signatureKey: string;
  title: string;
  severity: "failed" | "error";
  firstSeenAt: Date;
  lastSeenAt: Date;
  pipelineCount: number;
  latestPipelineId: number;
  latestPipelineUrl: string;
  latestRef: string;
  latestSha: string;
  latestUpdatedAt: Date;
  occurrenceCount: number;
  affectedTestCount: number;
  sampleTestName: string;
  sampleClassname?: string;
  current: boolean;
  triageState: AutomationClusterTriageState;
  creating: boolean;
  work?: AutomationFailureClusterWork;
}

export interface ListAutomationFailureInboxOptions {
  projectId: string;
  scheduleIds: readonly number[];
  from: Date;
  scheduleId?: number;
  pipelineId?: number;
  presence: AutomationFailurePresence;
  search?: string;
  triageState?: AutomationClusterTriageState;
  limit: number;
  offset: number;
}

export interface AutomationFailureInboxPage {
  items: AutomationFailureInboxItem[];
  total: number;
  facets: {
    states: Record<AutomationClusterTriageState, number>;
    schedules: Array<{ scheduleId: number; count: number }>;
    current: number;
    recent: number;
  };
}

export type AutomationJobRetryAttemptStatus =
  | "requested"
  | "accepted"
  | "failed";

export interface AutomationJobRetryAttempt {
  projectId: string;
  pipelineId: number;
  scheduleId: number;
  sourceJobId: number;
  sourceJobName: string;
  retryJobId?: number;
  retryJobUrl?: string;
  status: AutomationJobRetryAttemptStatus;
  error?: string;
  requestedAt: Date;
  completedAt?: Date;
}

export interface AutomationJobRetryWave {
  projectId: string;
  pipelineId: number;
  scheduleId: number;
  state: "claimed" | "complete" | "partial" | "failed";
  executionId: string;
  requestedAt: Date;
  completedAt?: Date;
  error?: string;
  attempts: AutomationJobRetryAttempt[];
}

export interface AutomationFailureClaimResult {
  claimed: boolean;
  recovered: boolean;
  work: AutomationFailureClusterWork;
}

export interface AutomationRepository {
  /** Replaces a pipeline and all of its children in one transaction. */
  recordPipeline(snapshot: AutomationPipelineSnapshot): void;
  upsertSchedule(schedule: AutomationSchedule): void;
  latestUpdatedCursor(
    projectId: string,
    scheduleId: number,
  ): AutomationPipelineCursor | null;
  /** Stable by project then configured GitLab schedule id. */
  listSchedules(projectId?: string): AutomationSchedule[];
  /** Deterministically newest-first by updated time, then pipeline id. */
  listPipelines(options: ListAutomationPipelinesOptions): AutomationPipelineSnapshot[];
  /**
   * Pipeline identity and status only. The dashboard chart uses this so a
   * status count does not load every job and failed test.
   */
  listPipelineStatuses(options: {
    projectId: string;
    from?: Date;
    limit: number;
  }): AutomationPipelineStatusRow[];
  getPipeline(
    projectId: string,
    pipelineId: number,
    options?: { includeFailureDiagnostics?: boolean },
  ): AutomationPipelineSnapshot | undefined;
  listFailureClusters(
    options: ListAutomationFailureClustersOptions,
  ): AutomationFailureClusterPage;
  listFailureInbox(
    options: ListAutomationFailureInboxOptions,
  ): AutomationFailureInboxPage;
  claimJobRetryWave(input: {
    projectId: string;
    pipelineId: number;
    scheduleId: number;
    executionId: string;
    jobs: ReadonlyArray<{ jobId: number; name: string }>;
    now: Date;
  }): boolean;
  recordJobRetryAttemptResult(input: {
    projectId: string;
    pipelineId: number;
    sourceJobId: number;
    retryJobId?: number;
    retryJobUrl?: string;
    error?: string;
    now: Date;
  }): void;
  completeJobRetryWave(input: {
    projectId: string;
    pipelineId: number;
    state: "complete" | "partial" | "failed";
    error?: string;
    now: Date;
  }): void;
  getJobRetryWave(
    projectId: string,
    pipelineId: number,
  ): AutomationJobRetryWave | undefined;
  getFailureCluster(
    projectId: string,
    pipelineId: number,
    signatureKey: string,
    memberLimit: number,
  ): AutomationFailureClusterDetail | undefined;
  getFailureClusterWork(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
  ): AutomationFailureClusterWork | undefined;
  claimFailureCluster(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
    identity: string,
    now: Date,
    staleBefore: Date,
  ): AutomationFailureClaimResult;
  releaseFailureClusterClaim(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
  ): boolean;
  recordFailureClusterTicket(input: {
    projectId: string;
    scheduleId: number;
    signatureKey: string;
    identity: string;
    jiraKey: string;
    jiraUrl: string;
    now: Date;
  }): AutomationFailureClusterWork;
  recordFailureClusterMr(input: {
    projectId: string;
    scheduleId: number;
    signatureKey: string;
    identity: string;
    jiraKey?: string;
    jiraUrl?: string;
    mrIid: number;
    mrUrl: string;
    now: Date;
  }): AutomationFailureClusterWork;
  clearFailureClusterMr(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
    now: Date,
  ): AutomationFailureClusterWork | undefined;
  markScheduleSynced(projectId: string, scheduleId: number, syncedAt: Date): void;
  /** Deletes pipelines updated before the cutoff; FK cascades remove children. */
  prune(before: Date): number;
}

/**
 * Which repo/manifest/branch the Releases page reads and edits.
 *
 * Instance-wide, not per-user: there is one `example-org/releases` for the
 * team, so a single row. Editable live from Settings, which is why it lives in
 * the DB rather than the bootstrap config — see `src/config/schema.ts`.
 */
export interface ReleaseConfig {
  /** A GitLab project — numeric id or `group/project` path. */
  projectId: string;
  /** Path to the manifest file within the repo, e.g. `releases.yml`. */
  manifestPath: string;
  /** The branch the manifest is read from and MRs target, e.g. `main`. */
  targetBranch: string;
}

export interface ReleaseConfigRepository {
  /** Null until an operator sets it. */
  get(): ReleaseConfig | null;
  set(config: ReleaseConfig): void;
}

/**
 * Instance-wide overrides for the two files an E2E job normally reads from the
 * Test-Automation repository, plus optional instructions for the next agents.
 *
 * Null means "use the repository file" for the two overrides and "send no
 * additional instructions" for the last field.
 */
export interface E2eTestConfig {
  agentInstructionsOverride: string | null;
  runtimeConfigOverride: string | null;
  additionalInstructions: string | null;
}

export interface E2eTestConfigRepository {
  /** Decrypted runtime config for a job; throws if a stored value is unreadable. */
  get(): E2eTestConfig;
  /** Browser-safe status, including whether an encrypted runtime override is unreadable. */
  inspect(): E2eTestConfig & {
    secretsEnabled: boolean;
    runtimeConfigUnreadable: boolean;
  };
  set(patch: Partial<E2eTestConfig>): void;
}

/** What a channel needs to be told about a release that just opened. */
export interface ReleaseAnnouncement {
  environment: string;
  changes: FormatChange[];
  mrUrl: string;
  /** Who clicked Upload — the acting developer's email. */
  author: string;
  merged: boolean;
  autoMergeEnabled: boolean;
  /** Omitted by older callers, which is equivalent to a normal deploy. */
  kind?: "deploy" | "revert";
}

/** What a channel needs to be told about a new post-deploy finding. */
export interface DeployWatchFindingAnnouncement {
  source: DeployWatchFindingSource;
  environment: string;
  service?: string;
  signature: string;
  eventCount: number;
  releaseUrl: string;
  releaseLabel: string;
  externalUrl?: string;
  issueType?: string;
  /** Who uploaded the release, named so the channel knows who to ask. */
  author?: string;
}

/**
 * Announces a release to the team, out of band from the merge request.
 *
 * A port rather than a Slack client reference so `ReleaseApplicationService`
 * stays ignorant of which chat tool the team uses, and so a release can be
 * uploaded in a test without a token. `announce` throws on failure and the
 * caller downgrades that to a warning — see `ReleaseApplicationService.notify`:
 * a chat outage must not fail a release whose merge request already exists.
 */
export interface ReleaseNotifier {
  /** Whether a message can be sent at all — the token and channel are both set. */
  configured(): boolean;
  announce(input: ReleaseAnnouncement, signal?: AbortSignal): Promise<void>;
  /** A signature the post-deploy watcher found that was not there before the release. */
  announceFinding(input: DeployWatchFindingAnnouncement, signal?: AbortSignal): Promise<void>;
}

/** One immutable image a release expects Kubernetes to run. */
export interface ReleaseDeploymentTarget {
  service: string;
  expectedImage: string;
}

export type DeploymentTargetState =
  | "released"
  | "pending"
  | "progressing"
  | "degraded"
  | "missing"
  | "unavailable";

/**
 * Runtime evidence for one Deployment. Counts come from the Deployment status;
 * podCount and observedDigest prove what the active replicas actually run.
 */
export interface DeploymentTargetStatus extends ReleaseDeploymentTarget {
  state: DeploymentTargetState;
  desiredReplicas: number;
  updatedReplicas: number;
  readyReplicas: number;
  availableReplicas: number;
  podCount: number;
  observedDigest?: string;
  message?: string;
}

/** Read-only boundary around the Kubernetes control plane. */
export interface DeploymentVerifier {
  verify(
    environment: string,
    targets: readonly ReleaseDeploymentTarget[],
    signal?: AbortSignal,
  ): Promise<DeploymentTargetStatus[]>;
}

/**
 * A production release, watched for the errors it caused.
 *
 * One row per prod release. Talos uploads begin as a pending merge request;
 * releases discovered after landing begin in `watching` and may point either to
 * their merged MR or directly to the target-branch commit.
 *
 * `services` is both what makes the correlation possible at all — it is the
 * Datadog `service` facet and the manifest entry name, the same string — and the
 * limit of what this can attribute: a finding is pinned to the release, the
 * bumped service and the uploader, not to whichever individual merge request
 * inside that service actually caused it. Mapping a version bump to the commits
 * behind it does not exist yet; see the plan for what that would take.
 */
export interface DeployWatch {
  id: string;
  environment: string;
  projectId: string;
  releaseKind: "merge-request" | "commit";
  mrIid?: number;
  mrUrl?: string;
  commitSha?: string;
  commitUrl?: string;
  branch: string;
  /** The developer who clicked Upload. Absent only if their account was removed since. */
  actorId?: string;
  services: string[];
  state: "pending-merge" | "watching" | "done" | "abandoned";
  openedAt: Date;
  /** Set once GitLab reports the merge request merged. */
  mergedAt?: Date;
  /** When the baseline sample was taken — always just before `mergedAt`. */
  baselineAt?: Date;
  /** The watch stops polling once past this instant. */
  watchUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDeployWatchInput {
  environment: string;
  projectId: string;
  mrIid: number;
  mrUrl: string;
  branch: string;
  actorId?: string;
  services: string[];
}

export type CreateDetectedDeployWatchInput = {
  environment: string;
  projectId: string;
  branch: string;
  services: string[];
  mergedAt: Date;
  watchUntil: Date;
  commitSha: string;
  commitUrl: string;
} & (
  | {
      releaseKind: "merge-request";
      mrIid: number;
      mrUrl: string;
    }
  | {
      releaseKind: "commit";
    }
);

export interface UpdateDeployWatchInput {
  state?: DeployWatch["state"];
  mergedAt?: Date;
  watchUntil?: Date;
}

export type DeployWatchFindingSource = "datadog" | "logrocket";

/** One error the watcher saw after the release that it did not see before. */
export interface DeployWatchFinding {
  id: string;
  watchId: string;
  source: DeployWatchFindingSource;
  service?: string;
  signature: string;
  fingerprint: string;
  /** A Datadog sample count or LogRocket session/alert count. */
  eventCount: number;
  externalUrl?: string;
  issueType?: string;
  sampleMessage?: string;
  sampleStack?: string;
  firstSeenAt: Date;
  createdAt: Date;
}

export type RecordDeployWatchFindingInput = Omit<DeployWatchFinding, "id" | "createdAt">;

export interface DeployWatchRepository {
  create(input: CreateDeployWatchInput): DeployWatch;
  /**
   * Atomically opens an already-landed release, or returns the existing watch
   * when another poll/upload won the race.
   */
  createDetected(input: CreateDetectedDeployWatchInput): {
    watch: DeployWatch;
    created: boolean;
  };
  get(id: string): DeployWatch | undefined;
  /** The watch already open for this merge request, if `upload()` has raised one. */
  getByMr(projectId: string, mrIid: number): DeployWatch | undefined;
  getByCommit(projectId: string, commitSha: string, environment: string): DeployWatch | undefined;
  update(id: string, patch: UpdateDeployWatchInput): DeployWatch;
  /**
   * Replaces the baseline fingerprint set and stamps when it was taken. Its own
   * method rather than a field on `update`, because every other field is set at
   * most once per state transition while this one is exactly the baseline
   * capture step — keeping it separate is what makes that step greppable.
   */
  setBaseline(id: string, fingerprints: readonly string[], baselineAt: Date): DeployWatch;
  /** The most recently captured baseline set, for the watching step to diff against. */
  baseline(id: string): ReadonlySet<string>;
  list(options?: { limit?: number }): DeployWatch[];
  /**
   * Records a finding, or does nothing if this fingerprint was already found for
   * this watch — `null` in that case, which is how the caller knows not to notify
   * a second time for the same signature.
   */
  addFinding(input: RecordDeployWatchFindingInput): DeployWatchFinding | null;
  findings(watchId: string): DeployWatchFinding[];
}

/**
 * Where one developer's "Fix this issue" click opens its merge request.
 *
 * Per-user and not instance-wide, because a Jira ticket names no repository:
 * the only honest source for "which project does TP-1204 belong in" is the
 * person who was assigned it. Unencrypted — a project path and a branch name
 * are not secrets — and null until they set it, which is what makes the graph's
 * button explain itself rather than guessing a branch to push to.
 */
export interface FixIssueDefaults {
  /** A GitLab project — numeric id or `group/project` path. */
  projectId: string;
  /** The branch the fix is cut from and the merge request targets. */
  targetBranch: string;
}

export interface FixIssueDefaultsRepository {
  /** Null until this developer sets it. */
  get(userId: string): FixIssueDefaults | null;
  set(userId: string, defaults: FixIssueDefaults): void;
}

/**
 * How one developer has set the console up for themselves — see migration 46.
 *
 * Most values are browser presentation choices. The typed
 * `AgentRunPreferences` adapter also uses this storage for the model defaults the
 * server applies to this developer's manually initiated work.
 *
 * Values are opaque JSON strings. The client that owns a key is the only thing that
 * can say what a valid value for it is, and it has to cope with an old one anyway,
 * so validating here would be a second guess at a shape this layer cannot know.
 */
export interface PreferenceRepository {
  /** Every preference this developer has set, `key` → raw JSON. Empty for a new account. */
  all(userId: string): Record<string, string>;
  /** Writes one key. The value must already be JSON — this does not serialise. */
  set(userId: string, key: string, value: string): void;
  /** Forgets one key, so the page falls back to its default rather than storing it. */
  clear(userId: string, key: string): void;
}

// Re-exported for the same reason as the subject types: a caller holding a
// `WebhookRepository` should not have to know which file declares its queue half.
export type { PendingTrigger, TriggerQueue } from "../core/webhook.ts";

/** A registered GitLab webhook, described without its secret. */
export interface WebhookEndpoint {
  id: string;
  /** The loop a delivery triggers. */
  taskId: string;
  description?: string;
  enabled: boolean;
  createdAt: Date;
  /** The account that registered it, for "who set this up". */
  createdBy?: string;
  lastDeliveryAt?: Date;
  deliveries: number;
}

export interface WebhookDelivery {
  eventUuid: string;
  endpointId: string;
  /** `merge_request`, `note`, `pipeline` — whatever GitLab sent. */
  eventKind: string;
  /** What it was about, for diagnosis: `acme/web!412`. */
  subject?: string;
  receivedAt: Date;
  outcome: "queued" | "ignored" | "duplicate";
}

export interface CreateWebhookInput {
  taskId: string;
  description?: string;
  createdBy?: string;
}

/**
 * Webhook endpoints, their deliveries, and the trigger queue those deliveries
 * feed. One repository because the three are one story: a delivery is only
 * meaningful against the endpoint that authenticated it, and only useful once it
 * has become a pending trigger.
 *
 * The secret is returned exactly once, by `create`, and stored hashed. Nothing
 * can read it back — an operator who loses it registers a new endpoint, which is
 * a minute of work, and in exchange a stolen database is not a set of live
 * webhook URLs.
 */
export interface WebhookRepository extends TriggerQueue {
  get(id: string): WebhookEndpoint | undefined;
  list(taskId?: string): WebhookEndpoint[];
  /** The plaintext secret is the operator's only copy — show it and move on. */
  create(input: CreateWebhookInput): { endpoint: WebhookEndpoint; secret: string };
  delete(id: string): boolean;
  /**
   * The endpoint, if this token is its secret. Undefined for an unknown id or a
   * wrong token — one answer for both, so the response cannot be used to
   * enumerate ids. Comparison is timing-safe.
   */
  verify(id: string, token: string | null): WebhookEndpoint | undefined;
  /**
   * Records a delivery, returning false when this event was already seen.
   *
   * GitLab retries a delivery it did not get a 2xx for, and a retried
   * `merge_request` event must not start a second review. The dedupe is a
   * primary key on the event id, so two processes racing the same retry cannot
   * both win.
   */
  recordDelivery(input: Omit<WebhookDelivery, "receivedAt">): boolean;
  deliveries(endpointId?: string, limit?: number): WebhookDelivery[];
  /** Ages out a bounded delivery batch; the endpoint's counter keeps the total. */
  purgeDeliveries(before: Date, limit?: number): number;
  deliveryRetentionCount(before: Date): number;
}

export type JobCounts = Record<JobStatus, number>;

/**
 * The queue plus the reads the API and maintenance jobs need. `JobQueue` itself
 * stays minimal because `core/worker-pool.ts` must not be able to reach history.
 */
export interface JobRepository extends JobQueue {
  get(id: string): Job | null;
  byLoop(loopId: string, limit?: number): Job[];
  bySubject(loopId: string, subjectKey: string, limit?: number): Job[];
  bySubjectsForLoops(loopIds: readonly string[], limitPerSubject?: number): Map<string, Job[]>;
  byParent(parentExecutionId: string): Job[];
  byParents(parentExecutionIds: readonly string[]): Map<string, Job[]>;
  hasActiveChildren(loopId: string, kind: string): boolean;
  /**
   * Every job ever raised under one dedupe key, newest first.
   *
   * The read the pull request view's action pills need. Keyed on the dedupe key
   * rather than the subject because that is what identifies "this action on this
   * merge request" regardless of which loop — or which page's click — raised it,
   * and a job queued from the graph must show up on the pull request page as the
   * same in-flight work rather than as a second one.
   */
  byDedupeKey(dedupeKey: string, limit?: number): Job[];
  /**
   * Every job queued or leased for a manual pull request action, over every
   * merge request at once — the read the ticket graph needs to mark a merge
   * request node "running" for an action started with no subject behind it
   * (see `src/api/pull-request-actions.ts`).
   */
  activeManualActions(): Job[];
  /**
   * Every job of one handler kind that is queued or leased right now, over
   * every dedupe key at once — the read a manual action needs to notice that
   * the *automatic loop* already has this exact merge request in flight under
   * its own dedupe key, which `byDedupeKey`/`activeManualActions` cannot see.
   */
  activeForKind(kind: string): Job[];
  /**
   * Every job ever queued for any manual action on one merge request, newest
   * first — the pull request view's Activity tab (see
   * `src/api/pull-request-actions.ts`).
   */
  manualActionHistory(projectId: string, mrIid: number, limit?: number): Job[];
  /**
   * Every job ever queued for any manual ticket action, over every ticket at
   * once — the read the ticket graph needs to draw an action node per step
   * somebody triggered on a ticket, finished ones included (see
   * `src/api/ticket-actions.ts`).
   */
  manualTicketActionHistory(limit?: number): Job[];
  recent(limit?: number): Job[];
  counts(loopId?: string): JobCounts;
  /** Work attributed to one developer, grouped by queue state. */
  countsByActor(actorId: string): JobCounts;
  /** Queued + leased work by loop, without aggregating finished history. */
  activeCounts(loopIds: readonly string[]): Map<string, number>;
  activeTotal(): number;
  queuePressure(now?: Date): { ready: number; oldestReadyAgeMs: number };
  /**
   * The most recent job that died on this exact dedupe key, if any.
   *
   * A discoverer checks this before enqueueing. Without it, a job that fails
   * every attempt is re-enqueued on the next tick — a permanently broken merge
   * request would start a fresh Claude container every couple of minutes,
   * forever. Keyed on the dedupe key rather than the subject, so a *new* version
   * of the same subject is still admitted: the fingerprint is part of the key.
   */
  deadFor(dedupeKey: string): Job | null;
  /** Operator retry of a job that exhausted its attempts. */
  revive(id: string): boolean;
  /** Administrative hold applies only while pending and does not spend an attempt. */
  hold(id: string, reason?: string): boolean;
  resume(id: string): boolean;
  setPriority(id: string, priority: number): boolean;
  supersede(
    id: string,
    replacementJobId: string,
    reason: string,
    includeRunning?: boolean,
  ): boolean;
  controlState(id: string): JobControlState | null;
  purgeFinished(before: Date, limit?: number): number;
  /** Report-only retention preview; no row is changed by this read. */
  retentionCounts(before: Date): { done: number; deadProtected: number; deadRemovable: number };
  /**
   * Operator cancel of one job. False when it is already finished.
   *
   * Must be called *before* the job's run is aborted — see the implementation
   * for why the order is what makes the cancel stick.
   */
  cancelJob(id: string, reason: string): boolean;
  cancelLoop(loopId: string, reason: string): number;
}

// `TaskSpawner` used to live here: the interface a loop reached through to create
// a `task_instances` row per merge request and run it. Both loops enqueue now, so
// a unit of work is a `jobs` row that finishes and ages out rather than a
// configuration row that accumulates forever. See `core/job.ts`.

export interface ScheduledTaskRow {
  enabled: boolean;
  trigger: Trigger;
  maxItemsPerRun: number;
  params: unknown;
}

export interface ScheduleRepository {
  all(): Map<string, ScheduledTaskRow>;
  get(taskId: string): ScheduledTaskRow | null;
  setConfig(taskId: string, patch: Partial<ScheduledTaskRow>): void;
  clear(taskId: string): void;
}

export type Visibility = "public" | "private";

export interface TaskInstance {
  id: string;
  definitionId: string;
  name: string;
  description?: string;
  createdAt: Date;
  visibility: Visibility;
  /** Creator of a private instance. Public and legacy instances may have no owner. */
  ownerId?: string;
  /** Per-loop prompt override. Null/undefined means use the global template. */
  promptTemplate?: string;
}

export interface CreateTaskInstanceInput {
  id?: string;
  definitionId: string;
  name: string;
  description?: string;
  visibility?: Visibility;
  ownerId?: string;
  promptTemplate?: string;
}

export interface UpdateTaskInstanceInput {
  name?: string;
  description?: string | null;
  promptTemplate?: string | null;
}

export interface InstanceRepository {
  all(): TaskInstance[];
  get(id: string): TaskInstance | null;
  create(input: CreateTaskInstanceInput): TaskInstance;
  update(id: string, input: UpdateTaskInstanceInput): void;
  delete(id: string): void;
}

export interface GeneralConfigOverrides {
  logLevel: LogLevel | null;
  timezone: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  llmEffort: string | null;
  llmMaxTokens: number | null;
}

export interface GeneralConfigRepository {
  get(): GeneralConfigOverrides;
  setConfig(patch: Partial<GeneralConfigOverrides>): void;
  clear(): void;
}

/**
 * Operator overrides for the LLM prompts the agent tasks build. Keyed by
 * prompt id (`code-review`, `mr-follow-up`, `jira-ticket-to-mr`, ...); an id
 * absent from `get()` means "use the hardcoded default" — see
 * `config/resolve-prompts.ts`.
 */
export interface PromptTemplateRepository {
  get(): Record<string, string>;
  /** `null` deletes the override, reverting that prompt to its default. */
  setTemplate(id: string, template: string | null): void;
  /** Reverts every prompt to its default when `id` is omitted. */
  clear(id?: string): void;
}

/** One in-app notification, surfaced by the topbar Bell. */
export interface NotificationRecord {
  id: string;
  kind: string;
  title: string;
  body?: string;
  link?: string;
  taskRunId?: string;
  /** The job this notification was raised for, if any — see `deleteByJob`. */
  jobId?: string;
  createdAt: Date;
  readAt?: Date;
}

export interface CreateNotificationInput {
  kind: string;
  title: string;
  body?: string;
  link?: string;
  taskRunId?: string;
  jobId?: string;
}

/** Global, not per-user — see the `notifications` migration for why. */
export interface NotificationRepository {
  create(input: CreateNotificationInput): NotificationRecord;
  list(options?: { unreadOnly?: boolean; limit?: number }): NotificationRecord[];
  unreadCount(): number;
  markRead(id: string): void;
  markAllRead(): void;
  /**
   * Removes any notification raised for this job — called once the job
   * finishes (success or dead), so a "queued"/"running" notice does not
   * outlive the work it was about.
   */
  deleteByJob(jobId: string): void;
}

export interface TaskRunSummary {
  executionId: string;
  taskId: string;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  status: "running" | RunStatus;
  dryRun: boolean;
  params?: unknown;
  itemsSeen?: number;
  itemsProcessed?: number;
  itemsSkipped?: number;
  error?: string;
  details?: Record<string, unknown>;
  /** Set only for a run whose params name a single merge request. */
  projectId?: string;
  mrIid?: number;
}

export interface RunStats {
  total: number;
  successes: number;
  failures: number;
  avgDurationMs: number | null;
}

/** The run facts a task-list row needs, fetched in batches by repository adapters. */
export interface TaskRunMetrics {
  lastRun: TaskRunSummary | null;
  stats: RunStats;
}

export interface RunRepository extends TaskExecutionSink {
  runStarted(record: Parameters<TaskExecutionSink["runStarted"]>[0]): Promise<void>;
  runFinished(record: TaskExecutionRecord): Promise<void>;
  recentRuns(taskId: string, limit?: number, offset?: number): TaskRunSummary[];
  recentRunsFor(taskIds: readonly string[], limitPerTask?: number): Map<string, TaskRunSummary[]>;
  resourcesForRuns(executionIds: readonly string[]): Map<string, Array<{
    kind: "ticket" | "merge-request";
    key: string;
    provenance: string;
  }>>;
  lastRun(taskId: string): TaskRunSummary | null;
  /**
   * Every run against one merge request, whoever started it — a button click or
   * a loop tick. The job queue's `manualActionHistory` answers only the former.
   */
  runsFor(
    projectId: string,
    mrIid: number,
    limit?: number,
    offset?: number,
  ): TaskRunSummary[];
  countFor(projectId: string, mrIid: number): number;
  getRun(executionId: string): TaskRunSummary | null;
  /** Batch form used by polling views that render many completed action results. */
  getRuns(executionIds: readonly string[]): Map<string, TaskRunSummary>;
  closeOpenRun(
    executionId: string,
    args: { status: RunStatus; error: string; finishedAt?: Date },
  ): boolean;
  lastSuccessfulRun(taskId: string): TaskRunSummary | null;
  appendLog(executionId: string, line: ExecutionLogLine): void;
  /**
   * The concrete snapshot the most recent run that requested `alias` actually
   * reported at startup (the `claude started (<model>)` log line), or `null`
   * if no run has used that alias yet. Ground truth for what an alias
   * currently resolves to, since that resolution happens inside the agent
   * image's CLI, not in this codebase.
   */
  lastResolvedModel(alias: string): { model: string; ts: string } | null;
  logs(executionId: string): ExecutionLogLine[];
  /**
   * An ordered, bounded suffix of an execution's log. `afterId` is exclusive,
   * so a client can resume without re-reading the log it has already rendered.
   */
  logPage(executionId: string, afterId: number, limit: number): {
    lines: ExecutionLogLine[];
    hasMore: boolean;
  };
  /** Newest bounded page, or the page immediately preceding `beforeId`. */
  logTail(executionId: string, beforeId: number | undefined, limit: number): {
    lines: ExecutionLogLine[];
    hasOlder: boolean;
  };
  steps(executionId: string): StepRecord[];
  findOrphanedRuns(): TaskRunSummary[];
  closeOrphanedRuns(reason: string): number;
  stats(taskId: string): RunStats;
  metricsFor(taskIds: readonly string[]): Map<string, TaskRunMetrics>;
  /** Report-only raw execution-history retention preview. */
  retentionCounts(before: Date): { runs: number; logs: number };
  rawLogRetentionCount(before: Date): number;
  purgeRawLogs(before: Date, limit?: number): number;
  purgeFinishedRuns(before: Date, limit?: number): number;
  /** Flushes and stops background persistence work before the database closes. */
  close(): void;
  logBufferStats(): {
    records: number;
    bytes: number;
    dropped: number;
    busyRetries: number;
    writeErrors: number;
    batches: number;
  };
}
