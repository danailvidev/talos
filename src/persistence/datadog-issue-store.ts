import type { Database } from "bun:sqlite";
import type {
  DatadogArea,
  DatadogIssue,
  DatadogIssueRepository,
  DatadogSeverity,
  RecordDatadogIssueInput,
} from "../application/ports.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface Row {
  id: string;
  fingerprint: string;
  service: string | null;
  signature: string;
  title: string;
  problem_key: string | null;
  problem_title: string | null;
  problem_event_count: number | null;
  severity: string;
  area: string;
  team: string | null;
  routed_by: string | null;
  event_count: number;
  previous_event_count: number | null;
  sample_count: number;
  sample_size: number;
  status: string | null;
  env: string | null;
  source: string | null;
  host: string | null;
  kube_namespace: string | null;
  sample_log_id: string | null;
  sample_message: string | null;
  sample_stack: string | null;
  query: string;
  first_seen_at: string;
  last_seen_at: string;
  last_scan_at: string;
  scan_count: number;
  state: string;
  jira_issue_key: string | null;
  jira_filed_at: string | null;
}

const COLUMNS = `id, fingerprint, service, signature, title, problem_key, problem_title,
                 problem_event_count, severity, area, team,
                 routed_by, event_count, previous_event_count, sample_count, sample_size,
                 status, env, source, host, kube_namespace, sample_log_id, sample_message,
                 sample_stack, query, first_seen_at, last_seen_at, last_scan_at,
                 scan_count, state, jira_issue_key, jira_filed_at`;

const SELECT = `SELECT ${COLUMNS} FROM datadog_issues`;

/**
 * Severity ordering for SQL. SQLite sorts text alphabetically, which would put
 * `critical` after `high` and `low` in the middle, so the order is spelled out.
 */
const SEVERITY_RANK = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                                     WHEN 'medium' THEN 2 ELSE 3 END`;

/**
 * The Datadog issues the scans have found.
 *
 * The interesting behaviour is all in `record`, because a scan re-finds
 * essentially everything it found yesterday. Folding on `fingerprint` is what
 * keeps the page a list of forty problems instead of forty rows a day, and the
 * fold is deliberately asymmetric: counts, severity and the sample move to what
 * the newest scan saw, while `first_seen_at`, the Jira link and a dismissal are
 * the row's own history and are never overwritten by a re-sighting.
 */
export class SqliteDatadogIssueStore implements DatadogIssueRepository {
  constructor(private readonly db: Database) {}

  record(input: RecordDatadogIssueInput): DatadogIssue {
    const fingerprint = fingerprintFor(input);
    const now = new Date();
    const existing = this.db
      .query<Row, [string]>(`${SELECT} WHERE fingerprint = ?`)
      .get(fingerprint);

    if (existing) {
      this.db.run(
        `UPDATE datadog_issues
            SET title = ?, problem_key = ?, problem_title = ?,
                problem_event_count = ?,
                severity = ?, area = ?, team = ?, routed_by = ?,
                previous_event_count = event_count,
                event_count = ?, sample_count = ?, sample_size = ?,
                status = COALESCE(?, status), env = COALESCE(?, env),
                source = COALESCE(?, source), host = COALESCE(?, host),
                kube_namespace = COALESCE(?, kube_namespace),
                sample_log_id = COALESCE(?, sample_log_id),
                sample_message = COALESCE(?, sample_message),
                sample_stack = COALESCE(?, sample_stack),
                query = ?,
                -- Earliest wins: a scan window only reaches back a day, so the
                -- oldest occurrence we ever saw is older than anything this scan
                -- can see.
                first_seen_at = MIN(first_seen_at, ?),
                last_seen_at = MAX(last_seen_at, ?),
                last_scan_at = ?,
                scan_count = scan_count + 1
          WHERE id = ?`,
        [
          input.title,
          input.problemKey ?? null,
          input.problemTitle ?? null,
          input.problemEventCount ?? null,
          input.severity,
          input.area,
          input.team ?? null,
          input.routedBy ?? null,
          input.eventCount,
          input.sampleCount,
          input.sampleSize,
          input.status ?? null,
          input.env ?? null,
          input.source ?? null,
          input.host ?? null,
          input.kubeNamespace ?? null,
          input.sampleLogId ?? null,
          input.sampleMessage ?? null,
          input.sampleStack ?? null,
          input.query,
          toIso(input.firstSeenAt),
          toIso(input.lastSeenAt),
          toIso(now),
          existing.id,
        ],
      );
      return this.get(existing.id)!;
    }

    const id = newId();
    this.db.run(
      `INSERT INTO datadog_issues
         (id, fingerprint, service, signature, title, problem_key, problem_title,
          problem_event_count, severity, area, team, routed_by,
          event_count, sample_count, sample_size, status, env, source, host,
          kube_namespace, sample_log_id, sample_message, sample_stack, query,
          first_seen_at, last_seen_at, last_scan_at, scan_count, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open')`,
      [
        id,
        fingerprint,
        input.service ?? null,
        input.signature,
        input.title,
        input.problemKey ?? null,
        input.problemTitle ?? null,
        input.problemEventCount ?? null,
        input.severity,
        input.area,
        input.team ?? null,
        input.routedBy ?? null,
        input.eventCount,
        input.sampleCount,
        input.sampleSize,
        input.status ?? null,
        input.env ?? null,
        input.source ?? null,
        input.host ?? null,
        input.kubeNamespace ?? null,
        input.sampleLogId ?? null,
        input.sampleMessage ?? null,
        input.sampleStack ?? null,
        input.query,
        toIso(input.firstSeenAt),
        toIso(input.lastSeenAt),
        toIso(now),
      ],
    );
    return this.get(id)!;
  }

  list(options?: {
    includeDismissed?: boolean;
    seenSince?: Date;
    team?: string;
    area?: DatadogArea;
    limit?: number;
  }): DatadogIssue[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (!options?.includeDismissed) where.push("state != 'dismissed'");
    if (options?.seenSince) {
      where.push("last_scan_at >= ?");
      params.push(toIso(options.seenSince));
    }
    if (options?.team) {
      where.push("team = ?");
      params.push(options.team);
    }
    if (options?.area) {
      where.push("area = ?");
      params.push(options.area);
    }
    params.push(options?.limit ?? 300);

    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    return this.db
      .query<Row, (string | number)[]>(
        `${SELECT}${clause} ORDER BY ${SEVERITY_RANK}, event_count DESC LIMIT ?`,
      )
      .all(...params)
      .map(toIssue);
  }

  get(id: string): DatadogIssue | undefined {
    const row = this.db.query<Row, [string]>(`${SELECT} WHERE id = ?`).get(id);
    return row ? toIssue(row) : undefined;
  }

  listByProblem(problemKey: string): DatadogIssue[] {
    return this.db
      .query<Row, [string]>(
        `${SELECT} WHERE problem_key = ? ORDER BY event_count DESC`,
      )
      .all(problemKey)
      .map(toIssue);
  }

  findByFingerprint(fingerprint: string): DatadogIssue | undefined {
    const row = this.db
      .query<Row, [string]>(`${SELECT} WHERE fingerprint = ?`)
      .get(fingerprint);
    return row ? toIssue(row) : undefined;
  }

  /**
   * The filter chips' options, read from the data rather than from the rule list.
   *
   * On purpose: a team named in a rule that has never matched anything would be a
   * chip that filters to an empty page, and an area that stopped appearing when
   * its rule changed would linger.
   */
  facets(): { teams: string[]; areas: DatadogArea[] } {
    const teams = this.db
      .query<{ team: string }, []>(
        `SELECT DISTINCT team FROM datadog_issues
          WHERE team IS NOT NULL AND state != 'dismissed' ORDER BY team`,
      )
      .all()
      .map((row) => row.team);
    const areas = this.db
      .query<{ area: string }, []>(
        `SELECT DISTINCT area FROM datadog_issues WHERE state != 'dismissed'`,
      )
      .all()
      .map((row) => row.area as DatadogArea);
    return { teams, areas };
  }

  link(id: string, jiraIssueKey: string): DatadogIssue | undefined {
    this.db.run(
      `UPDATE datadog_issues
          SET jira_filed_at = CASE
                                WHEN jira_issue_key = ? THEN jira_filed_at
                                ELSE ?
                              END,
              jira_issue_key = ?,
              state = 'linked'
        WHERE id = ?`,
      [jiraIssueKey, toIso(new Date()), jiraIssueKey, id],
    );
    return this.get(id);
  }

  setState(id: string, state: "open" | "dismissed"): DatadogIssue | undefined {
    // Reopening a filed issue does not unfile its ticket, so the key stays —
    // the link is how anybody finds the work that was already started.
    this.db.run("UPDATE datadog_issues SET state = ? WHERE id = ?", [state, id]);
    return this.get(id);
  }

  pruneStale(before: Date): number {
    const { changes } = this.db.run(
      `DELETE FROM datadog_issues
        WHERE state = 'open'
          AND jira_issue_key IS NULL
          AND last_scan_at < ?`,
      [toIso(before)],
    );
    return changes;
  }
}

/**
 * The identity of an issue across scans: service plus signature.
 *
 * Duplicated deliberately from `connectors/datadog/signature.ts` rather than
 * imported: no other store depends on a connector, and four lines of hashing is a
 * cheaper price than that dependency. Keep the two in step — a change to one
 * without the other would orphan every existing row.
 */
function fingerprintFor(input: RecordDatadogIssueInput): string {
  const basis = `${input.service ?? "unknown"} ${input.signature}`;
  return new Bun.CryptoHasher("sha256").update(basis).digest("hex").slice(0, 32);
}

function toIssue(row: Row): DatadogIssue {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    ...(row.service ? { service: row.service } : {}),
    signature: row.signature,
    title: row.title,
    ...(row.problem_key ? { problemKey: row.problem_key } : {}),
    ...(row.problem_title ? { problemTitle: row.problem_title } : {}),
    ...(row.problem_event_count != null
      ? { problemEventCount: row.problem_event_count }
      : {}),
    severity: row.severity as DatadogSeverity,
    area: row.area as DatadogArea,
    ...(row.team ? { team: row.team } : {}),
    ...(row.routed_by ? { routedBy: row.routed_by } : {}),
    eventCount: row.event_count,
    ...(row.previous_event_count != null
      ? { previousEventCount: row.previous_event_count }
      : {}),
    sampleCount: row.sample_count,
    sampleSize: row.sample_size,
    ...(row.status ? { status: row.status } : {}),
    ...(row.env ? { env: row.env } : {}),
    ...(row.source ? { source: row.source } : {}),
    ...(row.host ? { host: row.host } : {}),
    ...(row.kube_namespace ? { kubeNamespace: row.kube_namespace } : {}),
    ...(row.sample_log_id ? { sampleLogId: row.sample_log_id } : {}),
    ...(row.sample_message ? { sampleMessage: row.sample_message } : {}),
    ...(row.sample_stack ? { sampleStack: row.sample_stack } : {}),
    query: row.query,
    firstSeenAt: fromIso(row.first_seen_at)!,
    lastSeenAt: fromIso(row.last_seen_at)!,
    lastScanAt: fromIso(row.last_scan_at)!,
    scanCount: row.scan_count,
    state: row.state as DatadogIssue["state"],
    ...(row.jira_issue_key ? { jiraIssueKey: row.jira_issue_key } : {}),
    ...(row.jira_filed_at ? { jiraFiledAt: fromIso(row.jira_filed_at)! } : {}),
  };
}
