import type { DatadogIssue } from "./ports.ts";
import {
  bulletList,
  codeBlock,
  doc,
  heading,
  linkParagraph,
  paragraph,
  rule,
} from "../connectors/jira/adf.ts";

const LABEL = "datadog";

export const DATADOG_SERVICE_PROJECT_PREFIX = "example-org/services";
export const DATADOG_SERVICE_TARGET_BRANCH = "master";

export function datadogServiceProjectPrefix(): string {
  return Bun.env.TALOS_DATADOG_PROJECT_PREFIX?.trim() || DATADOG_SERVICE_PROJECT_PREFIX;
}

export function defaultDatadogServiceTarget(service: string): {
  projectId: string;
  targetBranch: string;
} {
  return {
    projectId: `${datadogServiceProjectPrefix()}/${service.trim()}`,
    targetBranch: DATADOG_SERVICE_TARGET_BRANCH,
  };
}

export function datadogTicketSummary(issue: DatadogIssue): string {
  const full = issue.problemTitle ?? issue.title;
  const title = full.length > 200 ? `${full.slice(0, 199)}…` : full;
  return `[Datadog] ${title}`;
}

export function datadogFingerprintLabel(fingerprint: string): string {
  return `datadog-fp-${fingerprint.slice(0, 24)}`;
}

export function datadogTicketLabels(
  issue: DatadogIssue,
  fingerprints: readonly string[] = [issue.fingerprint],
  configured: readonly string[] = [],
): string[] {
  const labels = [
    ...configured,
    LABEL,
    `datadog-${issue.severity}`,
    `area-${issue.area}`,
    ...fingerprints.map(datadogFingerprintLabel),
  ];
  if (issue.team && !/\s/.test(issue.team)) labels.push(`team-${issue.team}`);
  return [...new Set(labels)];
}

export function datadogTicketDescription(
  issue: DatadogIssue,
  members: readonly DatadogIssue[],
  explorerUrl?: string | null,
): ReturnType<typeof doc> {
  const others = members.filter((member) => member.id !== issue.id);
  const facts: string[] = [];
  if (issue.service) facts.push(`Service: ${issue.service}`);
  facts.push(`Severity: ${issue.severity} (assigned by talos from the trend, not by Datadog)`);
  facts.push(`Area: ${issue.area}${issue.team ? ` · team ${issue.team}` : ""}`);
  facts.push(
    `Occurrences: ≈${(issue.problemEventCount ?? issue.eventCount).toLocaleString()} — ` +
      `estimated from ${issue.sampleCount} of ${issue.sampleSize} sampled log bodies`,
  );
  if (others.length > 0) {
    facts.push(`Log lines: ${members.length} distinct message shapes, grouped as one failure`);
  }
  if (issue.status) facts.push(`Log status: ${issue.status}`);
  if (issue.env) facts.push(`Environment: ${issue.env}`);
  if (issue.source) facts.push(`Source: ${issue.source}`);
  if (issue.host) facts.push(`Sample host: ${issue.host}`);
  if (issue.kubeNamespace) facts.push(`Kubernetes namespace: ${issue.kubeNamespace}`);
  facts.push(`First seen: ${issue.firstSeenAt.toISOString()}`);
  facts.push(`Last seen: ${issue.lastSeenAt.toISOString()}`);
  facts.push(`Scans that found it: ${issue.scanCount}`);

  return doc(
    paragraph(
      "Filed automatically from a Datadog log scan. Datadog Error Tracking is not " +
        "indexing this org, so the issue was clustered from raw error logs: the " +
        "signature below is a normalised message shape, with ids, paths and numbers " +
        "replaced by placeholders.",
    ),
    heading("Error signature", 3),
    codeBlock(issue.signature),
    issue.sampleStack ? heading("Sample stack trace", 3) : null,
    issue.sampleStack ? codeBlock(issue.sampleStack) : null,
    issue.sampleMessage ? heading("Sample message", 3) : null,
    issue.sampleMessage ? codeBlock(issue.sampleMessage) : null,
    others.length > 0 ? heading("Other log lines from the same failure", 3) : null,
    others.length > 0
      ? paragraph(
          "Grouped automatically because these mention each other's code — the same " +
            "fault reported from different frames. Counts are per line and overlap, " +
            "so they must not be added.",
        )
      : null,
    others.length > 0
      ? bulletList(
          others.map(
            (member) =>
              `${member.service ?? "unknown"} · ≈${member.eventCount.toLocaleString()} · ` +
              `${member.signature}`,
          ),
        )
      : null,
    heading("Signal", 3),
    bulletList(facts),
    heading("In Datadog", 3),
    paragraph(`Log query: ${issue.query}`),
    explorerUrl ? linkParagraph("Open in the Datadog log explorer", explorerUrl) : null,
    rule(),
    paragraph(
      `talos Datadog issue ${issue.id}` +
        (others.length > 0 ? ` (+${others.length} grouped signature(s))` : ""),
    ),
  );
}
