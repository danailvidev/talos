import { z } from "zod";

export type ReviewSeverity = "blocker" | "warning" | "nit";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file: string;
  line?: number;
  comment: string;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
  /** True when the model's reply could not be parsed as the requested JSON shape. */
  unstructured: boolean;
}

/**
 * What a review agent must return.
 *
 * Findings are coerced rather than validated field by field: a review is
 * human-readable prose either way, and rejecting the whole batch because one
 * finding invented a severity would throw away the other nine. The two fields that
 * *are* strict — a string summary and an array of findings — are the ones whose
 * absence means the model answered a different question.
 */
export const ReviewOutputSchema = z
  .object({ summary: z.string(), findings: z.array(z.unknown()) })
  .transform(
    (value): ReviewResult => ({
      summary: value.summary,
      findings: value.findings.filter(isRecord).map(toFinding),
      unstructured: false,
    }),
  );

/**
 * The fallback for a reply that is not the requested JSON.
 *
 * Deliberately not an error: a malformed review still reaches the merge request as
 * prose, where a human can read it, instead of the run failing and the work being
 * thrown away. `unstructured` is what tells the note formatter to present it as
 * raw output rather than as findings.
 */
export function unstructuredReview(rawText: string): ReviewResult {
  const text = rawText.trim();
  return {
    summary: text || "(claude returned no output)",
    findings: [],
    unstructured: true,
  };
}

function toFinding(value: Record<string, unknown>): ReviewFinding {
  return {
    severity: isSeverity(value.severity) ? value.severity : "nit",
    file: typeof value.file === "string" ? value.file : "(unknown file)",
    ...(typeof value.line === "number" ? { line: value.line } : {}),
    comment: typeof value.comment === "string" ? value.comment : "",
  };
}

function isSeverity(value: unknown): value is ReviewSeverity {
  return value === "blocker" || value === "warning" || value === "nit";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
