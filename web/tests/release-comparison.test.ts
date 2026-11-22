import { describe, expect, test } from "bun:test";
import type {
  EnvironmentVersionView,
  ReleaseHistoryEntryView,
} from "../src/api.ts";
import {
  compareSemanticVersions,
  differingServiceKeys,
  lowerServiceVersionKeys,
  sameDayDeploymentWarnings,
  type PendingReleaseVersionChange,
} from "../src/release-comparison.ts";
import { keys } from "../src/query-keys.ts";

function environment(
  name: string,
  services: EnvironmentVersionView["services"],
): EnvironmentVersionView {
  return { name, services };
}

describe("release environment comparison", () => {
  test("does not mark services with matching versions", () => {
    const left = environment("DEV", [
      { name: "web", version: "1.0.0", section: "applications" },
    ]);
    const right = environment("QA", [
      { name: "web", version: "1.0.0", section: "applications" },
    ]);

    expect([...differingServiceKeys(left, right)]).toEqual([]);
  });

  test("marks a service whose version differs", () => {
    const left = environment("DEV", [
      { name: "web", version: "1.0.0", section: "applications" },
    ]);
    const right = environment("QA", [
      { name: "web", version: "1.1.0", section: "applications" },
    ]);

    expect([...differingServiceKeys(left, right)]).toEqual(["applications:web"]);
  });

  test("distinguishes the same service name in different sections", () => {
    const left = environment("DEV", [
      { name: "gateway", version: "1.0.0", section: "applications" },
      { name: "gateway", version: "2.0.0", section: "services" },
    ]);
    const right = environment("QA", [
      { name: "gateway", version: "1.0.0", section: "applications" },
      { name: "gateway", version: "2.1.0", section: "services" },
    ]);

    expect([...differingServiceKeys(left, right)]).toEqual(["services:gateway"]);
  });

  test("marks services that exist in only one environment", () => {
    const left = environment("DEV", [
      { name: "web", version: "1.0.0", section: "applications" },
      { name: "worker", version: "2.0.0", section: "services" },
    ]);
    const right = environment("QA", [
      { name: "web", version: "1.0.0", section: "applications" },
      { name: "api", version: "3.0.0", section: "services" },
    ]);

    expect([...differingServiceKeys(left, right)]).toEqual([
      "services:worker",
      "services:api",
    ]);
  });

  test("identifies the lower semantic version on either side", () => {
    const left = environment("DEV", [
      { name: "web", version: "1.8.17", section: "applications" },
      { name: "api", version: "3.5.91", section: "services" },
    ]);
    const right = environment("QA", [
      { name: "web", version: "1.8.19", section: "applications" },
      { name: "api", version: "3.5.90", section: "services" },
    ]);

    const [lowerLeft, lowerRight] = lowerServiceVersionKeys(left, right);
    expect([...lowerLeft]).toEqual(["applications:web"]);
    expect([...lowerRight]).toEqual(["services:api"]);
  });

  test("does not order missing or non-semantic service versions", () => {
    const left = environment("DEV", [
      { name: "web", version: "latest", section: "applications" },
      { name: "worker", version: "1.0.0", section: "services" },
    ]);
    const right = environment("QA", [
      { name: "web", version: "1.0.0", section: "applications" },
    ]);

    const [lowerLeft, lowerRight] = lowerServiceVersionKeys(left, right);
    expect([...lowerLeft]).toEqual([]);
    expect([...lowerRight]).toEqual([]);
  });
});

describe("semantic version precedence", () => {
  test("compares numeric components numerically", () => {
    expect(compareSemanticVersions("1.9.9", "1.10.0")).toBe(-1);
    expect(compareSemanticVersions("2.0.0", "1.99.99")).toBe(1);
  });

  test("supports prereleases, build metadata, and dotted legacy prereleases", () => {
    expect(compareSemanticVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareSemanticVersions("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
    expect(compareSemanticVersions("2.4.45.maddietest2", "2.4.45")).toBe(-1);
  });

  test("does not compare invalid semantic versions", () => {
    expect(compareSemanticVersions("latest", "1.0.0")).toBeUndefined();
    expect(compareSemanticVersions("1.0", "1.0.0")).toBeUndefined();
  });
});

function deployment(
  overrides: Partial<ReleaseHistoryEntryView> = {},
): ReleaseHistoryEntryView {
  return {
    environment: "DEV3",
    sha: "abcdef123456",
    shortSha: "abcdef12",
    title: "DEV3 Services: assignment 1.1.1",
    authorName: "Alice",
    authorEmail: "alice@example.com",
    committedAt: "2026-10-02T09:00:00Z",
    webUrl: "https://gitlab.example/commit/abcdef123456",
    changes: [
      {
        service: "assignment",
        section: "services",
        from: "1.1.0",
        to: "1.1.1",
      },
    ],
    ...overrides,
  };
}

const assignmentChange: PendingReleaseVersionChange = {
  service: "assignment",
  section: "services",
  previousVersion: "1.1.1",
  version: "1.1.2",
};

function warnings(
  entries: ReleaseHistoryEntryView[],
  changes: PendingReleaseVersionChange[] = [assignmentChange],
  now = new Date("2026-10-02T12:00:00Z"),
  timeZone = "UTC",
) {
  return sameDayDeploymentWarnings({
    environment: "DEV3",
    changes,
    entries,
    now,
    timeZone,
  });
}

describe("same-day deployment warnings", () => {
  test("attributes a replacement to the matching service and environment", () => {
    expect(warnings([deployment()])).toEqual([
      {
        service: "assignment",
        section: "services",
        previousVersion: "1.1.1",
        version: "1.1.2",
        authorName: "Alice",
        authorEmail: "alice@example.com",
        committedAt: "2026-10-02T09:00:00Z",
        webUrl: "https://gitlab.example/commit/abcdef123456",
      },
    ]);
  });

  test("ignores a different environment, service, section, day, or current version", () => {
    const entries = [
      deployment({ environment: "DEV4" }),
      deployment({
        changes: [{ service: "billing", section: "services", from: "1.1.0", to: "1.1.1" }],
      }),
      deployment({
        changes: [
          {
            service: "assignment",
            section: "applications",
            from: "1.1.0",
            to: "1.1.1",
          },
        ],
      }),
      deployment({ committedAt: "2026-10-01T09:00:00Z" }),
      deployment({
        changes: [
          { service: "assignment", section: "services", from: "1.0.0", to: "1.1.0" },
        ],
      }),
    ];

    expect(warnings(entries)).toEqual([]);
  });

  test("returns one warning for each affected changed service", () => {
    const changes: PendingReleaseVersionChange[] = [
      assignmentChange,
      {
        service: "billing",
        section: "applications",
        previousVersion: "2.0.0",
        version: "2.1.0",
      },
    ];
    const entries = [
      deployment(),
      deployment({
        authorName: "Bob",
        changes: [
          { service: "billing", section: "applications", from: "1.9.0", to: "2.0.0" },
        ],
      }),
    ];

    expect(warnings(entries, changes).map((warning) => warning.service)).toEqual([
      "assignment",
      "billing",
    ]);
  });

  test("uses the newest history entry that set the current version", () => {
    const entries = [
      deployment({ authorName: "Newest", committedAt: "2026-10-02T11:00:00Z" }),
      deployment({ authorName: "Older", committedAt: "2026-10-02T08:00:00Z" }),
    ];

    expect(warnings(entries)[0]?.authorName).toBe("Newest");
  });

  test("uses the instance timezone at a calendar-day boundary", () => {
    const entry = deployment({ committedAt: "2026-10-02T00:30:00Z" });
    const now = new Date("2026-10-02T07:30:00Z");

    expect(warnings([entry], undefined, now, "America/Los_Angeles")).toEqual([]);
    expect(warnings([entry], undefined, now, "UTC")).toHaveLength(1);
  });
});

test("release history cache keys separate environments and calendar windows", () => {
  const dev3 = keys.releaseHistory(200, "DEV3", "2026-10-01T21:00:00.000Z");
  const dev4 = keys.releaseHistory(200, "DEV4", "2026-10-01T21:00:00.000Z");
  const nextDay = keys.releaseHistory(200, "DEV3", "2026-10-02T21:00:00.000Z");

  expect(dev3).not.toEqual(dev4);
  expect(dev3).not.toEqual(nextDay);
});
