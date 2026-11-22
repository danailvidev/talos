import type { TestObservation } from "./ports.ts";

/**
 * Telling a flaky test from a broken one.
 *
 * `gitlab-ci-failure` used to file a ticket the first time a spec file went red,
 * having asked only "is this file already ticketed?". On a nightly suite that
 * makes flakes the majority of the board, and a board of flakes is one nobody
 * reads — which costs more than the tickets are worth, because the real
 * regression is in there too.
 *
 * What distinguishes them is not the failure, it is the shape of the history
 * around it. A regression fails and keeps failing. A flake fails, then passes,
 * then fails. So the decision needs several runs, and one run cannot make it —
 * which is why the first sighting of a failure is deliberately *held* rather than
 * filed, and why holding is a decision rather than an error.
 *
 * Pure and source-agnostic: everything it needs is in the observations handed to
 * it, none of which name a pipeline, a spec file or GitLab at all — a run is a
 * `runId`, a test is whatever the caller is judging. That is what lets a second
 * producer (say, a backend unit test runner) reuse this exact rule rather than
 * reimplementing "flaky" its own way. Living in `application/` rather than inside
 * `tasks/ci-failure/` is the point: a task that is not `ci-failure` can depend on
 * `application/` without reaching into another task's folder.
 */

export type TestVerdict = "regression" | "flaky" | "new" | "unknown";

export interface FlakeOptions {
  /**
   * Consecutive failures before a ticket is filed.
   *
   * Two, by default. One is today's behaviour and files every flake; three costs
   * two nights before anybody is told about a real regression.
   */
  failuresBeforeFiling: number;
  /** How many recent conclusive runs the verdict is judged over. */
  historyWindow: number;
  /** Failure rate at or above which a flake is worth quarantining. */
  quarantineFlakeRate: number;
  /** Conclusive runs needed before a rate is worth quoting at all. */
  minObservations: number;
}

export const DEFAULT_FLAKE_OPTIONS: FlakeOptions = {
  failuresBeforeFiling: 2,
  historyWindow: 10,
  quarantineFlakeRate: 0.3,
  minObservations: 4,
};

/**
 * The five numbers a verdict is made of.
 *
 * Split out from `FlakeAssessment` because the Flaky specs page has these
 * already, aggregated in SQL over many tests at once, and should not have to
 * re-fetch every test's observation list just to get a label. `judge` is the one
 * definition of the rule, and both callers go through it.
 */
export interface TestStats {
  /** Conclusive runs in the window. Inconclusive ones are never counted. */
  observed: number;
  failed: number;
  /** Failures in a row, newest-first. 0 when the most recent run passed. */
  consecutiveFailures: number;
  /** The newest run in the window where this test passed, if any. */
  lastPassedRunId?: string;
  /** Whether the *most recent* failure was the suite failing to run at all. */
  suiteFailedToRun?: boolean;
}

export interface FlakeAssessment extends TestStats {
  verdict: TestVerdict;
  /** `failed / observed`, or 0 when nothing was observed. */
  flakeRate: number;
  /** True when this is a flake bad enough to be worth quarantining. */
  quarantine: boolean;
}

/**
 * Counts one test's recent history.
 *
 * `history` must be newest-first and must already exclude inconclusive runs — a
 * run that died for a non-test reason proves nothing about any test, and
 * treating it as a pass would break a regression's streak and relabel it a
 * flake. `TestRunHistoryRepository.history` guarantees both.
 */
export function summarise(
  history: readonly TestObservation[],
  window = DEFAULT_FLAKE_OPTIONS.historyWindow,
): TestStats {
  const recent = history.slice(0, Math.max(1, window));

  let consecutiveFailures = 0;
  for (const observation of recent) {
    if (!observation.failed) break;
    consecutiveFailures++;
  }

  const lastPassedRunId = recent.find((o) => !o.failed)?.runId;
  const latestFailure = recent.find((o) => o.failed);

  return {
    observed: recent.length,
    failed: recent.filter((o) => o.failed).length,
    consecutiveFailures,
    ...(lastPassedRunId != null ? { lastPassedRunId } : {}),
    ...(latestFailure ? { suiteFailedToRun: latestFailure.suiteFailedToRun === true } : {}),
  };
}

/** Turns the counts into a verdict. The single definition of "flaky". */
export function judge(
  stats: TestStats,
  options: FlakeOptions = DEFAULT_FLAKE_OPTIONS,
): FlakeAssessment {
  const { observed, failed, consecutiveFailures } = stats;
  const flakeRate = observed === 0 ? 0 : failed / observed;

  // The whole signal, in one comparison: if not every failure in the window sits
  // in the newest unbroken run of failures, then a pass separates them — the test
  // has passed on code it also failed on, which a regression by definition cannot
  // do. (`consecutiveFailures === 0` with failures behind it is the same story: it
  // has since recovered.)
  const intermittent = failed > consecutiveFailures;

  // A suite that fails to *run* — an import or syntax error — is not a race. It
  // fails identically every time, so there is nothing to learn from waiting.
  const importError = consecutiveFailures > 0 && stats.suiteFailedToRun === true;

  let verdict: TestVerdict;
  if (importError || consecutiveFailures >= options.failuresBeforeFiling) {
    verdict = "regression";
  } else if (intermittent) {
    verdict = "flaky";
  } else if (observed <= 1) {
    verdict = "new";
  } else {
    // One failure, with clean runs behind it and nothing since. Could be either;
    // one more run decides it.
    verdict = "unknown";
  }

  return {
    ...stats,
    verdict,
    flakeRate,
    // Only ever suggested for a flake: a test failing on every single run has a
    // rate of 1.0, and quarantining a genuine regression is how a bug ships.
    quarantine:
      verdict === "flaky" &&
      observed >= options.minObservations &&
      flakeRate >= options.quarantineFlakeRate,
  };
}

/** `judge(summarise(history))` — what a producer calls at its decision point. */
export function assess(
  history: readonly TestObservation[],
  options: FlakeOptions = DEFAULT_FLAKE_OPTIONS,
): FlakeAssessment {
  return judge(summarise(history, options.historyWindow), options);
}

/** One line of plain English for a ticket, a log line or a table cell. */
export function describeAssessment(assessment: FlakeAssessment): string {
  if (assessment.observed === 0) return "no recorded history for this test yet";

  const rate = `failed ${assessment.failed} of the last ${assessment.observed} run(s)`;
  const passed =
    assessment.lastPassedRunId != null
      ? `, last passed in run ${assessment.lastPassedRunId}`
      : ", never seen passing in that window";

  return `${rate}${passed}`;
}
