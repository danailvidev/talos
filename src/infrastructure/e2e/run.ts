import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { ConfigError, LlmError } from "../../core/errors.ts";
import { UnresolvedRuntimeError } from "../../core/orchestration.ts";
import { registerSecretValues, type Logger } from "../../logging/logger.ts";
import { acquireAgentCapacity } from "../agent/capacity.ts";
import {
  AGENT_EXECUTION_LABEL,
  AGENT_MANAGED_LABEL,
  agentContainerName,
  agentOrchestrationLabelArgs,
  agentUserArgs,
  stopDockerContainerConfirmed,
  writeSecretFiles,
} from "../agent/containers.ts";
import { AGENT_HOME } from "../agent/image.ts";
import {
  hostClaudeConfigDir,
  resolveAgentRuntimeAuth,
} from "../agent/run.ts";
import { configuredJobExecutor } from "../agent/execution.ts";
import { kubernetesRuntimeId } from "../agent/kubernetes-executor.ts";
import {
  AgentEventAccumulator,
  agentFailureReason,
  agentResultText,
  consumeNdjson,
  modelJsonValues,
  logsFromStreamLine,
} from "../agent/stream.ts";
import { recordAgentUsage } from "../agent/usage.ts";
import { E2E_IMAGE_TAG } from "./image.ts";

export interface E2eBrowserRuntime {
  startUrl: string;
  testTimeoutMs: number;
}

export interface E2eAgentOptions<T> {
  executionId: string;
  project: string;
  branch: string;
  sha: string;
  gitlabApiUrl: string;
  gitlabToken: string;
  runtime: E2eBrowserRuntime;
  /** Placeholder name -> value, consumed only by Playwright MCP's secrets file. */
  playwrightSecrets?: Record<string, string>;
  contextFiles: Record<string, string>;
  artifactDirectory: string;
  prompt: string;
  output: z.ZodType<T>;
  model?: string;
  effort?: string;
  actor?: { id: string; email: string };
  logger?: Logger;
  signal?: AbortSignal;
}

export async function runE2eAgent<T>(options: E2eAgentOptions<T>): Promise<T> {
  // The test budget starts once a slot is granted; time spent queued behind
  // other agents is not the test's to lose.
  const kubernetesExecutor = configuredJobExecutor();
  const runtimeId = kubernetesExecutor
    ? kubernetesRuntimeId("e2e", options.executionId)
    : agentContainerName(options.executionId, "e2e");
  const lease = await acquireAgentCapacity({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.actor ? { actorId: options.actor.id } : {}),
    executionId: options.executionId,
    workloadKind: "e2e",
    runtimeKind: kubernetesExecutor ? "kubernetes" : "docker",
    runtimeId,
  });
  const timeout = AbortSignal.timeout(options.runtime.testTimeoutMs);
  const signal = AbortSignal.any([lease.signal, timeout]);
  let outcome: "succeeded" | "failed" | "cancelled" = "failed";
  if (kubernetesExecutor) {
    try {
      lease.markRunning(runtimeId);
      const result = await runKubernetesE2e(
        options,
        kubernetesExecutor,
        signal,
        timeout,
        lease.attemptId,
        runtimeId,
      );
      outcome = "succeeded";
      return result;
    } catch (cause) {
      if (cause instanceof UnresolvedRuntimeError) {
        lease.retain(cause.message);
      } else if (lease.signal.aborted && !timeout.aborted) {
        outcome = "cancelled";
      }
      throw cause;
    } finally {
      await lease.release(outcome);
    }
  }
  let runtimeDir: string | undefined;
  let contextDir: string | undefined;
  let secretDir: string | undefined;
  try {
    runtimeDir = await mkdtemp(join(tmpdir(), "talos-e2e-runtime-"));
    contextDir = await writeFiles("talos-e2e-context-", options.contextFiles);
    secretDir = await mkdtemp(join(tmpdir(), "talos-e2e-secret-"));
    if (options.playwrightSecrets && Object.keys(options.playwrightSecrets).length > 0) {
      await writeFile(
        join(secretDir, "playwright-secrets.env"),
        dotenv(options.playwrightSecrets),
        { mode: 0o600 },
      );
    }
    registerSecretValues(Object.values(options.playwrightSecrets ?? {}));

    const config = {
      project: options.project,
      branch: options.branch,
      sha: options.sha,
      gitlabApiUrl: options.gitlabApiUrl,
      runtime: options.runtime,
      prompt: options.prompt,
      model: options.model,
      effort: options.effort,
      hasPlaywrightSecrets:
        options.playwrightSecrets != null &&
        Object.keys(options.playwrightSecrets).length > 0,
    };
    await writeFile(join(runtimeDir, "config.json"), JSON.stringify(config), { mode: 0o600 });
    lease.markRunning(runtimeId);
    const result = await runContainer(options, {
      signal,
      timedOut: timeout,
      runtimeDir,
      contextDir,
      secretDir,
      attemptId: lease.attemptId,
    });
    outcome = "succeeded";
    return result;
  } catch (cause) {
    if (cause instanceof UnresolvedRuntimeError) {
      lease.retain(cause.message);
    } else if (lease.signal.aborted && !timeout.aborted) {
      outcome = "cancelled";
    }
    throw cause;
  } finally {
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
    if (contextDir) await rm(contextDir, { recursive: true, force: true });
    if (secretDir) await rm(secretDir, { recursive: true, force: true });
    await lease.release(outcome);
  }
}

async function runKubernetesE2e<T>(
  options: E2eAgentOptions<T>,
  executor: NonNullable<ReturnType<typeof configuredJobExecutor>>,
  signal: AbortSignal,
  timeout: AbortSignal,
  attemptId: string | undefined,
  runtimeId: string,
): Promise<T> {
  const auth = resolveAgentRuntimeAuth("claude", options.actor?.id);
  if (!auth) {
    throw new ConfigError(
      `No connected Claude account for ${options.actor?.email ?? "this run"}; ` +
        "Kubernetes workers cannot use the control-plane host login.",
    );
  }
  registerSecretValues(Object.values(options.playwrightSecrets ?? {}));
  const runtime = {
    project: options.project,
    branch: options.branch,
    sha: options.sha,
    gitlabApiUrl: options.gitlabApiUrl,
    runtime: options.runtime,
    prompt: options.prompt,
    model: options.model,
    effort: options.effort,
    hasPlaywrightSecrets:
      options.playwrightSecrets != null &&
      Object.keys(options.playwrightSecrets).length > 0,
    artifactUpload: process.env.TALOS_ARTIFACT_S3_BUCKET
      ? {
          bucket: process.env.TALOS_ARTIFACT_S3_BUCKET,
          prefix: `${(process.env.TALOS_ARTIFACT_S3_PREFIX ?? "talos/e2e").replace(/\/+$/, "")}/${options.executionId}`,
          region: process.env.AWS_REGION,
        }
      : undefined,
  };
  const files: Record<string, string> = {
    "runtime/config.json": JSON.stringify(runtime),
    "e2e-secrets/gitlab-token": options.gitlabToken,
    ...(Object.keys(auth.env).length
      ? { "e2e-secrets/agent-env.json": JSON.stringify(auth.env) }
      : {}),
    ...(options.playwrightSecrets && Object.keys(options.playwrightSecrets).length
      ? { "e2e-secrets/playwright-secrets.env": dotenv(options.playwrightSecrets) }
      : {}),
  };
  for (const [name, body] of Object.entries(options.contextFiles)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new ConfigError(`Invalid context filename '${name}'.`);
    }
    files[`context/${name}`] = body;
  }

  const events = new AgentEventAccumulator();
  const startedAt = new Date();
  let status: "success" | "failed" | "cancelled" = "failed";
  try {
    const result = await executor.run({
      executionId: options.executionId,
      attemptId,
      runtimeId,
      name: "e2e",
      image: process.env.TALOS_E2E_IMAGE!,
      timeoutMs: options.runtime.testTimeoutMs,
      signal,
      logger: options.logger,
      env: { HOME: AGENT_HOME },
      files,
      secrets: [
        options.gitlabToken,
        ...Object.values(options.playwrightSecrets ?? {}),
        ...Object.values(auth.env),
      ],
      onStdoutLine: (line) => {
        const parsed = tryJson(line);
        if (parsed) events.add(parsed);
        for (const log of logsFromStreamLine(line)) {
          const write = log.level === "error"
            ? options.logger?.error
            : log.level === "warn"
              ? options.logger?.warn
              : options.logger?.info;
          write?.call(options.logger, { agent: "claude", e2e: true, kubernetes: true, ...log.meta }, log.message);
        }
      },
    });
    if (result.exitCode !== 0) {
      throw failure(options, events, result.stderr, timeout.aborted, options.signal?.aborted);
    }
    const parsed = parseE2eResult(options, events);
    status = "success";
    return parsed;
  } catch (cause) {
    status = options.signal?.aborted && !timeout.aborted ? "cancelled" : "failed";
    if (cause instanceof LlmError) throw cause;
    throw failure(options, events, "", timeout.aborted, options.signal?.aborted, cause);
  } finally {
    await recordE2eInvocation(options, auth, events, startedAt, status);
  }
}

async function runContainer<T>(
  options: E2eAgentOptions<T>,
  paths: {
    signal: AbortSignal;
    timedOut: AbortSignal;
    runtimeDir: string;
    contextDir: string;
    secretDir: string;
    attemptId?: string;
  },
): Promise<T> {
  const auth = resolveAgentRuntimeAuth("claude", options.actor?.id);
  const claudeDir = auth?.homeDir ?? (auth ? undefined : hostClaudeConfigDir());
  const claudeJson = auth ? undefined : join(homedir(), ".claude.json");
  if (!auth && claudeDir && !existsSync(claudeDir)) {
    throw new ConfigError(
      `No Claude credentials for ${options.actor?.email ?? "this run"}; connect an account in Settings -> Agent connections.`,
    );
  }
  const limits = resourceLimits();
  const containerName = agentContainerName(options.executionId, "e2e");
  await writeSecretFiles(paths.secretDir, {
    "gitlab-token": options.gitlabToken,
    ...(auth && Object.keys(auth.env).length > 0
      ? { "agent-env.json": JSON.stringify(auth.env) }
      : {}),
  });
  const args = [
    "docker", "run", "--rm",
    "--name", containerName,
    ...e2eDockerNetworkArgs(),
    "--label", `${AGENT_MANAGED_LABEL}=1`,
    "--label", `${AGENT_EXECUTION_LABEL}=${options.executionId}`,
    ...agentOrchestrationLabelArgs(paths.attemptId),
    ...agentUserArgs(),
    "--pids-limit", String(limits.pids),
    "--memory", limits.memory,
    "--cpus", String(limits.cpus),
    "--shm-size", limits.shm,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    ...(claudeDir ? ["-v", `${claudeDir}:${AGENT_HOME}/.claude:ro`] : []),
    ...(claudeJson && existsSync(claudeJson)
      ? ["-v", `${claudeJson}:${AGENT_HOME}/.claude.json:ro`]
      : []),
    "-v", `${paths.runtimeDir}:/run/talos:rw`,
    "-v", `${paths.secretDir}:/run/talos-secret:rw`,
    "-v", `${paths.contextDir}:/mr-input:ro`,
    "-v", `${options.artifactDirectory}:/artifacts:rw`,
    E2E_IMAGE_TAG,
  ];

  options.logger?.info(
    {
      project: options.project,
      branch: options.branch,
      sha: options.sha,
      startUrl: options.runtime.startUrl,
      agentAccount: auth?.label ?? "this host's own login",
    },
    `starting QA E2E container for ${options.project}@${options.branch}`,
  );

  const events = new AgentEventAccumulator();
  const startedAt = new Date();
  let status: "success" | "failed" | "cancelled" = "failed";
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: paths.signal });
  const stop = () => stopDockerContainerConfirmed(containerName);
  const kill = () => void stop();
  if (paths.signal.aborted) kill();
  else paths.signal.addEventListener("abort", kill, { once: true });
  let stderr = "";
  try {
    const [exitCode, , errorText] = await Promise.all([
      proc.exited,
      consumeNdjson(proc.stdout, (line) => {
        const parsed = tryJson(line);
        if (parsed) events.add(parsed);
        for (const log of logsFromStreamLine(line)) {
          const write = log.level === "error"
            ? options.logger?.error
            : log.level === "warn"
              ? options.logger?.warn
              : options.logger?.info;
          write?.call(options.logger, { agent: "claude", e2e: true, ...log.meta }, log.message);
        }
      }),
      new Response(proc.stderr).text(),
    ]);
    stderr = redact(
      errorText.slice(-256 * 1024),
      [options.gitlabToken, ...Object.values(options.playwrightSecrets ?? {})],
    );
    if (exitCode !== 0) {
      throw failure(options, events, stderr, paths.timedOut.aborted, options.signal?.aborted);
    }
    const parsed = parseE2eResult(options, events);
    status = "success";
    return parsed;
  } catch (error) {
    if (!await stop()) {
      throw new UnresolvedRuntimeError(
        `Docker container ${containerName} could not be confirmed stopped`,
        { cause: error },
      );
    }
    status = options.signal?.aborted && !paths.timedOut.aborted ? "cancelled" : "failed";
    if (error instanceof LlmError) throw error;
    throw failure(options, events, stderr, paths.timedOut.aborted, options.signal?.aborted, error);
  } finally {
    paths.signal.removeEventListener("abort", kill);
    await recordE2eInvocation(options, auth, events, startedAt, status);
  }
}

/**
 * QA portals are private and reached through the Talos host's VPN. The default
 * bridge network keeps the container out of the host's network namespace; some
 * corporate VPN clients block bridge forwarding, and `TALOS_E2E_NETWORK=host`
 * shares the host's routes and split DNS instead.
 */
export function e2eDockerNetworkArgs(
  mode: string | undefined = Bun.env.TALOS_E2E_NETWORK,
): string[] {
  const value = mode?.trim() ?? "";
  if (value === "") return [];
  if (value === "host") return ["--network", "host"];
  throw new ConfigError(`TALOS_E2E_NETWORK must be 'host' or unset, not '${value}'.`);
}

function failure(
  options: E2eAgentOptions<unknown>,
  events: AgentEventAccumulator,
  stderr: string,
  timedOut: boolean,
  cancelled = false,
  cause?: unknown,
): LlmError {
  const reason = agentFailureReason(events.snapshot());
  const details = [reason, stderr.trim(), cause instanceof Error ? cause.message : undefined]
    .filter(Boolean)
    .join("; ");
  const accessDenied = isE2eAccessDenied(details);
  return new LlmError(
    timedOut
      ? `QA E2E run timed out after ${Math.round(options.runtime.testTimeoutMs / 60_000)} minutes`
      : cancelled
        ? "QA E2E run was cancelled"
        : `QA E2E container failed${details ? `: ${details}` : ""}`,
    { provider: "claude", retryable: false, terminal: accessDenied, cause },
  );
}

function parseE2eResult<T>(options: E2eAgentOptions<T>, events: AgentEventAccumulator): T {
  const raw = agentResultText(events.snapshot());
  if (!raw) throw new LlmError("E2E agent returned no structured result", { provider: "claude" });
  const values = modelJsonValues(raw);
  if (values.length === 0) {
    throw new LlmError("E2E agent returned invalid JSON", { provider: "claude" });
  }
  let schemaError: string | undefined;
  for (const json of values) {
    const parsed = options.output.safeParse(json);
    if (parsed.success) return parsed.data;
    schemaError = parsed.error.message;
  }
  throw new LlmError(`E2E agent returned an invalid result: ${schemaError}`, {
    provider: "claude",
  });
}

async function recordE2eInvocation(
  options: E2eAgentOptions<unknown>,
  auth: ReturnType<typeof resolveAgentRuntimeAuth>,
  events: AgentEventAccumulator,
  startedAt: Date,
  status: "success" | "failed" | "cancelled",
): Promise<void> {
  if (!options.actor) return;
  const usage = events.usage();
  try {
    await recordAgentUsage({
      userId: options.actor.id,
      ...(auth ? { accountId: auth.id, optionId: auth.optionId } : {}),
      accountLabel: auth?.label ?? "Host Claude runtime",
      authSource: auth ? "connected" : "host",
      provider: "claude",
      source: "e2e",
      executionId: options.executionId,
      invocationLabel: "e2e",
      status,
      startedAt,
      finishedAt: new Date(),
      ...(usage ? { usage } : {}),
    });
  } catch (cause) {
    options.logger?.warn({ cause, agent: "claude" }, "could not record E2E agent usage");
  }
}

export function isE2eAccessDenied(details: string): boolean {
  return /(?:HTTP|error:)\s+(?:401|403|406)\b/i.test(details);
}

async function writeFiles(prefix: string, files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all(
    Object.entries(files).map(([name, body]) => {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new ConfigError(`Invalid context filename '${name}'.`);
      return writeFile(join(directory, name), body, "utf8");
    }),
  );
  return directory;
}

function tryJson(line: string): unknown {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resourceLimits(): { memory: string; cpus: number; pids: number; shm: string } {
  const memory = Bun.env.TALOS_E2E_MEMORY?.trim() || "4g";
  const shm = Bun.env.TALOS_E2E_SHM?.trim() || "1g";
  const cpus = Number(Bun.env.TALOS_E2E_CPUS ?? 2);
  const pids = Number(Bun.env.TALOS_E2E_PIDS ?? 1024);
  if (!/^\d+(?:\.\d+)?[bkmg]$/i.test(memory) || !/^\d+(?:\.\d+)?[bkmg]$/i.test(shm)) {
    throw new ConfigError("TALOS_E2E_MEMORY and TALOS_E2E_SHM must be Docker sizes such as 4g.");
  }
  if (!Number.isFinite(cpus) || cpus <= 0 || !Number.isInteger(pids) || pids < 64) {
    throw new ConfigError("Invalid TALOS_E2E_CPUS or TALOS_E2E_PIDS resource limit.");
  }
  return { memory, cpus, pids, shm };
}

function dotenv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n") + "\n";
}

function redact(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) {
    if (secret) clean = clean.split(secret).join("[redacted]");
  }
  return clean;
}
