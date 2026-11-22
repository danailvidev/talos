/**
 * Worker for the cross-process claim race test.
 *
 * bun:sqlite is synchronous, so Promise.all inside one process cannot truly
 * interleave two claims. Real contention needs real processes, which is what
 * this script provides: it opens the same database file and races for the same
 * event key. Prints "won" or "lost".
 */
import { Database } from "bun:sqlite";
import { SqliteStateStore } from "../../src/persistence/sqlite-state-store.ts";

const [path, taskId, externalId, startAtMs] = process.argv.slice(2);
if (!path || !taskId || !externalId || !startAtMs) {
  throw new Error("usage: claim-race-worker <db> <taskId> <externalId> <startAtMs>");
}

const db = new Database(path);
db.run("PRAGMA busy_timeout = 5000");
const store = new SqliteStateStore(db);

// Spin until the shared start time so the processes collide rather than queue.
const startAt = Number(startAtMs);
while (Date.now() < startAt) {
  // busy-wait: sleeping would blur the collision window
}

const won = await store.claimEvent(taskId, externalId, "race");
db.close();

console.log(won ? "won" : "lost");
