import { describe, expect, test } from "bun:test";
import { MergeRequestDiscussionListSchema } from "../src/connectors/gitlab/types.ts";
import {
  anchoredFiles,
  discussionEventId,
  pendingDiscussions,
} from "../src/tasks/mr-follow-up/discussions.ts";
import { discussion } from "./fixtures/gitlab.ts";

describe("pendingDiscussions", () => {
  test("selects an unresolved reviewer thread", () => {
    const parsed = MergeRequestDiscussionListSchema.parse([discussion()]);
    const pending = pendingDiscussions(parsed);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.noteId).toBe(501);
    expect(discussionEventId("acme/web", 12, pending[0]!)).toBe(
      "acme/web!12:discussion-1:501",
    );
  });

  test("does not skip a thread whose latest note is the token user's own follow-up", () => {
    const parsed = MergeRequestDiscussionListSchema.parse([
      discussion({
        notes: [
          discussion().notes[0],
          {
            ...discussion().notes[0],
            id: 502,
            body: "Any update on this?",
            author: { id: 4001, username: "author" },
          },
        ],
      }),
    ]);
    expect(pendingDiscussions(parsed).map((item) => item.noteId)).toEqual([502]);
  });

  test("includes an unanswered non-resolvable question but not a statement", () => {
    const question = discussion({
      id: "q",
      notes: [{ ...discussion().notes[0], id: 601, resolvable: false, resolved: null }],
    });
    const statement = discussion({
      id: "s",
      notes: [
        {
          ...discussion().notes[0],
          id: 602,
          body: "Looks good to me.",
          resolvable: false,
          resolved: null,
        },
      ],
    });
    const parsed = MergeRequestDiscussionListSchema.parse([question, statement]);
    expect(pendingDiscussions(parsed).map((item) => item.discussionId)).toEqual(["q"]);
  });

  test("keeps each diff comment on its own file when the bodies do not name one", () => {
    const note = discussion().notes[0]!;
    const parsed = MergeRequestDiscussionListSchema.parse([
      discussion({
        id: "row",
        notes: [
          {
            ...note,
            id: 1,
            body: "prefer real domain entities",
            position: {
              new_path: "projects/classroom/curriculum-index-row.component.spec.ts",
              new_line: 53,
            },
          },
        ],
      }),
      discussion({
        id: "topic",
        notes: [
          {
            ...note,
            id: 2,
            body: "prefer real domain entities",
            position: {
              new_path: "projects/classroom/curriculum-topic.component.spec.ts",
              old_line: 40,
              new_line: 63,
              line_range: {
                start: { new_line: 60 },
                end: { new_line: 63 },
              },
            },
          },
        ],
      }),
    ]);
    const pending = pendingDiscussions(parsed);
    expect(pending.map((item) => item.location)).toEqual([
      "projects/classroom/curriculum-index-row.component.spec.ts:53",
      "projects/classroom/curriculum-topic.component.spec.ts:63",
    ]);
    expect(pending[1]?.anchor).toEqual({
      path: "projects/classroom/curriculum-topic.component.spec.ts",
      line: 63,
      oldLine: 40,
      newLine: 63,
      range: { start: { newLine: 60 }, end: { newLine: 63 } },
    });
    expect(anchoredFiles(pending)).toEqual([
      "projects/classroom/curriculum-index-row.component.spec.ts",
      "projects/classroom/curriculum-topic.component.spec.ts",
    ]);
  });

  test("reads the anchor from the note that has one, and falls back to the old path", () => {
    const note = discussion().notes[0]!;
    const parsed = MergeRequestDiscussionListSchema.parse([
      discussion({
        notes: [
          {
            ...note,
            id: 1,
            body: "please rename this",
            position: { old_path: "src/legacy.ts", old_line: 8 },
          },
          {
            ...note,
            id: 2,
            body: "any update?",
            resolvable: false,
            resolved: null,
          },
        ],
      }),
    ]);
    const pending = pendingDiscussions(parsed);
    expect(pending[0]?.noteId).toBe(2);
    expect(pending[0]?.location).toBe("src/legacy.ts:8");
    expect(pending[0]?.anchor).toEqual({ path: "src/legacy.ts", line: 8, oldLine: 8 });
  });
});
