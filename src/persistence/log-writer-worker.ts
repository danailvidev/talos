import { Database } from "bun:sqlite";

declare const self: Worker;

type LogArgs = [string, string, string, string | null, string, string | null];
interface BatchMessage {
  type: "batch";
  id: number;
  databasePath: string;
  rows: LogArgs[];
  acknowledgement: SharedArrayBuffer;
}

let database: Database | undefined;
let path: string | undefined;

self.onmessage = async (event: MessageEvent<BatchMessage>) => {
  const message = event.data;
  if (message.type !== "batch") return;
  let error: string | undefined;
  try {
    if (!database || path !== message.databasePath) {
      database?.close();
      path = message.databasePath;
      database = new Database(path);
      database.run("PRAGMA foreign_keys = ON");
      database.run("PRAGMA busy_timeout = 250");
    }
    await writeWithBackoff(database, message.rows);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    const acknowledgement = new Int32Array(message.acknowledgement);
    Atomics.store(acknowledgement, 0, message.id);
    Atomics.notify(acknowledgement, 0);
    self.postMessage({ type: "ack", id: message.id, error });
  }
};

async function writeWithBackoff(db: Database, rows: LogArgs[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      db.transaction(() => {
        for (const args of rows) {
          try {
            db.run(
              `INSERT INTO task_run_logs
                 (execution_id, ts, level, step, message, meta)
               VALUES (?, ?, ?, ?, ?, ?)`,
              args,
            );
          } catch (cause) {
            // Logging can race the run-start insert. One parentless diagnostic
            // must not poison the rest of an otherwise valid batch.
            if (!String(cause).includes("FOREIGN KEY")) throw cause;
          }
        }
      })();
      return;
    } catch (cause) {
      const text = String(cause).toLowerCase();
      if (attempt >= 5 || (!text.includes("busy") && !text.includes("locked"))) throw cause;
      await Bun.sleep(25 * (attempt + 1));
    }
  }
}
