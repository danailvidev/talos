#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createCipher } from "../src/secrets/crypto.ts";

const databasePath = resolve(process.argv[2] ?? "");
const backupPath = resolve(process.argv[3] ?? `${databasePath}.pre-key-rotation`);
const oldKeyPath = process.env.TALOS_OLD_SECRET_KEY_FILE;
const newKeyPath = process.env.TALOS_NEW_SECRET_KEY_FILE;

if (!process.argv[2] || !oldKeyPath || !newKeyPath) {
  console.error(
    "Usage: TALOS_OLD_SECRET_KEY_FILE=/secure/old " +
      "TALOS_NEW_SECRET_KEY_FILE=/secure/new bun run scripts/rotate-secret-key.ts " +
      "<database> [backup]",
  );
  process.exit(2);
}
if (backupPath === databasePath) throw new Error("Backup path must differ from the database path.");

async function readProtectedKey(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${path} must not be readable or writable by group or others.`);
  }
  const value = (await Bun.file(path).text()).trim();
  if (!value) throw new Error(`${path} is empty.`);
  return value;
}

const oldCipher = createCipher(await readProtectedKey(oldKeyPath));
const newCipher = createCipher(await readProtectedKey(newKeyPath));
const db = new Database(databasePath);

type Cell = {
  table: string;
  column: string;
  rowid: number;
  plaintext: string;
};

const encryptedColumns = [
  { table: "user_credentials", column: "value" },
  { table: "slack_connections", column: "access_token" },
  { table: "slack_connections", column: "refresh_token" },
  { table: "agent_accounts", column: "secret" },
  { table: "integration_config", column: "value", where: "encrypted = 1" },
  { table: "e2e_test_config", column: "runtime_config_override" },
] as const;

try {
  db.run("PRAGMA busy_timeout = 5000");
  const hasLeaseTable = db
    .query<{ found: number }, []>(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'daemon_lease'",
    )
    .get();
  if (hasLeaseTable) {
    const lease = db
      .query<{ expires_at: string }, []>(
        "SELECT expires_at FROM daemon_lease WHERE singleton = 1",
      )
      .get();
    if (lease && Date.parse(lease.expires_at) > Date.now()) {
      throw new Error("Talos still owns the database lease. Stop every server before rotating.");
    }
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");

  const cells: Cell[] = [];
  for (const target of encryptedColumns) {
    const where = `${target.column} IS NOT NULL${
      "where" in target ? ` AND ${target.where}` : ""
    }`;
    const rows = db
      .query<{ rowid: number; value: string }, []>(
        `SELECT rowid, ${target.column} AS value FROM ${target.table} WHERE ${where}`,
      )
      .all();
    for (const row of rows) {
      cells.push({
        table: target.table,
        column: target.column,
        rowid: row.rowid,
        plaintext: oldCipher.decrypt(row.value),
      });
    }
  }

  const escapedBackup = backupPath.replaceAll("'", "''");
  db.run(`VACUUM INTO '${escapedBackup}'`);

  db.transaction(() => {
    for (const cell of cells) {
      db.run(
        `UPDATE ${cell.table} SET ${cell.column} = ? WHERE rowid = ?`,
        [newCipher.encrypt(cell.plaintext), cell.rowid],
      );
    }
  })();

  // A successful transaction is not enough: verify every rewritten value with
  // the new key before declaring the old key safe to retire.
  for (const cell of cells) {
    const row = db
      .query<{ value: string }, [number]>(
        `SELECT ${cell.column} AS value FROM ${cell.table} WHERE rowid = ?`,
      )
      .get(cell.rowid);
    if (!row || newCipher.decrypt(row.value) !== cell.plaintext) {
      throw new Error(`Verification failed for ${cell.table}.${cell.column} row ${cell.rowid}.`);
    }
  }

  console.log(`Rotated ${cells.length} encrypted value(s). Backup: ${backupPath}`);
} finally {
  db.close();
}
