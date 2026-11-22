import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ConfigError } from "../src/core/errors.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteFeedbackStore } from "../src/persistence/feedback-store.ts";

function store(maxPendingBytes = 100 * 1024 * 1024): {
  db: Database;
  feedback: SqliteFeedbackStore;
} {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return { db, feedback: new SqliteFeedbackStore(db, maxPendingBytes) };
}

describe("SqliteFeedbackStore publication outbox", () => {
  test("keeps pending attachments and purges them after publication", () => {
    const { db, feedback } = store();
    const created = feedback.create("user-1", {
      type: "bug",
      title: "Screenshot",
      description: "Keep this until GitLab accepts it.",
      attachments: [
        {
          name: "screen.png",
          contentType: "image/png",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    });

    expect(feedback.attachments(created.id)).toHaveLength(1);
    feedback.markPublicationPending(created.id, "missing_token");
    expect(feedback.get(created.id)).toMatchObject({
      publicationStatus: "pending",
      publicationReason: "missing_token",
    });

    feedback.linkExternalIssue(created.id, {
      number: 12,
      url: "https://gitlab.com/example-org/tools/talos/-/issues/12",
    });
    expect(feedback.get(created.id)).toMatchObject({
      publicationStatus: "published",
      externalIssueNumber: 12,
    });
    expect(feedback.attachments(created.id)).toEqual([]);
    db.close();
  });

  test("enforces the aggregate pending attachment budget per user", () => {
    const { db, feedback } = store(5);
    feedback.create("user-1", {
      type: "general",
      title: "First",
      description: "Uses the pending budget.",
      attachments: [
        {
          name: "first.png",
          contentType: "image/png",
          bytes: new Uint8Array([1, 2, 3, 4]),
        },
      ],
    });

    expect(() =>
      feedback.create("user-1", {
        type: "general",
        title: "Second",
        description: "Would exceed the pending budget.",
        attachments: [
          {
            name: "second.png",
            contentType: "image/png",
            bytes: new Uint8Array([5, 6]),
          },
        ],
      }),
    ).toThrow(ConfigError);

    expect(() =>
      feedback.create("user-2", {
        type: "general",
        title: "Other user",
        description: "Has a separate budget.",
        attachments: [
          {
            name: "other.png",
            contentType: "image/png",
            bytes: new Uint8Array([1, 2, 3, 4, 5]),
          },
        ],
      }),
    ).not.toThrow();
    db.close();
  });

  test("deleting pending feedback cascades to its attachments", () => {
    const { db, feedback } = store();
    const created = feedback.create("user-1", {
      type: "security",
      title: "Remove",
      description: "Delete the retained bytes too.",
      attachments: [
        {
          name: "private.png",
          contentType: "image/png",
          bytes: new Uint8Array([1]),
        },
      ],
    });

    expect(feedback.delete(created.id)).toBe(true);
    expect(feedback.attachments(created.id)).toEqual([]);
    db.close();
  });
});
