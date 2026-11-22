import { describe, expect, test } from "bun:test";
import type { TraceAnalysis } from "../src/connectors/gitlab/trace-format.ts";
import {
  SUITE_MARKER,
  UNATTRIBUTED,
  basename,
  diffSignatures,
  groupByFile,
  signatureOf,
  subjectKeyOf,
  titleOf,
  type FailureGroup,
} from "../src/tasks/ci-failure/group.ts";
import {
  buildChangeComment,
  buildDescription,
  type TicketContext,
} from "../src/tasks/ci-failure/ticket.ts";

function analysis(over: Partial<TraceAnalysis> = {}): TraceAnalysis {
  return {
    runner: "jest",
    failedTests: [],
    failedSuites: [],
    failedFiles: [],
    tail: "",
    ...over,
  };
}

function group(over: Partial<FailureGroup> = {}): FailureGroup {
  return {
    file: "src/app/checkout/checkout.component.spec.ts",
    tests: [],
    details: [],
    suiteFailedToRun: false,
    ...over,
  };
}

const CTX: TicketContext = {
  project: "acme/webportal",
  pipelineId: 4242,
  pipelineUrl: "https://gitlab.test/acme/webportal/-/pipelines/4242",
  jobId: 99,
  jobName: "unit-tests",
  jobUrl: "https://gitlab.test/acme/webportal/-/jobs/99",
  ref: "main",
};

describe("groupByFile", () => {
  test("puts every failing test in its file's group, order preserved", () => {
    const groups = groupByFile(
      analysis({
        failedTests: [
          { file: "a.spec.ts", name: "A › one", detail: "expected 1" },
          { file: "b.spec.ts", name: "B › one", detail: "expected 2" },
          { file: "a.spec.ts", name: "A › two", detail: "expected 3" },
        ],
      }),
    );

    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.file === "a.spec.ts")!;
    // One ticket per file is the whole grouping decision; order is the runner's.
    expect(a.tests).toEqual(["A › one", "A › two"]);
    expect(a.details.map((d) => d.detail)).toEqual(["expected 1", "expected 3"]);
  });

  test("leaves unattributed failures for the caller's parser diagnostic", () => {
    // A synthetic file would combine unrelated specs and produce a meaningless
    // flake rate and Jira ticket.
    const groups = groupByFile(
      analysis({ failedTests: [{ name: "orphan", detail: "boom" }] }),
    );
    expect(groups).toEqual([]);
  });

  test("creates a group for a suite that never ran and reported no tests", () => {
    const groups = groupByFile(
      analysis({ failedSuites: [{ file: "c.spec.ts", detail: "Cannot find module 'x'" }] }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.suiteFailedToRun).toBe(true);
    expect(groups[0]!.suiteDetail).toContain("Cannot find module");
    expect(groups[0]!.tests).toEqual([]);
  });

  test("merges a suite error into the group of a file that also failed tests", () => {
    const groups = groupByFile(
      analysis({
        failedTests: [{ file: "d.spec.ts", name: "D › one", detail: "x" }],
        failedSuites: [{ file: "d.spec.ts", detail: "and then it crashed" }],
      }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tests).toHaveLength(1);
    expect(groups[0]!.suiteFailedToRun).toBe(true);
  });
});

describe("signatureOf", () => {
  test("is order-independent, so a reordered run is not a change", () => {
    const one = signatureOf(group({ tests: ["B › x", "A › y"] }));
    const two = signatureOf(group({ tests: ["A › y", "B › x"] }));
    expect(one).toBe(two);
  });

  test("ignores assertion text and line numbers", () => {
    // "Expected 90, received 100" becomes "received 103" tomorrow; a signature
    // built on it would earn a pointless comment every night.
    const one = signatureOf(
      group({ tests: ["A › y"], details: [{ name: "A › y", detail: "received 100" }] }),
    );
    const two = signatureOf(
      group({ tests: ["A › y"], details: [{ name: "A › y", detail: "received 103" }] }),
    );
    expect(one).toBe(two);
  });

  test("separates names by newline, since a test name contains spaces", () => {
    const signature = signatureOf(group({ tests: ["Component › does a thing"] }));
    expect(signature.split("\n")).toEqual(["Component › does a thing"]);
  });

  test("records a suite failure alongside the test names, not instead of them", () => {
    const signature = signatureOf(
      group({ tests: ["A › y"], suiteFailedToRun: true, suiteDetail: "boom" }),
    );
    expect(signature.split("\n")).toContain(SUITE_MARKER);
    expect(signature.split("\n")).toContain("A › y");
  });

  test("summarises a file failing wholesale by count", () => {
    const many = Array.from({ length: 120 }, (_, i) => `T ${String(i).padStart(3, "0")}`);
    const signature = signatureOf(group({ tests: many }));
    expect(signature.split("\n")).toHaveLength(51);
    expect(signature).toContain("and-more:70");
  });
});

describe("subjectKeyOf", () => {
  test("carries the project, so one db can serve repos with the same paths", () => {
    expect(subjectKeyOf("acme/web", group({ file: "a.spec.ts" }))).toBe(
      "spec:acme/web:a.spec.ts",
    );
    expect(subjectKeyOf(42, group({ file: "a.spec.ts" }))).toBe("spec:42:a.spec.ts");
  });

  test("carries no pipeline id — that is what makes it survive to tomorrow", () => {
    expect(subjectKeyOf("acme/web", group())).not.toMatch(/\d{3,}/);
  });
});

describe("titleOf", () => {
  test("leads with the basename and names the first failing test", () => {
    expect(titleOf(group({ tests: ["Checkout › applies a discount"] }))).toBe(
      "Unit test failure: checkout.component.spec.ts — Checkout › applies a discount",
    );
  });

  test("counts the rest rather than listing them", () => {
    expect(titleOf(group({ tests: ["one", "two", "three"] }))).toContain("(+2 more)");
  });

  test("says so when the suite never ran", () => {
    expect(titleOf(group({ suiteFailedToRun: true }))).toContain("suite failed to run");
  });

  test("honours a configured prefix", () => {
    expect(titleOf(group({ tests: ["one"] }), "Nightly")).toStartWith("Nightly: ");
  });
});

describe("basename", () => {
  test("takes the last path segment, and copes with no separator", () => {
    expect(basename("a/b/c.spec.ts")).toBe("c.spec.ts");
    expect(basename("c.spec.ts")).toBe("c.spec.ts");
    expect(basename(UNATTRIBUTED)).toBe(UNATTRIBUTED);
  });
});

describe("diffSignatures", () => {
  test("returns null for the same tests failing again — the common case", () => {
    // Null must mean no Jira call at all; that is why a signature is stored.
    const g = group({ tests: ["A › y", "B › x"] });
    expect(diffSignatures(signatureOf(g), g)).toBeNull();
  });

  test("is null across a reordered run", () => {
    const before = signatureOf(group({ tests: ["B › x", "A › y"] }));
    expect(diffSignatures(before, group({ tests: ["A › y", "B › x"] }))).toBeNull();
  });

  test("reports added and removed tests", () => {
    const before = signatureOf(group({ tests: ["A › y", "B › x"] }));
    const diff = diffSignatures(before, group({ tests: ["A › y", "C › z"] }));
    expect(diff?.added).toEqual(["C › z"]);
    expect(diff?.removed).toEqual(["B › x"]);
    expect(diff?.suiteChanged).toBe(false);
  });

  test("reports a file that stopped compiling", () => {
    const before = signatureOf(group({ tests: ["A › y"] }));
    const diff = diffSignatures(
      before,
      group({ tests: ["A › y"], suiteFailedToRun: true, suiteDetail: "Cannot find module" }),
    );
    expect(diff?.suiteChanged).toBe(true);
    expect(diff?.added).toEqual([]);
  });

  test("reports a file that started compiling again", () => {
    const before = signatureOf(group({ tests: ["A › y"], suiteFailedToRun: true }));
    const diff = diffSignatures(before, group({ tests: ["A › y"] }));
    expect(diff?.suiteChanged).toBe(true);
  });

  test("does not mistake a marker for a test name", () => {
    // Markers are space-prefixed; a trimmed test name never is.
    const before = signatureOf(group({ tests: ["A › y"], suiteFailedToRun: true }));
    const diff = diffSignatures(
      before,
      group({ tests: ["A › y"], suiteFailedToRun: true }),
    );
    expect(diff).toBeNull();
  });

  test("treats an empty stored signature as everything being new", () => {
    const diff = diffSignatures("", group({ tests: ["A › y"] }));
    expect(diff?.added).toEqual(["A › y"]);
    expect(diff?.removed).toEqual([]);
  });
});

describe("buildDescription", () => {
  function text(document: unknown): string {
    return JSON.stringify(document);
  }

  test("answers what failed, what the runner said, and where the log is", () => {
    const document = buildDescription(
      group({
        tests: ["Checkout › applies a discount"],
        details: [
          {
            name: "Checkout › applies a discount",
            detail: "expect(total).toBe(90)\n  Received: 100",
          },
        ],
      }),
      { ...CTX, summary: { failed: 1, passed: 20, total: 21 } },
    );

    const json = text(document);
    expect(json).toContain("checkout.component.spec.ts");
    expect(json).toContain("Received: 100");
    expect(json).toContain(CTX.jobUrl);
    expect(json).toContain(CTX.pipelineUrl);
    expect(json).toContain("1 failed, 20 passed, 21 total");
    // So nobody wonders who typed it.
    expect(json).toContain("talos");
  });

  test("leads with the suite error when the file failed to run", () => {
    const document = buildDescription(
      group({ suiteFailedToRun: true, suiteDetail: "Cannot find module 'x'" }),
      CTX,
    );

    const headings = document.content.filter((n) => n.type === "heading");
    expect(headings[0]?.content?.[0]?.text).toBe("Suite failed to run");
    expect(text(document)).toContain("failed to run — no tests in it executed");
  });

  test("shows the first ten details in full and counts the rest", () => {
    const tests = Array.from({ length: 14 }, (_, i) => `T${i}`);
    const document = buildDescription(
      group({
        tests,
        details: tests.map((name) => ({ name, detail: `detail for ${name}` })),
      }),
      CTX,
    );

    const json = text(document);
    expect(json).toContain("detail for T0");
    expect(json).toContain("detail for T9");
    // A ticket is not a log dump.
    expect(json).not.toContain("detail for T13");
    expect(json).toContain("4 further failing test(s)");
  });

  test("caps a runaway detail block and says how much was dropped", () => {
    const detail = Array.from({ length: 60 }, (_, i) => `frame ${i}`).join("\n");
    const json = text(
      buildDescription(group({ tests: ["A"], details: [{ name: "A", detail }] }), CTX),
    );
    expect(json).toContain("frame 19");
    expect(json).not.toContain("frame 20");
    expect(json).toContain("40 more line(s)");
  });

  test("tells the reader when the log itself was truncated before parsing", () => {
    // Otherwise a reader who cannot find a failure doubts the parser.
    const json = text(
      buildDescription(group({ tests: ["A"] }), { ...CTX, traceTruncated: true }),
    );
    expect(json).toContain("truncated before parsing");
  });

  test("includes the commit when known", () => {
    const json = text(
      buildDescription(group({ tests: ["A"] }), {
        ...CTX,
        commitTitle: "Bump lib",
        commitAuthor: "Ada",
      }),
    );
    expect(json).toContain("Bump lib — Ada");
  });
});

describe("buildChangeComment", () => {
  test("posts the diff, not a re-post of the description", () => {
    const g = group({
      tests: ["A › y", "C › z"],
      details: [
        { name: "A › y", detail: "old and unchanged" },
        { name: "C › z", detail: "brand new failure" },
      ],
    });
    const diff = diffSignatures(signatureOf(group({ tests: ["A › y", "B › x"] })), g)!;

    const json = JSON.stringify(buildChangeComment(g, diff, CTX));
    expect(json).toContain("C › z");
    expect(json).toContain("brand new failure");
    expect(json).toContain("B › x");
    expect(json).toContain("No longer failing");
    // The ticket already carries the original detail for the unchanged failure.
    expect(json).not.toContain("old and unchanged");
  });

  test("explains a suite that stopped compiling in words", () => {
    const g = group({ tests: ["A › y"], suiteFailedToRun: true });
    const diff = diffSignatures(signatureOf(group({ tests: ["A › y"] })), g)!;
    expect(JSON.stringify(buildChangeComment(g, diff, CTX))).toContain(
      "fails to run at all",
    );
  });

  test("links the job log of the run that observed the change", () => {
    const g = group({ tests: ["A"] });
    const diff = diffSignatures("", g)!;
    const json = JSON.stringify(buildChangeComment(g, diff, CTX));
    expect(json).toContain(CTX.jobUrl);
    expect(json).toContain("Pipeline #4242 on main");
  });
});
