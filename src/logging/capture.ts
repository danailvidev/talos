import { Writable } from "node:stream";

/**
 * Fields pino always writes that are either noise in the UI or already stored
 * as columns. Everything else (status, durationMs, item ids, …) is kept as
 * `meta` so a log line still has the context the operator saw on stdout.
 */
const DROPPED = new Set([
  "pid",
  "hostname",
  "time",
  "level",
  "msg",
  "executionId",
  "task",
  "step",
]);

export interface ExecutionLogLine {
  /** SQLite row id when the line was read back from persisted history. */
  id?: number;
  ts: Date;
  level: string;
  step?: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface ExecutionLogSink {
  appendLog(executionId: string, line: ExecutionLogLine): void;
}

/**
 * A pino destination that records lines carrying `executionId` into the sink.
 * Lines from the rest of the process (startup, HTTP) have no execution id and
 * are ignored.
 */
export function createExecutionLogCapture(sink: ExecutionLogSink): Writable {
  const maxLineBytes = 1 * 1024 * 1024;
  let leftover = "";
  let discardingLongLine = false;

  return new Writable({
    write(chunk, _encoding, callback) {
      leftover += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      const pieces = leftover.split("\n");
      leftover = pieces.pop() ?? "";
      for (const piece of pieces) {
        if (discardingLongLine) {
          discardingLongLine = false;
          continue;
        }
        if (Buffer.byteLength(piece) <= maxLineBytes) ingest(sink, piece);
      }
      if (Buffer.byteLength(leftover) > maxLineBytes) {
        leftover = "";
        discardingLongLine = true;
      }
      callback();
    },
  });
}

function ingest(sink: ExecutionLogSink, piece: string): void {
  const text = piece.trim();
  if (!text) return;

  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }

  const executionId = rec.executionId;
  if (typeof executionId !== "string" || executionId.length === 0) return;

  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (!DROPPED.has(key)) meta[key] = value;
  }

  sink.appendLog(executionId, {
    ts: typeof rec.time === "number" ? new Date(rec.time) : new Date(),
    level: String(rec.level ?? "info"),
    step: typeof rec.step === "string" ? rec.step : undefined,
    message: typeof rec.msg === "string" ? rec.msg : "",
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  });
}
