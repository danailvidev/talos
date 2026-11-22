import {
  createKubernetesJobClient,
  KubernetesApiError,
  type KubernetesJobClient,
  type KubernetesPod,
} from "../../connectors/kubernetes/client.ts";
import { createHash } from "node:crypto";
import type { KubernetesRuntimeConfig } from "../../config/runtime.ts";
import { ConfigError } from "../../core/errors.ts";
import type {
  AgentRuntimeLifecycle,
  ManagedRuntimeResource,
  RuntimePresence,
} from "../../core/orchestration.ts";
import { UnresolvedRuntimeError } from "../../core/orchestration.ts";
import {
  AGENT_ATTEMPT_LABEL,
  AGENT_EXECUTION_LABEL,
  AGENT_INSTALLATION_LABEL,
  AGENT_MANAGED_LABEL,
  agentInstallationId,
} from "./containers.ts";
import type {
  JobExecutionRequest,
  JobExecutionResult,
  JobExecutor,
} from "./execution.ts";

export class KubernetesJobExecutor implements JobExecutor, AgentRuntimeLifecycle {
  readonly kind = "kubernetes" as const;
  private readonly active = new Map<string, string>();

  constructor(
    private readonly config: KubernetesRuntimeConfig,
    private readonly client: KubernetesJobClient = createKubernetesJobClient(),
  ) {}

  async run(request: JobExecutionRequest): Promise<JobExecutionResult> {
    const name = request.runtimeId ?? kubernetesJobName(request.name, request.executionId);
    const secretName = `${name}-input`;
    this.active.set(request.executionId, name);
    const payload = serializeFiles(request.files);
    const manifest = buildKubernetesJobManifest(this.config, request, name, secretName);

    try {
      // Create the Job first so its immutable UID can own the input Secret.
      // A Pod waits while the referenced Secret is absent; once the Secret is
      // created, kubelet starts it normally. If this process crashes later,
      // Kubernetes garbage-collects the credential-bearing Secret with the Job.
      const job = await this.client.createJob(this.config.namespace, manifest);
      const jobUid = job.metadata?.uid;
      if (!jobUid) {
        throw new ConfigError(`Kubernetes did not return a UID for worker Job ${name}.`);
      }
      await this.client.createSecret(this.config.namespace, {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: secretName,
          labels: labels(request.executionId, request.attemptId),
          ownerReferences: [{
            apiVersion: "batch/v1",
            kind: "Job",
            name,
            uid: jobUid,
            controller: true,
            blockOwnerDeletion: false,
          }],
        },
        type: "Opaque",
        data: { "payload.json": Buffer.from(payload).toString("base64") },
      });
      request.logger?.info(
        { namespace: this.config.namespace, job: name, image: request.image },
        "started Kubernetes worker Job",
      );
      return await this.waitForCompletion(name, request);
    } finally {
      this.active.delete(request.executionId);
      const stopped = await this.stop(name);
      await this.bestEffort(() => this.client.deleteSecret(this.config.namespace, secretName));
      if (!stopped) {
        throw new UnresolvedRuntimeError(
          `Kubernetes Job ${name} could not be confirmed stopped`,
        );
      }
    }
  }

  async cancel(executionId: string): Promise<void> {
    const job = this.active.get(executionId);
    if (job) await this.bestEffort(() => this.client.deleteJob(this.config.namespace, job));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
  }

  async inspect(id: string): Promise<RuntimePresence> {
    try {
      const job = await this.client.readJob(this.config.namespace, id);
      if ((job.status?.succeeded ?? 0) > 0 || (job.status?.failed ?? 0) > 0) {
        return "stopped";
      }
      return "running";
    } catch (cause) {
      if (cause instanceof KubernetesApiError && cause.statusCode === 404) return "missing";
      return "unknown";
    }
  }

  async list(installationId: string): Promise<ManagedRuntimeResource[]> {
    const jobs = await this.client.listJobs(
      this.config.namespace,
      `${AGENT_MANAGED_LABEL}=true,${AGENT_INSTALLATION_LABEL}=${installationId}`,
    );
    return managedJobs(jobs.items);
  }

  async listUnscoped(): Promise<ManagedRuntimeResource[]> {
    const jobs = await this.client.listJobs(
      this.config.namespace,
      `${AGENT_MANAGED_LABEL}=true`,
    );
    return managedJobs(
      jobs.items.filter((job) => !job.metadata?.labels?.[AGENT_INSTALLATION_LABEL]),
    );
  }

  async stop(id: string): Promise<boolean> {
    const before = await this.inspect(id);
    if (before === "missing") return true;
    if (before === "unknown") return false;
    try {
      await this.client.deleteJob(this.config.namespace, id);
    } catch (cause) {
      if (!(cause instanceof KubernetesApiError && cause.statusCode === 404)) return false;
    }
    return await this.inspect(id) === "missing";
  }

  private async waitForCompletion(
    name: string,
    request: JobExecutionRequest,
  ): Promise<JobExecutionResult> {
    const started = Date.now();
    let consumed = 0;
    let pending = "";
    let podName: string | undefined;

    while (Date.now() - started <= request.timeoutMs) {
      if (request.signal?.aborted) {
        await this.cancel(request.executionId);
        throw request.signal.reason instanceof Error
          ? request.signal.reason
          : new Error("Kubernetes Job was cancelled.");
      }

      if (!podName) {
        const pods = await this.client.listPods(
          this.config.namespace,
          `job-name=${name}`,
        );
        podName = pods.items[0]?.metadata?.name;
      }
      if (podName) {
        const logs = await this.client.readPodLog(this.config.namespace, podName).catch(() => "");
        if (logs.length < consumed) consumed = 0;
        const fresh = pending + logs.slice(consumed);
        consumed = logs.length;
        const lines = fresh.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line) request.onStdoutLine(redact(line, request.secrets));
        }
      }

      const job = await this.client.readJob(this.config.namespace, name);
      if ((job.status?.succeeded ?? 0) > 0) {
        if (pending) request.onStdoutLine(redact(pending, request.secrets));
        return { exitCode: 0, stderr: "" };
      }
      if ((job.status?.failed ?? 0) > 0) {
        const pods = await this.client.listPods(this.config.namespace, `job-name=${name}`);
        const terminated = workerTermination(pods.items[0]);
        return {
          exitCode: terminated?.exitCode ?? 1,
          stderr: redact(
            terminated?.message ?? terminated?.reason ?? "Kubernetes worker Job failed.",
            request.secrets,
          ),
        };
      }
      await abortableDelay(this.config.pollIntervalMs, request.signal);
    }

    await this.cancel(request.executionId);
    throw new Error(`Kubernetes Job ${name} timed out after ${request.timeoutMs}ms.`);
  }

  private async bestEffort(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch {
      // Cleanup is idempotent and must not replace the worker's actual outcome.
    }
  }
}

export function buildKubernetesJobManifest(
  config: KubernetesRuntimeConfig,
  request: Pick<
    JobExecutionRequest,
    "executionId" | "attemptId" | "image" | "timeoutMs" | "env" | "command" | "args"
  >,
  name: string,
  secretName: string,
): Record<string, unknown> {
  const workVolume = { name: "work", emptyDir: {} };
  const payloadVolume = {
    name: "payload",
    secret: { secretName, defaultMode: 0o440 },
  };
  const mounts = [
    { name: "work", mountPath: "/run/talos-secrets", subPath: "agent-secrets" },
    { name: "work", mountPath: "/run/talos-secret", subPath: "e2e-secrets" },
    { name: "work", mountPath: "/run/talos", subPath: "runtime" },
    { name: "work", mountPath: "/mr-input", subPath: "context", readOnly: true },
    { name: "work", mountPath: "/home/talos/.claude/skills", subPath: "skills", readOnly: true },
    { name: "work", mountPath: "/artifacts", subPath: "artifacts" },
    { name: "work", mountPath: "/workspace", subPath: "workspace" },
    { name: "work", mountPath: "/home/talos", subPath: "home" },
    { name: "work", mountPath: "/tmp", subPath: "tmp" },
  ];
  const activeDeadlineSeconds = Math.max(1, Math.ceil(request.timeoutMs / 1000));

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, labels: labels(request.executionId, request.attemptId) },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: config.jobTtlSeconds,
      activeDeadlineSeconds,
      template: {
        metadata: { labels: labels(request.executionId, request.attemptId) },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: config.workerServiceAccount,
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          volumes: [workVolume, payloadVolume],
          initContainers: [
            {
              name: "materialize-input",
              image: request.image,
              command: [
                "node",
                "-e",
                materializeScript(),
              ],
              volumeMounts: [
                { name: "payload", mountPath: "/input", readOnly: true },
                { name: "work", mountPath: "/work" },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
          containers: [
            {
              name: "worker",
              image: request.image,
              imagePullPolicy: "IfNotPresent",
              ...(request.command?.length ? { command: request.command } : {}),
              ...(request.args?.length ? { args: request.args } : {}),
              env: Object.entries(request.env).map(([name, value]) => ({ name, value })),
              volumeMounts: mounts,
              resources: {
                requests: {
                  cpu: config.cpuRequest,
                  memory: config.memoryRequest,
                },
                limits: {
                  cpu: config.cpuLimit,
                  memory: config.memoryLimit,
                },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
        },
      },
    },
  };
}

function serializeFiles(files: Record<string, string>): string {
  for (const path of Object.keys(files)) {
    if (!/^(agent-secrets|e2e-secrets|runtime|context|skills|artifacts)\/[a-zA-Z0-9_./-]+$/.test(path)
      || path.includes("..")) {
      throw new ConfigError(`Unsafe Kubernetes worker input path '${path}'.`);
    }
  }
  return JSON.stringify(files);
}

function materializeScript(): string {
  return [
    'const fs=require("fs"),p=require("path");',
    'for(const dir of ["agent-secrets","e2e-secrets","runtime","context","skills","artifacts","workspace","home","tmp"])',
    'fs.mkdirSync(p.join("/work",dir),{recursive:true});',
    'const files=JSON.parse(fs.readFileSync("/input/payload.json","utf8"));',
    'for(const [name,body] of Object.entries(files)){',
    'const out=p.join("/work",name);fs.mkdirSync(p.dirname(out),{recursive:true});',
    'fs.writeFileSync(out,String(body),{mode:name.includes("secrets/")?0o600:0o644});}',
  ].join("");
}

function labels(executionId: string, attemptId?: string): Record<string, string> {
  return {
    [AGENT_MANAGED_LABEL]: "true",
    [AGENT_EXECUTION_LABEL]: labelValue(executionId),
    ...(attemptId ? { [AGENT_ATTEMPT_LABEL]: labelValue(attemptId) } : {}),
    ...(agentInstallationId()
      ? { [AGENT_INSTALLATION_LABEL]: labelValue(agentInstallationId()!) }
      : {}),
  };
}

function labelValue(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
  return (safe || "run").slice(0, 63);
}

export function kubernetesRuntimeId(kind: string, executionId: string): string {
  const value = `talos-${kind}-${executionId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const digest = createHash("sha256").update(`${kind}\0${executionId}`).digest("hex").slice(0, 10);
  return `${value.slice(0, 51).replace(/-$/, "")}-${digest}`;
}

const kubernetesJobName = kubernetesRuntimeId;

function workerTermination(pod: KubernetesPod | undefined) {
  return pod?.status?.containerStatuses
    ?.find((status) => status.name === "worker")
    ?.state?.terminated;
}

function managedJobs(
  jobs: Array<Awaited<ReturnType<KubernetesJobClient["createJob"]>>>,
): ManagedRuntimeResource[] {
  return jobs.flatMap((job) => {
    const id = job.metadata?.name;
    if (!id) return [];
    const jobLabels = job.metadata?.labels ?? {};
    return [{
      kind: "kubernetes" as const,
      id,
      presence:
        (job.status?.succeeded ?? 0) > 0 || (job.status?.failed ?? 0) > 0
          ? "stopped" as const
          : "running" as const,
      ...(jobLabels[AGENT_ATTEMPT_LABEL]
        ? { attemptId: jobLabels[AGENT_ATTEMPT_LABEL] }
        : {}),
      ...(jobLabels[AGENT_EXECUTION_LABEL]
        ? { executionId: jobLabels[AGENT_EXECUTION_LABEL] }
        : {}),
    }];
  });
}

function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
