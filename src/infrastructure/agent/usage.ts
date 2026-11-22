import type {
  AgentUsageAuthSource,
  AgentUsageSource,
  AgentUsageStatus,
} from "../../application/ports.ts";
import type { AgentUsageSnapshot } from "./stream.ts";

export interface AgentUsageRecord {
  userId: string;
  accountId?: string;
  accountLabel: string;
  optionId?: string;
  authSource: AgentUsageAuthSource;
  provider: string;
  source: AgentUsageSource;
  executionId?: string;
  invocationLabel?: string;
  status: AgentUsageStatus;
  startedAt: Date;
  finishedAt: Date;
  usage?: AgentUsageSnapshot;
}

export type AgentUsageRecorder = (record: AgentUsageRecord) => void | Promise<void>;

let recorder: AgentUsageRecorder | undefined;

/** Installed by the application composition root; runners remain persistence-agnostic. */
export function setAgentUsageRecorder(next: AgentUsageRecorder | undefined): void {
  recorder = next;
}

export async function recordAgentUsage(record: AgentUsageRecord): Promise<void> {
  await recorder?.(record);
}
