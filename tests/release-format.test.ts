import { describe, expect, test } from "bun:test";

import {
  buildReleaseRevertDescription,
  buildReleaseRevertTitle,
  buildReleaseSlackMessage,
} from "../shared/release-format.ts";

describe("release revert formatting", () => {
  test("names the source deployment in the MR", () => {
    expect(buildReleaseRevertTitle("dev", "abcdef12")).toBe(
      "Revert DEV deployment abcdef12",
    );
    expect(
      buildReleaseRevertDescription({
        environment: "dev",
        shortSha: "abcdef12",
        commitUrl: "https://gitlab.example/commit/abcdef12",
        changes: [
          {
            service: "api",
            section: "services",
            previousVersion: "2.0.0",
            version: "1.0.0",
          },
        ],
      }),
    ).toContain(
      "Reverts deployment [`abcdef12`](https://gitlab.example/commit/abcdef12) from **DEV**.",
    );
  });

  test("labels Slack announcements as reverts", () => {
    expect(
      buildReleaseSlackMessage({
        environment: "dev",
        kind: "revert",
        changes: [],
        mrUrl: "https://gitlab.example/mr/1",
        author: "dev@example.com",
        merged: false,
        autoMergeEnabled: true,
      }),
    ).toStartWith("*DEV revert* — opened by dev@example.com");
  });
});
