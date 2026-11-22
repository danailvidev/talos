import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  CreateWebhookInput,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookRepository,
} from "../application/ports.ts";
import type { PendingTrigger } from "../core/webhook.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

/** 32 bytes hex: long enough that guessing is not a threat model. */
const SECRET_BYTES = 32;

/**
 * Webhook endpoints, deliveries and the trigger queue, in SQLite.
 *
 * The secret never round-trips: `create` returns it once and stores only a
 * SHA-256 digest, and `verify` hashes what GitLab sent to compare. A plain digest
 * rather than a password hash is the right call here — the input is 256 bits of
 * randomness we generated, not something a human chose, so there is nothing for a
 * dictionary to attack and no reason to spend scrypt time on every delivery.
 */
export class SqliteWebhookStore implements WebhookRepository {
  constructor(private readonly db: Database) {}

  get(id: string): WebhookEndpoint | undefined {
    const row = this.db
      .query<EndpointRow, [string]>("SELECT * FROM webhook_endpoints WHERE id = ?")
      .get(id);
    return row ? toEndpoint(row) : undefined;
  }

  list(taskId?: string): WebhookEndpoint[] {
    const rows = taskId
      ? this.db
          .query<EndpointRow, [string]>(
            "SELECT * FROM webhook_endpoints WHERE task_id = ? ORDER BY created_at",
          )
          .all(taskId)
      : this.db
          .query<EndpointRow, []>("SELECT * FROM webhook_endpoints ORDER BY created_at")
          .all();
    return rows.map(toEndpoint);
  }

  create(input: CreateWebhookInput): { endpoint: WebhookEndpoint; secret: string } {
    const secret = randomBytes(SECRET_BYTES).toString("hex");
    const id = newId();
    const createdAt = new Date();
    this.db.run(
      `INSERT INTO webhook_endpoints
         (id, task_id, secret_hash, description, enabled, created_at, created_by, deliveries)
       VALUES (?, ?, ?, ?, 1, ?, ?, 0)`,
      [
        id,
        input.taskId,
        hash(secret),
        input.description ?? null,
        toIso(createdAt),
        input.createdBy ?? null,
      ],
    );
    return {
      endpoint: {
        id,
        taskId: input.taskId,
        ...(input.description ? { description: input.description } : {}),
        enabled: true,
        createdAt,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        deliveries: 0,
      },
      secret,
    };
  }

  delete(id: string): boolean {
    return this.db.run("DELETE FROM webhook_endpoints WHERE id = ?", [id]).changes > 0;
  }

  verify(id: string, token: string | null): WebhookEndpoint | undefined {
    if (!token) return undefined;
    const row = this.db
      .query<EndpointRow, [string]>("SELECT * FROM webhook_endpoints WHERE id = ?")
      .get(id);
    if (!row) return undefined;

    // Both sides are fixed-length hex digests, so timingSafeEqual can be used
    // without leaking a length. Comparing the hashes rather than the secrets is
    // what lets the stored value stay a digest.
    const expected = Buffer.from(row.secret_hash, "hex");
    const actual = Buffer.from(hash(token), "hex");
    if (expected.length !== actual.length) return undefined;
    return timingSafeEqual(expected, actual) ? toEndpoint(row) : undefined;
  }

  recordDelivery(input: Omit<WebhookDelivery, "receivedAt">): boolean {
    const receivedAt = toIso(new Date());
    const inserted =
      this.db.run(
        `INSERT OR IGNORE INTO webhook_deliveries
           (event_uuid, endpoint_id, event_kind, subject, received_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.eventUuid,
          input.endpointId,
          input.eventKind,
          input.subject ?? null,
          receivedAt,
          input.outcome,
        ],
      ).changes > 0;

    // The counter tracks what actually reached us, duplicates included: "GitLab
    // is hitting this endpoint" is the question it answers, and a retry storm is
    // exactly the thing worth seeing.
    this.db.run(
      `UPDATE webhook_endpoints
          SET deliveries = deliveries + 1, last_delivery_at = ?
        WHERE id = ?`,
      [receivedAt, input.endpointId],
    );
    return inserted;
  }

  deliveries(endpointId?: string, limit = 50): WebhookDelivery[] {
    const rows = endpointId
      ? this.db
          .query<DeliveryRow, [string, number]>(
            `SELECT * FROM webhook_deliveries WHERE endpoint_id = ?
              ORDER BY received_at DESC LIMIT ?`,
          )
          .all(endpointId, limit)
      : this.db
          .query<DeliveryRow, [number]>(
            "SELECT * FROM webhook_deliveries ORDER BY received_at DESC LIMIT ?",
          )
          .all(limit);
    return rows.map(toDelivery);
  }

  deliveryRetentionCount(before: Date): number {
    return this.db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE received_at < ?",
    ).get(toIso(before))?.count ?? 0;
  }

  purgeDeliveries(before: Date, limit = 250): number {
    const ids = this.db.query<{ event_uuid: string }, [string, number]>(
      `SELECT event_uuid FROM webhook_deliveries WHERE received_at < ?
        ORDER BY received_at LIMIT ?`,
    ).all(toIso(before), limit).map((row) => row.event_uuid);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    this.db.run(`DELETE FROM webhook_deliveries WHERE event_uuid IN (${placeholders})`, ids);
    return ids.length;
  }

  pending(): PendingTrigger[] {
    return this.db
      .query<TriggerRow, []>("SELECT * FROM webhook_triggers ORDER BY requested_at")
      .all()
      .map(toTrigger);
  }

  claim(taskId: string): PendingTrigger | undefined {
    // DELETE … RETURNING is the claim: whichever statement removes the row is the
    // one that runs the loop, so a second poller finds nothing rather than
    // starting a duplicate run.
    const row = this.db
      .query<TriggerRow, [string]>(
        "DELETE FROM webhook_triggers WHERE task_id = ? RETURNING *",
      )
      .get(taskId);
    return row ? toTrigger(row) : undefined;
  }

  request(taskId: string, source: string): void {
    // `requested_at` is kept from the first delivery in the burst, not bumped:
    // it measures how long the oldest news has been waiting, which is the number
    // worth watching. `source` takes the latest, since that is the event that
    // most recently justified the run.
    this.db.run(
      `INSERT INTO webhook_triggers (task_id, requested_at, source, events)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (task_id) DO UPDATE SET
         source = excluded.source,
         events = webhook_triggers.events + 1`,
      [taskId, toIso(new Date()), source],
    );
  }
}

function hash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

interface EndpointRow {
  id: string;
  task_id: string;
  secret_hash: string;
  description: string | null;
  enabled: number;
  created_at: string;
  created_by: string | null;
  last_delivery_at: string | null;
  deliveries: number;
}

interface DeliveryRow {
  event_uuid: string;
  endpoint_id: string;
  event_kind: string;
  subject: string | null;
  received_at: string;
  outcome: string;
}

interface TriggerRow {
  task_id: string;
  requested_at: string;
  source: string;
  events: number;
}

function toEndpoint(row: EndpointRow): WebhookEndpoint {
  const lastDeliveryAt = fromIso(row.last_delivery_at);
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.description ? { description: row.description } : {}),
    enabled: row.enabled === 1,
    createdAt: fromIso(row.created_at)!,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(lastDeliveryAt ? { lastDeliveryAt } : {}),
    deliveries: row.deliveries,
  };
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    eventUuid: row.event_uuid,
    endpointId: row.endpoint_id,
    eventKind: row.event_kind,
    ...(row.subject ? { subject: row.subject } : {}),
    receivedAt: fromIso(row.received_at)!,
    outcome: row.outcome as WebhookDelivery["outcome"],
  };
}

function toTrigger(row: TriggerRow): PendingTrigger {
  return {
    taskId: row.task_id,
    requestedAt: fromIso(row.requested_at)!,
    source: row.source,
    events: row.events,
  };
}
