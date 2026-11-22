/**
 * One containerized Claude agent, however it is being used.
 *
 * `docker-review.ts` and `mr-follow-up-agent.ts` used to live side by side here:
 * two Dockerfiles, two entrypoints, two `docker run` argv builders, two copies of
 * NDJSON consumption, redaction and cleanup. The only real differences were which
 * tools Claude could call and what happened to its edits — both now parameters of
 * `runAgentJob`. See `WritePolicy`.
 */

export {
  AGENT_ENTRYPOINT_SH,
  AGENT_IMAGE_TAG,
  BRANCH_MOVED_EXIT_CODE,
  ensureAgentImage,
  requireDocker,
} from "./image.ts";

export {
  AGENT_PROVIDERS,
  detectAgents,
  type AgentProvider,
  type DetectedAgent,
} from "./detect.ts";

export {
  AGENT_EXECUTION_LABEL,
  AGENT_ATTEMPT_LABEL,
  AGENT_INSTALLATION_LABEL,
  AGENT_MANAGED_LABEL,
  agentContainerFailure,
  agentContainerName,
  configureAgentInstallation,
  DockerAgentRuntime,
  stopAgentContainers,
} from "./containers.ts";

export {
  agentFailureReason,
  agentResultText,
  extractJsonBlock,
  isCredentialFailure,
  logsFromStreamLine,
  pushOutcome,
  type PushOutcome,
  type StreamLog,
} from "./stream.ts";

export {
  claudeCliFlags,
  DEFAULT_AGENT_TIMEOUT_MS,
  runAgentJob,
  type AgentCommit,
  type AgentJobOptions,
  type AgentJobResult,
  type AgentWorkspace,
  type WritePolicy,
} from "./run.ts";

export { setAgentWorkspaceCache } from "./cache.ts";
export {
  HostProcessRuntime,
  hostProcessMarker,
  hostProcessRuntimeId,
} from "./host-runtime.ts";

export {
  activeAgentJobs,
  agentCapacitySnapshot,
  agentResourceLimits,
  configureAgentHostCapacity,
  setAgentConcurrency,
  setAgentResourceLimits,
  setInteractiveAgentReserve,
  waitingAgentJobs,
  type AgentResourceLimits,
} from "./capacity.ts";
