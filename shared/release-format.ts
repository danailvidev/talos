import type { ManifestSection } from "./api-contract.ts";

/**
 * How a release merge request's title, description and label are worded.
 *
 * Pure and dependency-free so it is the single source of truth on both sides:
 * the web dialog prefills the editable title/description with these, and the
 * server falls back to them when the caller sends nothing (or an override).
 */

/** A change, optionally annotated with the version it replaces, for the description. */
export interface FormatChange {
  service: string;
  version: string;
  section: ManifestSection;
  /** The version before this edit, when known — renders a `old → new` bullet. */
  previousVersion?: string;
}

/** Section keys paired with the human labels used in titles and descriptions. */
const SECTION_LABELS: { section: ManifestSection; label: string }[] = [
  { section: "applications", label: "Applications" },
  { section: "services", label: "Services" },
];

/**
 * The GitLab label for an environment, matching the repo's `env::<ENV>`
 * convention (e.g. `env::BETA3`, `env::DEV`). Uppercased so a folder named in
 * any case lands on the label the team already uses.
 */
export function environmentLabel(environment: string): string {
  return `env::${environment.toUpperCase()}`;
}

/**
 * The merge request title: `<ENV> Applications: <list> Services: <list>`, with
 * a section shown only when it has changes. Each entry is `name version`.
 */
export function buildReleaseTitle(
  environment: string,
  changes: { service: string; version: string; section: ManifestSection }[],
): string {
  const parts: string[] = [];
  for (const { section, label } of SECTION_LABELS) {
    const inSection = changes.filter((c) => c.section === section);
    if (inSection.length === 0) continue;
    parts.push(`${label}: ${inSection.map((c) => `${c.service} ${c.version}`).join(", ")}`);
  }
  return `${environment.toUpperCase()} ${parts.join(" ")}`.trim();
}

/**
 * The merge request description: a heading per changed section, then one bullet
 * per change reading `name: old → new` (or just `name → new` when the previous
 * version is unknown) — so every edit in the diff is spelled out in prose.
 */
/**
 * The Slack announcement posted when a release merge request opens.
 *
 * Slack mrkdwn, which is not markdown: links are `<url|label>`, bold is a single
 * `*`, and there are no headings — so this cannot reuse the merge request
 * description above even though it says much the same thing. Kept short on
 * purpose. This lands in a channel where most readers only need to know which
 * environment moved and whether they have to do anything; the full per-section
 * breakdown is one click away in the merge request.
 */
export function buildReleaseSlackMessage(input: {
  environment: string;
  changes: FormatChange[];
  mrUrl: string;
  /** Who clicked Upload, named so the channel knows who to ask. */
  author: string;
  merged: boolean;
  autoMergeEnabled: boolean;
  kind?: "deploy" | "revert";
}): string {
  const action = input.kind === "revert" ? "revert" : "release";
  const lines = [`*${input.environment.toUpperCase()} ${action}* — opened by ${input.author}`];

  // Flat bullets rather than a heading per section: with one or two changed
  // services, section headings are more scaffolding than content.
  for (const { section, label } of SECTION_LABELS) {
    const inSection = input.changes.filter((c) => c.section === section);
    if (inSection.length === 0) continue;
    for (const c of inSection) {
      const from = c.previousVersion ? `\`${c.previousVersion}\` → ` : "";
      lines.push(`• \`${c.service}\`: ${from}\`${c.version}\` _(${label.toLowerCase()})_`);
    }
  }

  // The status clause is the actionable half of the message: "merged" needs
  // nobody, while an MR that could not auto-merge is waiting on a human.
  const status = input.merged
    ? "Merged"
    : input.autoMergeEnabled
      ? "Merging automatically once the pipeline succeeds"
      : "Needs a manual merge";
  lines.push(`${status} · <${input.mrUrl}|merge request>`);

  return lines.join("\n");
}

/**
 * The Slack announcement posted when the post-deploy watcher finds a new error
 * signature after a production release.
 *
 * Deliberately not folded into `buildReleaseSlackMessage`: that message describes
 * the release as it opened, and this one describes something the release *caused*,
 * discovered up to hours later — a different fact at a different time, sent as its
 * own message rather than an edit nobody would notice.
 */
export function buildDeployWatchFindingSlackMessage(input: {
  source: "datadog" | "logrocket";
  environment: string;
  service?: string;
  signature: string;
  eventCount: number;
  releaseUrl: string;
  releaseLabel: string;
  externalUrl?: string;
  issueType?: string;
  author?: string;
}): string {
  if (input.source === "logrocket") {
    const lines = [
      `*New LogRocket issue since the ${input.environment.toUpperCase()} release* ` +
        (input.author ? `(opened by ${input.author})` : ""),
    ];
    if (input.issueType) lines.push(`_${input.issueType}_`);
    lines.push(`> ${input.signature}`);
    const countLabel = input.eventCount === 1 ? "session/alert" : "sessions/alerts";
    lines.push(`Reported for ${input.eventCount.toLocaleString()} ${countLabel}`);
    if (input.externalUrl) lines.push(`<${input.externalUrl}|Open in LogRocket>`);
    lines.push(`<${input.releaseUrl}|Release ${input.releaseLabel}>`);
    return lines.join("\n");
  }

  const lines = [
    `*New error since the ${input.environment.toUpperCase()} release* ` +
      (input.author ? `(opened by ${input.author})` : ""),
  ];
  if (input.service) lines.push(`\`${input.service}\``);
  lines.push(`> ${input.signature}`);
  lines.push(
    `Seen ${input.eventCount.toLocaleString()} time(s) since the merge · ` +
      `<${input.releaseUrl}|release ${input.releaseLabel}>`,
  );
  return lines.join("\n");
}

export function buildReleaseDescription(environment: string, changes: FormatChange[]): string {
  const lines: string[] = [`Release update for **${environment.toUpperCase()}**.`, ""];
  for (const { section, label } of SECTION_LABELS) {
    const inSection = changes.filter((c) => c.section === section);
    if (inSection.length === 0) continue;
    lines.push(`### ${label}`);
    for (const c of inSection) {
      lines.push(
        c.previousVersion
          ? `- \`${c.service}\`: \`${c.previousVersion}\` → \`${c.version}\``
          : `- \`${c.service}\` → \`${c.version}\``,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function buildReleaseRevertTitle(environment: string, shortSha: string): string {
  return `Revert ${environment.toUpperCase()} deployment ${shortSha}`;
}

export function buildReleaseRevertDescription(input: {
  environment: string;
  shortSha: string;
  commitUrl?: string | null;
  changes: FormatChange[];
}): string {
  const source = input.commitUrl
    ? `[\`${input.shortSha}\`](${input.commitUrl})`
    : `\`${input.shortSha}\``;
  return [
    `Reverts deployment ${source} from **${input.environment.toUpperCase()}**.`,
    "",
    buildReleaseDescription(input.environment, input.changes),
  ].join("\n");
}
