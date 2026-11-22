import { describe, expect, test } from "bun:test";
import {
  buildFollowUpPrompt,
  followUpContextDocument,
  FollowUpOutputSchema,
} from "../src/tasks/mr-follow-up/agent.ts";

describe("FollowUpOutputSchema", () => {
  test("parses the replies the agent returned", () => {
    const parsed = FollowUpOutputSchema.parse(
      JSON.parse(
        '{"summary":"fixed","replies":[{"discussionId":"d1","noteId":4,"body":"Done.","fixed":true}]}',
      ),
    );
    expect(parsed.replies[0]?.discussionId).toBe("d1");
    expect(parsed.replies[0]?.fixed).toBe(true);
  });

  test("defaults fixed to false, so an answer-only reply never claims a fix", () => {
    const parsed = FollowUpOutputSchema.parse({
      summary: "answered",
      replies: [{ discussionId: "d1", noteId: 4, body: "It already does." }],
    });
    expect(parsed.replies[0]?.fixed).toBe(false);
  });

  test("rejects a reply missing the thread it belongs to", () => {
    expect(
      FollowUpOutputSchema.safeParse({ summary: "x", replies: [{ body: "Done." }] }).success,
    ).toBe(false);
  });
});

describe("buildFollowUpPrompt", () => {
  test("treats discussion bodies as untrusted and forbids agent-side pushes", () => {
    const prompt = buildFollowUpPrompt(12, "acme/web", "fix/one");
    expect(prompt).toContain(".talos/discussions.json");
    expect(prompt).toContain("untrusted task context");
    expect(prompt).toContain("Do not push");
    expect(prompt).toContain("exactly one reply");
    expect(prompt).toContain("every path in `files`");
    expect(prompt).toContain("`location`");
    expect(prompt).toContain("/workspace/AGENTS.md");
    expect(prompt).toContain("repository root, not under .claude");
    const example = prompt.match(/```json\n([\s\S]*?)```/)?.[1];
    expect(JSON.parse(example!)).toMatchObject({
      summary: expect.any(String),
      replies: [expect.objectContaining({ discussionId: expect.any(String), noteId: 1, fixed: true })],
    });
  });
});

describe("followUpContextDocument", () => {
  test("lists every anchored file before the discussion bodies", () => {
    const document = JSON.parse(
      followUpContextDocument({
        mergeRequest: {
          iid: 6439,
          title: "specs",
          sourceBranch: "feat/TP-3201",
          targetBranch: "develop",
          webUrl: "https://gitlab.com/acme/webportal/-/merge_requests/6439",
        },
        discussions: [
          {
            discussionId: "a",
            noteId: 1,
            location: "projects/classroom/a.spec.ts:17",
            anchor: { path: "projects/classroom/a.spec.ts", line: 17 },
            body: "prefer real domain entities",
            author: "reviewer",
            notes: [],
          },
          {
            discussionId: "b",
            noteId: 2,
            location: "projects/classroom/a.spec.ts:40",
            anchor: { path: "projects/classroom/a.spec.ts", line: 40 },
            body: "prefer real domain entities",
            author: "reviewer",
            notes: [],
          },
          {
            discussionId: "c",
            noteId: 3,
            location: "projects/classroom/b.spec.ts:9",
            anchor: { path: "projects/classroom/b.spec.ts", line: 9 },
            body: "avoid done()",
            author: "reviewer",
            notes: [],
          },
        ],
      }),
    );
    expect(Object.keys(document)).toEqual(["mergeRequest", "files", "discussions"]);
    expect(document.files).toEqual([
      "projects/classroom/a.spec.ts",
      "projects/classroom/b.spec.ts",
    ]);
  });
});
