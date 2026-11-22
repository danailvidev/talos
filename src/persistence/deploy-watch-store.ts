import type { Database } from "bun:sqlite";
import type {
  CreateDetectedDeployWatchInput,
  CreateDeployWatchInput,
  DeployWatch,
  DeployWatchFinding,
  DeployWatchRepository,
  RecordDeployWatchFindingInput,
  UpdateDeployWatchInput,
} from "../application/ports.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface WatchRow {
  id: string;
  environment: string;
  project_id: string;
  release_kind: string;
  mr_iid: number | null;
  mr_url: string | null;
  commit_sha: string | null;
  commit_url: string | null;
  branch: string;
  actor_id: string | null;
  services_json: string;
  state: string;
  opened_at: string;
  merged_at: string | null;
  baseline_at: string | null;
  baseline_fingerprints_json: string | null;
  watch_until: string | null;
  created_at: string;
  updated_at: string;
}

interface FindingRow {
  id: string;
  watch_id: string;
  source: string;
  service: string | null;
  signature: string;
  fingerprint: string;
  event_count: number;
  external_url: string | null;
  issue_type: string | null;
  sample_message: string | null;
  sample_stack: string | null;
  first_seen_at: string;
  created_at: string;
}

const WATCH_COLUMNS = `id, environment, project_id, release_kind, mr_iid, mr_url,
                       commit_sha, commit_url, branch, actor_id, services_json,
                       state, opened_at, merged_at, baseline_at,
                       baseline_fingerprints_json, watch_until, created_at, updated_at`;

const FINDING_COLUMNS = `id, watch_id, source, service, signature, fingerprint, event_count,
                         external_url, issue_type, sample_message, sample_stack,
                         first_seen_at, created_at`;

/**
 * The post-deploy watch a production release opens, and the findings it turns up.
 *
 * `update` and `setBaseline` are separate methods rather than one wide patch
 * because they run at different, non-overlapping steps of the watch (merge
 * detected vs. baseline captured) — keeping them apart is what makes each step's
 * write greppable on its own.
 */
export class SqliteDeployWatchStore implements DeployWatchRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateDeployWatchInput): DeployWatch {
    const id = newId();
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO deploy_watches
         (id, environment, project_id, release_kind, mr_iid, mr_url, branch, actor_id,
          services_json, state, opened_at, created_at, updated_at)
       VALUES (?, ?, ?, 'merge-request', ?, ?, ?, ?, ?, 'pending-merge', ?, ?, ?)`,
      [
        id,
        input.environment,
        input.projectId,
        input.mrIid,
        input.mrUrl,
        input.branch,
        input.actorId ?? null,
        JSON.stringify(input.services),
        now,
        now,
        now,
      ],
    );
    return this.get(id)!;
  }

  createDetected(input: CreateDetectedDeployWatchInput): {
    watch: DeployWatch;
    created: boolean;
  } {
    const id = newId();
    const now = toIso(new Date());
    const result = this.db.run(
      `INSERT INTO deploy_watches
         (id, environment, project_id, release_kind, mr_iid, mr_url,
          commit_sha, commit_url, branch, services_json, state, opened_at,
          merged_at, watch_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'watching', ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [
        id,
        input.environment,
        input.projectId,
        input.releaseKind,
        input.releaseKind === "merge-request" ? input.mrIid : null,
        input.releaseKind === "merge-request" ? input.mrUrl : null,
        input.commitSha,
        input.commitUrl,
        input.branch,
        JSON.stringify(input.services),
        now,
        toIso(input.mergedAt),
        toIso(input.watchUntil),
        now,
        now,
      ],
    );
    const watch =
      input.releaseKind === "merge-request"
        ? this.getByMr(input.projectId, input.mrIid)
        : this.getByCommit(input.projectId, input.commitSha, input.environment);
    if (!watch) throw new Error("Could not create or resolve the detected deploy watch.");
    return { watch, created: result.changes > 0 };
  }

  get(id: string): DeployWatch | undefined {
    const row = this.db
      .query<WatchRow, [string]>(`SELECT ${WATCH_COLUMNS} FROM deploy_watches WHERE id = ?`)
      .get(id);
    return row ? toWatch(row) : undefined;
  }

  getByMr(projectId: string, mrIid: number): DeployWatch | undefined {
    const row = this.db
      .query<WatchRow, [string, number]>(
        `SELECT ${WATCH_COLUMNS} FROM deploy_watches
         WHERE project_id = ? AND mr_iid = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, mrIid);
    return row ? toWatch(row) : undefined;
  }

  getByCommit(
    projectId: string,
    commitSha: string,
    environment: string,
  ): DeployWatch | undefined {
    const row = this.db
      .query<WatchRow, [string, string, string]>(
        `SELECT ${WATCH_COLUMNS} FROM deploy_watches
         WHERE project_id = ? AND commit_sha = ? AND environment = ?
           AND release_kind = 'commit'
         LIMIT 1`,
      )
      .get(projectId, commitSha, environment);
    return row ? toWatch(row) : undefined;
  }

  update(id: string, patch: UpdateDeployWatchInput): DeployWatch {
    const now = toIso(new Date());
    this.db.run(
      `UPDATE deploy_watches
         SET state       = COALESCE(?, state),
             merged_at   = COALESCE(?, merged_at),
             watch_until = COALESCE(?, watch_until),
             updated_at  = ?
       WHERE id = ?`,
      [
        patch.state ?? null,
        patch.mergedAt ? toIso(patch.mergedAt) : null,
        patch.watchUntil ? toIso(patch.watchUntil) : null,
        now,
        id,
      ],
    );
    const watch = this.get(id);
    if (!watch) throw new Error(`No deploy watch ${id}.`);
    return watch;
  }

  setBaseline(id: string, fingerprints: readonly string[], baselineAt: Date): DeployWatch {
    this.db.run(
      `UPDATE deploy_watches
         SET baseline_at = ?, baseline_fingerprints_json = ?, updated_at = ?
       WHERE id = ?`,
      [toIso(baselineAt), JSON.stringify(fingerprints), toIso(new Date()), id],
    );
    const watch = this.get(id);
    if (!watch) throw new Error(`No deploy watch ${id}.`);
    return watch;
  }

  baseline(id: string): ReadonlySet<string> {
    const row = this.db
      .query<{ baseline_fingerprints_json: string | null }, [string]>(
        `SELECT baseline_fingerprints_json FROM deploy_watches WHERE id = ?`,
      )
      .get(id);
    if (!row?.baseline_fingerprints_json) return new Set();
    return new Set(JSON.parse(row.baseline_fingerprints_json) as string[]);
  }

  list(options?: { limit?: number }): DeployWatch[] {
    return this.db
      .query<WatchRow, [number]>(
        `SELECT ${WATCH_COLUMNS} FROM deploy_watches ORDER BY opened_at DESC LIMIT ?`,
      )
      .all(options?.limit ?? 50)
      .map(toWatch);
  }

  addFinding(input: RecordDeployWatchFindingInput): DeployWatchFinding | null {
    const id = newId();
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO deploy_watch_findings
         (id, watch_id, source, service, signature, fingerprint, event_count,
          external_url, issue_type, sample_message, sample_stack, first_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (watch_id, fingerprint) DO NOTHING`,
      [
        id,
        input.watchId,
        input.source,
        input.service ?? null,
        input.signature,
        input.fingerprint,
        input.eventCount,
        input.externalUrl ?? null,
        input.issueType ?? null,
        input.sampleMessage ?? null,
        input.sampleStack ?? null,
        toIso(input.firstSeenAt),
        now,
      ],
    );
    const row = this.db
      .query<FindingRow, [string, string]>(
        `SELECT ${FINDING_COLUMNS} FROM deploy_watch_findings WHERE watch_id = ? AND fingerprint = ?`,
      )
      .get(input.watchId, input.fingerprint);
    // A row with a different id than the one just generated means the conflict
    // branch fired — this fingerprint was already found, and the caller must not
    // notify a second time for it.
    return row && row.id === id ? toFinding(row) : null;
  }

  findings(watchId: string): DeployWatchFinding[] {
    return this.db
      .query<FindingRow, [string]>(
        `SELECT ${FINDING_COLUMNS} FROM deploy_watch_findings WHERE watch_id = ? ORDER BY created_at DESC`,
      )
      .all(watchId)
      .map(toFinding);
  }
}

function toWatch(row: WatchRow): DeployWatch {
  return {
    id: row.id,
    environment: row.environment,
    projectId: row.project_id,
    releaseKind: row.release_kind as DeployWatch["releaseKind"],
    ...(row.mr_iid != null ? { mrIid: row.mr_iid } : {}),
    ...(row.mr_url ? { mrUrl: row.mr_url } : {}),
    ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
    ...(row.commit_url ? { commitUrl: row.commit_url } : {}),
    branch: row.branch,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    services: JSON.parse(row.services_json) as string[],
    state: row.state as DeployWatch["state"],
    openedAt: fromIso(row.opened_at),
    ...(row.merged_at ? { mergedAt: fromIso(row.merged_at) } : {}),
    ...(row.baseline_at ? { baselineAt: fromIso(row.baseline_at) } : {}),
    ...(row.watch_until ? { watchUntil: fromIso(row.watch_until) } : {}),
    createdAt: fromIso(row.created_at),
    updatedAt: fromIso(row.updated_at),
  };
}

function toFinding(row: FindingRow): DeployWatchFinding {
  return {
    id: row.id,
    watchId: row.watch_id,
    source: row.source as DeployWatchFinding["source"],
    ...(row.service ? { service: row.service } : {}),
    signature: row.signature,
    fingerprint: row.fingerprint,
    eventCount: row.event_count,
    ...(row.external_url ? { externalUrl: row.external_url } : {}),
    ...(row.issue_type ? { issueType: row.issue_type } : {}),
    ...(row.sample_message ? { sampleMessage: row.sample_message } : {}),
    ...(row.sample_stack ? { sampleStack: row.sample_stack } : {}),
    firstSeenAt: fromIso(row.first_seen_at),
    createdAt: fromIso(row.created_at),
  };
}
