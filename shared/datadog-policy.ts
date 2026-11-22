/**
 * Operator-visible Datadog regression policy.
 *
 * Backend decisions and the Settings explanation both import these values so a
 * threshold change cannot silently leave the UI documentation behind.
 */
export const DATADOG_REGRESSION_POLICY = {
  environment: "prod",
  staleAfterDays: 7,
  confirmationMinHours: 12,
  confirmationMaxHours: 36,
  historicalScanCount: 2,
  criticalGrowthRatio: 3,
  highGrowthRatio: 1.5,
  lowGrowthRatio: 0.8,
  maxGroupingTokenSpread: 3,
  criticalStatuses: ["emergency", "alert", "critical", "crit", "fatal"],
  softStatuses: ["warn", "warning", "notice", "info", "debug", "ok"],
  immediateSeverities: ["critical", "high"],
} as const;

export function isImmediateDatadogSeverity(severity: string): boolean {
  return (DATADOG_REGRESSION_POLICY.immediateSeverities as readonly string[]).includes(
    severity,
  );
}
