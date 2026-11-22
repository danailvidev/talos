const ALLOWED_CHANGE_TYPES = new Set(["fix", "feat", "refactor"]);
const CONVENTIONAL_PREFIX = /^([a-z]+)(?:\([^)\r\n]+\))?!?:\s*/i;

/**
 * Keeps merge requests opened by the fix workflow compatible with semantic
 * release, even when an agent omits or duplicates part of the required prefix.
 *
 * A valid type supplied by the agent is preserved. The fix workflow otherwise
 * defaults to `fix`, which is safer than trusting free-form output to satisfy a
 * repository's merge-request title checks.
 */
export function fixIssueMergeRequestTitle(
  issueKey: string,
  proposedTitle: string | undefined,
  issueSummary: string,
): string {
  const proposed = singleLine(proposedTitle) || singleLine(issueSummary) || issueKey;
  const prefix = proposed.match(CONVENTIONAL_PREFIX);
  const proposedType = prefix?.[1]?.toLowerCase();
  const type = proposedType && ALLOWED_CHANGE_TYPES.has(proposedType) ? proposedType : "fix";
  const withoutType = prefix ? proposed.slice(prefix[0].length) : proposed;
  const body = withoutIssueKey(withoutType, issueKey) || withoutIssueKey(issueSummary, issueKey);

  return `${type}: ${issueKey}${body ? ` ${singleLine(body)}` : ""}`;
}

function singleLine(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function withoutIssueKey(value: string, issueKey: string): string {
  const escapedKey = issueKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return singleLine(value).replace(
    new RegExp(`^(?:\\[${escapedKey}\\]|${escapedKey})(?:\\s*[:\\-—]\\s*|\\s+|$)`, "i"),
    "",
  );
}
