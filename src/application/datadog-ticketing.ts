import type {
  DatadogIssue,
  DatadogIssueRepository,
  DatadogRoutingRepository,
  DatadogServiceTargetRepository,
  SubjectRepository,
} from "./ports.ts";
import type { TaskConnectorFactory } from "./gateways.ts";
import type { DatadogProblemFinding } from "./datadog-scan.ts";
import { route } from "./datadog-triage.ts";
import {
  datadogFingerprintLabel,
  datadogTicketDescription,
  datadogTicketLabels,
  datadogTicketSummary,
  defaultDatadogServiceTarget,
} from "./datadog-ticket.ts";
import {
  extractJiraIssueKey,
  looksLikeEmail,
} from "../connectors/jira/client.ts";
import { isResolved } from "../connectors/jira/types.ts";
import { datadogSite, logExplorerUrl } from "../connectors/datadog/client.ts";
import { ConfigError } from "../core/errors.ts";
import { describeError } from "../core/executor.ts";
import { NO_RETRY } from "../core/retry.ts";
import { mutate } from "../core/step.ts";
import type { TaskContext } from "../core/task.ts";
import type { Logger } from "../logging/logger.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import {
  DATADOG_REGRESSION_POLICY,
  isImmediateDatadogSeverity,
} from "../../shared/datadog-policy.ts";

export type DatadogTicketAction =
  | "filed"
  | "adopted"
  | "existing"
  | "activePr"
  | "held"
  | "dismissed"
  | "deferred"
  | "suppressed"
  | "failed";

export interface DatadogTicketOutcome {
  action: DatadogTicketAction;
  title: string;
  issueKey?: string;
  issueUrl?: string;
  mrUrl?: string;
  reason?: string;
}

export interface DatadogTicketingSummary {
  filed: number;
  adopted: number;
  existing: number;
  activePr: number;
  held: number;
  dismissed: number;
  deferred: number;
  suppressed: number;
  failed: number;
  outcomes: DatadogTicketOutcome[];
}

export interface DatadogTicketingDeps {
  issues: DatadogIssueRepository;
  routing: DatadogRoutingRepository;
  subjects: SubjectRepository;
  serviceTargets?: DatadogServiceTargetRepository;
  connectors: TaskConnectorFactory;
}

export interface DatadogJiraTicketConfig {
  project?: string;
  issueType: string;
  assigneeMode: "automatic" | "fixed";
  assignee?: string;
  boardId?: number;
  useActiveSprint: boolean;
  labels: string[];
  bugFoundBy?: string;
  feBeUx?: string;
}

const DEFAULT_ISSUE_TYPE = "Bug";
const CLAIM_LOOP_ID = "datadog-regression-ticket-claims";

/**
 * Turns one scan's problem findings into Jira lifecycle decisions.
 *
 * Scanning and filing remain separate phases: the Datadog tables are refreshed
 * even when Jira is down, while each problem's external writes are isolated.
 */
export async function ticketDatadogRegressions(
  ctx: TaskContext,
  problems: readonly DatadogProblemFinding[],
  deps: DatadogTicketingDeps,
  config?: DatadogJiraTicketConfig,
): Promise<DatadogTicketingSummary> {
  const summary: DatadogTicketingSummary = {
    filed: 0,
    adopted: 0,
    existing: 0,
    activePr: 0,
    held: 0,
    dismissed: 0,
    deferred: 0,
    suppressed: 0,
    failed: 0,
    outcomes: [],
  };
  const jira = deps.connectors.jira(ctx);
  let gitlab: ReturnType<TaskConnectorFactory["gitlab"]> | undefined;
  const getGitlab = () => (gitlab ??= deps.connectors.gitlab(ctx));
  let writes = 0;

  const ordered = [...problems].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.eventCount - a.eventCount,
  );

  for (const problem of ordered) {
    if (ctx.signal.aborted) break;
    try {
      const outcome = await ctx.step(
        `jira:${problem.memberFingerprints[0]?.slice(0, 12) ?? problem.key.slice(0, 12)}`,
        () =>
          decideProblem(ctx, problem, deps, config, {
            jira,
            getGitlab,
            canFile: writes < ctx.maxItemsPerRun,
            consumeFile: () => {
              writes++;
            },
          }),
        { retry: NO_RETRY, meta: { title: problem.title, severity: problem.severity } },
      );
      summary[outcome.action]++;
      summary.outcomes.push(outcome);
    } catch (error) {
      const reason = describeError(error);
      ctx.logger.error(
        { problem: problem.title, error: reason },
        `could not reconcile or file Jira work for Datadog problem "${problem.title}"`,
      );
      summary.failed++;
      summary.outcomes.push({ action: "failed", title: problem.title, reason });
    }
  }

  return summary;
}

async function decideProblem(
  ctx: TaskContext,
  problem: DatadogProblemFinding,
  deps: DatadogTicketingDeps,
  config: DatadogJiraTicketConfig | undefined,
  clients: {
    jira: ReturnType<TaskConnectorFactory["jira"]>;
    getGitlab: () => ReturnType<TaskConnectorFactory["gitlab"]>;
    canFile: boolean;
    consumeFile: () => void;
  },
): Promise<DatadogTicketOutcome> {
  if (problem.dismissed) {
    return { action: "dismissed", title: problem.title, reason: "dismissed on Datadog page" };
  }

  const primary = problem.members[0];
  if (!primary) {
    const action =
      isImmediateDatadogSeverity(problem.severity) ||
      problem.confirmedOnPriorDailyScan
        ? "suppressed"
        : "held";
    return {
      action,
      title: problem.title,
      reason: ctx.dryRun ? "dry run: no local issue rows written" : "problem has no stored members",
    };
  }

  const knownKeys = [
    ...new Set([
      ...problem.previousJiraIssueKeys,
      ...problem.members.flatMap((member) => member.jiraIssueKey ?? []),
    ]),
  ];
  for (const issueKey of knownKeys) {
    const issue = await clients.jira.issue(issueKey, ctx.signal);
    if (issue && !isResolved(issue)) {
      if (!ctx.dryRun) {
        for (const member of problem.members) deps.issues.link(member.id, issueKey);
        track(ctx, deps, problem, issueKey, clients.jira.issueUrl(issueKey), "existing");
        closeClaim(deps, problem, `tracking open ${issueKey}`);
      }
      return ticketOutcome(clients.jira, problem, "existing", issueKey, "Jira issue is open");
    }

    const activeMr = await findActiveMr(
      problem.service,
      issueKey,
      deps,
      clients.getGitlab(),
      ctx,
    );
    if (activeMr) {
      if (!ctx.dryRun) {
        for (const member of problem.members) deps.issues.link(member.id, issueKey);
        track(
          ctx,
          deps,
          problem,
          issueKey,
          clients.jira.issueUrl(issueKey),
          "activePr",
          activeMr.web_url,
        );
        closeClaim(deps, problem, `${issueKey} has active merge request`);
      }
      return {
        ...ticketOutcome(
          clients.jira,
          problem,
          "activePr",
          issueKey,
          "resolved Jira issue still has an active merge request",
        ),
        mrUrl: activeMr.web_url,
      };
    }
    if (!ctx.dryRun) {
      const tracked = deps.subjects.findOpenByExternalRef(ctx.taskId, issueKey);
      if (tracked) deps.subjects.close(ctx.taskId, tracked.subjectKey, `${issueKey} resolved`);
      closeClaim(deps, problem, `${issueKey} resolved`);
    }
  }

  const project = jiraProjectFor(ctx, primary, deps.routing, config?.project);
  if (!project) {
    throw new ConfigError(
      `No Jira project is configured for Datadog service ${primary.service ?? "unknown"}.`,
    );
  }

  const orphaned = await findFingerprintJiraIssues(
    ctx,
    clients.jira,
    project,
    problem.memberFingerprints,
  );
  const openOrphan = orphaned.find((issue) => !issue.resolved);
  if (openOrphan) {
    if (!ctx.dryRun) {
      for (const member of problem.members) deps.issues.link(member.id, openOrphan.key);
      track(
        ctx,
        deps,
        problem,
        openOrphan.key,
        clients.jira.issueUrl(openOrphan.key),
        "adopted",
      );
      closeClaim(deps, problem, "adopted existing Jira issue");
    }
    return ticketOutcome(
      clients.jira,
      problem,
      "adopted",
      openOrphan.key,
      "adopted by fingerprint label",
    );
  }
  for (const orphan of orphaned) {
    const activeMr = await findActiveMr(
      problem.service,
      orphan.key,
      deps,
      clients.getGitlab(),
      ctx,
    );
    if (!activeMr) continue;
    if (!ctx.dryRun) {
      for (const member of problem.members) deps.issues.link(member.id, orphan.key);
      track(
        ctx,
        deps,
        problem,
        orphan.key,
        clients.jira.issueUrl(orphan.key),
        "activePr",
        activeMr.web_url,
      );
      closeClaim(deps, problem, "resolved Jira issue has active merge request");
    }
    return {
      ...ticketOutcome(
        clients.jira,
        problem,
        "activePr",
        orphan.key,
        "resolved fingerprint-labelled issue still has an active merge request",
      ),
      mrUrl: activeMr.web_url,
    };
  }

  const historicalUnticketed =
    !problem.isNew &&
    knownKeys.length === 0 &&
    problem.members.every(
      (member) =>
        member.scanCount > DATADOG_REGRESSION_POLICY.historicalScanCount ||
        member.lastScanAt.getTime() - member.firstSeenAt.getTime() >
          DATADOG_REGRESSION_POLICY.confirmationMaxHours * 3_600_000,
    );
  if (historicalUnticketed) {
    return {
      action: "held",
      title: problem.title,
      reason: "pre-existing problem predates automated Jira tracking",
    };
  }

  const confirmed =
    isImmediateDatadogSeverity(problem.severity) ||
    problem.confirmedOnPriorDailyScan ||
    knownKeys.length > 0;
  if (!confirmed) {
    return {
      action: "held",
      title: problem.title,
      reason: "medium/low problem needs a second daily observation",
    };
  }
  if (!clients.canFile) {
    return {
      action: "deferred",
      title: problem.title,
      reason: `run ticket cap of ${ctx.maxItemsPerRun} reached`,
    };
  }
  if (ctx.dryRun) {
    return { action: "suppressed", title: problem.title, reason: "dry run: would file" };
  }

  const claimKey = problemSubjectKey(problem);
  let claim = deps.subjects.open({
    loopId: CLAIM_LOOP_ID,
    subjectKey: claimKey,
    fingerprint: memberFingerprint(problem),
    metadata: subjectMetadata(problem, "claim"),
  });
  if (!claim) {
    const existingClaim = deps.subjects.findOpen(CLAIM_LOOP_ID, claimKey);
    if (
      existingClaim &&
      !existingClaim.externalRef &&
      Date.now() - existingClaim.updatedAt.getTime() > 60 * 60_000
    ) {
      deps.subjects.close(CLAIM_LOOP_ID, claimKey, "stale ticketing claim");
      claim = deps.subjects.open({
        loopId: CLAIM_LOOP_ID,
        subjectKey: claimKey,
        fingerprint: memberFingerprint(problem),
        metadata: subjectMetadata(problem, "claim"),
      });
    }
  }
  if (!claim) {
    return {
      action: "deferred",
      title: problem.title,
      reason: "another run is already processing this problem",
    };
  }

  const explorerUrl = logExplorerUrl(datadogSite(ctx.secrets), primary.query, {
    from: primary.firstSeenAt,
    to: primary.lastSeenAt,
  });
  const target = await resolveDatadogJiraTarget(
    {
      secrets: ctx.secrets,
      logger: ctx.logger,
      signal: ctx.signal,
    },
    clients.jira,
    project,
    config,
  );
  let created: Awaited<ReturnType<typeof clients.jira.createIssue>>;
  try {
    clients.consumeFile();
    created = (await mutate(
      ctx,
      `file a Jira ${target.issueType} in ${project} for ${problem.title}`,
      () =>
        clients.jira.createIssue({
          projectKey: project,
          issueType: target.issueType,
          summary: datadogTicketSummary(primary),
          description: datadogTicketDescription(primary, problem.members, explorerUrl),
          labels: datadogTicketLabels(
            primary,
            problem.memberFingerprints,
            target.labels,
          ),
          ...(target.assigneeAccountId
            ? { assigneeAccountId: target.assigneeAccountId }
            : {}),
          ...(target.sprintId != null ? { sprintId: target.sprintId } : {}),
          ...(Object.keys(target.extraFields).length > 0
            ? { extraFields: target.extraFields }
            : {}),
          signal: ctx.signal,
        }),
      { problem: problem.title, service: problem.service, severity: problem.severity },
    ))!;
  } catch (error) {
    deps.subjects.close(CLAIM_LOOP_ID, claimKey, "Jira create failed");
    throw error;
  }

  for (const member of problem.members) deps.issues.link(member.id, created.key);
  track(ctx, deps, problem, created.key, clients.jira.issueUrl(created.key), "filed");
  closeClaim(deps, problem, `filed ${created.key}`);
  return ticketOutcome(clients.jira, problem, "filed", created.key);
}

function track(
  ctx: TaskContext,
  deps: DatadogTicketingDeps,
  problem: DatadogProblemFinding,
  issueKey: string,
  issueUrl: string,
  action: "filed" | "adopted" | "existing" | "activePr",
  mrUrl?: string,
): void {
  const metadata = {
    ...subjectMetadata(problem, action),
    ...(mrUrl ? { mrUrl } : {}),
  };
  const fingerprint = memberFingerprint(problem);
  const subjectKey = problemSubjectKey(problem);
  const existing =
    deps.subjects.findOpen(ctx.taskId, subjectKey) ??
    deps.subjects.findOpenByExternalRef(ctx.taskId, issueKey);
  if (existing) {
    deps.subjects.observe({
      loopId: ctx.taskId,
      subjectKey: existing.subjectKey,
      fingerprint,
      externalRef: issueKey,
      externalUrl: issueUrl,
      metadata,
    });
    deps.subjects.markActedOn(ctx.taskId, existing.subjectKey, fingerprint, {
      externalRef: issueKey,
      externalUrl: issueUrl,
      metadata,
    });
    return;
  }
  deps.subjects.open({
    loopId: ctx.taskId,
    subjectKey,
    fingerprint,
    externalRef: issueKey,
    externalUrl: issueUrl,
    metadata,
  });
}

async function findFingerprintJiraIssues(
  ctx: TaskContext,
  jira: ReturnType<TaskConnectorFactory["jira"]>,
  project: string,
  fingerprints: readonly string[],
): Promise<{ key: string; resolved: boolean }[]> {
  const labels = fingerprints.map(datadogFingerprintLabel);
  if (labels.length === 0) return [];
  const quoted = labels.map((label) => `"${label}"`).join(", ");
  const jql = `project = "${project}" AND labels in (${quoted}) ORDER BY created DESC`;
  const matches = await jira.searchIssues(jql, {
    limit: 20,
    fields: ["summary", "status", "assignee"],
    signal: ctx.signal,
  });
  return matches.map((issue) => ({ key: issue.key, resolved: isResolved(issue) }));
}

async function findActiveMr(
  service: string | undefined,
  issueKey: string,
  deps: DatadogTicketingDeps,
  gitlab: ReturnType<TaskConnectorFactory["gitlab"]>,
  ctx: TaskContext,
) {
  if (!service) return undefined;
  const project =
    deps.serviceTargets?.get(service)?.projectId ??
    defaultDatadogServiceTarget(service).projectId;
  const mergeRequests = await gitlab.listMergeRequests(project, {
    state: "opened",
    drafts: "include",
    // The connector paginates this through its full safety bound. Branch names
    // are not covered by GitLab's `search`, so a server-side text search alone
    // would miss the common `fix/TP-1234` linkage.
    limit: 2000,
    signal: ctx.signal,
  });
  return mergeRequests.find(
    (mr) =>
      extractJiraIssueKey(mr.source_branch, mr.title, mr.description ?? undefined) === issueKey,
  );
}

export interface ResolvedDatadogJiraTarget {
  issueType: string;
  labels: string[];
  assigneeAccountId?: string;
  sprintId?: number;
  extraFields: Record<string, unknown>;
}

export async function resolveDatadogJiraTarget(
  context: {
    secrets: SecretStore;
    logger: Logger;
    signal?: AbortSignal;
  },
  jira: ReturnType<TaskConnectorFactory["jira"]>,
  project: string,
  config: DatadogJiraTicketConfig | undefined,
): Promise<ResolvedDatadogJiraTarget> {
  const issueType =
    config?.issueType ||
    context.secrets.get("DATADOG_JIRA_ISSUE_TYPE")?.trim() ||
    DEFAULT_ISSUE_TYPE;

  let assigneeAccountId: string | undefined;
  if (config) {
    const assignee =
      config.assigneeMode === "fixed"
        ? config.assignee
        : context.secrets.get("JIRA_EMAIL")?.trim();
    if (assignee) {
      assigneeAccountId = looksLikeEmail(assignee)
        ? await jira.accountIdForEmail(assignee, context.signal)
        : assignee;
    }
  }

  const sprintField = await jira.findSprintFieldId(context.signal);
  if (!sprintField) {
    throw new ConfigError(
      `Datadog tickets require an active sprint, but Jira project ${project} has no sprint field.`,
    );
  }
  const resolved = await jira.resolveActiveSprint({
    projectKey: project,
    boardId: config?.boardId,
    signal: context.signal,
  });
  const sprintId = resolved.sprint?.id;
  if (sprintId == null) {
    throw new ConfigError(
      `Datadog tickets require an active sprint for ${project}: ` +
        `${resolved.reason ?? "none was found"}.`,
    );
  }

  const selectFields = [
    ...(config?.bugFoundBy
      ? [{ name: "Bug found by", value: config.bugFoundBy }]
      : []),
    ...(config?.feBeUx ? [{ name: "FE/BE/UX", value: config.feBeUx }] : []),
  ];
  const extraFields =
    selectFields.length > 0
      ? await jira.extraSelectFields(selectFields, context.signal)
      : {};

  return {
    issueType,
    labels: config?.labels ?? [],
    ...(assigneeAccountId ? { assigneeAccountId } : {}),
    sprintId,
    extraFields,
  };
}

function jiraProjectFor(
  ctx: TaskContext,
  issue: DatadogIssue,
  routing: DatadogRoutingRepository,
  configuredProject?: string,
): string | undefined {
  const matched = route(
    {
      service: issue.service,
      source: issue.source,
      kubeNamespace: issue.kubeNamespace,
      env: issue.env,
      host: issue.host,
      signature: issue.signature,
    },
    routing.list(),
  );
  if (matched.jiraProject) return matched.jiraProject;
  if (configuredProject?.trim()) return configuredProject.trim().toUpperCase();
  return ctx.secrets.get("DATADOG_JIRA_PROJECT")?.trim() || undefined;
}

function ticketOutcome(
  jira: ReturnType<TaskConnectorFactory["jira"]>,
  problem: DatadogProblemFinding,
  action: "filed" | "adopted" | "existing" | "activePr",
  issueKey: string,
  reason?: string,
): DatadogTicketOutcome {
  return {
    action,
    title: problem.title,
    issueKey,
    issueUrl: jira.issueUrl(issueKey),
    ...(reason ? { reason } : {}),
  };
}

function problemSubjectKey(problem: DatadogProblemFinding): string {
  return `datadog:problem:${[...problem.memberFingerprints].sort()[0] ?? problem.key}`;
}

function memberFingerprint(problem: DatadogProblemFinding): string {
  return problem.memberFingerprints.slice().sort().join(":");
}

function closeClaim(
  deps: DatadogTicketingDeps,
  problem: DatadogProblemFinding,
  reason: string,
): void {
  deps.subjects.close(CLAIM_LOOP_ID, problemSubjectKey(problem), reason);
}

function subjectMetadata(
  problem: DatadogProblemFinding,
  action: string,
): Record<string, unknown> {
  return {
    action,
    title: problem.title,
    service: problem.service,
    severity: problem.severity,
    eventCount: problem.eventCount,
    fingerprints: problem.memberFingerprints,
  };
}

function severityRank(severity: DatadogProblemFinding["severity"]): number {
  return ["critical", "high", "medium", "low"].indexOf(severity);
}
