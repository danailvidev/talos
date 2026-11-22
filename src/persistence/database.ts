import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError } from "../core/errors.ts";
import { migrate, schemaVersion, type AppliedMigration } from "./migrations.ts";

export interface OpenDatabaseResult {
  db: Database;
  applied: AppliedMigration[];
  version: number;
}

/**
 * Opens the SQLite database, creating its directory and applying migrations.
 *
 * Pragmas matter here. WAL allows concurrent server reads and writes; NORMAL
 * synchronous is the usual WAL pairing; busy_timeout stops a concurrent writer
 * from failing instantly; foreign_keys is off by default in SQLite and the
 * task_steps cascade depends on it.
 */
export function openDatabase(path: string): OpenDatabaseResult {
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (cause) {
      throw new ConfigError(`Could not create the directory for ${path}`, { cause });
    }
  }

  let db: Database;
  try {
    db = new Database(path, { create: true });
  } catch (cause) {
    throw new ConfigError(`Could not open the database at ${path}`, { cause });
  }

  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");

  const applied = migrate(db);
  return { db, applied, version: schemaVersion(db) };
}

/** ISO 8601 UTC. Stored as TEXT so the files stay greppable and sort correctly. */
export function toIso(date: Date): string {
  return date.toISOString();
}

export function fromIso(value: string): Date;
export function fromIso(value: string | null | undefined): Date | undefined;
export function fromIso(value: string | null | undefined): Date | undefined {
  return value == null ? undefined : new Date(value);
}

/**
 * Metadata columns hold JSON. A value that cannot round-trip is dropped with a
 * marker rather than throwing: losing an audit detail is preferable to failing a
 * run that has already performed its side effect.
 */
export function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return JSON.stringify({ _unserializable: true });
  }
}

export function fromJson<T>(value: string | null | undefined): T | undefined {
  if (value == null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
