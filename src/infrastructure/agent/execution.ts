import type { Logger } from "../../logging/logger.ts";

export interface JobExecutionRequest {
  executionId: string;
  attemptId?: string;
  /** Stable resource identity persisted before creation. */
  runtimeId?: string;
  name: string;
  image: string;
  timeoutMs: number;
  env: Record<string, string>;
  command?: string[];
  args?: string[];
  files: Record<string, string>;
  secrets: readonly string[];
  logger?: Logger;
  signal?: AbortSignal;
  onStdoutLine(line: string): void;
}

export interface JobExecutionResult {
  exitCode: number;
  stderr: string;
}

export interface JobExecutor {
  run(request: JobExecutionRequest): Promise<JobExecutionResult>;
  cancel(executionId: string): Promise<void>;
  shutdown(): Promise<void>;
}

let executor: JobExecutor | undefined;

export function configureJobExecutor(value: JobExecutor | undefined): void {
  executor = value;
}

export function configuredJobExecutor(): JobExecutor | undefined {
  return executor;
}

export async function cancelConfiguredJob(executionId: string): Promise<void> {
  await executor?.cancel(executionId);
}

export async function shutdownConfiguredJobs(): Promise<void> {
  await executor?.shutdown();
}
