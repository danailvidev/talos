import type { Database } from "bun:sqlite";
import type {
  CreateTaskInstanceInput,
  InstanceRepository,
  TaskInstance,
  UpdateTaskInstanceInput,
  Visibility,
} from "../application/ports.ts";
import { newId } from "./id.ts";
import { fromIso, toIso } from "./database.ts";

interface InstanceRow {
  id: string;
  definition_id: string;
  name: string;
  description: string | null;
  created_at: string;
  visibility: Visibility;
  owner_id: string | null;
  prompt_template: string | null;
}

export type { TaskInstance, Visibility } from "../application/ports.ts";

/**
 * User-created instances of an "instantiable" task definition — see
 * `core/task.ts`. Stored separately from `scheduled_task_config`: this table
 * is "does this task exist and what definition does it borrow", the config
 * table is "how does it run", and an instance can exist with no schedule
 * configured yet (manual-only, same as any freshly-registered task).
 */
export class SqliteInstanceStore implements InstanceRepository {
  constructor(private readonly db: Database) {}

  all(): TaskInstance[] {
    return this.db
      .query<InstanceRow, []>(
        "SELECT id, definition_id, name, description, created_at, visibility, owner_id, prompt_template FROM task_instances ORDER BY created_at",
      )
      .all()
      .map(toInstance);
  }

  get(id: string): TaskInstance | null {
    const row = this.db
      .query<InstanceRow, [string]>(
        "SELECT id, definition_id, name, description, created_at, visibility, owner_id, prompt_template FROM task_instances WHERE id = ?",
      )
      .get(id);
    return row ? toInstance(row) : null;
  }

  create(input: CreateTaskInstanceInput): TaskInstance {
    const id = input.id ?? newId();
    const createdAt = new Date();
    const visibility = input.visibility ?? "public";
    this.db.run(
      `INSERT INTO task_instances
         (id, definition_id, name, description, created_at, visibility, owner_id, prompt_template)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.definitionId,
        input.name,
        input.description ?? null,
        toIso(createdAt),
        visibility,
        input.ownerId ?? null,
        input.promptTemplate ?? null,
      ],
    );
    return {
      id,
      definitionId: input.definitionId,
      name: input.name,
      description: input.description,
      createdAt,
      visibility,
      ownerId: input.ownerId,
      promptTemplate: input.promptTemplate,
    };
  }

  update(id: string, input: UpdateTaskInstanceInput): void {
    const updates: string[] = [];
    const values: any[] = [];

    if (input.name !== undefined) {
      updates.push("name = ?");
      values.push(input.name);
    }
    if (input.description !== undefined) {
      updates.push("description = ?");
      values.push(input.description);
    }
    if (input.promptTemplate !== undefined) {
      updates.push("prompt_template = ?");
      values.push(input.promptTemplate);
    }

    if (updates.length === 0) return;

    values.push(id);
    this.db.run(
      `UPDATE task_instances SET ${updates.join(", ")} WHERE id = ?`,
      values,
    );
  }

  delete(id: string): void {
    this.db.run("DELETE FROM task_instances WHERE id = ?", [id]);
  }
}

function toInstance(row: InstanceRow): TaskInstance {
  return {
    id: row.id,
    definitionId: row.definition_id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: fromIso(row.created_at),
    visibility: row.visibility,
    ownerId: row.owner_id ?? undefined,
    promptTemplate: row.prompt_template ?? undefined,
  };
}
