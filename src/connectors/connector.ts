/**
 * What every connector owes the platform beyond its own API surface.
 *
 * `check()` exists so `talos connector test <name>` can answer the question
 * an operator actually has — "are my credentials and ids right?" — before a
 * task runs at 3am and fails on ticket creation. It never mutates.
 */
export interface Connector {
  readonly name: string;
  check(options?: { signal?: AbortSignal }): Promise<HealthReport>;
}

export interface HealthCheck {
  /** Short label, e.g. "authentication" or "project access". */
  name: string;
  ok: boolean;
  /** One-line result: the resolved identity, the failure reason, or a hint. */
  detail: string;
  /**
   * Extra lines an operator may need to copy into config — Jira issue type ids,
   * account ids. Printed indented under the check.
   */
  values?: string[];
}

export interface HealthReport {
  connector: string;
  ok: boolean;
  checks: HealthCheck[];
}

export function report(connector: string, checks: HealthCheck[]): HealthReport {
  return { connector, ok: checks.every((c) => c.ok), checks };
}

/**
 * Runs one check, turning a thrown error into a failed check rather than
 * aborting the report. An operator with a bad token and a bad project id should
 * learn both in one run.
 */
export async function runCheck(
  name: string,
  fn: () => Promise<Omit<HealthCheck, "name" | "ok"> & { ok?: boolean }>,
): Promise<HealthCheck> {
  try {
    const result = await fn();
    return { name, ok: result.ok ?? true, detail: result.detail, values: result.values };
  } catch (err) {
    return {
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
