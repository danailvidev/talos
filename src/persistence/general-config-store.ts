import type { Database } from "bun:sqlite";
import type {
  GeneralConfigOverrides,
  GeneralConfigRepository,
} from "../application/ports.ts";
import type { LogLevel } from "../logging/logger.ts";
import { toIso } from "./database.ts";

interface GeneralConfigRow {
  log_level: string | null;
  timezone: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  llm_effort: string | null;
  llm_max_tokens: number | null;
}

export type { GeneralConfigOverrides } from "../application/ports.ts";

const EMPTY: GeneralConfigOverrides = {
  logLevel: null,
  timezone: null,
  llmProvider: null,
  llmModel: null,
  llmEffort: null,
  llmMaxTokens: null,
};

/**
 * Live overrides for the general (non-task) settings that used to be
 * YAML-only — logLevel, timezone, llm defaults. One row, id fixed to 1: there
 * is nothing per-task here, unlike SqliteConfigStore.
 */
export class SqliteGeneralConfigStore implements GeneralConfigRepository {
  constructor(private readonly db: Database) {}

  get(): GeneralConfigOverrides {
    const row = this.db
      .query<GeneralConfigRow, []>(
        `SELECT log_level, timezone, llm_provider, llm_model, llm_effort, llm_max_tokens
           FROM general_config WHERE id = 1`,
      )
      .get();

    if (!row) return EMPTY;

    return {
      logLevel: (row.log_level as LogLevel | null) ?? null,
      timezone: row.timezone,
      llmProvider: row.llm_provider,
      llmModel: row.llm_model,
      llmEffort: row.llm_effort,
      llmMaxTokens: row.llm_max_tokens,
    };
  }

  /**
   * Merges `patch` over the stored row (or the empty defaults, if there is
   * none yet) and writes the full row back — same shape as
   * SqliteConfigStore.setConfig. A field set to `null` in the patch clears
   * that override.
   */
  setConfig(patch: Partial<GeneralConfigOverrides>): void {
    const current = this.get();
    const next: GeneralConfigOverrides = { ...current, ...patch };

    this.db.run(
      `INSERT INTO general_config
         (id, log_level, timezone, llm_provider, llm_model, llm_effort, llm_max_tokens, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         log_level = excluded.log_level,
         timezone = excluded.timezone,
         llm_provider = excluded.llm_provider,
         llm_model = excluded.llm_model,
         llm_effort = excluded.llm_effort,
         llm_max_tokens = excluded.llm_max_tokens,
         updated_at = excluded.updated_at`,
      [
        next.logLevel,
        next.timezone,
        next.llmProvider,
        next.llmModel,
        next.llmEffort,
        next.llmMaxTokens,
        toIso(new Date()),
      ],
    );
  }

  /** Deletes the row so every field reverts to its YAML default. */
  clear(): void {
    this.db.run("DELETE FROM general_config WHERE id = 1");
  }
}
