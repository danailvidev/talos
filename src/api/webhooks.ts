/**
 * Webhook ingress: `POST /webhooks/gitlab/:id`.
 *
 * Deliberately outside `/api/`, because it is not part of the API's security
 * model. Every `/api/` route needs a session cookie; GitLab has no session and
 * never will. This route authenticates the *endpoint* instead — a secret issued
 * per endpoint, sent in `X-Gitlab-Token`, compared timing-safely — and nothing
 * else about the request is trusted.
 *
 * The handler does the least it can: authenticate, dedupe, note that the loop has
 * news, answer. It does not parse the event into work. A delivery that tried to
 * be authoritative about *what* to do would duplicate every filter and brake the
 * discoverer already has, and it would be doing so from an unauthenticated
 * request. Instead the loop runs its normal discovery moments later and reaches
 * its own conclusions — the webhook only changes *when* that happens.
 */
import type { App } from "../app.ts";
import { describeError } from "../core/errors.ts";
import { handleLogRocketWebhook } from "./logrocket-webhook.ts";
import { CACHE_PREFIX } from "./cached-reads.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** GitLab payloads are a few KB. A megabyte is already a bug or an attack. */
const MAX_BODY_BYTES = 1_000_000;

/** Deliveries older than this are dropped; the endpoint's counter keeps the total. */
const DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Purge at most this often, so a busy endpoint does not sweep on every event. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastPurge = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Resolves a webhook delivery, or returns null for a path this module does not
 * own — same contract as `handleApiRequest`, so `serve.ts` can try both.
 */
export async function handleWebhookRequest(
  request: Request,
  app: App,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  // The other inbound integration, kept in its own module because it authenticates
  // and parses differently — see `logrocket-webhook.ts`. Returns null for a path
  // it does not own, so this stays the single ingress entry point.
  const logRocket = await handleLogRocketWebhook(request, app, path);
  if (logRocket) return logRocket;

  const match = path.match(/^\/webhooks\/gitlab\/([^/]+)$/);
  if (!match) return null;

  const id = decodeURIComponent(match[1]!);

  try {
    if (request.method !== "POST") {
      return json({ error: "Webhook deliveries must be POST." }, 405);
    }

    // One answer for an unknown id and a wrong secret: telling them apart would
    // turn this route into a way to enumerate endpoint ids.
    const endpoint = app.webhooks.verify(id, request.headers.get("x-gitlab-token"));
    if (!endpoint) {
      app.logger.warn(
        { endpoint: id },
        `rejected a webhook delivery for ${id}: unknown endpoint or wrong secret`,
      );
      return json({ error: "Unknown endpoint or invalid token." }, 401);
    }

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) {
      return json({ error: "Payload too large." }, 413);
    }
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return json({ error: "Payload too large." }, 413);
    }

    const payload = parsePayload(body);
    const eventKind =
      request.headers.get("x-gitlab-event") ?? stringField(payload, "object_kind") ?? "unknown";
    // GitLab sends an event id per delivery and reuses it across retries. When it
    // is missing — an old instance, a hand-rolled curl — the body is hashed
    // instead, so an identical retry still dedupes.
    const eventUuid =
      request.headers.get("x-gitlab-event-uuid") ??
      `body:${new Bun.CryptoHasher("sha256").update(`${endpoint.id}:${body}`).digest("hex")}`;
    const subject = describeSubject(payload);

    dropCachedMergeRequests(app, eventKind);

    const target = app.taskRegistry.get(endpoint.taskId);
    const scheduled = app.scheduledTask(endpoint.taskId);
    // A loop that is gone or switched off does not silently swallow deliveries:
    // the reason is recorded and returned, because "the webhook works and nothing
    // happens" is the hardest version of this to debug. Note that `enabled` is
    // what matters and not the trigger type — a loop with a `manual` trigger and
    // `enabled` on is a webhook-only loop, which is a legitimate setup.
    const ignoredBecause = !target
      ? `loop ${endpoint.taskId} is no longer registered`
      : !endpoint.enabled
        ? "endpoint is disabled"
        : !scheduled?.enabled.value
          ? `loop ${endpoint.taskId} is disabled`
          : null;

    const fresh = app.webhooks.recordDelivery({
      eventUuid,
      endpointId: endpoint.id,
      eventKind,
      ...(subject ? { subject } : {}),
      outcome: ignoredBecause ? "ignored" : "queued",
    });
    purgeOccasionally(app);

    if (!fresh) {
      // 200, not an error: this is GitLab retrying a delivery we already have, and
      // the correct response is to confirm rather than to invite another retry.
      app.logger.debug(
        { endpoint: endpoint.id, event: eventKind, eventUuid },
        `duplicate webhook delivery for ${endpoint.taskId}, ignored`,
      );
      return json({ ok: true, duplicate: true, task: endpoint.taskId });
    }

    if (ignoredBecause) {
      app.logger.info(
        { endpoint: endpoint.id, task: endpoint.taskId, event: eventKind },
        `webhook delivery ignored: ${ignoredBecause}`,
      );
      return json({ ok: true, queued: false, reason: ignoredBecause });
    }

    app.webhooks.request(endpoint.taskId, `gitlab:${eventKind}`);
    app.logger.info(
      {
        endpoint: endpoint.id,
        task: endpoint.taskId,
        event: eventKind,
        ...(subject ? { subject } : {}),
      },
      `webhook ${eventKind} for ${endpoint.taskId}${subject ? ` (${subject})` : ""}`,
    );
    // 202: the loop has not run yet. The scheduler picks the request up within
    // seconds, and holding the connection open for a run that may take minutes is
    // what got this wrong the first time (see `idleTimeout` in serve.ts).
    return json({ ok: true, queued: true, task: endpoint.taskId, event: eventKind }, 202);
  } catch (err) {
    // A 500 invites GitLab to retry, which is right for a transient fault and
    // harmless otherwise — the event id makes the retry a no-op.
    app.logger.error(
      { endpoint: id, err: describeError(err) },
      "unhandled error handling a webhook delivery",
    );
    return json({ error: "internal error" }, 500);
  }
}

/** Undefined rather than a 400: a body we cannot read still means "something happened". */
function parsePayload(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function stringField(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * A human-readable "what was this about" for the delivery log: `acme/web!412`,
 * `acme/web#7`, or the project alone. Best-effort by design — it is only ever
 * shown to an operator, never acted on.
 */
function describeSubject(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const project = payload.project as { path_with_namespace?: unknown } | undefined;
  const path =
    typeof project?.path_with_namespace === "string" ? project.path_with_namespace : undefined;
  const attributes = payload.object_attributes as { iid?: unknown } | undefined;
  const iid = typeof attributes?.iid === "number" ? attributes.iid : undefined;
  const mr = payload.merge_request as { iid?: unknown } | undefined;
  const mrIid = typeof mr?.iid === "number" ? mr.iid : undefined;

  const ref = mrIid ?? iid;
  if (path && ref != null) return `${path}!${ref}`;
  return path;
}

/**
 * The one thing this handler does act on: a merge request event means the cached
 * listings are behind the forge, so drop them.
 *
 * Placed above the `ignoredBecause` checks on purpose. Those are about whether a
 * *loop* should run, and a delivery for a disabled loop still carries the news that
 * a merge request moved — the console reads that listing whether or not anything is
 * scheduled against it. It is also safe to act on from an unauthenticated request
 * in a way that queueing work is not: the worst a forged delivery achieves is
 * making somebody's next page load pay for a forge call it would have paid for a
 * minute later anyway.
 *
 * Both prefixes rather than one merge request's key, because the key holds the
 * repository as the *console* spells it and this payload spells it GitLab's way;
 * guessing wrong would fail silently, which is the one outcome worse than dropping
 * a few extra entries. `pull-request-changes` is left alone deliberately — it is
 * keyed by the head commit set, so a push is already a different key.
 */
function dropCachedMergeRequests(app: App, eventKind: string): void {
  if (!eventKind.toLowerCase().includes("merge_request")) return;
  app.responseCache.invalidate(CACHE_PREFIX.pullRequests);
  app.responseCache.invalidate(CACHE_PREFIX.pullRequestDetail);
}

function purgeOccasionally(app: App): void {
  const now = Date.now();
  if (now - lastPurge < PURGE_INTERVAL_MS) return;
  lastPurge = now;
  const removed = app.webhooks.purgeDeliveries(new Date(now - DELIVERY_RETENTION_MS));
  if (removed > 0) {
    app.logger.debug({ removed }, `aged out ${removed} webhook delivery record(s)`);
  }
}
