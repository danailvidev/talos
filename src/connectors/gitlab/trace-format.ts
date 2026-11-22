/**
 * Turning a raw GitLab job trace into something a human — or a Jira description —
 * can read.
 *
 * A trace is not plain text. It carries ANSI colour, GitLab's own section
 * markers, and carriage returns from progress spinners that make a naive read
 * look like gibberish. Cleaning happens here rather than in the LLM step for the
 * same reason truncation does: the text lands in a SQLite row and a ticket body
 * too, not only in a prompt.
 *
 * The Jest-aware extraction is a best effort. When it recognises nothing it says
 * so and falls back to the tail of the log, because a formatter that silently
 * returns an empty summary would hide the failure it exists to report.
 */

/** ANSI CSI sequences: colour, cursor moves, erase-in-line. */
const ANSI = /\[[0-?]*[ -/]*[@-~]/g;

/**
 * GitLab wraps collapsible sections in these markers. They are metadata, not
 * output, and they carry the epoch seconds that make otherwise identical lines
 * differ between runs.
 */
const SECTION_MARKER = /^section_(start|end):\d+:[^\r\n]*/gm;

/**
 * When a runner has `FF_TIMESTAMPS` enabled, GitLab prefixes every line with an
 * RFC3339 timestamp and a stream tag: `2026-08-21T02:46:53.491Z 01E   ● Foo`.
 * The tag's trailing `+` marks a continuation of the previous line rather than a
 * new one.
 *
 * This defeats every `^`-anchored pattern below, and the timestamps also make
 * two identical runs differ byte for byte — so the prefix comes off before
 * anything else looks at the text.
 */
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z [0-9A-Za-z]{2,4}[+ ]/;

/**
 * A trace is prefixed or it is not; a handful of matches means a build script
 * echoed something that looks like one. Requiring most of the log to match keeps
 * this from mangling an unprefixed trace.
 */
const PREFIX_SHARE = 0.5;

export interface CleanOptions {
  /** Keep GitLab section names as headings instead of dropping them. */
  keepSectionNames?: boolean;
}

/** Strips ANSI, section markers and spinner carriage returns. */
export function cleanTrace(raw: string, options: CleanOptions = {}): string {
  let text = stripTimestampPrefixes(raw).replace(ANSI, "");

  text = text.replace(SECTION_MARKER, (match) => {
    if (!options.keepSectionNames) return "";
    const name = match.split(":")[2] ?? "";
    if (!match.startsWith("section_start")) return "";
    // Terminated with a newline because the marker shares its line with a `\r`
    // and the carriage-return collapse below keeps only each line's last segment
    // — a heading left on that line would be discarded.
    return `--- ${name} ---\n`;
  });

  return (
    text
      .replace(/\r\n/g, "\n")
      // A bare \r rewrites the current line: a progress bar's 200 intermediate
      // states are noise, and only the final state is real output.
      .split("\n")
      .map((line) => {
        const parts = line.split("\r");
        return parts[parts.length - 1] ?? "";
      })
      .join("\n")
      // Collapse the blank runs left behind by removed markers.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Removes GitLab's per-line timestamp prefix, if the trace carries one.
 *
 * Applied line by line rather than with a single global regex so a log line that
 * merely contains a timestamp-shaped substring is left alone.
 */
export function stripTimestampPrefixes(raw: string): string {
  if (raw === "") return raw;

  const lines = raw.split("\n");
  let matched = 0;
  for (const line of lines) {
    if (TIMESTAMP_PREFIX.test(line)) matched++;
  }
  if (matched < lines.length * PREFIX_SHARE) return raw;

  return lines
    .map((line) => {
      const match = TIMESTAMP_PREFIX.exec(line);
      return match ? line.slice(match[0].length) : line;
    })
    .join("\n");
}

export interface FailedTest {
  /** Spec file, when the runner reported one. */
  file?: string;
  /** Full test name, e.g. "CheckoutComponent › applies a discount". */
  name: string;
  /** The assertion text and stack, already cleaned and trimmed. */
  detail: string;
}

export interface TestSummary {
  failed: number;
  passed: number;
  total: number;
  suitesFailed?: number;
}

/** A suite that never ran: an import error, a syntax error, a bad config. */
export interface FailedSuite {
  file?: string;
  detail: string;
}

export interface TraceAnalysis {
  /** Runner recognised, or "unknown" when nothing matched. */
  runner: "jest" | "unknown";
  failedTests: FailedTest[];
  /**
   * Suites that failed before running any test. Kept apart from `failedTests`
   * because "0 tests failed but the suite could not load" is a different problem
   * from a failing assertion, and counting it as a test failure would make the
   * numbers disagree with Jest's own summary.
   */
  failedSuites: FailedSuite[];
  summary?: TestSummary;
  /** Spec files the runner marked FAIL, including any whose tests we missed. */
  failedFiles: string[];
  /** The last lines of the log; the fallback when nothing else parsed. */
  tail: string;
  /** The `ERROR: Job failed:` line, when GitLab wrote one. */
  jobError?: string;
}

/** How many trailing lines to keep as the fallback tail. */
const TAIL_LINES = 40;

export function analyseTrace(raw: string): TraceAnalysis {
  const text = cleanTrace(raw);
  const lines = text.split("\n");

  const analysis: TraceAnalysis = {
    runner: "unknown",
    failedTests: [],
    failedSuites: [],
    failedFiles: collectFailedFiles(lines),
    tail: lines.slice(-TAIL_LINES).join("\n"),
    jobError: lines.find((line) => line.startsWith("ERROR: Job failed"))?.trim(),
  };

  const summary = parseJestSummary(lines);
  const { tests, suites } = parseJestFailures(lines);

  // Any one signal is enough: a suite that crashes on import reports no test
  // names, and a run killed before the summary reports no counts.
  if (summary || tests.length > 0 || suites.length > 0) {
    analysis.runner = "jest";
    analysis.summary = summary;
    analysis.failedTests = tests;
    analysis.failedSuites = suites;
  }

  return analysis;
}

/** `FAIL src/app/thing.spec.ts (12.3 s)` */
function collectFailedFiles(lines: string[]): string[] {
  const files = new Set<string>();
  for (const line of lines) {
    const match = /^\s*FAIL\s+(\S+)/.exec(line);
    if (match?.[1]) files.add(match[1]);
  }
  return [...files];
}

/**
 * `Tests:       3 failed, 240 passed, 243 total`
 *
 * Read from the end: a monorepo runs Jest per project, and the last summary is
 * the one that matches the job's exit status.
 *
 * Anchored at the start of the line on purpose. A coverage reporter may print its
 * own box — `║  Tests:  11,997 total, 13 failures  ║` — after Jest's summary, and
 * reading backwards would otherwise find that one first and misparse its
 * comma-grouped numbers.
 */
function parseJestSummary(lines: string[]): TestSummary | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // `\s*` and not `.*`: the box-drawing variant has a `║` before "Tests:".
    if (!/^\s*Tests:/.test(line)) continue;

    const failed = /(\d+)\s+failed/.exec(line);
    const passed = /(\d+)\s+passed/.exec(line);
    const total = /(\d+)\s+total/.exec(line);
    if (!total) continue;

    const suites = lines
      .slice(0, i)
      .reverse()
      .find((candidate) => /^\s*Test Suites:/.test(candidate));

    return {
      failed: failed ? Number(failed[1]) : 0,
      passed: passed ? Number(passed[1]) : 0,
      total: Number(total[1]),
      suitesFailed: suites
        ? Number(/(\d+)\s+failed/.exec(suites)?.[1] ?? 0)
        : undefined,
    };
  }
  return undefined;
}

/**
 * Jest marks each failure with `●`. A block runs to the next `●`, the next
 * `FAIL`/`PASS`, or the summary — whichever comes first.
 */
function parseJestFailures(allLines: string[]): {
  tests: FailedTest[];
  suites: FailedSuite[];
} {
  const lines = failureSection(allLines);
  const tests: FailedTest[] = [];
  const suites: FailedSuite[] = [];
  let currentFile: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // A capped trace is a head+tail capture. Anything after this marker is not
    // contiguous with the file header seen before it, so carrying `currentFile`
    // across the gap can blame a failure on the wrong spec.
    if (isTraceOmission(line)) {
      currentFile = undefined;
      continue;
    }

    const fileMatch = /^\s*(?:FAIL|PASS)\s+(\S+)/.exec(line);
    if (fileMatch?.[1]) {
      currentFile = fileMatch[1];
      continue;
    }

    const bullet = /^\s*●\s+(.+)$/.exec(line);
    if (!bullet?.[1]) continue;

    const name = bullet[1].trim();
    // Jest reuses ● for advisory blocks that are not test failures.
    if (isNotATestFailure(name)) continue;

    const detail: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (isTraceOmission(next)) break;
      if (/^\s*●/.test(next)) break;
      if (/^\s*(FAIL|PASS)\s+\S/.test(next)) break;
      if (/^\s*(Test Suites|Tests|Snapshots|Time|Ran all test suites):/.test(next)) break;
      detail.push(next);
    }

    const text = tidyDetail(detail);
    // Large GitLab traces can lose the suite's FAIL header while retaining the
    // failure and its stack in the tail capture. Jest's own stack frame is then
    // the strongest available identity and is safer than guessing from a class
    // name such as `SpGtmService`.
    const file = currentFile ?? specFileFromDetail(detail);

    // "Test suite failed to run" is a suite-level marker, not a test name.
    // Counting it as a failed test would put the count out of step with Jest's
    // own summary, which reports 0 failed tests in that case.
    if (/^Test suite failed to run/i.test(name)) {
      suites.push({ ...(file ? { file } : {}), detail: text });
      continue;
    }

    tests.push({ ...(file ? { file } : {}), name, detail: text });
  }

  // Jest prints each failure twice: once as its suite finishes, then again under
  // "Summary of all failing tests" at the end. Left as-is, a run with 13 failures
  // reports 26 and disagrees with the summary line in the same output.
  return { tests: dedupeTests(tests), suites: dedupeSuites(suites) };
}

/** Marker inserted by the bounded HTTP reader between a trace's head and tail. */
const TRACE_OMISSION = /^\.\.\. \[\d+ bytes omitted of \d+ total\] \.\.\.$/;

function isTraceOmission(line: string): boolean {
  return TRACE_OMISSION.test(line.trim());
}

/**
 * Recovers a spec path from Jest's application stack frame.
 *
 * Deliberately requires `.spec.*` or `.test.*`: arbitrary stack frames name
 * production and framework files too, and choosing one of those would create a
 * stable-looking but false ticket identity.
 */
function specFileFromDetail(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (/\bnode_modules[\\/]/.test(line)) continue;
    const match =
      /(?:^|[\s(])((?:file:\/\/)?[^()\s]+?\.(?:spec|test)\.[cm]?[jt]sx?):\d+(?::\d+)?(?:\)|\s|$)/.exec(
        line,
      );
    if (!match?.[1]) continue;

    let path = match[1].replace(/^file:\/\//, "").replaceAll("\\", "/");
    // Absolute CI paths begin with runner-owned directories. Return the
    // repository-relative part when it has a conventional source root.
    if (path.startsWith("/")) {
      const relative = /\/((?:apps|libs|packages|projects|src|test|tests)\/.+)$/.exec(path);
      if (relative?.[1]) path = relative[1];
    }
    return path.replace(/^\.\//, "");
  }
  return undefined;
}

/**
 * Keeps the first occurrence of each file+name pair.
 *
 * First rather than last because the inline block is emitted while the suite is
 * still in context, and the end-of-run repeat is occasionally trimmed.
 */
function dedupeTests(tests: FailedTest[]): FailedTest[] {
  const seen = new Set<string>();
  return tests.filter((test) => {
    const key = `${test.file ?? ""} ${test.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSuites(suites: FailedSuite[]): FailedSuite[] {
  const seen = new Set<string>();
  return suites.filter((suite) => {
    // Keyed on the detail too: two suites can share a file only if one of them
    // has no file at all, and then the cause is the only thing telling them apart.
    const key = `${suite.file ?? ""} ${suite.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Stack frames inside dependencies, which never name the broken line. */
const VENDOR_FRAME = /^\s*at .*\b(node_modules|internal\/|node:)/;

/**
 * Collapses a failure's detail to the part that identifies the bug.
 *
 * An Angular + Jest stack is mostly zone.js and @angular/core frames — 20 lines
 * of framework internals around the one line naming the spec file. Dropping the
 * vendor frames is what makes the difference between a readable ticket and a wall
 * of `node_modules` paths, and the count is kept so nothing looks lost.
 */
function tidyDetail(lines: string[]): string {
  const kept: string[] = [];
  let dropped = 0;

  for (const line of lines) {
    if (VENDOR_FRAME.test(line)) {
      dropped++;
      continue;
    }
    kept.push(line);
  }

  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // Only worth saying when the frames were the bulk of it; a stack of two adds
  // noise to report.
  return dropped > 2 ? `${text}\n  … ${dropped} framework stack frame(s) omitted` : text;
}

/**
 * The lines worth parsing failures from.
 *
 * With `--ci`, Jest reports each failure twice: inline as its suite finishes, and
 * again under "Summary of all failing tests" at the end. The recap is the better
 * source, and not only to avoid duplicates — a parallel run interleaves the
 * inline blocks with other workers' console output, so a block there can absorb
 * hundreds of unrelated lines before the next `●` ends it. The recap is
 * contiguous.
 *
 * Falls back to the whole log when there is no recap: a run killed before the
 * end still has its inline blocks, and they are all that is left.
 */
function failureSection(lines: string[]): string[] {
  const start = lines.findIndex((line) => /^Summary of all failing tests/i.test(line.trim()));
  if (start === -1) return lines;

  // The recap ends at the counts. Without this the coverage table and the
  // post-run banners would be read as one enormous failure detail.
  const after = lines
    .slice(start + 1)
    .findIndex((line) => /^\s*(Test Suites|Tests|Snapshots|Ran all test suites):?/.test(line));

  return after === -1
    ? lines.slice(start + 1)
    : lines.slice(start + 1, start + 1 + after);
}

/** Advisory `●` blocks Jest emits that are not failures. */
function isNotATestFailure(name: string): boolean {
  return (
    /^Console$/i.test(name) ||
    /^Deprecation Warning/i.test(name) ||
    name.startsWith("Cannot log after tests are done")
  );
}

export interface FormatOptions {
  /** Cap the rendered output. Extra failures are counted, not printed. */
  maxTests?: number;
  /** Cap each failure's detail, in lines. */
  maxDetailLines?: number;
  /** Include the raw tail even when parsing succeeded. */
  includeTail?: boolean;
}

const DEFAULT_MAX_TESTS = 20;
const DEFAULT_MAX_DETAIL_LINES = 25;

/**
 * Renders an analysis as plain text.
 *
 * Plain text rather than markdown or ANSI: this same string goes to a terminal,
 * a SQLite row and a Jira description, and the one format all three accept
 * without escaping is plain text.
 */
export function formatAnalysis(
  analysis: TraceAnalysis,
  options: FormatOptions = {},
): string {
  const maxTests = options.maxTests ?? DEFAULT_MAX_TESTS;
  const maxDetailLines = options.maxDetailLines ?? DEFAULT_MAX_DETAIL_LINES;
  const out: string[] = [];

  if (analysis.summary) {
    const s = analysis.summary;
    out.push(
      `Tests: ${s.failed} failed, ${s.passed} passed, ${s.total} total` +
        (s.suitesFailed ? ` (${s.suitesFailed} suite(s) failed)` : ""),
    );
  }

  if (analysis.failedTests.length === 0 && analysis.failedSuites.length > 0) {
    // Distinct from both "no failures" and "nothing parsed": the suites are known
    // and so is why they died.
    out.push(`\nSuites that failed to run (${analysis.failedSuites.length}):`);
    for (const suite of analysis.failedSuites) {
      out.push(`\n  ✗ ${suite.file ?? "(unknown file)"}`);
      for (const line of suite.detail.split("\n").filter((l) => l.trim() !== "").slice(0, maxDetailLines)) {
        out.push(`      ${line.trim()}`);
      }
    }
    if (analysis.jobError) out.push(`\n${analysis.jobError}`);
    return out.join("\n");
  }

  if (analysis.failedTests.length === 0) {
    // Saying which case this is matters: "no failures parsed" and "no failures"
    // look identical in the output but mean opposite things.
    out.push(
      analysis.runner === "unknown"
        ? "No recognised test output. Raw log tail:"
        : "No individual test failures reported — the suite likely failed to run. Raw log tail:",
    );
    if (analysis.jobError) out.push(`\n${analysis.jobError}`);
    out.push(`\n${analysis.tail}`);
    return out.join("\n");
  }

  const shown = analysis.failedTests.slice(0, maxTests);
  out.push(`\nFailed tests (${analysis.failedTests.length}):`);

  for (const test of shown) {
    out.push(`\n  ✗ ${test.name}`);
    if (test.file) out.push(`    ${test.file}`);

    const detailLines = test.detail.split("\n").filter((l) => l.trim() !== "");
    for (const line of detailLines.slice(0, maxDetailLines)) {
      out.push(`      ${line.trim()}`);
    }
    if (detailLines.length > maxDetailLines) {
      out.push(`      … ${detailLines.length - maxDetailLines} more line(s)`);
    }
  }

  if (analysis.failedTests.length > shown.length) {
    out.push(`\n… and ${analysis.failedTests.length - shown.length} more failed test(s)`);
  }

  // A suite that died on import carries the most useful failure in the log, and
  // it reports no test name — so it would otherwise go unmentioned entirely.
  if (analysis.failedSuites.length > 0) {
    out.push(`\nSuites that failed to run (${analysis.failedSuites.length}):`);
    for (const suite of analysis.failedSuites) {
      out.push(`\n  ✗ ${suite.file ?? "(unknown file)"}`);
      for (const line of suite.detail.split("\n").filter((l) => l.trim() !== "").slice(0, maxDetailLines)) {
        out.push(`      ${line.trim()}`);
      }
    }
  }

  if (analysis.jobError) out.push(`\n${analysis.jobError}`);
  if (options.includeTail) out.push(`\nRaw log tail:\n${analysis.tail}`);

  return out.join("\n");
}

/** One-line title for a ticket, derived deterministically — no LLM involved. */
export function summariseFailure(analysis: TraceAnalysis, jobName: string): string {
  const first = analysis.failedTests[0];
  if (!first) {
    // A suite that could not load is the more specific fact, so prefer it over
    // the count — which is 0 in exactly that case and would read as "nothing
    // failed".
    const suite = analysis.failedSuites[0];
    if (suite) {
      const extra =
        analysis.failedSuites.length > 1
          ? ` (+${analysis.failedSuites.length - 1} more)`
          : "";
      return `${jobName}: suite failed to run — ${suite.file ?? "unknown file"}${extra}`;
    }
    return analysis.summary
      ? `${jobName}: ${analysis.summary.failed} test(s) failed`
      : `${jobName}: job failed`;
  }

  const extra =
    analysis.failedTests.length > 1
      ? ` (+${analysis.failedTests.length - 1} more)`
      : "";
  return `${jobName}: ${first.name}${extra}`;
}
