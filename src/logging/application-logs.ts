import { Writable } from "node:stream";

const DROPPED = new Set(["pid", "hostname", "time", "level", "msg"]);
const MAX_LINE_BYTES = 1 * 1024 * 1024;

export interface ApplicationLogLine {
  id: number;
  timestamp: Date;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

/**
 * A bounded, process-local view of already-redacted Pino output for the admin
 * console. It deliberately does not become a second durable log store: stdout
 * remains the deployment's source of truth and this buffer cannot grow forever.
 */
export class ApplicationLogBuffer {
  readonly stream: Writable;
  private readonly lines: ApplicationLogLine[] = [];
  private nextId = 1;

  constructor(private readonly capacity = 1_000) {
    let leftover = "";
    let discardingLongLine = false;

    this.stream = new Writable({
      write: (chunk, _encoding, callback) => {
        leftover += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
        const pieces = leftover.split("\n");
        leftover = pieces.pop() ?? "";
        for (const piece of pieces) {
          if (discardingLongLine) {
            discardingLongLine = false;
            continue;
          }
          if (Buffer.byteLength(piece) <= MAX_LINE_BYTES) this.ingest(piece);
        }
        if (Buffer.byteLength(leftover) > MAX_LINE_BYTES) {
          leftover = "";
          discardingLongLine = true;
        }
        callback();
      },
    });
  }

  /** Newest first, matching how operators inspect a live log. */
  list(limit = 200): ApplicationLogLine[] {
    return this.lines.slice(-Math.max(1, Math.min(limit, this.capacity))).reverse();
  }

  private ingest(piece: string): void {
    const text = piece.trim();
    if (!text) return;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!DROPPED.has(key)) meta[key] = value;
    }
    this.lines.push({
      id: this.nextId++,
      timestamp: typeof record.time === "number" ? new Date(record.time) : new Date(),
      level: String(record.level ?? "info"),
      // Reset and verification links intentionally remain usable on host stdout,
      // but their bearer tokens must not be copied into the browser log viewer.
      message: typeof record.msg === "string" ? maskUrlTokens(record.msg) : "",
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity);
    }
  }
}

function maskUrlTokens(value: string): string {
  return value.replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]");
}
