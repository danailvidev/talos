/**
 * Webhook ingress for LogRocket issue alerts: `POST /webhooks/logrocket/:secret`.
 *
 * This exists because LogRocket has no API for reading issues or sessions. Their
 * public API is one endpoint (Galileo highlights, per user, asynchronous) — there
 * is nothing to poll for "what is broken right now". Alerts are the only push:
 * LogRocket → Issues → Alerts sends a JSON body to a URL you paste in. So the URL
 * is the integration, and this handler is where the LogRocket page's list comes
 * from.
 *
 * The secret is in the path rather than a header because LogRocket's alert
 * configuration is a URL and nothing else — no header fields, no signing key, no
 * shared secret of its own. A long random path segment is therefore the whole
 * authentication story, which is why an unset secret refuses every delivery
 * instead of accepting anonymous ones: without it the URL would be guessable from
 * the path alone, and anything could file issues into the console.
 *
 * Unlike the GitLab receiver this one *does* parse the payload, because there is
 * no discovery pass behind it to reach its own conclusions — the delivery is the
 * only account of the issue that will ever exist. It still does nothing with it
 * beyond storing it: filing a ticket and starting an agent are a person's click
 * on the page, never an unauthenticated request's decision.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { App } from "../app.ts";
import type { RecordLogRocketIssueInput } from "../application/ports.ts";
import { describeError } from "../core/errors.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** Alert bodies are a few KB; a screenshot URL is a URL, not an image. */
const MAX_BODY_BYTES = 1_000_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Resolves a LogRocket alert delivery, or returns null for a path this module
 * does not own — same contract as `handleWebhookRequest`.
 */
export async function handleLogRocketWebhook(
  request: Request,
  app: App,
  path: string,
): Promise<Response | null> {
  // A trailing slash is tolerated: the segment is pasted by hand into another
  // product's form, and refusing over one character nobody can see would be a
  // silent 404 with no way to work out why.
  const match = path.match(/^\/webhooks\/logrocket\/([^/]+)\/?$/);
  if (!match) return null;

  const presented = decodeURIComponent(match[1]!).trim();

  try {
    if (request.method !== "POST") {
      return json({ error: "Webhook deliveries must be POST." }, 405);
    }

    const expected = app.secrets.get("LOGROCKET_WEBHOOK_SECRET")?.trim();
    if (!expected) {
      app.logger.warn(
        "rejected a LogRocket alert: no LOGROCKET_WEBHOOK_SECRET is configured",
      );
      return json(
        { error: "LogRocket alerts are not configured on this server." },
        404,
      );
    }
    if (!secretMatches(expected, presented)) {
      // 404, not 401: this URL is only ever known to somebody who was given it,
      // and a 401 would confirm to a scanner that the path prefix is live.
      // Fingerprints rather than the values: enough to tell "LogRocket has an
      // old secret" from "the paste was truncated" without printing either
      // secret into a log file. Eight hex characters of a SHA-256 identify a
      // 32-byte random string in practice and reverse to nothing.
      app.logger.warn(
        {
          presentedLength: presented.length,
          presented: fingerprint(presented),
          expectedLength: expected.length,
          expected: fingerprint(expected),
        },
        "rejected a LogRocket alert: wrong webhook secret",
      );
      return json({ error: "Not found." }, 404);
    }

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return json({ error: "Payload too large." }, 413);
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return json({ error: "Payload too large." }, 413);

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return json({ error: "Body is not valid JSON." }, 400);
    }

    const input = parseAlert(payload);
    if (!input) {
      // 200 rather than 400: LogRocket has other alert types (metric thresholds,
      // conditional alerts) that may point at the same URL, and answering an
      // error would make them retry something we will never want.
      app.logger.info(
        { type: describeType(payload) },
        "ignored a LogRocket delivery that is not an issue alert",
      );
      return json({ ok: true, stored: false, reason: "not an issue alert" });
    }

    const issue = app.logRocketIssues.record(input);
    app.logger.info(
      {
        issue: issue.id,
        alerts: issue.alertCount,
        sessions: issue.sessionCount,
        issueType: issue.issueType,
      },
      `LogRocket alert: ${issue.title}`,
    );
    return json({ ok: true, stored: true, id: issue.id, alertCount: issue.alertCount });
  } catch (err) {
    app.logger.error(
      { err: describeError(err) },
      "unhandled error handling a LogRocket alert",
    );
    return json({ error: "internal error" }, 500);
  }
}

/**
 * Compares the presented path segment with the configured secret.
 *
 * Hashed first so `timingSafeEqual` gets two equal-length buffers: comparing the
 * raw strings would throw on a length mismatch, and refusing early on length is
 * itself a signal about the secret.
 */
/** A short, non-reversible label for a secret, for comparing two of them in a log. */
function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function secretMatches(expected: string, presented: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

/**
 * Reads an Issue Alert body, or undefined when the payload is not one.
 *
 * Every field is optional and read defensively: this is an unauthenticated-shape
 * JSON body from a third party whose schema is theirs to change, and a missing
 * `summary` should cost us a column, not the delivery. The alert nests the
 * interesting half under `issue` and keeps the title at the top level.
 */
function parseAlert(payload: unknown): RecordLogRocketIssueInput | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  const issue =
    body.issue && typeof body.issue === "object" && !Array.isArray(body.issue)
      ? (body.issue as Record<string, unknown>)
      : undefined;
  if (!issue) return undefined;

  const title = str(body.title) ?? str(issue.label) ?? str(issue.issueDescription);
  if (!title) return undefined;

  return {
    title,
    ...opt("appId", str(body.appID) ?? str(body.appId)),
    ...opt("issueType", str(issue.issueType)),
    ...opt("label", str(issue.label)),
    ...opt("description", str(issue.issueDescription) ?? str(issue.description)),
    ...opt("summary", str(issue.summary)),
    ...opt("userImpact", str(issue.user_impact) ?? str(issue.userImpact)),
    ...opt("url", str(issue.url)),
    ...opt("screenshotUrl", str(issue.screenshotUrl)),
    ...opt("sessionCount", num(issue.sessionCount)),
    ...opt("sessionRate", num(issue.sessionRate)),
    ...opt("firstSeenAt", date(issue.firstSeen)),
    payload,
  };
}

function opt<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** ISO strings and epoch milliseconds both appear in the wild; both are accepted. */
function date(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const fromMs = new Date(value);
    return Number.isNaN(fromMs.getTime()) ? undefined : fromMs;
  }
  const text = str(value);
  if (!text) return undefined;
  const parsed = new Date(/^\d+$/.test(text) ? Number(text) : text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function describeType(payload: unknown): string {
  const type = (payload as Record<string, unknown> | null)?.type;
  return typeof type === "string" ? type : "unknown";
}
