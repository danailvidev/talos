import type { Database } from "bun:sqlite";
import type {
  LogRocketIssue,
  LogRocketIssueRepository,
  RecordLogRocketIssueInput,
} from "../application/ports.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface Row {
  id: string;
  fingerprint: string;
  app_id: string | null;
  issue_type: string | null;
  title: string;
  label: string | null;
  description: string | null;
  summary: string | null;
  user_impact: string | null;
  url: string | null;
  screenshot_url: string | null;
  session_count: number | null;
  session_rate: number | null;
  first_seen_at: string | null;
  last_alert_at: string;
  alert_count: number;
  state: string;
  jira_issue_key: string | null;
  jira_filed_at: string | null;
}

const SELECT = `SELECT id, fingerprint, app_id, issue_type, title, label, description,
                       summary, user_impact, url, screenshot_url, session_count,
                       session_rate, first_seen_at, last_alert_at, alert_count, state,
                       jira_issue_key, jira_filed_at
                  FROM logrocket_issues`;

/** Nothing in an alert is worth more than a screenful in a table row. */
const MAX_TEXT = 4000;

/**
 * The LogRocket issues this install has been alerted about.
 *
 * The table is the list because LogRocket offers no endpoint that returns one —
 * see `LogRocketIssueRepository`. Every row therefore arrives from a webhook, and
 * the same issue arrives repeatedly: LogRocket re-fires an alert as an issue
 * keeps happening, with a higher session count each time. `record` folds those
 * into the row they belong to on `fingerprint`, so the page shows one line per
 * issue whose numbers move rather than a growing pile of near-duplicates.
 */
export class SqliteLogRocketIssueStore implements LogRocketIssueRepository {
  constructor(private readonly db: Database) {}

  record(input: RecordLogRocketIssueInput): LogRocketIssue {
    const fingerprint = fingerprintOf(input);
    const now = new Date();
    const existing = this.db
      .query<Row, [string]>(`${SELECT} WHERE fingerprint = ?`)
      .get(fingerprint);

    if (existing) {
      // The newest alert wins for everything it carries, and only for that: a
      // later alert that omits the summary must not erase the one we have, and
      // `first_seen_at` stays whatever the issue actually first said. The count
      // is taken as reported rather than incremented — LogRocket counts sessions,
      // we count alerts, and those are different numbers.
      this.db.run(
        `UPDATE logrocket_issues
            SET title = ?, issue_type = COALESCE(?, issue_type),
                label = COALESCE(?, label), description = COALESCE(?, description),
                summary = COALESCE(?, summary), user_impact = COALESCE(?, user_impact),
                url = COALESCE(?, url), screenshot_url = COALESCE(?, screenshot_url),
                session_count = COALESCE(?, session_count),
                session_rate = COALESCE(?, session_rate),
                first_seen_at = COALESCE(first_seen_at, ?),
                last_alert_at = ?, alert_count = alert_count + 1, payload = ?
          WHERE id = ?`,
        [
          clamp(input.title) ?? existing.title,
          clamp(input.issueType) ?? null,
          clamp(input.label) ?? null,
          clamp(input.description) ?? null,
          clamp(input.summary) ?? null,
          clamp(input.userImpact) ?? null,
          clamp(input.url) ?? null,
          clamp(input.screenshotUrl) ?? null,
          input.sessionCount ?? null,
          input.sessionRate ?? null,
          input.firstSeenAt ? toIso(input.firstSeenAt) : null,
          toIso(now),
          JSON.stringify(input.payload ?? null),
          existing.id,
        ],
      );
      return this.get(existing.id)!;
    }

    const id = newId();
    this.db.run(
      `INSERT INTO logrocket_issues
         (id, fingerprint, app_id, issue_type, title, label, description, summary,
          user_impact, url, screenshot_url, session_count, session_rate,
          first_seen_at, last_alert_at, alert_count, payload, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'open')`,
      [
        id,
        fingerprint,
        clamp(input.appId) ?? null,
        clamp(input.issueType) ?? null,
        clamp(input.title) ?? "LogRocket issue",
        clamp(input.label) ?? null,
        clamp(input.description) ?? null,
        clamp(input.summary) ?? null,
        clamp(input.userImpact) ?? null,
        clamp(input.url) ?? null,
        clamp(input.screenshotUrl) ?? null,
        input.sessionCount ?? null,
        input.sessionRate ?? null,
        input.firstSeenAt ? toIso(input.firstSeenAt) : toIso(now),
        toIso(now),
        JSON.stringify(input.payload ?? null),
      ],
    );
    return this.get(id)!;
  }

  list(options?: { includeDismissed?: boolean; limit?: number }): LogRocketIssue[] {
    const limit = options?.limit ?? 200;
    const where = options?.includeDismissed ? "" : " WHERE state != 'dismissed'";
    return this.db
      .query<Row, [number]>(`${SELECT}${where} ORDER BY last_alert_at DESC LIMIT ?`)
      .all(limit)
      .map(toIssue);
  }

  firstSeenBetween(from: Date, to: Date): LogRocketIssue[] {
    return this.db
      .query<Row, [string, string]>(
        `${SELECT}
          WHERE first_seen_at >= ? AND first_seen_at <= ?
          ORDER BY first_seen_at ASC`,
      )
      .all(toIso(from), toIso(to))
      .map(toIssue);
  }

  get(id: string): LogRocketIssue | undefined {
    const row = this.db.query<Row, [string]>(`${SELECT} WHERE id = ?`).get(id);
    return row ? toIssue(row) : undefined;
  }

  link(id: string, jiraIssueKey: string): LogRocketIssue | undefined {
    this.db.run(
      `UPDATE logrocket_issues
          SET jira_issue_key = ?, jira_filed_at = ?, state = 'linked'
        WHERE id = ?`,
      [jiraIssueKey, toIso(new Date()), id],
    );
    return this.get(id);
  }

  setState(id: string, state: "open" | "dismissed"): LogRocketIssue | undefined {
    // Deliberately not clearing `jira_issue_key`: reopening an issue that was
    // filed does not unfile the ticket, and the link is how somebody finds it.
    this.db.run("UPDATE logrocket_issues SET state = ? WHERE id = ?", [state, id]);
    return this.get(id);
  }
}

/**
 * What makes two alerts the same issue.
 *
 * LogRocket sends no issue id, so this is derived. The issue URL is the strongest
 * signal available — it points at one issue in their console and stays put across
 * re-alerts — with the app, type and title as the fallback for a payload that
 * carries no URL. Title alone would merge unrelated issues from two apps; the
 * session count is deliberately absent, since it is the thing that changes.
 */
function fingerprintOf(input: RecordLogRocketIssueInput): string {
  const url = input.url?.trim();
  const basis = url
    ? `url:${url}`
    : `alt:${input.appId ?? ""}|${input.issueType ?? ""}|${input.title.trim()}`;
  return new Bun.CryptoHasher("sha256").update(basis).digest("hex").slice(0, 32);
}

/** Trims, drops empties, and caps the length of one text field from a payload. */
function clamp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed;
}

function toIssue(row: Row): LogRocketIssue {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    ...(row.app_id ? { appId: row.app_id } : {}),
    ...(row.issue_type ? { issueType: row.issue_type } : {}),
    title: row.title,
    ...(row.label ? { label: row.label } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.user_impact ? { userImpact: row.user_impact } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.screenshot_url ? { screenshotUrl: row.screenshot_url } : {}),
    ...(row.session_count != null ? { sessionCount: row.session_count } : {}),
    ...(row.session_rate != null ? { sessionRate: row.session_rate } : {}),
    ...(row.first_seen_at ? { firstSeenAt: fromIso(row.first_seen_at)! } : {}),
    lastAlertAt: fromIso(row.last_alert_at)!,
    alertCount: row.alert_count,
    state: row.state as LogRocketIssue["state"],
    ...(row.jira_issue_key ? { jiraIssueKey: row.jira_issue_key } : {}),
    ...(row.jira_filed_at ? { jiraFiledAt: fromIso(row.jira_filed_at)! } : {}),
  };
}
