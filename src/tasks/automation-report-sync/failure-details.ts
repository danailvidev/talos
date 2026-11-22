import type { PipelineTestCase } from "../../connectors/gitlab/types.ts";

export const AUTOMATION_REPORT_VERSION = 2;

export interface FailureSignature {
  key: string;
  title: string;
}

export interface SafeAttachment {
  jobId: number;
  path: string;
  name: string;
}

const ERROR_TYPE = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:Error|Exception|Failure))\b(?::\s*(.*))?/;
const FRAME = /^\s*(?:at\s+|File\s+["']|#\d+\s+)/i;
const NON_APPLICATION_FRAME =
  /(?:node:internal|node_modules|\/vendor\/|site-packages|<anonymous>|(?:^|[.(\s])(?:java|sun|jdk|org\.junit|org\.gradle)\.)/i;

/**
 * A root-cause shape, deliberately unscoped. Callers that cluster occurrences
 * scope this key by project and schedule rather than baking either into it.
 */
export function failureSignature(
  testCase: Pick<
    PipelineTestCase,
    "status" | "name" | "system_output" | "stack_trace" | "file"
  >,
): FailureSignature {
  const text = [testCase.stack_trace, testCase.system_output]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const lines = cleanLines(text);
  const error = lines
    .map((line) => line.match(ERROR_TYPE))
    .find((match): match is RegExpMatchArray => match != null);
  const type = error?.[1]?.split(".").at(-1) ??
    (testCase.status === "error" ? "TestError" : "AssertionFailure");
  const messageSource =
    error?.[2] ||
    lines.find((line) => !FRAME.test(line) && !isRunnerNoise(line)) ||
    testCase.name;
  const message = normalizeVolatile(messageSource);
  const frameSource = lines.find(
    (line) => FRAME.test(line) && !NON_APPLICATION_FRAME.test(line),
  );
  const frame = frameSource
    ? normalizeFrame(frameSource)
    : safeTestFile(testCase.file);
  const basis = [type.toLowerCase(), message.toLowerCase(), frame?.toLowerCase()]
    .filter(Boolean)
    .join("|");
  const key = new Bun.CryptoHasher("sha256")
    .update(basis)
    .digest("hex")
    .slice(0, 32);
  const readable = message && message !== type ? `${type}: ${message}` : type;
  return {
    key,
    title: truncate(readable, 240),
  };
}

/**
 * Accepts only this pipeline's GitLab project URL and the browser artifact-file
 * shape. The returned value contains no origin, query, fragment, or credential.
 */
export function safeAttachment(
  attachmentUrl: string | null | undefined,
  pipelineWebUrl: string,
  suiteBuildIds: readonly number[],
): SafeAttachment | undefined {
  if (!attachmentUrl) return undefined;
  let pipeline: URL;
  let attachment: URL;
  try {
    pipeline = new URL(pipelineWebUrl);
    attachment = new URL(attachmentUrl, pipeline);
  } catch {
    return undefined;
  }
  if (
    !["http:", "https:"].includes(pipeline.protocol) ||
    attachment.origin !== pipeline.origin ||
    attachment.username ||
    attachment.password
  ) {
    return undefined;
  }

  const pipelineMarker = "/-/pipelines/";
  const markerIndex = pipeline.pathname.indexOf(pipelineMarker);
  if (markerIndex <= 0) return undefined;
  const projectPath = pipeline.pathname.slice(0, markerIndex);
  const prefix = `${projectPath}/-/jobs/`;
  if (!attachment.pathname.startsWith(prefix)) return undefined;

  const remainder = attachment.pathname.slice(prefix.length);
  const match = remainder.match(/^(\d+)\/artifacts\/file\/(.+)$/);
  if (!match) return undefined;
  const jobId = Number(match[1]);
  if (!Number.isSafeInteger(jobId) || !suiteBuildIds.includes(jobId)) {
    return undefined;
  }

  const path = decodeSafeArtifactPath(match[2]!);
  if (!path) return undefined;
  return { jobId, path, name: path.split("/").at(-1)! };
}

/** A display-only source path: bounded and stripped of control characters. */
export function safeTestFile(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return normalized ? truncate(normalized, 2_048) : undefined;
}

function decodeSafeArtifactPath(encoded: string): string | undefined {
  if (encoded.length > 8_192) return undefined;
  const decoded: string[] = [];
  for (const part of encoded.split("/")) {
    let value: string;
    try {
      value = decodeURIComponent(part);
    } catch {
      return undefined;
    }
    if (
      !value ||
      value === "." ||
      value === ".." ||
      value.length > 255 ||
      value.includes("/") ||
      value.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      return undefined;
    }
    decoded.push(value);
  }
  return decoded.join("/");
}

function cleanLines(value: string): string[] {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeFrame(value: string): string {
  let normalized = value.replaceAll("\\", "/").replace(/:\d+(?::\d+)?(?=[)\s]|$)/g, "");
  const root = normalized.match(/\/((?:src|test|tests|web)\/[^)\s"']+)/i);
  if (root?.[1]) {
    normalized = normalized.replace(/\/[^)\s"']+/, root[1]);
  }
  return normalizeVolatile(normalized);
}

function normalizeVolatile(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gi, "<timestamp>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\b(?:0x)?[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\b\d{6,}\b/g, "<id>")
    .replace(/\bline\s+\d+\b/gi, "line <n>")
    .replace(/:\d+(?::\d+)?(?=[)\s]|$)/g, "")
    .replace(
      /\b(locator|selector|element|target)\s*(?:\(|[=:])\s*(["'`])[^"'`]*\2\)?/gi,
      "$1(<selector>)",
    )
    .replace(/(["'`])(?:[#.][\w-]+|\[[^\]"']+\]|\/\/[^"'`]+)\1/g, "<selector>")
    .replace(/\s+/g, " ")
    .trim();
}

function isRunnerNoise(line: string): boolean {
  return /^(?:error: job failed|running with gitlab-runner|expected:|received:|\^+$)/i.test(
    line,
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
