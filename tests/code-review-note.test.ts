import { describe, expect, test } from "bun:test";
import {
  formatFailedNote,
  formatProgressNote,
  formatReviewNote,
} from "../src/tasks/code-review/notes.ts";

describe("formatProgressNote", () => {
  test("matches GitLab Duo's review-session activity row", () => {
    expect(formatProgressNote("task-abc")).toBe(
      "Talos started review session task-abc and will let you know when it's finished.",
    );
  });
});

describe("formatFailedNote", () => {
  test("replaces the in-progress row so the MR is not left waiting", () => {
    expect(formatFailedNote("task-abc", "container timed out")).toContain("task-abc");
    expect(formatFailedNote("task-abc", "container timed out")).toContain("container timed out");
  });
});

describe("formatReviewNote", () => {
  test("keeps the findings table", () => {
    const body = formatReviewNote(
      {
        id: 1,
        iid: 6193,
        project_id: 42,
        title: "fix",
        state: "opened",
        source_branch: "fix/TP-3012",
        target_branch: "main",
        sha: "abcdef12deadbeef",
        web_url: "https://gitlab.com/acme/web/-/merge_requests/6193",
        updated_at: new Date("2026-08-25T00:00:00.000Z"),
      },
      "looks good",
      [{ severity: "nit", file: "a.ts", comment: "n" }],
    );
    expect(body).toContain("fix/TP-3012 @ abcdef12");
    expect(body).toContain("| nit | a.ts | n |");
  });
});
