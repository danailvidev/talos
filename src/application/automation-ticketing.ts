import { createHash } from "node:crypto";

import type {
  AutomationAiTriageRecord,
  AutomationAiTriageRepository,
  AutomationConfig,
  AutomationConfigRepository,
  AutomationFailureClusterDetail,
  AutomationFailureClusterWork,
  AutomationRepository,
} from "./ports.ts";
import type { GitLabClient } from "../connectors/gitlab/client.ts";
import type { MergeRequest } from "../connectors/gitlab/types.ts";
import type { JiraClient } from "../connectors/jira/client.ts";
import {
  bulletList,
  codeBlock,
  doc,
  heading,
  linkParagraph,
  paragraph,
  rule,
} from "../connectors/jira/adf.ts";
import { ConfigError } from "../core/errors.ts";

const CLAIM_STALE_MS = 15 * 60_000;
const MAX_OPEN_MRS = 2_000;
const MAX_TICKET_TESTS = 30;
const MAX_PIPELINE_TICKET_TESTS = 100;
const MAX_DIAGNOSTIC_CHARS = 8_000;

type AutomationJiraGateway = Pick<
  JiraClient,
  | "myself"
  | "accountIdForEmail"
  | "resolveActiveSprint"
  | "searchIssues"
  | "createIssue"
  | "issueUrl"
>;

type AutomationGitLabGateway = Pick<GitLabClient, "listMergeRequests">;

export type AutomationTicketAction =
  | "created"
  | "adopted"
  | "existing-ticket"
  | "active-mr"
  | "creating";

export interface AutomationTicketResult {
  signatureKey: string;
  action: AutomationTicketAction;
  triageState: "untriaged" | "ticketed" | "active-mr";
  jiraKey?: string;
  jiraUrl?: string;
  mrIid?: number;
  mrUrl?: string;
  sprint: {
    applied: boolean;
    fallbackReason?: string;
  };
}

export interface AutomationTicketDraft {
  projectKey: string;
  parentKey?: string;
  summary: string;
  description: string;
}

export interface AutomationTicketInput {
  summary: string;
  description: string;
  parentKey?: string;
}

export interface AutomationBulkTicketOutcome {
  signatureKey: string;
  ok: boolean;
  result?: AutomationTicketResult;
  error?: string;
}

export interface AutomationTicketServiceDeps {
  config: AutomationConfigRepository;
  automation: AutomationRepository;
  aiTriage?: AutomationAiTriageRepository;
  jira: () => AutomationJiraGateway;
  gitlab: () => AutomationGitLabGateway;
  now?: () => Date;
}

/**
 * The idempotent boundary between a stored failure cluster and external work.
 *
 * The database claim is acquired before Jira is searched or written. If the
 * process dies after Jira accepts a create but before the local row is updated,
 * stale recovery searches by the deterministic label and adopts that issue.
 */
export class AutomationTicketService {
  constructor(private readonly deps: AutomationTicketServiceDeps) {}

  draft(
    pipelineId: number,
    signatureKey: string,
  ): AutomationTicketDraft {
    const config = this.deps.config.get();
    if (!config) throw new ConfigError("Automation is not configured.");
    if (!config.jira) {
      throw new ConfigError("Automation Jira ticketing is not configured.");
    }
    const pipeline = this.deps.automation.getPipeline(
      config.projectId,
      pipelineId,
      { includeFailureDiagnostics: false },
    );
    if (
      !pipeline ||
      !config.schedules.some((schedule) => schedule.scheduleId === pipeline.scheduleId)
    ) {
      throw new ConfigError(`Automation pipeline ${pipelineId} was not found.`);
    }
    const cluster = this.deps.automation.getFailureCluster(
      config.projectId,
      pipelineId,
      signatureKey,
      100,
    );
    if (!cluster) {
      throw new ConfigError(
        `Failure cluster '${signatureKey}' is not part of Automation pipeline ${pipelineId}.`,
      );
    }
    return {
      projectKey: config.jira.projectKey,
      ...(config.jira.parentKey ? { parentKey: config.jira.parentKey } : {}),
      summary: automationTicketSummary(cluster, config),
      description: automationTicketIntroduction(cluster, config),
    };
  }

  async ticket(
    pipelineId: number,
    signatureKey: string,
    input?: AutomationTicketInput,
    signal?: AbortSignal,
  ): Promise<AutomationTicketResult> {
    const prepared = await this.prepare(pipelineId, [signatureKey], signal);
    const cluster = prepared.clusters.get(signatureKey);
    if (!cluster) {
      throw new ConfigError(
        `Failure cluster '${signatureKey}' is not part of Automation pipeline ${pipelineId}.`,
      );
    }
    return this.ticketPrepared(
      cluster,
      prepared.config,
      prepared.mergeRequests,
      input,
      signal,
    );
  }

  async ticketBulk(
    pipelineId: number,
    signatureKeys: readonly string[],
    signal?: AbortSignal,
  ): Promise<AutomationBulkTicketOutcome[]> {
    if (signatureKeys.length === 0) {
      throw new ConfigError("At least one failure cluster must be selected.");
    }
    let prepared: Awaited<ReturnType<AutomationTicketService["prepare"]>>;
    try {
      prepared = await this.prepare(pipelineId, signatureKeys, signal);
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return signatureKeys.map((signatureKey) => ({
        signatureKey,
        ok: false,
        error: message,
      }));
    }
    const clusters = signatureKeys.map((signatureKey) =>
      prepared.clusters.get(signatureKey),
    );
    const missingIndex = clusters.findIndex((cluster) => cluster == null);
    if (missingIndex >= 0) {
      const missing = signatureKeys[missingIndex]!;
      return bulkFailure(
        signatureKeys,
        `Failure cluster '${missing}' is not part of Automation pipeline ${pipelineId}.`,
      );
    }

    const selected = clusters as AutomationFailureClusterDetail[];
    const first = selected[0]!;
    const pipelineIdentity = automationPipelineIdentity(
      first.projectId,
      first.scheduleId,
      pipelineId,
    );
    const marker = automationFingerprintMarker(pipelineIdentity);
    const now = this.deps.now?.() ?? new Date();
    const existing = selected.map((cluster) => ({
      cluster,
      work: this.deps.automation.getFailureClusterWork(
          cluster.projectId,
          cluster.scheduleId,
          cluster.signatureKey,
        ),
    }));
    const conflicting = existing.find(
      ({ cluster, work }) =>
        work != null &&
        work.identity !== automationPipelineClusterIdentity(cluster, pipelineId),
    );
    if (conflicting) {
      return bulkFailure(
        signatureKeys,
        "A selected failure already has separate Jira or merge-request work.",
      );
    }
    const covered = existing.find(
      ({ work }) => work?.state === "ticketed" || work?.state === "active-mr",
    )?.work;
    if (covered?.state === "active-mr" && covered.mrIid != null && covered.mrUrl) {
      const works = selected.map((cluster) =>
        this.deps.automation.recordFailureClusterMr({
          projectId: cluster.projectId,
          scheduleId: cluster.scheduleId,
          signatureKey: cluster.signatureKey,
          identity: automationPipelineClusterIdentity(cluster, pipelineId),
          ...(covered.jiraKey ? { jiraKey: covered.jiraKey } : {}),
          ...(covered.jiraUrl ? { jiraUrl: covered.jiraUrl } : {}),
          mrIid: covered.mrIid!,
          mrUrl: covered.mrUrl!,
          now,
        }),
      );
      return bulkSuccess(selected, works, "active-mr");
    }
    if (covered?.jiraKey && covered.jiraUrl) {
      const works = this.recordBulkTicket(
        selected,
        pipelineId,
        covered.jiraKey,
        covered.jiraUrl,
        now,
      );
      return bulkSuccess(selected, works, "existing-ticket");
    }

    const leader = [...selected].sort((a, b) =>
      a.signatureKey.localeCompare(b.signatureKey),
    )[0]!;
    const claim = this.deps.automation.claimFailureCluster(
      leader.projectId,
      leader.scheduleId,
      leader.signatureKey,
      automationPipelineClusterIdentity(leader, pipelineId),
      now,
      new Date(now.getTime() - CLAIM_STALE_MS),
    );
    if (!claim.claimed) {
      if (
        claim.work.identity !==
        automationPipelineClusterIdentity(leader, pipelineId)
      ) {
        return bulkFailure(
          signatureKeys,
          "A selected failure already has separate Jira or merge-request work.",
        );
      }
      if (claim.work.jiraKey && claim.work.jiraUrl) {
        const works = this.recordBulkTicket(
          selected,
          pipelineId,
          claim.work.jiraKey,
          claim.work.jiraUrl,
          now,
        );
        return bulkSuccess(selected, works, "existing-ticket");
      }
      return selected.map((cluster) => ({
        signatureKey: cluster.signatureKey,
        ok: true,
        result: {
          signatureKey: cluster.signatureKey,
          action: "creating",
          triageState: "untriaged",
          sprint: { applied: false },
        },
      }));
    }

    try {
      const markerMr = findMatchingMr(prepared.mergeRequests, marker);
      if (markerMr) {
        const works = selected.map((cluster) =>
          this.deps.automation.recordFailureClusterMr({
            projectId: cluster.projectId,
            scheduleId: cluster.scheduleId,
            signatureKey: cluster.signatureKey,
            identity: automationPipelineClusterIdentity(cluster, pipelineId),
            mrIid: markerMr.iid,
            mrUrl: markerMr.web_url,
            now,
          }),
        );
        return bulkSuccess(selected, works, "active-mr");
      }

      const jira = this.deps.jira();
      const label = automationFingerprintLabel(pipelineIdentity);
      const adopted = (
        await jira.searchIssues(
          `project = "${escapeJql(prepared.config.jira.projectKey)}" ` +
            `AND labels = "${label}" ORDER BY created DESC`,
          { limit: 2, fields: ["summary", "status"], signal },
        )
      )[0];
      if (adopted) {
        const works = this.recordBulkTicket(
          selected,
          pipelineId,
          adopted.key,
          jira.issueUrl(adopted.key),
          now,
        );
        return bulkSuccess(selected, works, "adopted");
      }

      const sprint = prepared.config.jira.useActiveSprint
        ? await jira.resolveActiveSprint({
            projectKey: prepared.config.jira.projectKey,
            ...(prepared.config.jira.boardId != null
              ? { boardId: prepared.config.jira.boardId }
              : {}),
            signal,
          })
        : {};
      const assigneeAccountId =
        prepared.config.jira.assigneeMode === "automatic"
          ? (await jira.myself(signal)).accountId
          : await resolveFixedAssignee(
              jira,
              prepared.config.jira.fixedAssignee!,
              signal,
            );
      const created = await jira.createIssue({
        projectKey: prepared.config.jira.projectKey,
        ...(prepared.config.jira.parentKey
          ? { parentKey: prepared.config.jira.parentKey }
          : {}),
        issueType: prepared.config.jira.issueType,
        summary: automationPipelineTicketSummary(selected, prepared.config),
        description: automationPipelineTicketDescription(
          selected,
          prepared.config,
          marker,
          this.deps.aiTriage,
        ),
        labels: [...new Set([...prepared.config.jira.labels, label])],
        assigneeAccountId,
        ...(sprint.sprint ? { sprintId: sprint.sprint.id } : {}),
        signal,
      });
      const works = this.recordBulkTicket(
        selected,
        pipelineId,
        created.key,
        jira.issueUrl(created.key),
        now,
      );
      const outcomes = bulkSuccess(selected, works, "created");
      for (const outcome of outcomes) {
        if (!outcome.result) continue;
        outcome.result.sprint = sprint.sprint
          ? { applied: true }
          : {
              applied: false,
              ...(prepared.config.jira.useActiveSprint
                ? {
                    fallbackReason:
                      sprint.reason ?? "No active sprint was found; filed in backlog.",
                  }
                : {}),
            };
      }
      return outcomes;
    } catch (error) {
      this.deps.automation.releaseFailureClusterClaim(
        leader.projectId,
        leader.scheduleId,
        leader.signatureKey,
      );
      return bulkFailure(
        signatureKeys,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private recordBulkTicket(
    clusters: readonly AutomationFailureClusterDetail[],
    pipelineId: number,
    jiraKey: string,
    jiraUrl: string,
    now: Date,
  ): AutomationFailureClusterWork[] {
    return clusters.map((cluster) =>
      this.deps.automation.recordFailureClusterTicket({
        projectId: cluster.projectId,
        scheduleId: cluster.scheduleId,
        signatureKey: cluster.signatureKey,
        identity: automationPipelineClusterIdentity(cluster, pipelineId),
        jiraKey,
        jiraUrl,
        now,
      }),
    );
  }

  private async prepare(
    pipelineId: number,
    signatureKeys: readonly string[],
    signal?: AbortSignal,
  ): Promise<{
    config: AutomationConfig & { jira: NonNullable<AutomationConfig["jira"]> };
    clusters: Map<string, AutomationFailureClusterDetail>;
    mergeRequests: MergeRequest[];
  }> {
    const config = this.deps.config.get();
    if (!config) throw new ConfigError("Automation is not configured.");
    if (!config.jira) {
      throw new ConfigError("Automation Jira ticketing is not configured.");
    }
    const pipeline = this.deps.automation.getPipeline(
      config.projectId,
      pipelineId,
      { includeFailureDiagnostics: false },
    );
    if (
      !pipeline ||
      !config.schedules.some((schedule) => schedule.scheduleId === pipeline.scheduleId)
    ) {
      throw new ConfigError(`Automation pipeline ${pipelineId} was not found.`);
    }

    const clusters = new Map<string, AutomationFailureClusterDetail>();
    for (const key of new Set(signatureKeys)) {
      const cluster = this.deps.automation.getFailureCluster(
        config.projectId,
        pipelineId,
        key,
        100,
      );
      if (cluster) clusters.set(key, cluster);
    }

    // One project-wide read is shared by every selected cluster. Jira-key and
    // fingerprint indexes are applied in memory; no test-name matching occurs.
    const mergeRequests = await this.deps.gitlab().listMergeRequests(
      config.projectId,
      {
        state: "opened",
        drafts: "include",
        limit: MAX_OPEN_MRS,
        signal,
      },
    );
    return {
      config: config as AutomationConfig & {
        jira: NonNullable<AutomationConfig["jira"]>;
      },
      clusters,
      mergeRequests,
    };
  }

  private async ticketPrepared(
    cluster: AutomationFailureClusterDetail,
    config: AutomationConfig & { jira: NonNullable<AutomationConfig["jira"]> },
    mergeRequests: readonly MergeRequest[],
    input?: AutomationTicketInput,
    signal?: AbortSignal,
  ): Promise<AutomationTicketResult> {
    const jira = this.deps.jira();
    const identity = automationClusterIdentity(
      cluster.projectId,
      cluster.scheduleId,
      cluster.signatureKey,
    );
    const marker = automationFingerprintMarker(identity);
    const now = this.deps.now?.() ?? new Date();
    let local = this.deps.automation.getFailureClusterWork(
      cluster.projectId,
      cluster.scheduleId,
      cluster.signatureKey,
    );

    if (local?.state === "active-mr") {
      const mr = findMatchingMr(mergeRequests, marker, local.jiraKey);
      if (mr) {
        const updated = this.recordMr(cluster, identity, mr, now, local);
        return resultFromWork(cluster.signatureKey, updated, "active-mr");
      }
      // The project-wide read contains every open MR. Absence means the stored
      // link is no longer active, so downgrade to its ticket or make an
      // MR-only cluster claimable again.
      local = this.deps.automation.clearFailureClusterMr(
        cluster.projectId,
        cluster.scheduleId,
        cluster.signatureKey,
        now,
      );
    }
    if (local?.state === "ticketed") {
      const mr = findMatchingMr(mergeRequests, marker, local.jiraKey);
      if (mr) {
        const updated = this.recordMr(cluster, identity, mr, now, local);
        return resultFromWork(cluster.signatureKey, updated, "active-mr");
      }
      return resultFromWork(cluster.signatureKey, local, "existing-ticket");
    }

    const claim = this.deps.automation.claimFailureCluster(
      cluster.projectId,
      cluster.scheduleId,
      cluster.signatureKey,
      identity,
      now,
      new Date(now.getTime() - CLAIM_STALE_MS),
    );
    if (!claim.claimed) {
      return claim.work.state === "creating"
        ? {
            signatureKey: cluster.signatureKey,
            action: "creating",
            triageState: "untriaged",
            sprint: { applied: false },
          }
        : resultFromWork(cluster.signatureKey, claim.work, "existing-ticket");
    }

    try {
      const markerMr = findMatchingMr(mergeRequests, marker);
      if (markerMr) {
        const updated = this.recordMr(cluster, identity, markerMr, now);
        return resultFromWork(cluster.signatureKey, updated, "active-mr");
      }

      const label = automationFingerprintLabel(identity);
      const adopted = (
        await jira.searchIssues(
          `project = "${escapeJql(config.jira.projectKey)}" AND labels = "${label}" ` +
            "ORDER BY created DESC",
          {
            limit: 2,
            fields: ["summary", "status"],
            signal,
          },
        )
      )[0];
      if (adopted) {
        const jiraUrl = jira.issueUrl(adopted.key);
        const ticket = this.deps.automation.recordFailureClusterTicket({
          projectId: cluster.projectId,
          scheduleId: cluster.scheduleId,
          signatureKey: cluster.signatureKey,
          identity,
          jiraKey: adopted.key,
          jiraUrl,
          now,
        });
        const linkedMr = findMatchingMr(mergeRequests, marker, adopted.key);
        if (linkedMr) {
          const updated = this.recordMr(cluster, identity, linkedMr, now, ticket);
          return resultFromWork(cluster.signatureKey, updated, "active-mr");
        }
        return resultFromWork(cluster.signatureKey, ticket, "adopted");
      }

      const sprint = config.jira.useActiveSprint
        ? await jira.resolveActiveSprint({
            projectKey: config.jira.projectKey,
            ...(config.jira.boardId != null
              ? { boardId: config.jira.boardId }
              : {}),
            signal,
          })
        : {};
      const assigneeAccountId =
        config.jira.assigneeMode === "automatic"
          ? (await jira.myself(signal)).accountId
          : await resolveFixedAssignee(
              jira,
              config.jira.fixedAssignee!,
              signal,
            );
      const created = await jira.createIssue({
        projectKey: config.jira.projectKey,
        ...((input?.parentKey ?? config.jira.parentKey)
          ? { parentKey: input?.parentKey ?? config.jira.parentKey }
          : {}),
        issueType: config.jira.issueType,
        summary: input?.summary ?? automationTicketSummary(cluster, config),
        description: automationTicketDescription(
          cluster,
          config,
          marker,
          currentTriage(this.deps.aiTriage, cluster),
          input?.description,
        ),
        labels: [...new Set([...config.jira.labels, label])],
        assigneeAccountId,
        ...(sprint.sprint ? { sprintId: sprint.sprint.id } : {}),
        signal,
      });
      const stored = this.deps.automation.recordFailureClusterTicket({
        projectId: cluster.projectId,
        scheduleId: cluster.scheduleId,
        signatureKey: cluster.signatureKey,
        identity,
        jiraKey: created.key,
        jiraUrl: jira.issueUrl(created.key),
        now,
      });
      const result = resultFromWork(cluster.signatureKey, stored, "created");
      result.sprint = sprint.sprint
        ? { applied: true }
        : {
            applied: false,
            ...(config.jira.useActiveSprint
              ? {
                  fallbackReason:
                    sprint.reason ?? "No active sprint was found; filed in backlog.",
                }
              : {}),
          };
      return result;
    } catch (error) {
      this.deps.automation.releaseFailureClusterClaim(
        cluster.projectId,
        cluster.scheduleId,
        cluster.signatureKey,
      );
      throw error;
    }
  }

  private recordMr(
    cluster: AutomationFailureClusterDetail,
    identity: string,
    mr: MergeRequest,
    now: Date,
    work?: AutomationFailureClusterWork,
  ): AutomationFailureClusterWork {
    return this.deps.automation.recordFailureClusterMr({
      projectId: cluster.projectId,
      scheduleId: cluster.scheduleId,
      signatureKey: cluster.signatureKey,
      identity,
      ...(work?.jiraKey ? { jiraKey: work.jiraKey } : {}),
      ...(work?.jiraUrl ? { jiraUrl: work.jiraUrl } : {}),
      mrIid: mr.iid,
      mrUrl: mr.web_url,
      now,
    });
  }
}

export function automationClusterIdentity(
  projectId: string,
  scheduleId: number,
  signatureKey: string,
): string {
  return createHash("sha256")
    .update(`${projectId}\u001f${scheduleId}\u001f${signatureKey}`)
    .digest("hex")
    .slice(0, 32);
}

export function automationPipelineIdentity(
  projectId: string,
  scheduleId: number,
  pipelineId: number,
): string {
  return createHash("sha256")
    .update(`${projectId}\u001f${scheduleId}\u001fpipeline\u001f${pipelineId}`)
    .digest("hex")
    .slice(0, 32);
}

function automationPipelineClusterIdentity(
  cluster: AutomationFailureClusterDetail,
  pipelineId: number,
): string {
  return createHash("sha256")
    .update(
      `${cluster.projectId}\u001f${cluster.scheduleId}\u001fpipeline-work` +
        `\u001f${pipelineId}\u001f${cluster.signatureKey}`,
    )
    .digest("hex")
    .slice(0, 32);
}

export function automationFingerprintLabel(identity: string): string {
  return `talos-auto-${identity}`;
}

export function automationFingerprintMarker(identity: string): string {
  return `talos-automation-fingerprint:${identity}`;
}

function findMatchingMr(
  mergeRequests: readonly MergeRequest[],
  marker: string,
  jiraKey?: string,
): MergeRequest | undefined {
  return mergeRequests.find((mr) => {
    const fields = [mr.title, mr.source_branch, mr.description ?? ""];
    if (fields.some((value) => value.includes(marker))) return true;
    return jiraKey != null && fields.some((value) => containsExactKey(value, jiraKey));
  });
}

function containsExactKey(value: string, jiraKey: string): boolean {
  const escaped = jiraKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, "i").test(value);
}

async function resolveFixedAssignee(
  jira: AutomationJiraGateway,
  value: string,
  signal?: AbortSignal,
): Promise<string> {
  return value.includes("@")
    ? jira.accountIdForEmail(value, signal)
    : value;
}

function automationTicketSummary(
  cluster: AutomationFailureClusterDetail,
  config: AutomationConfig,
): string {
  const configured = config.schedules.find(
    (schedule) => schedule.scheduleId === cluster.scheduleId,
  );
  const schedule = configured?.displayName ?? `Schedule ${cluster.scheduleId}`;
  return `[Automation · ${schedule}] ${cluster.title}`;
}

function automationTicketIntroduction(
  cluster: AutomationFailureClusterDetail,
  config: AutomationConfig,
): string {
  const configured = config.schedules.find(
    (schedule) => schedule.scheduleId === cluster.scheduleId,
  );
  const schedule = configured?.displayName ?? `Schedule ${cluster.scheduleId}`;
  return (
    `${cluster.affectedTestCount} distinct test(s) failed in ${schedule}. ` +
    `${cluster.occurrenceCount} failed/error occurrence(s) share this ` +
    "normalized root-cause signature."
  );
}

function automationTicketDescription(
  cluster: AutomationFailureClusterDetail,
  config: AutomationConfig,
  marker: string,
  triage?: AutomationAiTriageRecord,
  introduction?: string,
) {
  const configured = config.schedules.find(
    (schedule) => schedule.scheduleId === cluster.scheduleId,
  );
  const schedule = configured?.displayName ?? `Schedule ${cluster.scheduleId}`;
  const tests = cluster.members
    .slice(0, MAX_TICKET_TESTS)
    .map((member) =>
      member.classname ? `${member.classname} · ${member.name}` : member.name,
    );
  const jobs = [
    ...new Map(
      cluster.members
        .filter((member) => member.jobId != null)
        .map((member) => [
          member.jobId!,
          `${member.jobName ?? `Job ${member.jobId}`} (${member.jobId})`,
        ]),
    ).values(),
  ];
  const screenshot = cluster.members.find(
    (member) => member.attachmentJobId != null && member.attachmentPath,
  );

  return doc(
    paragraph(introduction ?? automationTicketIntroduction(cluster, config)),
    heading("Failure cluster"),
    bulletList([
      `Schedule: ${schedule} (${cluster.scheduleId})`,
      `Signature: ${cluster.title}`,
      `Severity: ${cluster.severity}`,
      `Pipeline: ${cluster.pipelineId}`,
      ...(jobs.length > 0 ? [`Jobs: ${jobs.join(", ")}`] : []),
    ]),
    heading("Affected tests"),
    bulletList(tests),
    cluster.affectedTestCount > tests.length
      ? paragraph(
          `… ${cluster.affectedTestCount - tests.length} additional test(s); ` +
            "see the pipeline cluster detail.",
        )
      : null,
    cluster.representative.systemOutput ? heading("Sample output") : null,
    cluster.representative.systemOutput
      ? codeBlock(capDiagnostic(cluster.representative.systemOutput))
      : null,
    cluster.representative.stackTrace ? heading("Sample stack trace") : null,
    cluster.representative.stackTrace
      ? codeBlock(capDiagnostic(cluster.representative.stackTrace))
      : null,
    triage ? heading("AI triage") : null,
    triage
      ? bulletList([
          `Verdict: ${triage.verdict}`,
          `Confidence: ${Math.round(triage.confidence * 100)}%`,
        ])
      : null,
    triage ? paragraph(`Rationale: ${triage.rationale}`) : null,
    triage ? paragraph(`Recommendation: ${triage.recommendation}`) : null,
    heading("GitLab"),
    linkParagraph(`Pipeline #${cluster.pipelineId}`, cluster.pipelineUrl),
    ...jobLinks(cluster),
    screenshot
      ? linkParagraph(
          `Screenshot: ${screenshot.attachmentName ?? "failure artifact"}`,
          artifactUrl(cluster.pipelineUrl, screenshot.attachmentJobId!, screenshot.attachmentPath!) ??
            cluster.pipelineUrl,
        )
      : null,
    rule(),
    paragraph(marker),
    paragraph("Filed by talos Automation failure triage."),
  );
}

function automationPipelineTicketSummary(
  clusters: readonly AutomationFailureClusterDetail[],
  config: AutomationConfig,
): string {
  const first = clusters[0]!;
  const configured = config.schedules.find(
    (schedule) => schedule.scheduleId === first.scheduleId,
  );
  const schedule = configured?.displayName ?? `Schedule ${first.scheduleId}`;
  const tests = clusters.reduce(
    (total, cluster) => total + cluster.affectedTestCount,
    0,
  );
  return (
    `[Automation · ${schedule}] Pipeline #${first.pipelineId}: ` +
    `${tests} failed test${tests === 1 ? "" : "s"}`
  );
}

function automationPipelineTicketDescription(
  clusters: readonly AutomationFailureClusterDetail[],
  config: AutomationConfig,
  marker: string,
  triageRepository?: AutomationAiTriageRepository,
) {
  const first = clusters[0]!;
  const configured = config.schedules.find(
    (schedule) => schedule.scheduleId === first.scheduleId,
  );
  const schedule = configured?.displayName ?? `Schedule ${first.scheduleId}`;
  const allTests = clusters.flatMap((cluster) =>
    cluster.members.map((member) => {
      const name = member.classname
        ? `${member.classname} · ${member.name}`
        : member.name;
      return `${name} — ${cluster.title}`;
    }),
  );
  const tests = allTests.slice(0, MAX_PIPELINE_TICKET_TESTS);
  const distinctTests = clusters.reduce(
    (total, cluster) => total + cluster.affectedTestCount,
    0,
  );
  const jobs = [
    ...new Map(
      clusters.flatMap((cluster) =>
        cluster.members
          .filter((member) => member.jobId != null)
          .map((member) => [
            member.jobId!,
            `${member.jobName ?? `Job ${member.jobId}`} (${member.jobId})`,
          ] as const),
      ),
    ).values(),
  ];
  const triage = clusters.flatMap((cluster) => {
    const result = currentTriage(triageRepository, cluster);
    return result
      ? [`${cluster.title}: ${result.verdict} (${Math.round(result.confidence * 100)}%)`]
      : [];
  });

  return doc(
    paragraph(
      `${distinctTests} distinct failed test(s) from ${clusters.length} selected ` +
        `failure cluster(s) in ${schedule}.`,
    ),
    heading("Pipeline"),
    bulletList([
      `Schedule: ${schedule} (${first.scheduleId})`,
      `Pipeline: ${first.pipelineId}`,
      ...(jobs.length > 0 ? [`Jobs: ${jobs.join(", ")}`] : []),
    ]),
    heading("Failed tests"),
    bulletList(tests),
    allTests.length > tests.length
      ? paragraph(
          `… ${allTests.length - tests.length} additional failed test(s); ` +
            "see the pipeline for the complete list.",
        )
      : null,
    heading("Failure clusters"),
    bulletList(
      clusters.map(
        (cluster) =>
          `${cluster.title} — ${cluster.affectedTestCount} test(s), ` +
          `${cluster.occurrenceCount} occurrence(s)`,
      ),
    ),
    triage.length > 0 ? heading("AI triage") : null,
    triage.length > 0 ? bulletList(triage) : null,
    heading("GitLab"),
    linkParagraph(`Pipeline #${first.pipelineId}`, first.pipelineUrl),
    ...clusters.flatMap(jobLinks),
    rule(),
    paragraph(marker),
    paragraph("Filed by talos Automation failure triage."),
  );
}

function currentTriage(
  repository: AutomationAiTriageRepository | undefined,
  cluster: AutomationFailureClusterDetail,
): AutomationAiTriageRecord | undefined {
  const result = repository?.get(
    cluster.projectId,
    cluster.scheduleId,
    cluster.signatureKey,
  );
  return result?.signature === cluster.title ? result : undefined;
}

function jobLinks(cluster: AutomationFailureClusterDetail) {
  return [
    ...new Map(
      cluster.members
        .filter((member) => member.jobId != null && member.jobUrl)
        .map((member) => [
          member.jobId!,
          linkParagraph(
            `Job: ${member.jobName ?? member.jobId}`,
            member.jobUrl!,
          ),
        ]),
    ).values(),
  ];
}

function artifactUrl(
  pipelineUrl: string,
  jobId: number,
  path: string,
): string | undefined {
  try {
    const url = new URL(pipelineUrl);
    const marker = url.pathname.indexOf("/-/pipelines/");
    if (marker <= 0) return undefined;
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `${url.origin}${url.pathname.slice(0, marker)}/-/jobs/${jobId}/artifacts/file/${encoded}`;
  } catch {
    return undefined;
  }
}

function capDiagnostic(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_CHARS
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_CHARS)}\n… truncated`;
}

function resultFromWork(
  signatureKey: string,
  work: AutomationFailureClusterWork,
  action: AutomationTicketAction,
): AutomationTicketResult {
  return {
    signatureKey,
    action,
    triageState: work.state === "active-mr" ? "active-mr" : "ticketed",
    ...(work.jiraKey ? { jiraKey: work.jiraKey } : {}),
    ...(work.jiraUrl ? { jiraUrl: work.jiraUrl } : {}),
    ...(work.mrIid != null ? { mrIid: work.mrIid } : {}),
    ...(work.mrUrl ? { mrUrl: work.mrUrl } : {}),
    sprint: { applied: false },
  };
}

function bulkSuccess(
  clusters: readonly AutomationFailureClusterDetail[],
  works: readonly AutomationFailureClusterWork[],
  action: AutomationTicketAction,
): AutomationBulkTicketOutcome[] {
  return clusters.map((cluster, index) => ({
    signatureKey: cluster.signatureKey,
    ok: true,
    result: resultFromWork(cluster.signatureKey, works[index]!, action),
  }));
}

function bulkFailure(
  signatureKeys: readonly string[],
  error: string,
): AutomationBulkTicketOutcome[] {
  return signatureKeys.map((signatureKey) => ({
    signatureKey,
    ok: false,
    error,
  }));
}

function escapeJql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
