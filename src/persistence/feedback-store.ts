import type { Database } from "bun:sqlite";
import type { FeedbackType } from "../../shared/api-contract.ts";
import type {
  Feedback,
  FeedbackAttachment,
  FeedbackPublicationReason,
  FeedbackRepository,
} from "../application/ports.ts";
import { ConfigError } from "../core/errors.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface Row {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  labels_json: string;
  publication_status: string;
  publication_reason: string | null;
  external_issue_url: string | null;
  external_issue_number: number | null;
  created_at: string;
}

interface AttachmentRow {
  name: string;
  content_type: string;
  bytes: Uint8Array;
}

const MAX_TITLE_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_PENDING_ATTACHMENT_BYTES_PER_USER = 100 * 1024 * 1024;
const FEEDBACK_DETAILS: Record<FeedbackType, { scope: string; labels: string[] }> = {
  bug: { scope: "Bug", labels: ["bug"] },
  feature: { scope: "Feature", labels: ["feature"] },
  general: { scope: "Feedback", labels: [] },
  security: { scope: "Security", labels: ["security"] },
};

export class SqliteFeedbackStore implements FeedbackRepository {
  constructor(
    private readonly db: Database,
    private readonly maxPendingAttachmentBytesPerUser =
      MAX_PENDING_ATTACHMENT_BYTES_PER_USER,
  ) {}

  create(
    userId: string,
    input: {
      type: FeedbackType;
      title: string;
      description: string;
      attachments?: readonly FeedbackAttachment[];
    },
  ): Feedback {
    const details = FEEDBACK_DETAILS[input.type];
    if (!details) throw new ConfigError("Choose a valid feedback type.");

    const rawTitle = input.title.trim();
    const description = input.description.trim();
    if (!rawTitle) throw new ConfigError("Feedback needs a title.");
    if (!description) throw new ConfigError("Feedback needs a description.");

    const id = newId();
    const createdAt = new Date();
    const title = `[${details.scope}]: ${rawTitle}`.slice(0, MAX_TITLE_LENGTH);
    const labels = [...details.labels];
    const attachments = input.attachments ?? [];
    this.validateAttachments(userId, attachments);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO feedback
           (id, user_id, type, title, message, labels_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          userId,
          input.type,
          title,
          description.slice(0, MAX_DESCRIPTION_LENGTH),
          JSON.stringify(labels),
          toIso(createdAt),
        ],
      );
      for (const attachment of attachments) {
        this.db.run(
          `INSERT INTO feedback_attachments
             (id, feedback_id, name, content_type, bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            newId(),
            id,
            attachment.name,
            attachment.contentType,
            attachment.bytes,
            toIso(createdAt),
          ],
        );
      }
    })();
    return {
      id,
      userId,
      type: input.type,
      title,
      description: description.slice(0, MAX_DESCRIPTION_LENGTH),
      labels,
      publicationStatus: "pending",
      createdAt,
    };
  }

  get(id: string): Feedback | undefined {
    const row = this.db
      .query<Row, [string]>(
        `SELECT id, user_id, type, title, message, labels_json,
                publication_status, publication_reason,
                external_issue_url, external_issue_number, created_at
           FROM feedback
          WHERE id = ?`,
      )
      .get(id);
    return row ? toFeedback(row) : undefined;
  }

  pendingForUser(userId: string): Feedback[] {
    return this.db
      .query<Row, [string]>(
        `SELECT id, user_id, type, title, message, labels_json,
                publication_status, publication_reason,
                external_issue_url, external_issue_number, created_at
           FROM feedback
          WHERE user_id = ? AND publication_status = 'pending'
          ORDER BY created_at DESC`,
      )
      .all(userId)
      .map(toFeedback);
  }

  attachments(id: string): FeedbackAttachment[] {
    return this.db
      .query<AttachmentRow, [string]>(
        `SELECT name, content_type, bytes
           FROM feedback_attachments
          WHERE feedback_id = ?
          ORDER BY created_at, id`,
      )
      .all(id)
      .map((row) => ({
        name: row.name,
        contentType: row.content_type,
        bytes: row.bytes,
      }));
  }

  markPublicationPending(id: string, reason: FeedbackPublicationReason): void {
    const result = this.db.run(
      `UPDATE feedback
          SET publication_status = 'pending', publication_reason = ?
        WHERE id = ? AND external_issue_url IS NULL`,
      [reason, id],
    );
    if (result.changes === 0) {
      throw new ConfigError(`Feedback '${id}' is not pending.`);
    }
  }

  linkExternalIssue(id: string, issue: { number: number; url: string }): void {
    this.db.transaction(() => {
      const result = this.db.run(
        `UPDATE feedback
            SET external_issue_url = ?, external_issue_number = ?,
                publication_status = 'published', publication_reason = NULL
          WHERE id = ?`,
        [issue.url, issue.number, id],
      );
      if (result.changes === 0) {
        throw new ConfigError(`Feedback '${id}' does not exist.`);
      }
      this.db.run("DELETE FROM feedback_attachments WHERE feedback_id = ?", [id]);
    })();
  }

  delete(id: string): boolean {
    return this.db.run("DELETE FROM feedback WHERE id = ?", [id]).changes > 0;
  }

  list(): Feedback[] {
    return this.db
      .query<Row, []>(
        `SELECT id, user_id, type, title, message, labels_json,
                publication_status, publication_reason,
                external_issue_url, external_issue_number, created_at
           FROM feedback
          ORDER BY created_at DESC`,
      )
      .all()
      .map(toFeedback);
  }

  private validateAttachments(
    userId: string,
    attachments: readonly FeedbackAttachment[],
  ): void {
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new ConfigError(`Attach at most ${MAX_ATTACHMENTS} images.`);
    }
    let incomingBytes = 0;
    for (const attachment of attachments) {
      if (!attachment.name || attachment.name.length > 200) {
        throw new ConfigError("Feedback attachment names must be between 1 and 200 characters.");
      }
      if (!attachment.contentType || attachment.contentType.length > 100) {
        throw new ConfigError("Feedback attachment content type is invalid.");
      }
      if (
        attachment.bytes.byteLength === 0 ||
        attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES
      ) {
        throw new ConfigError("Each feedback attachment must be between 1 byte and 10 MB.");
      }
      incomingBytes += attachment.bytes.byteLength;
    }
    const row = this.db
      .query<{ bytes: number }, [string]>(
        `SELECT COALESCE(SUM(length(a.bytes)), 0) AS bytes
           FROM feedback_attachments a
           JOIN feedback f ON f.id = a.feedback_id
          WHERE f.user_id = ? AND f.publication_status = 'pending'`,
      )
      .get(userId);
    if ((row?.bytes ?? 0) + incomingBytes > this.maxPendingAttachmentBytesPerUser) {
      throw new ConfigError(
        "Pending feedback attachments are limited to 100 MB per user. " +
          "Publish or delete an earlier pending submission first.",
      );
    }
  }
}

function toFeedback(row: Row): Feedback {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as FeedbackType,
    title: row.title,
    description: row.message,
    labels: JSON.parse(row.labels_json) as string[],
    publicationStatus: row.publication_status as Feedback["publicationStatus"],
    ...(row.publication_reason
      ? { publicationReason: row.publication_reason as FeedbackPublicationReason }
      : {}),
    ...(row.external_issue_url ? { externalIssueUrl: row.external_issue_url } : {}),
    ...(row.external_issue_number != null
      ? { externalIssueNumber: row.external_issue_number }
      : {}),
    createdAt: fromIso(row.created_at)!,
  };
}
