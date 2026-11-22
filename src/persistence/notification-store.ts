import type { Database } from "bun:sqlite";
import type {
  CreateNotificationInput,
  NotificationRecord,
  NotificationRepository,
} from "../application/ports.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  task_run_id: string | null;
  job_id: string | null;
  created_at: string;
  read_at: string | null;
}

function toRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    ...(row.body ? { body: row.body } : {}),
    ...(row.link ? { link: row.link } : {}),
    ...(row.task_run_id ? { taskRunId: row.task_run_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    createdAt: fromIso(row.created_at),
    ...(row.read_at ? { readAt: fromIso(row.read_at) } : {}),
  };
}

export class SqliteNotificationStore implements NotificationRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateNotificationInput): NotificationRecord {
    const id = newId();
    const createdAt = new Date();
    this.db.run(
      `INSERT INTO notifications (id, kind, title, body, link, task_run_id, job_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.kind,
        input.title,
        input.body ?? null,
        input.link ?? null,
        input.taskRunId ?? null,
        input.jobId ?? null,
        toIso(createdAt),
      ],
    );
    return { id, kind: input.kind, title: input.title, createdAt, ...notificationExtras(input) };
  }

  list(options?: { unreadOnly?: boolean; limit?: number }): NotificationRecord[] {
    // Clean up old notifications (older than 1 week)
    this.cleanupOldNotifications();

    const limit = options?.limit ?? 50;
    const rows = options?.unreadOnly
      ? this.db
          .query<NotificationRow, [number]>(
            `SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit)
      : this.db
          .query<NotificationRow, [number]>(
            `SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit);
    return rows.map(toRecord);
  }

  private cleanupOldNotifications(): void {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    this.db.run(
      `DELETE FROM notifications WHERE created_at < ?`,
      [toIso(oneWeekAgo)],
    );
  }

  unreadCount(): number {
    const row = this.db
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL`)
      .get();
    return row?.count ?? 0;
  }

  markRead(id: string): void {
    this.db.run(`UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`, [
      toIso(new Date()),
      id,
    ]);
  }

  markAllRead(): void {
    this.db.run(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`, [toIso(new Date())]);
  }

  deleteByJob(jobId: string): void {
    this.db.run(`DELETE FROM notifications WHERE job_id = ?`, [jobId]);
  }
}

function notificationExtras(input: CreateNotificationInput): Partial<NotificationRecord> {
  return {
    ...(input.body ? { body: input.body } : {}),
    ...(input.link ? { link: input.link } : {}),
    ...(input.taskRunId ? { taskRunId: input.taskRunId } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
  };
}
