/**
 * Deciding how bad a Datadog issue is, and whose it is.
 *
 * Both answers have to be manufactured. A log has a `status` and nothing that
 * resembles severity in the sense a triage list means it — 18 million lines a week
 * are `status:error` and almost none of them are an emergency. And this org's logs
 * carry no `team` tag at all: grouping by `team` returns zero buckets, so
 * ownership cannot be read from Datadog and has to be declared.
 *
 * So: severity is computed from status, volume and trend, and ownership comes from
 * operator-authored rules with a small set of heuristics behind them. Both are
 * deliberately explainable — every issue records the rule or heuristic that routed
 * it, because the failure mode of automatic triage is not being wrong, it is being
 * wrong in a way nobody can locate.
 *
 * No LLM is involved, by choice. The rules are deterministic, auditable and free,
 * and the LLM is spent where it earns its keep: fixing the code. `classify` is the
 * one seam where a model would slot in — a fallback for facts no rule matched —
 * and it is marked below.
 */
import type { DatadogArea, DatadogRoutingRule, DatadogSeverity } from "./ports.ts";
import { DATADOG_REGRESSION_POLICY } from "../../shared/datadog-policy.ts";

/** What the routing rules and heuristics get to look at. */
export interface DatadogFacts {
  service?: string;
  source?: string;
  kubeNamespace?: string;
  env?: string;
  host?: string;
  signature?: string;
}

export interface Routing {
  /** True when a rule says this is noise and the scan should not record it. */
  ignored: boolean;
  area: DatadogArea;
  team?: string;
  /** Files this issue's ticket somewhere other than the default project. */
  jiraProject?: string;
  /** `rule:service=csi-*`, `heuristic:infra-name`, `default:backend`. */
  routedBy: string;
}

/**
 * Applies the rules in priority order, then the heuristics.
 *
 * First match wins, including for `ignore` — which is why priority is editable:
 * "everything in kube-system is infrastructure" and "csi-* is noise" only produce
 * the intended answer in one of the two possible orders.
 *
 * A `route` rule that names a team but no area still falls through to the
 * heuristics *for the area only*, rather than being recorded as `unknown`: the
 * person writing "payments-team owns billing-api" has said nothing about whether
 * that is frontend or backend, and guessing `unknown` throws away an answer we can
 * work out.
 */
export function route(facts: DatadogFacts, rules: readonly DatadogRoutingRule[]): Routing {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of ordered) {
    const value = factValue(facts, rule.facet);
    if (value == null || !globMatches(rule.pattern, value)) continue;

    const label = `rule:${rule.facet}=${rule.pattern}`;
    if (rule.action === "ignore") {
      return { ignored: true, area: rule.area ?? "unknown", routedBy: label };
    }

    const heuristic = rule.area ? undefined : classify(facts);
    return {
      ignored: false,
      area: rule.area ?? heuristic?.area ?? "unknown",
      ...(rule.team ? { team: rule.team } : {}),
      ...(rule.jiraProject ? { jiraProject: rule.jiraProject } : {}),
      routedBy: heuristic ? `${label} + ${heuristic.routedBy}` : label,
    };
  }

  const heuristic = classify(facts);
  return { ignored: false, area: heuristic.area, routedBy: heuristic.routedBy };
}

/**
 * Names that give away a platform component rather than product code.
 *
 * Matched against both service and source. These are the loudest things in this
 * estate by an order of magnitude, and while the seeded rules ignore the worst of
 * them, the list keeps growing on its own — a new CSI sidecar should land in
 * `infrastructure` on the day it appears rather than in whichever team's bucket
 * `unknown` gets triaged into.
 */
const INFRA_PATTERNS: readonly RegExp[] = [
  /^(?:datadog-)?agent$/i,
  /^(?:csi|kube|kubelet|containerd|cri-o|etcd|calico|cilium|coredns|flannel)\b/i,
  /^(?:amazon-k8s|aws-|eks-|ebs-|efs-)/i,
  /^(?:argocd|awx|ansible|terraform|jenkins|vault|consul|nomad)\b/i,
  /^(?:prometheus|grafana|alertmanager|fluent|fluentd|fluentbit|logstash|filebeat)\b/i,
  /^(?:istio|envoy|traefik|haproxy|nginx-ingress|cert-manager|external-dns)\b/i,
];

/** Browser and mobile logs: somebody's UI, wherever it was served from. */
const FRONTEND_PATTERNS: readonly RegExp[] = [
  /^(?:browser|rum|javascript|js|react|angular|vue|svelte|next|nuxt)\b/i,
  /(?:^|[-_])(?:frontend|webapp|web-app|ui|spa|portal|client)(?:$|[-_])/i,
];

/** Stores and pipelines. Split out because the fix is rarely in application code. */
const DATA_PATTERNS: readonly RegExp[] = [
  /^(?:postgres|postgresql|mysql|mariadb|mssql|sqlserver|oracle|mongo|mongodb)\b/i,
  /^(?:redis|memcached|elastic|elasticsearch|opensearch|clickhouse|cassandra)\b/i,
  /^(?:kafka|rabbitmq|activemq|airflow|dbt|spark|flink|hadoop|hive|snowflake)\b/i,
  /(?:^|[-_])(?:etl|warehouse|ingest|pipeline)(?:$|[-_])/i,
];

/**
 * The area a set of facts looks like, when no rule said.
 *
 * **This is the seam an LLM would fill.** Everything above is a name match, and
 * names run out: a service called `lcm` tells you nothing, and the honest answer
 * for it is the default. A model given the signature, the stack frames and the
 * service name would do better than a default — and it would do so at a cost per
 * issue and with no audit trail, which is why the deterministic version ships
 * first and this function is small enough to wrap.
 */
export function classify(facts: DatadogFacts): { area: DatadogArea; routedBy: string } {
  const names = [facts.service, facts.source].filter((n): n is string => !!n);

  if (facts.kubeNamespace && /^(?:kube-|kube$|monitoring|logging|istio-|cert-manager)/i.test(facts.kubeNamespace)) {
    return { area: "infrastructure", routedBy: "heuristic:infra-namespace" };
  }
  if (names.some((name) => INFRA_PATTERNS.some((p) => p.test(name)))) {
    return { area: "infrastructure", routedBy: "heuristic:infra-name" };
  }
  if (names.some((name) => FRONTEND_PATTERNS.some((p) => p.test(name)))) {
    return { area: "frontend", routedBy: "heuristic:frontend-name" };
  }
  if (names.some((name) => DATA_PATTERNS.some((p) => p.test(name)))) {
    return { area: "data", routedBy: "heuristic:data-name" };
  }
  // Backend rather than `unknown` on purpose: a service emitting errors in an
  // application log is somebody's server code until shown otherwise, and
  // `unknown` is a bucket people learn to ignore.
  return { area: "backend", routedBy: "default:backend" };
}

/** Log statuses that mean "page someone", independent of volume. */
const CRITICAL_STATUSES = new Set<string>(
  DATADOG_REGRESSION_POLICY.criticalStatuses,
);

/** Statuses below `error` — a warning at any volume is not a critical bug. */
const SOFT_STATUSES = new Set<string>(DATADOG_REGRESSION_POLICY.softStatuses);

const ORDER: readonly DatadogSeverity[] = ["critical", "high", "medium", "low"];

export interface SeverityInput {
  /** Datadog log status of the sample. */
  status?: string;
  /** Estimated occurrences in the scan window. */
  eventCount: number;
  /** The previous scan's estimate, when there was one. */
  previousEventCount?: number;
  /** True when this scan is the first to see it. */
  isNew: boolean;
}

/**
 * How urgent this is: what changed, not how big it is.
 *
 * Volume was the obvious basis and it does not work in this estate. Measuring the
 * live account settled it: `status` has exactly one bucket, `error`, across all
 * 2.08M production error logs — no `fatal`, no `critical`, ever — and `@error.kind`
 * is set on sixty of those two million lines. Volume is therefore the only thing
 * Datadog offers, and volume is dominated by one service: `lcm` writes 1.71M of the
 * 2.08M, so absolute thresholds mark everything in `lcm` critical and can never
 * promote anything in a service that only writes a thousand lines a day, however
 * broken it is.
 *
 * So severity is the derivative. A problem that appeared today, or has tripled
 * since yesterday, is critical; one that is growing is high; one holding steady is
 * medium; one shrinking is low. That ranks a 686-occurrence failure that tripled
 * overnight above a 285,462-occurrence one that has been at 285,462 for a month —
 * which is the correct order to work in, because the second is a known cost and the
 * first is news.
 *
 * The trade is explicit and worth stating: a large, long-standing, genuinely
 * important failure sits at `medium` here forever. That is a real loss, and the
 * mitigation is that volume is still on the row, still sortable, and still the tie
 * breaker within a severity band.
 *
 * The one non-trend rule left is a status that means emergency, which wins
 * outright. It never fires in this account; it costs nothing and would be wrong to
 * remove for an install whose logs are better tagged than this one's.
 */
export function severityOf(input: SeverityInput): DatadogSeverity {
  const status = input.status?.toLowerCase().trim();
  if (status && CRITICAL_STATUSES.has(status)) return "critical";

  // A warning is capped at medium however fast it grows: a spike in something the
  // emitting service itself did not call an error is not an emergency.
  const soft = status != null && SOFT_STATUSES.has(status) && status !== "error";

  // Everything is new on the first scan of a fresh install, so a fresh install
  // opens on a page of criticals. That is accurate rather than a bug — nothing is
  // known to be steady yet — and it resolves itself after one day of history.
  if (input.isNew) return soft ? "medium" : "critical";

  const previous = input.previousEventCount;
  // Seen before, but no previous estimate to compare against — the row was folded
  // in by a scan that predates the trend columns, or the count was zero. Neither is
  // evidence of anything, and `medium` is the "no signal" band.
  if (previous == null || previous <= 0) return "medium";

  const ratio = input.eventCount / previous;
  if (ratio >= DATADOG_REGRESSION_POLICY.criticalGrowthRatio) {
    return soft ? "medium" : "critical";
  }
  if (ratio >= DATADOG_REGRESSION_POLICY.highGrowthRatio) {
    return soft ? "medium" : "high";
  }
  if (ratio <= DATADOG_REGRESSION_POLICY.lowGrowthRatio) return "low";
  return "medium";
}

/** Sort key: critical first. Used wherever severity ordering is not SQL's job. */
export function severityRank(severity: DatadogSeverity): number {
  return ORDER.indexOf(severity);
}

/**
 * Case-insensitive glob with `*` and `?`, anchored at both ends.
 *
 * Anchored because a rule reading `csi-*` must not match `my-csi-thing`: an
 * `ignore` rule that matches more than its author expected removes things from a
 * triage list silently, and silent subtraction is the worst thing this file could
 * do.
 */
export function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[\\s\\S]*")
    .replace(/\?/g, "[\\s\\S]");
  return new RegExp(`^${escaped}$`, "i").test(value.trim());
}

function factValue(
  facts: DatadogFacts,
  facet: DatadogRoutingRule["facet"],
): string | undefined {
  switch (facet) {
    case "service":
      return facts.service;
    case "source":
      return facts.source;
    case "kube_namespace":
      return facts.kubeNamespace;
    case "env":
      return facts.env;
    case "host":
      return facts.host;
    case "signature":
      return facts.signature;
  }
}
