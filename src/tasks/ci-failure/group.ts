import type { TraceAnalysis } from "../../connectors/gitlab/trace-format.ts";

/**
 * Grouping test failures into tickets.
 *
 * A nightly Angular run reports 13 failures across 4 spec files with two root
 * causes. One ticket per failing *test* files 13 tickets nobody reads; one per
 * pipeline files a single ticket that four different people would each have to
 * ignore three quarters of. The spec file is the unit that maps to one owner and
 * one fix, so it is the unit that maps to one ticket.
 *
 * The file is also the only identity that survives to tomorrow. A pipeline id is
 * new every night, and a test name changes when someone renames a `describe` — so
 * keying on either would refile everything.
 */

/** How many test names go into a signature before it is summarised by count. */
const SIGNATURE_TESTS = 50;

/** Legacy bucket used before unresolved failures became parser diagnostics. */
export const UNATTRIBUTED = "(unattributed)";

/**
 * Signature members that are not test names.
 *
 * Both begin with a space, which a trimmed test name never does — so the diff can
 * tell a marker from a test name without a second encoding.
 */
export const SUITE_MARKER = " suite-failed-to-run";
export const OVERFLOW_MARKER = " and-more:";

export interface FailureGroup {
  /** Spec file path, relative to the repo root. */
  file: string;
  /** Failing test names in this file, in the order the runner reported them. */
  tests: string[];
  /** Per-test detail: the assertion and the stack frame naming the spec. */
  details: { name: string; detail: string }[];
  /**
   * True when the file failed to *run* at all — an import or syntax error —
   * rather than failing an assertion. A different problem with a different fix,
   * so the ticket says which.
   */
  suiteFailedToRun: boolean;
  /** The suite-level error, when `suiteFailedToRun`. */
  suiteDetail?: string;
}

/**
 * Groups a trace analysis by spec file.
 *
 * Unresolved failures are deliberately not grouped. A synthetic file combines
 * unrelated tests, produces meaningless flake rates and can file a Jira ticket
 * nobody can act on. The caller reports them as a job-level parser diagnostic.
 */
export function groupByFile(analysis: TraceAnalysis): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();

  const ensure = (file: string): FailureGroup => {
    let group = groups.get(file);
    if (!group) {
      group = { file, tests: [], details: [], suiteFailedToRun: false };
      groups.set(file, group);
    }
    return group;
  };

  for (const test of analysis.failedTests) {
    if (!test.file) continue;
    const group = ensure(test.file);
    group.tests.push(test.name);
    group.details.push({ name: test.name, detail: test.detail });
  }

  // A suite that never ran reports no test names, so it would otherwise produce
  // no group at all — losing the most informative failure in the log.
  for (const suite of analysis.failedSuites) {
    if (!suite.file) continue;
    const group = ensure(suite.file);
    group.suiteFailedToRun = true;
    group.suiteDetail = suite.detail;
  }

  return [...groups.values()];
}

/**
 * A fingerprint of what is failing in one file.
 *
 * Built from test names only — not assertion text, not line numbers. Assertion
 * text carries received values ("Expected 90, received 100" becomes "received
 * 103" tomorrow) and stacks carry line numbers that move when anyone edits the
 * file above the test. Either would make an unchanged failure look changed and
 * earn a pointless comment every single night.
 *
 * Sorted, so the runner reordering its output between runs is not a change.
 * Newline-separated, because a test name reads "Component › does a thing" and a
 * space-joined signature could not be split back into names.
 */
export function signatureOf(group: FailureGroup): string {
  const parts: string[] = [];

  // A file that stopped compiling, having previously merely failed an assertion,
  // is a real change worth a comment — so the marker joins the signature rather
  // than replacing it.
  if (group.suiteFailedToRun) parts.push(SUITE_MARKER);

  const names = [...group.tests].sort();
  if (names.length <= SIGNATURE_TESTS) {
    parts.push(...names);
  } else {
    // A file with hundreds of failures is failing wholesale; exact membership is
    // not the interesting fact and would make the signature enormous.
    parts.push(
      ...names.slice(0, SIGNATURE_TESTS),
      `${OVERFLOW_MARKER}${names.length - SIGNATURE_TESTS}`,
    );
  }

  return parts.join("\n");
}

/**
 * The subject key for a group: stable across pipelines, unique per file.
 *
 * Carries the GitLab project so one database can serve several projects without a
 * spec file of the same path in two repos colliding, and namespaced `spec:` like
 * every other loop's key because they all share `work_subjects`.
 */
export function subjectKeyOf(project: string | number, group: FailureGroup): string {
  return `spec:${project}:${group.file}`;
}

/**
 * The ticket title.
 *
 * Leads with the file's basename because that is what a human scanning a board
 * recognises, and names the first failing test because "4 tests failing" alone
 * gives no clue whether it is a missing provider or an assertion drift.
 */
export function titleOf(group: FailureGroup, prefix = "Unit test failure"): string {
  const base = basename(group.file);

  if (group.suiteFailedToRun && group.tests.length === 0) {
    return `${prefix}: ${base} — suite failed to run`;
  }

  const first = group.tests[0] ?? "unknown test";
  const extra = group.tests.length > 1 ? ` (+${group.tests.length - 1} more)` : "";
  return `${prefix}: ${base} — ${first}${extra}`;
}

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export interface SignatureDiff {
  /** Tests failing now that were not in the ticket's recorded signature. */
  added: string[];
  /** Tests the ticket records that are no longer failing. */
  removed: string[];
  /** True when the file went from failing assertions to not compiling, or back. */
  suiteChanged: boolean;
}

/**
 * How a failure changed since the ticket was filed, or null when it has not.
 *
 * Null is the common case — the same tests failing again tonight — and it must
 * produce no Jira call at all, which is the whole point of storing a signature.
 */
export function diffSignatures(
  previous: string,
  group: FailureGroup,
): SignatureDiff | null {
  const previousParts = previous.split("\n").filter((part) => part !== "");
  const before = new Set(previousParts.filter((part) => !isMarker(part)));
  const after = new Set([...group.tests].sort());

  const added = [...after].filter((name) => !before.has(name));
  const removed = [...before].filter((name) => !after.has(name));
  const suiteChanged =
    previousParts.includes(SUITE_MARKER) !== group.suiteFailedToRun;

  return added.length === 0 && removed.length === 0 && !suiteChanged
    ? null
    : { added, removed, suiteChanged };
}

function isMarker(part: string): boolean {
  return part.startsWith(" ");
}
