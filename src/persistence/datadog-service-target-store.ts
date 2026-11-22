import type { Database } from "bun:sqlite";
import type {
  DatadogServiceTarget,
  DatadogServiceTargetInput,
  DatadogServiceTargetRepository,
} from "../application/ports.ts";
import { ConfigError } from "../core/errors.ts";
import { fromIso, toIso } from "./database.ts";

interface Row {
  service: string;
  project_id: string;
  target_branch: string;
  updated_at: string;
}

const SELECT =
  "SELECT service, project_id, target_branch, updated_at FROM datadog_service_targets";

export class SqliteDatadogServiceTargetStore
  implements DatadogServiceTargetRepository
{
  constructor(private readonly db: Database) {}

  list(): DatadogServiceTarget[] {
    return this.db
      .query<Row, []>(`${SELECT} ORDER BY service COLLATE NOCASE`)
      .all()
      .map(toTarget);
  }

  get(service: string): DatadogServiceTarget | undefined {
    const normalized = cleanService(service);
    const row = this.db
      .query<Row, [string]>(`${SELECT} WHERE service = ? COLLATE NOCASE`)
      .get(normalized);
    return row ? toTarget(row) : undefined;
  }

  set(service: string, input: DatadogServiceTargetInput): DatadogServiceTarget {
    const normalized = cleanService(service);
    const projectId = required(input.projectId, "GitLab project");
    const targetBranch = required(input.targetBranch, "base branch");
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO datadog_service_targets
         (service, project_id, target_branch, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (service) DO UPDATE SET
         project_id = excluded.project_id,
         target_branch = excluded.target_branch,
         updated_at = excluded.updated_at`,
      [normalized, projectId, targetBranch, now],
    );
    return this.get(normalized)!;
  }

  delete(service: string): boolean {
    return (
      this.db.run(
        "DELETE FROM datadog_service_targets WHERE service = ? COLLATE NOCASE",
        [cleanService(service)],
      ).changes > 0
    );
  }
}

function cleanService(value: string): string {
  const service = required(value, "Datadog service");
  if (service.length > 200) {
    throw new ConfigError("Datadog service must be at most 200 characters.");
  }
  return service;
}

function required(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new ConfigError(`${label} is required.`);
  if (clean.length > 500) throw new ConfigError(`${label} must be at most 500 characters.`);
  return clean;
}

function toTarget(row: Row): DatadogServiceTarget {
  return {
    service: row.service,
    projectId: row.project_id,
    targetBranch: row.target_branch,
    updatedAt: fromIso(row.updated_at)!,
  };
}
