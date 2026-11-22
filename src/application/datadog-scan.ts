/**
 * One pass over Datadog's error logs, turned into a triage list.
 *
 * The shape of this is dictated by scale. This install writes ~2M production error
 * logs a day; nothing here may fetch them. So the scan is two-stage, and the
 * stages have very different costs:
 *
 *  1. **Count.** One aggregation gives the exact error volume per service. It
 *     transfers a few hundred bytes and answers "where is the noise", but says
 *     nothing about what the errors are.
 *  2. **Sample.** For every service bucket, a bounded page of log bodies
 *     (default 200) is read and clustered by error shape. That is what turns
 *     "lcm: 1.7M errors" into "lcm: four distinct problems, this one is 80% of it".
 *
 * Counts per issue are therefore *estimates*: the service total (exact) scaled by
 * the cluster's share of the sample. That is stated in the model, in the UI and in
 * the ticket, because an estimate presented as a measurement is how people stop
 * trusting a dashboard.
 *
 * Cost per run is aggregation pagination plus one bounded search per production
 * service. It grows with service count, never with the millions of matching logs.
 */
import {
  clusterSamples,
  fingerprintOf,
  titleOf,
} from "../connectors/datadog/signature.ts";
import type { DatadogClient } from "../connectors/datadog/client.ts";
import type { LogSample } from "../connectors/datadog/types.ts";
import type { Logger } from "../logging/logger.ts";
import { groupIntoProblems } from "./datadog-problems.ts";
import { route, severityOf, type DatadogFacts, type Routing } from "./datadog-triage.ts";
import type {
  DatadogIssue,
  DatadogIssueRepository,
  DatadogRoutingRepository,
  DatadogRoutingRule,
  DatadogSeverity,
} from "./ports.ts";
import { DATADOG_REGRESSION_POLICY } from "../../shared/datadog-policy.ts";

export interface DatadogScanDeps {
  client: DatadogClient;
  issues: DatadogIssueRepository;
  routing: DatadogRoutingRepository;
  logger: Logger;
}

export interface DatadogScanOptions {
  /** Base log search, e.g. `status:error env:prod`. */
  query: string;
  from: Date;
  to: Date;
  /** Service buckets per aggregate page; every page is consumed. */
  maxServices: number;
  /** Log bodies read per service. The estimate's denominator, and the run's cost. */
  samplesPerService: number;
  /** When true, nothing is written — the summary says what a real run would do. */
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface DatadogScanSummary {
  from: Date;
  to: Date;
  /** The query actually sent, including the negations the ignore rules produced. */
  query: string;
  /** Exact total matching logs in the window. */
  totalEvents: number;
  /** Services the aggregation returned, before ignore rules. */
  servicesSeen: number;
  servicesScanned: number;
  /** Services dropped by an ignore rule, for the run log. */
  servicesIgnored: string[];
  /** Distinct clusters found across every scanned service. */
  issuesFound: number;
  /** Root causes those clusters folded into — the number the page actually shows. */
  problemsFound: number;
  /** How many of them are more than one log line. The grouping's own yield. */
  problemsMerged: number;
  issuesRecorded: number;
  /** Clusters an ignore rule dropped after sampling — a signature rule, usually. */
  issuesIgnored: number;
  /** Recorded issues no previous scan had seen. */
  issuesNew: number;
  bySeverity: Record<DatadogSeverity, number>;
  /** True when Datadog answered an aggregation it could not finish scanning. */
  partial: boolean;
  /** Stale rows this run forgot — see `DatadogIssueRepository.pruneStale`. */
  issuesPruned: number;
  /** The issues this run touched, worst first. Empty on a dry run. */
  issues: DatadogIssue[];
  /** Root causes from this pass, with stable member identity for Jira tracking. */
  problems: DatadogProblemFinding[];
}

export interface DatadogProblemFinding {
  /** Scan-local grouping key. Never use this as durable identity. */
  key: string;
  title: string;
  service?: string;
  eventCount: number;
  severity: DatadogSeverity;
  isNew: boolean;
  /** Seen in a preceding daily window, not merely by a nearby manual scan. */
  confirmedOnPriorDailyScan: boolean;
  dismissed: boolean;
  previousJiraIssueKeys: string[];
  /** Persisted members. Empty in dry-run mode. */
  members: DatadogIssue[];
  /** Available in both real and dry runs. */
  memberFingerprints: string[];
}

/**
 * How long a signature survives without being seen again.
 *
 * A week rather than "since the last scan", because occurrence counts come from a
 * bounded sample: a cluster holding two of two hundred sampled bodies genuinely may
 * not appear tomorrow, and pruning on one absence would make small rows flap in and
 * out — losing the `scan_count` and previous count that severity is decided from
 * every time. Seven consecutive absences are not sampling.
 */
const STALE_AFTER_DAYS = DATADOG_REGRESSION_POLICY.staleAfterDays;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 3_600_000;
const DAILY_CONFIRMATION_MIN_MS =
  DATADOG_REGRESSION_POLICY.confirmationMinHours * 3_600_000;
const DAILY_CONFIRMATION_MAX_MS =
  DATADOG_REGRESSION_POLICY.confirmationMaxHours * 3_600_000;

/**
 * Facets whose ignore rules can be pushed into the Datadog query itself.
 *
 * Worth doing rather than filtering afterwards: ignored services need no sample
 * request at all. Excluding them server-side also keeps pagination focused on
 * product services rather than infrastructure noise.
 * `signature` is absent because it is ours, not Datadog's, and cannot be queried.
 */
const QUERYABLE_FACETS = new Set(["service", "source", "kube_namespace", "env", "host"]);

/** One clustered signature, sampled and routed, waiting for its problem. */
interface Candidate {
  service: string;
  signature: string;
  eventCount: number;
  sampleCount: number;
  sampleSize: number;
  sample: LogSample;
  facts: DatadogFacts;
  routing: Routing;
  /** The service-scoped query this cluster came out of, for the row's deep link. */
  serviceQuery: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export async function scanDatadog(
  deps: DatadogScanDeps,
  options: DatadogScanOptions,
): Promise<DatadogScanSummary> {
  const rules = deps.routing.list();
  const query = withExclusions(productionOnlyQuery(options.query), rules);
  const window = { query, from: options.from, to: options.to, ...signalOf(options) };

  const totalEvents = await deps.client.count(window);
  const { groups, partial } = await deps.client.countAllBy(window, [
    { facet: "service", limit: options.maxServices, sortByCount: true },
  ]);

  deps.logger.info(
    { query, services: groups.length, totalEvents, partial },
    `Datadog scan: ${totalEvents.toLocaleString()} error log(s) across ${groups.length} service(s)`,
  );

  const summary: DatadogScanSummary = {
    from: options.from,
    to: options.to,
    query,
    totalEvents,
    servicesSeen: groups.length,
    servicesScanned: 0,
    servicesIgnored: [],
    issuesFound: 0,
    problemsFound: 0,
    problemsMerged: 0,
    issuesRecorded: 0,
    issuesIgnored: 0,
    issuesNew: 0,
    issuesPruned: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    partial,
    issues: [],
    problems: [],
  };

  /**
   * Every cluster the sampling pass turned up, held until all services are in.
   *
   * Nothing is written during the loop below, which is a change from the obvious
   * shape: problem grouping needs to see all of the clusters at once, and a row
   * cannot be recorded before its problem is known.
   */
  const found: Candidate[] = [];

  for (const group of groups) {
    if (options.signal?.aborted) {
      deps.logger.warn("Datadog scan: shutdown requested, stopping between services");
      break;
    }

    const service = group.value.trim();
    if (!service) {
      // Logs with no service facet cannot be isolated by a follow-up query, so
      // there is no way to sample them per-group. Counted, not scanned.
      summary.servicesIgnored.push("(no service)");
      continue;
    }

    // Checked again after the query-level exclusions, because a rule on a facet
    // that is not queryable (or a pattern Datadog's syntax cannot express) still
    // has to be honoured.
    const serviceRouting = route({ service }, rules);
    if (serviceRouting.ignored) {
      summary.servicesIgnored.push(service);
      continue;
    }

    const serviceQuery = `${query} ${term("service", service)}`;
    const samples = (
      await deps.client.sampleLogs(
        { query: serviceQuery, from: options.from, to: options.to, ...signalOf(options) },
        options.samplesPerService,
      )
    ).filter(
      (sample) =>
        sample.tags.env?.toLowerCase() === DATADOG_REGRESSION_POLICY.environment,
    );
    summary.servicesScanned += 1;

    if (samples.length === 0) {
      // Counted in the aggregation but unreadable as events: an index the token
      // cannot search, or logs that rolled out of retention between the two calls.
      deps.logger.warn(
        { service, counted: group.count },
        `Datadog scan: ${service} counted ${group.count} error(s) but returned no log bodies`,
      );
      continue;
    }

    for (const cluster of clusterSamples(samples)) {
      const sample = cluster.sample;
      const facts = factsOf(service, sample, cluster.signature);
      const routing = route(facts, rules);
      summary.issuesFound += 1;

      if (routing.ignored) {
        summary.issuesIgnored += 1;
        continue;
      }

      found.push({
        service,
        signature: cluster.signature,
        // The exact service total, split by this shape's share of the sample.
        eventCount: Math.max(
          1,
          Math.round((group.count * cluster.count) / samples.length),
        ),
        sampleCount: cluster.count,
        sampleSize: samples.length,
        sample,
        facts,
        routing,
        serviceQuery,
        firstSeenAt: cluster.firstSeenAt ?? options.from,
        lastSeenAt: cluster.lastSeenAt ?? options.to,
      });
    }
  }

  // Second grouping pass, after every service has been sampled rather than per
  // service: one root cause routinely spans two of them (the FILE_READ fault is
  // reported by `lcm` and by `ahf`), and grouping inside the service loop could
  // never see that.
  const problems = groupIntoProblems(
    found.map((candidate) => ({
      ...(candidate.service ? { service: candidate.service } : {}),
      signature: candidate.signature,
      eventCount: candidate.eventCount,
      ...(bodyOf(candidate.sample) ? { sampleMessage: bodyOf(candidate.sample) } : {}),
      ...(candidate.sample.errorStack ? { sampleStack: candidate.sample.errorStack } : {}),
    })),
  );
  summary.problemsFound = problems.length;
  summary.problemsMerged = problems.filter((p) => p.members.length > 1).length;

  deps.logger.info(
    {
      clusters: found.length,
      problems: problems.length,
      merged: summary.problemsMerged,
    },
    `Datadog scan: ${found.length} cluster(s) folded into ${problems.length} problem(s)`,
  );

  for (const problem of problems) {
    const existingMembers: (DatadogIssue | undefined)[] = [];
    const recordedMembers: DatadogIssue[] = [];
    const memberFingerprints: string[] = [];
    const memberSeverities: DatadogSeverity[] = [];

    for (const member of problem.members) {
      const candidate = found[member]!;
      const { sample, facts, routing } = candidate;
      const fingerprint = fingerprintOf(candidate.service, candidate.signature);
      const existing = deps.issues.findByFingerprint(fingerprint);
      const severity = severityOf({
        ...(sample.status ? { status: sample.status } : {}),
        eventCount: candidate.eventCount,
        ...(existing ? { previousEventCount: existing.eventCount } : {}),
        isNew: existing == null,
      });

      existingMembers.push(existing);
      memberFingerprints.push(fingerprint);
      memberSeverities.push(severity);
      summary.bySeverity[severity] += 1;
      if (!existing) summary.issuesNew += 1;

      if (options.dryRun) {
        if (existing) recordedMembers.push(existing);
        continue;
      }

      const recorded = deps.issues.record({
        ...(candidate.service ? { service: candidate.service } : {}),
        signature: candidate.signature,
        title: titleOf(candidate.service, candidate.signature),
        problemKey: problem.key,
        problemTitle: titleOf(problem.service, problem.title),
        problemEventCount: problem.eventCount,
        severity,
        area: routing.area,
        ...(routing.team ? { team: routing.team } : {}),
        routedBy: routing.routedBy,
        eventCount: candidate.eventCount,
        sampleCount: candidate.sampleCount,
        sampleSize: candidate.sampleSize,
        ...(sample.status ? { status: sample.status } : {}),
        ...(facts.env ? { env: facts.env } : {}),
        ...(facts.source ? { source: facts.source } : {}),
        ...(sample.host ? { host: sample.host } : {}),
        ...(facts.kubeNamespace ? { kubeNamespace: facts.kubeNamespace } : {}),
        sampleLogId: sample.id,
        ...(bodyOf(sample) ? { sampleMessage: bodyOf(sample) } : {}),
        ...(sample.errorStack ? { sampleStack: sample.errorStack } : {}),
        // The search that isolates this one issue, not the service. Stored rather
        // than rebuilt at read time so the deep link on a row still describes what
        // the scan actually clustered, even after the base query is edited.
        query: issueQuery(candidate.serviceQuery, candidate.signature, sample),
        firstSeenAt: candidate.firstSeenAt,
        lastSeenAt: candidate.lastSeenAt,
      });
      summary.issuesRecorded += 1;
      summary.issues.push(recorded);
      recordedMembers.push(recorded);
    }

    const now = options.to.getTime();
    summary.problems.push({
      key: problem.key,
      title: titleOf(problem.service, problem.title),
      ...(problem.service ? { service: problem.service } : {}),
      eventCount: problem.eventCount,
      severity: worstSeverity(memberSeverities),
      isNew: existingMembers.every((issue) => issue == null),
      confirmedOnPriorDailyScan: existingMembers.some((issue) => {
        if (!issue) return false;
        const elapsed = now - issue.lastScanAt.getTime();
        return elapsed >= DAILY_CONFIRMATION_MIN_MS && elapsed <= DAILY_CONFIRMATION_MAX_MS;
      }),
      dismissed: existingMembers.some((issue) => issue?.state === "dismissed"),
      previousJiraIssueKeys: [
        ...new Set(existingMembers.flatMap((issue) => issue?.jiraIssueKey ?? [])),
      ],
      members: recordedMembers,
      memberFingerprints,
    });
  }

  summary.issues.sort(
    (a, b) => rankOf(a.severity) - rankOf(b.severity) || b.eventCount - a.eventCount,
  );

  // Rows nothing has re-seen in a week. A partial aggregation cannot prove that
  // an omitted service was quiet, so pruning waits for a complete pass.
  if (!options.dryRun && !summary.partial) {
    summary.issuesPruned = deps.issues.pruneStale(
      new Date(options.to.getTime() - STALE_AFTER_MS),
    );
    if (summary.issuesPruned > 0) {
      deps.logger.info(
        { pruned: summary.issuesPruned },
        `Datadog scan: forgot ${summary.issuesPruned} issue(s) unseen for ${STALE_AFTER_DAYS} days`,
      );
    }
  }

  deps.logger.info(
    {
      recorded: summary.issuesRecorded,
      new: summary.issuesNew,
      ignored: summary.issuesIgnored,
      problems: summary.problemsFound,
      severities: summary.bySeverity,
      servicesScanned: summary.servicesScanned,
    },
    `Datadog scan: ${summary.issuesRecorded} issue(s) in ${summary.problemsFound} problem(s), ${summary.issuesNew} new`,
  );

  return summary;
}

/** The sample's own words: the error message when the library set one. */
function bodyOf(sample: LogSample): string | undefined {
  return sample.errorMessage ?? sample.message;
}

/**
 * The base query with every expressible ignore rule negated into it.
 *
 * Patterns are quoted when they contain whitespace, which also disables wildcards
 * inside them — Datadog treats `*` in a quoted phrase literally. That is the right
 * trade: `service:"SIS Daemons"` has to work, and a service name with both a space
 * and a wildcard in its rule is a case that does not arise.
 */
export function withExclusions(
  baseQuery: string,
  rules: readonly DatadogRoutingRule[],
): string {
  const negations = rules
    .filter((rule) => rule.action === "ignore" && QUERYABLE_FACETS.has(rule.facet))
    .map((rule) => `-${term(rule.facet, rule.pattern)}`);
  return [baseQuery.trim(), ...negations].filter(Boolean).join(" ");
}

/** A configured query may narrow production, but it can never broaden beyond it. */
export function productionOnlyQuery(baseQuery: string): string {
  const base = baseQuery.trim() || "*";
  return `(${base}) AND env:${DATADOG_REGRESSION_POLICY.environment}`;
}

/** `service:lcm`, or `service:"SIS Daemons"` when quoting is needed. */
function term(facet: string, value: string): string {
  const trimmed = value.trim();
  return /[\s"]/.test(trimmed)
    ? `${facet}:"${trimmed.replace(/"/g, '\\"')}"`
    : `${facet}:${trimmed}`;
}

/**
 * A search that finds this issue rather than its service.
 *
 * Best effort by nature: the cluster is defined by a normalised signature, and
 * there is no Datadog query for "matches this shape". The error kind narrows it
 * properly when the sample had one; failing that the query stays at service level
 * and the row's own signature is what a person compares against. A query built by
 * pasting a normalised message with `<NUM>` placeholders in it would look precise
 * and match nothing, which is worse than being honestly coarse.
 */
function issueQuery(serviceQuery: string, signature: string, sample: LogSample): string {
  const kind = sample.errorKind?.trim();
  return kind ? `${serviceQuery} ${term("@error.kind", kind)}` : serviceQuery;
}

function factsOf(service: string, sample: LogSample, signature: string): DatadogFacts {
  return {
    service,
    signature,
    ...(sample.tags.source ? { source: sample.tags.source } : {}),
    ...(sample.tags.env ? { env: sample.tags.env } : {}),
    ...(sample.tags.kube_namespace ? { kubeNamespace: sample.tags.kube_namespace } : {}),
    ...(sample.host ? { host: sample.host } : {}),
  };
}

function signalOf(options: DatadogScanOptions): { signal?: AbortSignal } {
  return options.signal ? { signal: options.signal } : {};
}

function rankOf(severity: DatadogSeverity): number {
  return ["critical", "high", "medium", "low"].indexOf(severity);
}

function worstSeverity(severities: readonly DatadogSeverity[]): DatadogSeverity {
  return [...severities].sort((a, b) => rankOf(a) - rankOf(b))[0] ?? "low";
}
