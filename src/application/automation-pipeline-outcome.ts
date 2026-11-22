import type { AutomationPipelineSnapshot } from "./ports.ts";

export type AutomationPipelineOutcome =
  | "passed"
  | "test-failed"
  | "infrastructure-failed"
  | "running"
  | "canceled-skipped"
  | "report-missing"
  | "report-error";

export const AUTOMATION_RUNNING_STATUSES = new Set([
  "created",
  "waiting_for_resource",
  "waiting_for_callback",
  "preparing",
  "pending",
  "running",
  "manual",
  "scheduled",
]);

const CANCELED_STATUSES = new Set(["canceled", "canceling", "skipped"]);

/**
 * Product-level result independent of dashboard filtering. Report collection
 * failures remain distinct from GitLab infrastructure failures.
 */
export function automationPipelineOutcome(
  pipeline: AutomationPipelineSnapshot,
): AutomationPipelineOutcome {
  if (AUTOMATION_RUNNING_STATUSES.has(pipeline.status)) return "running";
  if (CANCELED_STATUSES.has(pipeline.status)) return "canceled-skipped";
  if (pipeline.reportState === "error") return "report-error";
  if (pipeline.reportState === "missing" || pipeline.reportState === "pending") {
    return "report-missing";
  }
  if (
    pipeline.report &&
    pipeline.report.failedCount + pipeline.report.errorCount > 0
  ) {
    return "test-failed";
  }
  if (pipeline.status === "failed") return "infrastructure-failed";
  if (pipeline.status === "success" && pipeline.reportState === "complete") {
    return "passed";
  }
  return "report-missing";
}
