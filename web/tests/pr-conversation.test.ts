import { describe, expect, test } from "bun:test";

import type { PullRequestFileChangeView, PullRequestThreadView } from "../src/api.ts";
import {
  findThreadLinePreview,
  withoutRedundantMetadataNotes,
} from "../src/pr/PullRequestConversation.tsx";

function thread(
  comments: Array<{ id: string; body: string; system: boolean }>,
): PullRequestThreadView {
  return {
    id: "thread",
    resolvable: false,
    resolved: false,
    comments: comments.map((comment) => ({
      ...comment,
      createdAt: "2026-09-17T12:00:00.000Z",
    })),
  };
}

describe("pull request conversation metadata", () => {
  test("removes only the redundant GitLab system-note shapes", () => {
    const visible = withoutRedundantMetadataNotes([
      thread([
        { id: "redundant", body: "  resolved all threads  ", system: true },
        { id: "assigned", body: "assigned to @danail.videv1", system: true },
        { id: "review", body: "requested review from @GitLabDuo", system: true },
        {
          id: "review-list",
          body:
            "requested review from @geraparf, @nicholas.klein, @tfarrell1993, and @GitLabDuo",
          system: true,
        },
        { id: "empty", body: "  \n", system: true },
        { id: "description", body: "changed the description", system: true },
        { id: "target", body: "changed target branch to main", system: true },
        { id: "user", body: "resolved all threads", system: false },
        { id: "user-assigned", body: "assigned to @danail.videv1", system: false },
        { id: "user-description", body: "changed the description", system: false },
        { id: "multiple", body: "assigned to @one and @two", system: true },
        { id: "single", body: "resolved thread", system: true },
      ]),
    ]);

    expect(visible[0]?.comments.map((comment) => comment.id)).toEqual([
      "target",
      "user",
      "user-assigned",
      "user-description",
      "multiple",
      "single",
    ]);
  });

  test("removes the empty standalone metadata thread", () => {
    expect(
      withoutRedundantMetadataNotes([
        thread([{ id: "redundant", body: "resolved all threads", system: true }]),
      ]),
    ).toEqual([]);
  });
});

describe("pull request conversation line previews", () => {
  const files: PullRequestFileChangeView[] = [
    {
      path: "src/models/mux-video-feedback.ts",
      previousPath: "src/legacy/mux-video-feedback.ts",
      status: "renamed",
      diff: [
        "@@ -57,5 +57,5 @@",
        " export interface Feedback {",
        "-  model: string;",
        "+  modelId: string;",
        " }",
        " export type FeedbackId = string;",
        " export type FeedbackSource = string;",
      ].join("\n"),
      tooLarge: false,
    },
  ];

  test("shows surrounding new-side context for a single-line diff comment", () => {
    const anchored = {
      ...thread([{ id: "comment", body: "Compare IDs inline", system: false }]),
      anchor: {
        path: "src/models/mux-video-feedback.ts",
        line: 58,
        oldLine: 58,
        newLine: 58,
      },
    };

    expect(findThreadLinePreview(anchored, files)).toEqual({
      lines: [
        {
          kind: "context",
          line: 57,
          text: "export interface Feedback {",
        },
        {
          kind: "add",
          line: 58,
          text: "  modelId: string;",
        },
        {
          kind: "context",
          line: 59,
          text: "}",
        },
        {
          kind: "context",
          line: 60,
          text: "export type FeedbackId = string;",
        },
      ],
    });
  });

  test("uses surrounding old-side context for removed-line comments", () => {
    const anchored = {
      ...thread([{ id: "comment", body: "Keep this?", system: false }]),
      anchor: {
        path: "src/legacy/mux-video-feedback.ts",
        line: 58,
        oldLine: 58,
      },
    };

    expect(findThreadLinePreview(anchored, files)).toEqual({
      lines: [
        {
          kind: "context",
          line: 57,
          text: "export interface Feedback {",
        },
        {
          kind: "remove",
          line: 58,
          text: "  model: string;",
        },
        {
          kind: "context",
          line: 59,
          text: "}",
        },
        {
          kind: "context",
          line: 60,
          text: "export type FeedbackId = string;",
        },
      ],
    });
  });

  test("shows every source line in a GitLab multi-line selection", () => {
    const anchored = {
      ...thread([{ id: "comment", body: "Extract this block", system: false }]),
      anchor: {
        path: "src/models/mux-video-feedback.ts",
        line: 60,
        newLine: 60,
        range: {
          start: { newLine: 57 },
          end: { newLine: 60 },
        },
      },
    };

    expect(findThreadLinePreview(anchored, files)).toEqual({
      lines: [
        { kind: "context", line: 57, text: "export interface Feedback {" },
        { kind: "add", line: 58, text: "  modelId: string;" },
        { kind: "context", line: 59, text: "}" },
        {
          kind: "context",
          line: 60,
          text: "export type FeedbackId = string;",
        },
      ],
    });
  });

  test("shows the relevant block above a Duo closing-brace anchor", () => {
    const anchored = {
      ...thread([{ id: "duo", body: "Cancel the prior request", system: false }]),
      anchor: {
        path: "hw-video-player.component.ts",
        line: 155,
        newLine: 155,
      },
    };
    const duoFile: PullRequestFileChangeView = {
      path: "hw-video-player.component.ts",
      status: "modified",
      diff: [
        "@@ -145,0 +146,13 @@",
        "+      return;",
        "+    }",
        "+",
        "+    this.feedbackSvc",
        "+      .isFeedbackDialogAllowed$(this.asset.id, this.feedbackContext)",
        "+      .pipe(untilDestroyed(this))",
        "+      .subscribe((isAllowed) => {",
        "+        this.isFeedbackDialogAllowed = isAllowed;",
        "+      });",
        "+  }",
        "+",
        "+  private get requiresToken(): boolean {",
        "+    return this.signed;",
      ].join("\n"),
      tooLarge: false,
    };

    expect(findThreadLinePreview(anchored, [duoFile])?.lines).toEqual([
      { kind: "add", line: 149, text: "    this.feedbackSvc" },
      {
        kind: "add",
        line: 150,
        text: "      .isFeedbackDialogAllowed$(this.asset.id, this.feedbackContext)",
      },
      { kind: "add", line: 151, text: "      .pipe(untilDestroyed(this))" },
      { kind: "add", line: 152, text: "      .subscribe((isAllowed) => {" },
      {
        kind: "add",
        line: 153,
        text: "        this.isFeedbackDialogAllowed = isAllowed;",
      },
      { kind: "add", line: 154, text: "      });" },
      { kind: "add", line: 155, text: "  }" },
    ]);
  });

  test("keeps the path-only fallback when the line is outside the available diff", () => {
    const anchored = {
      ...thread([{ id: "comment", body: "Old comment", system: false }]),
      anchor: {
        path: "src/models/mux-video-feedback.ts",
        line: 12,
        newLine: 12,
      },
    };

    expect(findThreadLinePreview(anchored, files)).toBeUndefined();
  });
});
