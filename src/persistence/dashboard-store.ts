import type { Database } from "bun:sqlite";

import type { DashboardRepository, NewDashboard, StoredDashboard } from "../application/dashboards/repository.ts";
import { WidgetSchema } from "../../shared/dashboard.ts";
import { ValidationError } from "../core/errors.ts";
import { toIso } from "./database.ts";
import { newId } from "./id.ts";

interface Row {
  id: string;
  owner_user_id: string;
  name: string;
  spec: string;
  created_at: string;
  updated_at: string;
}

/**
 * Private dashboards. `spec` is the versioned widget document; the name is a
 * column so the list does not have to parse JSON.
 */
export class SqliteDashboardStore implements DashboardRepository {
  constructor(private readonly db: Database) {}

  list(ownerUserId: string): StoredDashboard[] {
    return this.db
      .query<Row, [string]>(
        `SELECT id, owner_user_id, name, spec, created_at, updated_at
           FROM dashboards
          WHERE owner_user_id = ?
          ORDER BY updated_at DESC, id`,
      )
      .all(ownerUserId)
      .map(toDashboard);
  }

  get(ownerUserId: string, id: string): StoredDashboard | null {
    const row = this.db
      .query<Row, [string, string]>(
        `SELECT id, owner_user_id, name, spec, created_at, updated_at
           FROM dashboards WHERE owner_user_id = ? AND id = ?`,
      )
      .get(ownerUserId, id);
    return row ? toDashboard(row) : null;
  }

  insert(input: NewDashboard): StoredDashboard {
    const now = toIso(new Date());
    const row: StoredDashboard = {
      id: newId(),
      ownerUserId: input.ownerUserId,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      widgets: input.widgets,
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      `INSERT INTO dashboards (id, owner_user_id, name, spec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.ownerUserId, row.name, specJson(row), row.createdAt, row.updatedAt],
    );
    return row;
  }

  update(
    ownerUserId: string,
    id: string,
    patch: { name?: string; description?: string | null; widgets?: WidgetPatch },
  ): StoredDashboard | null {
    const current = this.get(ownerUserId, id);
    if (!current) return null;
    const next: StoredDashboard = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description === null
        ? undefined
        : patch.description ?? current.description,
      widgets: patch.widgets ?? current.widgets,
      updatedAt: toIso(new Date()),
    };
    this.db.run(
      `UPDATE dashboards SET name = ?, spec = ?, updated_at = ? WHERE owner_user_id = ? AND id = ?`,
      [next.name, specJson(next), next.updatedAt, ownerUserId, id],
    );
    return next;
  }

  delete(ownerUserId: string, id: string): boolean {
    return this.db.run(
      "DELETE FROM dashboards WHERE owner_user_id = ? AND id = ?",
      [ownerUserId, id],
    ).changes > 0;
  }
}

type WidgetPatch = StoredDashboard["widgets"];

function specJson(row: StoredDashboard): string {
  return JSON.stringify({
    version: 1,
    ...(row.description ? { description: row.description } : {}),
    widgets: row.widgets,
  });
}

function toDashboard(row: Row): StoredDashboard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.spec);
  } catch (cause) {
    throw new ValidationError(`Dashboard '${row.id}' has an unreadable spec.`, { cause });
  }
  const spec = parsed as { description?: unknown; widgets?: unknown };
  const widgets = WidgetSchema.array().safeParse(spec.widgets);
  if (!widgets.success) {
    throw new ValidationError(`Dashboard '${row.id}' has an invalid spec.`);
  }
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    ...(typeof spec.description === "string" && spec.description ? { description: spec.description } : {}),
    widgets: widgets.data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
