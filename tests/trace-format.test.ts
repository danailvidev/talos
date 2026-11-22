import { describe, expect, test } from "bun:test";
import {
  analyseTrace,
  cleanTrace,
  formatAnalysis,
  stripTimestampPrefixes,
  summariseFailure,
} from "../src/connectors/gitlab/trace-format.ts";
import {
  GITLAB_TIMESTAMPED_TRACE,
  JEST_FAILURE_TRACE,
  JEST_SUITE_CRASH_TRACE,
  NON_TEST_FAILURE_TRACE,
} from "./fixtures/jest-trace.ts";

describe("cleanTrace", () => {
  test("strips ANSI escapes", () => {
    const cleaned = cleanTrace(JEST_FAILURE_TRACE);
    expect(cleaned).not.toContain("\x1b");
    expect(cleaned).toContain("Tests:       2 failed, 238 passed, 240 total");
  });

  test("drops GitLab section markers, which are metadata not output", () => {
    const cleaned = cleanTrace(JEST_FAILURE_TRACE);
    // They also carry epoch seconds, which would make identical runs differ.
    expect(cleaned).not.toContain("section_start");
    expect(cleaned).not.toContain("section_end");
    expect(cleaned).not.toContain("1755680000");
  });

  test("keeps section names when asked", () => {
    const cleaned = cleanTrace(JEST_FAILURE_TRACE, { keepSectionNames: true });
    expect(cleaned).toContain("--- prepare_executor ---");
  });

  test("keeps only the final state of a line rewritten by carriage returns", () => {
    const cleaned = cleanTrace(JEST_FAILURE_TRACE);
    // A progress bar's intermediate states are noise; without this the log reads
    // as duplicated gibberish.
    expect(cleaned).not.toContain("Determining test suites to run... 20%");
    expect(cleaned).toContain("RUNS  src/app/checkout/checkout.component.spec.ts");
  });

  test("collapses the blank runs left by removed markers", () => {
    expect(cleanTrace(JEST_FAILURE_TRACE)).not.toContain("\n\n\n");
  });

  test("an empty trace does not throw", () => {
    expect(cleanTrace("")).toBe("");
  });
});

describe("stripTimestampPrefixes", () => {
  test("removes GitLab's FF_TIMESTAMPS prefix, including the + continuation form", () => {
    const stripped = stripTimestampPrefixes(
      [
        "2026-08-21T02:46:53.491496Z 01E   ● CheckoutComponent › fails",
        "2026-08-21T01:32:11.553950Z 00O+section_start:1787275933:step_script",
      ].join("\n"),
    );

    expect(stripped).toBe(
      ["  ● CheckoutComponent › fails", "section_start:1787275933:step_script"].join("\n"),
    );
  });

  test("leaves an unprefixed trace untouched", () => {
    // Otherwise a log line that merely mentions a timestamp would be mangled.
    expect(stripTimestampPrefixes(JEST_SUITE_CRASH_TRACE)).toBe(JEST_SUITE_CRASH_TRACE);
  });

  test("does not strip when only a few lines match", () => {
    const text = [
      "2026-08-21T02:46:53.491496Z 01E prefixed",
      "plain one",
      "plain two",
      "plain three",
    ].join("\n");
    // A build script echoing one timestamp-shaped line is not a prefixed trace.
    expect(stripTimestampPrefixes(text)).toBe(text);
  });

  test("an empty trace does not throw", () => {
    expect(stripTimestampPrefixes("")).toBe("");
  });
});

describe("analyseTrace on a real gitlab.com timestamped trace", () => {
  const analysis = analyseTrace(GITLAB_TIMESTAMPED_TRACE);

  test("parses through the line prefixes", () => {
    // Every pattern in the parser is ^-anchored, so a surviving prefix means
    // nothing at all is recognised.
    expect(analysis.runner).toBe("jest");
    expect(analysis.summary).toEqual({
      failed: 2,
      passed: 238,
      total: 240,
      suitesFailed: 1,
    });
  });

  test("reads Jest's counts, not the coverage reporter's box that follows", () => {
    // The box is printed later and uses grouped digits: reading backwards finds
    // it first, and "11,997 total" parses as 11.
    expect(analysis.summary?.total).toBe(240);
  });

  test("reports each failure once, matching Jest's own count", () => {
    // Jest prints every failure twice under --ci. Counting both gives 4 here and
    // contradicts the "2 failed" on the summary line in the same output.
    expect(analysis.failedTests).toHaveLength(2);
    expect(analysis.failedTests.map((t) => t.name)).toEqual([
      "CheckoutComponent › applies a percentage discount",
      "CheckoutComponent › rejects a negative quantity",
    ]);
  });

  test("takes detail from the recap, not the interleaved inline copy", () => {
    const [first] = analysis.failedTests;
    expect(first!.detail).toContain("Expected: 90");
    // The inline copy absorbs a parallel worker's console output up to the next
    // bullet; the recap is contiguous.
    expect(first!.detail).not.toContain("unrelated worker noise");
  });

  test("attributes the failures to the file from the recap's FAIL line", () => {
    expect(analysis.failedTests[0]!.file).toBe(
      "src/app/checkout/checkout.component.spec.ts",
    );
  });

  test("drops framework stack frames but keeps the spec file's own", () => {
    const analysis = analyseTrace(
      [
        "Summary of all failing tests",
        "FAIL src/app/thing.spec.ts",
        "  ● Thing › breaks",
        "    Expected: 1",
        "    at Object.<anonymous> (src/app/thing.spec.ts:40:29)",
        "    at _ZoneDelegate.invoke (node_modules/zone.js/bundles/zone.umd.js:410:32)",
        "    at ProxyZoneSpec.onInvoke (node_modules/zone.js/bundles/zone-testing.umd.js:2219:43)",
        "    at ZoneImpl.run (node_modules/zone.js/bundles/zone.umd.js:145:47)",
        "    at listOnTimeout (node:internal/timers:581:17)",
        "Tests:       1 failed, 0 passed, 1 total",
      ].join("\n"),
    );

    const detail = analysis.failedTests[0]!.detail;
    // The one frame naming the spec is the whole point of keeping any.
    expect(detail).toContain("src/app/thing.spec.ts:40:29");
    expect(detail).not.toContain("zone.js");
    expect(detail).not.toContain("node:internal");
    // Reported rather than silently removed.
    expect(detail).toContain("4 framework stack frame(s) omitted");
  });

  test("still finds the job's exit line", () => {
    expect(analysis.jobError).toBe("ERROR: Job failed: exit code 1");
  });

  test("the formatted output is free of prefixes and ANSI", () => {
    const text = formatAnalysis(analysis);
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("2026-08-21T02:4");
    expect(text).not.toContain("section_start");
  });
});

describe("analyseTrace on a Jest failure", () => {
  const analysis = analyseTrace(JEST_FAILURE_TRACE);

  test("recognises the runner", () => {
    expect(analysis.runner).toBe("jest");
  });

  test("reads the summary counts", () => {
    expect(analysis.summary).toEqual({
      failed: 2,
      passed: 238,
      total: 240,
      suitesFailed: 2,
    });
  });

  test("keeps a suite that failed to run apart from the failing tests", () => {
    // Jest reports 0 failed tests in that case, so counting it as one would put
    // our numbers out of step with the summary in the same output.
    expect(analysis.failedSuites).toHaveLength(1);
    expect(analysis.failedSuites[0]!.file).toBe(
      "projects/parent-portal/src/app/billing/billing.service.spec.ts",
    );
    expect(analysis.failedSuites[0]!.detail).toContain("Cannot find module");
    expect(analysis.failedTests.map((t) => t.name)).not.toContain(
      "Test suite failed to run",
    );
  });

  test("extracts each failed test with its file and assertion", () => {
    expect(analysis.failedTests).toHaveLength(2);

    const [first, second] = analysis.failedTests;
    expect(first!.name).toBe(
      "CheckoutComponent › applies a percentage discount to the subtotal",
    );
    expect(first!.file).toBe("src/app/checkout/checkout.component.spec.ts");
    expect(first!.detail).toContain("Expected: 90");
    expect(first!.detail).toContain("Received: 100");
    // The detail must stop at the next failure, not swallow it.
    expect(first!.detail).not.toContain("rejects a negative quantity");

    expect(second!.name).toBe("CheckoutComponent › rejects a negative quantity");
    expect(second!.detail).toContain("did not throw");
  });

  test("does not attribute a failure to a passing file", () => {
    // PASS lines also set the current file; a failure after one must not be
    // blamed on it.
    for (const test of analysis.failedTests) {
      expect(test.file).not.toContain("currency.pipe.spec.ts");
      expect(test.file).not.toContain("auth.service.spec.ts");
    }
  });

  test("lists files marked FAIL, including the suite that failed to run", () => {
    expect(analysis.failedFiles).toContain(
      "projects/parent-portal/src/app/billing/billing.service.spec.ts",
    );
  });

  test("captures the job's exit line", () => {
    expect(analysis.jobError).toBe("ERROR: Job failed: exit code 1");
  });

  test("detail is free of ANSI, so it is safe in a ticket body", () => {
    for (const test of analysis.failedTests) {
      expect(test.detail).not.toContain("\x1b");
    }
  });
});

describe("analyseTrace on a truncated Jest recap", () => {
  test("recovers a missing FAIL header from the test's own stack frame", () => {
    const analysis = analyseTrace(
      [
        "Summary of all failing tests",
        "  ● SpGtmService › pushes an event",
        "    Expected: true",
        "    at Object.<anonymous> (projects/student-portal/src/app/core/services/sp-gtm.service.spec.ts:42:17)",
        "Tests:       1 failed, 0 passed, 1 total",
      ].join("\n"),
    );

    expect(analysis.failedTests[0]?.file).toBe(
      "projects/student-portal/src/app/core/services/sp-gtm.service.spec.ts",
    );
  });

  test("does not carry a file header across the omitted middle of a trace", () => {
    const analysis = analyseTrace(
      [
        "FAIL src/app/wrong.spec.ts",
        "  ● Wrong › fails",
        "    at Object.<anonymous> (src/app/wrong.spec.ts:1:1)",
        "... [900000 bytes omitted of 1200000 total] ...",
        "  ● Right › fails",
        "    at Object.<anonymous> (/builds/acme/web/projects/right/right.spec.ts:8:3)",
        "Tests:       2 failed, 0 passed, 2 total",
      ].join("\n"),
    );

    expect(analysis.failedTests.map((test) => test.file)).toEqual([
      "src/app/wrong.spec.ts",
      "projects/right/right.spec.ts",
    ]);
  });

  test("leaves a failure unresolved when neither header nor stack names a spec", () => {
    const analysis = analyseTrace(
      [
        "  ● Mystery › fails",
        "    Expected: true",
        "Tests:       1 failed, 0 passed, 1 total",
      ].join("\n"),
    );

    expect(analysis.failedTests[0]?.file).toBeUndefined();
  });
});

describe("analyseTrace on a suite that failed to run", () => {
  const analysis = analyseTrace(JEST_SUITE_CRASH_TRACE);

  test("still recognises Jest from the summary alone", () => {
    // No test names are reported when a suite dies on import.
    expect(analysis.runner).toBe("jest");
    expect(analysis.summary?.total).toBe(0);
    expect(analysis.failedTests).toEqual([]);
    expect(analysis.failedSuites).toHaveLength(1);
  });

  test("names the file that failed", () => {
    expect(analysis.failedFiles).toEqual(["src/app/app.component.spec.ts"]);
  });

  test("the formatted output says the suite failed rather than showing nothing", () => {
    const text = formatAnalysis(analysis);
    expect(text).toContain("Suites that failed to run (1)");
    // The actual cause has to survive into the output.
    expect(text).toContain("SyntaxError");
    expect(text).toContain("app.component.spec.ts");
  });
});

describe("analyseTrace on a non-test failure", () => {
  const analysis = analyseTrace(NON_TEST_FAILURE_TRACE);

  test("admits it recognised nothing", () => {
    expect(analysis.runner).toBe("unknown");
    expect(analysis.failedTests).toEqual([]);
  });

  test("falls back to the tail, so the real cause is still reported", () => {
    const text = formatAnalysis(analysis);
    expect(text).toContain("No recognised test output");
    // A formatter that returned an empty summary here would hide the failure.
    expect(text).toContain("EBADENGINE");
  });
});

describe("formatAnalysis", () => {
  const analysis = analyseTrace(JEST_FAILURE_TRACE);

  test("leads with the counts and lists every failure", () => {
    const text = formatAnalysis(analysis);
    expect(text).toContain("Tests: 2 failed, 238 passed, 240 total");
    expect(text).toContain("Failed tests (2):");
    expect(text).toContain("applies a percentage discount");
  });

  test("mentions a suite that failed without reporting tests", () => {
    // Otherwise the most useful failure in the log goes unmentioned.
    const text = formatAnalysis(analysis);
    expect(text).toContain("Suites that failed to run (1)");
    expect(text).toContain("billing.service.spec.ts");
    expect(text).toContain("Cannot find module");
  });

  test("caps the number of failures shown and counts the rest", () => {
    const many = {
      ...analysis,
      failedSuites: [],
      failedTests: Array.from({ length: 30 }, (_, i) => ({
        name: `test ${i}`,
        detail: "boom",
      })),
    };

    const text = formatAnalysis(many, { maxTests: 5 });
    expect(text).toContain("test 4");
    expect(text).not.toContain("test 5");
    expect(text).toContain("and 25 more failed test(s)");
  });

  test("caps each failure's detail", () => {
    const long = {
      ...analysis,
      failedSuites: [],
      failedTests: [
        {
          name: "verbose",
          detail: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
        },
      ],
    };

    const text = formatAnalysis(long, { maxDetailLines: 3 });
    expect(text).toContain("line 2");
    expect(text).toContain("more line(s)");
  });

  test("contains no ANSI, so it can go straight into a ticket", () => {
    expect(formatAnalysis(analysis)).not.toContain("\x1b");
  });

  test("includes the raw tail on request", () => {
    expect(formatAnalysis(analysis, { includeTail: true })).toContain("Raw log tail:");
  });
});

describe("summariseFailure", () => {
  test("names the first failing test and counts the others", () => {
    const analysis = analyseTrace(JEST_FAILURE_TRACE);
    // Deterministic, no LLM: this is the fallback title when AI is disabled.
    expect(summariseFailure(analysis, "test:unit")).toBe(
      "test:unit: CheckoutComponent › applies a percentage discount to the subtotal (+1 more)",
    );
  });

  test("names the suite that could not load, rather than reporting 0 failures", () => {
    const analysis = analyseTrace(JEST_SUITE_CRASH_TRACE);
    // The count is 0 here, which as a title would read as "nothing failed".
    expect(summariseFailure(analysis, "test:unit")).toBe(
      "test:unit: suite failed to run — src/app/app.component.spec.ts",
    );
  });

  test("falls back to counts when only a summary was parsed", () => {
    expect(
      summariseFailure(
        {
          runner: "jest",
          failedTests: [],
          failedSuites: [],
          failedFiles: [],
          tail: "",
          summary: { failed: 3, passed: 10, total: 13 },
        },
        "test:unit",
      ),
    ).toBe("test:unit: 3 test(s) failed");
  });

  test("falls back to the job name when nothing parsed at all", () => {
    const analysis = analyseTrace(NON_TEST_FAILURE_TRACE);
    expect(summariseFailure(analysis, "build")).toBe("build: job failed");
  });
});
