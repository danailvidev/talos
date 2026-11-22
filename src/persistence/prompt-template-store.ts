import type { Database } from "bun:sqlite";
import type { PromptTemplateRepository } from "../application/ports.ts";
import { toIso } from "./database.ts";

interface PromptTemplateRow {
  id: string;
  template: string;
}

export class SqlitePromptTemplateStore implements PromptTemplateRepository {
  constructor(private readonly db: Database) {}

  get(): Record<string, string> {
    const rows = this.db
      .query<PromptTemplateRow, []>(`SELECT id, template FROM prompt_templates`)
      .all();
    const overrides: Record<string, string> = {};
    for (const row of rows) overrides[row.id] = row.template;
    return overrides;
  }

  setTemplate(id: string, template: string | null): void {
    if (template == null) {
      this.db.run(`DELETE FROM prompt_templates WHERE id = ?`, [id]);
      return;
    }
    this.db.run(
      `INSERT INTO prompt_templates (id, template, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         template = excluded.template, updated_at = excluded.updated_at`,
      [id, template, toIso(new Date())],
    );
  }

  clear(id?: string): void {
    if (id) this.db.run(`DELETE FROM prompt_templates WHERE id = ?`, [id]);
    else this.db.run(`DELETE FROM prompt_templates`);
  }
}
