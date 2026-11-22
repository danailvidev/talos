import type { Database } from "bun:sqlite";
import {
  normalizePermissions,
  type AppPermission,
} from "../shared/authorization.ts";

export const ADMIN_ROLE_ID = "admin";
export const QA_ROLE_ID = "qa";

export interface Role {
  id: string;
  name: string;
  description: string;
  system: boolean;
  permissions: AppPermission[];
  userCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface RoleRow {
  id: string;
  name: string;
  description: string;
  system: number;
  created_at: string;
  updated_at: string;
  user_count: number;
}

export class RoleError extends Error {}

export class RoleService {
  constructor(private readonly db: Database) {}

  list(): Role[] {
    return this.db
      .query<RoleRow, []>(
        `SELECT r.id, r.name, r.description, r.system, r.created_at, r.updated_at,
                COUNT(u.id) AS user_count
           FROM auth_roles r
           LEFT JOIN auth_users u ON u.role_id = r.id
          GROUP BY r.id
          ORDER BY r.system DESC, r.name COLLATE NOCASE`,
      )
      .all()
      .map((row) => this.fromRow(row));
  }

  get(id: string): Role | null {
    const row = this.db
      .query<RoleRow, [string]>(
        `SELECT r.id, r.name, r.description, r.system, r.created_at, r.updated_at,
                COUNT(u.id) AS user_count
           FROM auth_roles r
           LEFT JOIN auth_users u ON u.role_id = r.id
          WHERE r.id = ?
          GROUP BY r.id`,
      )
      .get(id);
    return row ? this.fromRow(row) : null;
  }

  create(input: {
    name: string;
    description?: string;
    permissions: readonly AppPermission[];
  }): Role {
    const name = validName(input.name);
    const description = validDescription(input.description ?? "");
    const permissions = validPermissions(input.permissions);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      this.db.transaction(() => {
        this.db.run(
          `INSERT INTO auth_roles (id, name, description, system, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
          [id, name, description, now, now],
        );
        this.replacePermissions(id, permissions);
      })();
    } catch (error) {
      if (isUniqueError(error)) throw new RoleError("A role with that name already exists.");
      throw error;
    }
    return this.get(id)!;
  }

  update(
    id: string,
    input: {
      name: string;
      description?: string;
      permissions: readonly AppPermission[];
    },
  ): Role {
    const current = this.get(id);
    if (!current) throw new RoleError("This role no longer exists.");
    const name = validName(input.name);
    const description = validDescription(input.description ?? "");
    const permissions = validPermissions(input.permissions);
    if (
      current.permissions.includes("users:manage") &&
      !permissions.includes("users:manage") &&
      this.managerPrincipalCountExcluding(id) === 0
    ) {
      throw new RoleError("At least one assigned role must retain permission to manage users.");
    }
    try {
      this.db.transaction(() => {
        this.db.run(
          "UPDATE auth_roles SET name = ?, description = ?, updated_at = ? WHERE id = ?",
          [name, description, new Date().toISOString(), id],
        );
        this.replacePermissions(id, permissions);
      })();
    } catch (error) {
      if (isUniqueError(error)) throw new RoleError("A role with that name already exists.");
      throw error;
    }
    return this.get(id)!;
  }

  delete(id: string): void {
    const role = this.get(id);
    if (!role) throw new RoleError("This role no longer exists.");
    if (role.system) throw new RoleError("Built-in roles cannot be deleted.");
    if (role.userCount > 0) {
      throw new RoleError("Reassign this role's users before deleting it.");
    }
    this.db.run("DELETE FROM auth_roles WHERE id = ?", [id]);
  }

  permissions(id: string): AppPermission[] {
    if (!this.get(id)) throw new RoleError("This role no longer exists.");
    return this.permissionRows(id);
  }

  private fromRow(row: RoleRow): Role {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      system: row.system === 1,
      permissions: this.permissionRows(row.id),
      userCount:
        row.user_count +
        (row.id === ADMIN_ROLE_ID || row.id === QA_ROLE_ID ? 1 : 0),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private permissionRows(id: string): AppPermission[] {
    const rows = this.db
      .query<{ permission: AppPermission }, [string]>(
        "SELECT permission FROM auth_role_permissions WHERE role_id = ? ORDER BY permission",
      )
      .all(id);
    return normalizePermissions(rows.map(({ permission }) => permission));
  }

  private replacePermissions(id: string, permissions: readonly AppPermission[]): void {
    this.db.run("DELETE FROM auth_role_permissions WHERE role_id = ?", [id]);
    for (const permission of permissions) {
      this.db.run(
        "INSERT INTO auth_role_permissions (role_id, permission) VALUES (?, ?)",
        [id, permission],
      );
    }
  }

  private managerPrincipalCountExcluding(roleId: string): number {
    const registered = this.db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
           FROM auth_users u
          WHERE u.role_id <> ?
            AND EXISTS (
              SELECT 1 FROM auth_role_permissions p
               WHERE p.role_id = u.role_id AND p.permission = 'users:manage'
            )`,
      )
      .get(roleId)?.count ?? 0;
    const builtInRoleIds = [ADMIN_ROLE_ID, QA_ROLE_ID].filter((id) => id !== roleId);
    const builtIn = builtInRoleIds.filter((id) =>
      this.permissionRows(id).includes("users:manage")
    ).length;
    return registered + builtIn;
  }
}

function validName(value: string): string {
  const name = value.trim();
  if (name.length < 2) throw new RoleError("Role name must be at least 2 characters.");
  if (name.length > 60) throw new RoleError("Role name must be 60 characters or fewer.");
  return name;
}

function validDescription(value: string): string {
  const description = value.trim();
  if (description.length > 240) {
    throw new RoleError("Role description must be 240 characters or fewer.");
  }
  return description;
}

function validPermissions(values: readonly unknown[]): AppPermission[] {
  try {
    return normalizePermissions(values);
  } catch (error) {
    throw new RoleError(error instanceof Error ? error.message : "Invalid permissions.");
  }
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}
