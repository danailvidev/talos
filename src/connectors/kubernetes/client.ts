import {
  KubeConfig,
  type V1Deployment,
  type V1Pod,
  type V1ReplicaSet,
} from "@kubernetes/client-node";
import type { RequestOptions } from "node:https";

import type {
  DeploymentTargetStatus,
  DeploymentVerifier,
  ReleaseDeploymentTarget,
} from "../../application/ports.ts";

export interface KubernetesClients {
  apps: {
    listNamespacedReplicaSet(input: {
      namespace: string;
    }): Promise<{ items: V1ReplicaSet[] }>;
    readNamespacedDeployment(input: {
      name: string;
      namespace: string;
    }): Promise<V1Deployment>;
  };
  core: {
    listNamespacedPod(input: { namespace: string }): Promise<{ items: V1Pod[] }>;
  };
}

/**
 * Uses the pod's ServiceAccount in Kubernetes and the host's kubeconfig
 * everywhere else. Client creation is lazy so a host without Kubernetes access
 * stays healthy and reports "unavailable" instead of preventing server startup.
 */
export class KubernetesDeploymentVerifier implements DeploymentVerifier {
  private clients?: KubernetesClients;

  constructor(clients?: KubernetesClients) {
    this.clients = clients;
  }

  async verify(
    environment: string,
    targets: readonly ReleaseDeploymentTarget[],
    signal?: AbortSignal,
  ): Promise<DeploymentTargetStatus[]> {
    const namespace = environment.trim().toLowerCase();
    try {
      const clients = this.getClients();
      const replicaSets = await abortable(
        clients.apps.listNamespacedReplicaSet({ namespace }),
        signal,
      );
      const pods = await abortable(
        clients.core.listNamespacedPod({ namespace }),
        signal,
      );
      return Promise.all(
        targets.map(async (target) => {
          try {
            const deployment = await abortable(
              clients.apps.readNamespacedDeployment({
                name: target.service,
                namespace,
              }),
              signal,
            );
            return evaluateDeployment(
              target,
              deployment,
              replicaSets.items,
              pods.items,
            );
          } catch (error) {
            if (signal?.aborted) throw abortReason(signal);
            if (statusCodeOf(error) === 404) {
              return emptyStatus(
                target,
                "missing",
                `Deployment ${namespace}/${target.service} was not found.`,
              );
            }
            return emptyStatus(target, "unavailable", messageOf(error));
          }
        }),
      );
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      return targets.map((target) =>
        emptyStatus(
          target,
          "unavailable",
          `Could not read Kubernetes namespace ${namespace}: ${messageOf(error)}`,
        ),
      );
    }
  }

  private getClients(): KubernetesClients {
    if (this.clients) return this.clients;
    const config = loadRuntimeKubeConfig();
    this.clients = createKubernetesClients(config);
    return this.clients;
  }
}

export function createKubernetesDeploymentVerifier(): DeploymentVerifier {
  return new KubernetesDeploymentVerifier();
}

/**
 * An explicit KUBECONFIG wins even inside Kubernetes. Otherwise the in-cluster
 * identity is preferred when Kubernetes injects its API coordinates; on a host,
 * loadFromDefault follows kubectl's KUBECONFIG/~/.kube/config convention,
 * including exec authentication such as `aws eks get-token`.
 */
export function loadRuntimeKubeConfig(
  config = new KubeConfig(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): KubeConfig {
  const explicitKubeconfig = Boolean(env.KUBECONFIG?.trim());
  const hasInClusterApi =
    Boolean(env.KUBERNETES_SERVICE_HOST?.trim()) &&
    Boolean(env.KUBERNETES_SERVICE_PORT?.trim());
  if (!explicitKubeconfig && hasInClusterApi) {
    config.loadFromCluster();
  } else {
    config.loadFromDefault();
  }
  return config;
}

/**
 * The generated client uses an Undici dispatcher for kubeconfig CAs. Bun's
 * fetch does not apply that dispatcher, so EKS certificates fail validation
 * even though kubectl and Node accept the same kubeconfig. These small adapters
 * pass the CA through Bun's native fetch TLS option and keep authentication,
 * including refreshed exec tokens, delegated to KubeConfig.
 */
export function createKubernetesClients(
  config: KubeConfig,
  fetcher: typeof fetch = fetch,
): KubernetesClients {
  const request = new KubeConfigJsonClient(config, fetcher);
  return {
    apps: {
      listNamespacedReplicaSet: ({ namespace }: { namespace: string }) =>
        request.get(`/apis/apps/v1/namespaces/${segment(namespace)}/replicasets`),
      readNamespacedDeployment: (
        { name, namespace }: { name: string; namespace: string },
      ) =>
        request.get(
          `/apis/apps/v1/namespaces/${segment(namespace)}/deployments/${segment(name)}`,
        ),
    },
    core: {
      listNamespacedPod: ({ namespace }: { namespace: string }) =>
        request.get(`/api/v1/namespaces/${segment(namespace)}/pods`),
    },
  };
}

export interface KubernetesJobClient {
  createSecret(namespace: string, manifest: unknown): Promise<unknown>;
  createJob(namespace: string, manifest: unknown): Promise<KubernetesJob>;
  listJobs(namespace: string, labelSelector: string): Promise<{ items: KubernetesJob[] }>;
  listPods(namespace: string, labelSelector: string): Promise<{ items: KubernetesPod[] }>;
  readPodLog(namespace: string, pod: string): Promise<string>;
  readJob(namespace: string, name: string): Promise<KubernetesJob>;
  deleteJob(namespace: string, name: string): Promise<void>;
  deleteSecret(namespace: string, name: string): Promise<void>;
}

export interface KubernetesPod {
  metadata?: { name?: string };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      state?: { terminated?: { exitCode?: number; reason?: string; message?: string } };
    }>;
  };
}

export interface KubernetesJob {
  metadata?: {
    name?: string;
    uid?: string;
    labels?: Record<string, string>;
  };
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
}

export function createKubernetesJobClient(
  config: KubeConfig = loadRuntimeKubeConfig(),
  fetcher: typeof fetch = fetch,
): KubernetesJobClient {
  const request = new KubeConfigJsonClient(config, fetcher);
  return {
    createSecret: (namespace, manifest) =>
      request.post(`/api/v1/namespaces/${segment(namespace)}/secrets`, manifest),
    createJob: (namespace, manifest) =>
      request.post(`/apis/batch/v1/namespaces/${segment(namespace)}/jobs`, manifest),
    listJobs: (namespace, labelSelector) =>
      request.get(
        `/apis/batch/v1/namespaces/${segment(namespace)}/jobs?labelSelector=${encodeURIComponent(labelSelector)}`,
      ),
    listPods: (namespace, labelSelector) =>
      request.get(
        `/api/v1/namespaces/${segment(namespace)}/pods?labelSelector=${encodeURIComponent(labelSelector)}`,
      ),
    readPodLog: (namespace, pod) =>
      request.text(`/api/v1/namespaces/${segment(namespace)}/pods/${segment(pod)}/log?container=worker`),
    readJob: (namespace, name) =>
      request.get(`/apis/batch/v1/namespaces/${segment(namespace)}/jobs/${segment(name)}`),
    deleteJob: (namespace, name) =>
      request.delete(`/apis/batch/v1/namespaces/${segment(namespace)}/jobs/${segment(name)}?propagationPolicy=Background`),
    deleteSecret: (namespace, name) =>
      request.delete(`/api/v1/namespaces/${segment(namespace)}/secrets/${segment(name)}`),
  };
}

export class KubeConfigJsonClient {
  constructor(
    private readonly config: KubeConfig,
    private readonly fetcher: typeof fetch,
  ) {}

  async get<T>(path: string): Promise<T> {
    return this.json<T>("GET", path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>("POST", path, body);
  }

  async delete(path: string): Promise<void> {
    await this.json("DELETE", path);
  }

  async text(path: string): Promise<string> {
    const response = await this.fetchResponse("GET", path);
    const text = await response.text();
    if (!response.ok) throw apiError(response.status, text);
    return text;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchResponse(method, path, body);
    const text = await response.text();
    const parsed = text ? safeJson(text) : {};
    if (!response.ok) {
      const message =
        parsed != null &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).message === "string"
          ? String((parsed as Record<string, unknown>).message)
          : `Kubernetes API returned HTTP ${response.status}.`;
      throw new KubernetesApiError(response.status, message);
    }
    return parsed as T;
  }

  private async fetchResponse(method: string, path: string, body?: unknown): Promise<Response> {
    const cluster = this.config.getCurrentCluster();
    if (!cluster) throw new Error("Kubernetes kubeconfig has no active cluster.");

    const options: RequestOptions = {};
    await this.config.applyToHTTPSOptions(options);
    const headers = requestHeaders(options);
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetcher(new URL(path, cluster.server), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      tls: {
        ...(options.ca !== undefined ? { ca: options.ca } : {}),
        ...(options.cert !== undefined
          ? { cert: options.cert as Bun.TLSOptions["cert"] }
          : {}),
        ...(options.key !== undefined
          ? { key: options.key as Bun.TLSOptions["key"] }
          : {}),
        ...(options.rejectUnauthorized !== undefined
          ? { rejectUnauthorized: options.rejectUnauthorized }
          : {}),
        ...(options.servername !== undefined ? { serverName: options.servername } : {}),
      },
    });
    return response;
  }
}

export class KubernetesApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "KubernetesApiError";
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function apiError(status: number, text: string): KubernetesApiError {
  const body = safeJson(text);
  const message =
    body != null &&
    typeof body === "object" &&
    typeof (body as Record<string, unknown>).message === "string"
      ? String((body as Record<string, unknown>).message)
      : `Kubernetes API returned HTTP ${status}.`;
  return new KubernetesApiError(status, message);
}

function requestHeaders(options: RequestOptions): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
  }
  return headers;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Pure rollout evaluation, exported so the safety conditions can be tested
 * without a Kubernetes cluster.
 */
export function evaluateDeployment(
  target: ReleaseDeploymentTarget,
  deployment: V1Deployment,
  replicaSets: readonly V1ReplicaSet[],
  pods: readonly V1Pod[],
): DeploymentTargetStatus {
  const desired = deployment.spec?.replicas ?? 1;
  const status = deployment.status;
  const counts = {
    desiredReplicas: desired,
    updatedReplicas: status?.updatedReplicas ?? 0,
    readyReplicas: status?.readyReplicas ?? 0,
    availableReplicas: status?.availableReplicas ?? 0,
  };
  const base = { ...target, ...counts };
  const generation = deployment.metadata?.generation ?? 0;
  const observedGeneration = status?.observedGeneration ?? 0;
  const templateContainer = deployment.spec?.template.spec?.containers.find(
    (container) => container.name === target.service,
  );

  if (desired === 0) {
    return {
      ...base,
      state: "degraded",
      podCount: 0,
      message: "Deployment is scaled to zero; no running image can be verified.",
    };
  }
  if (!templateContainer) {
    return {
      ...base,
      state: "degraded",
      podCount: 0,
      message: `Container ${target.service} is missing from the Deployment template.`,
    };
  }
  if (!imageMatchesExpected(target.expectedImage, templateContainer.image)) {
    return {
      ...base,
      state: "pending",
      podCount: 0,
      message: `Deployment still requests ${templateContainer.image}; waiting for ${target.expectedImage}.`,
    };
  }

  // `NewReplicaSetAvailable` means Kubernetes already considered the rollout
  // complete. If that same Deployment is now explicitly Available=False, it is
  // an unhealthy steady state (for example, every replica later lost
  // readiness), not a rollout that is still deploying.
  const unavailable = status?.conditions?.find(
    (condition) =>
      condition.type === "Available" &&
      condition.status === "False",
  );
  const completedRollout = status?.conditions?.some(
    (condition) =>
      condition.type === "Progressing" &&
      condition.status === "True" &&
      condition.reason === "NewReplicaSetAvailable",
  );
  if (unavailable && completedRollout) {
    return {
      ...base,
      state: "degraded",
      podCount: 0,
      message:
        unavailable.message ??
        "Kubernetes reports that the completed Deployment is unavailable.",
    };
  }

  const deadline = status?.conditions?.find(
    (condition) =>
      condition.type === "Progressing" &&
      condition.status === "False" &&
      condition.reason === "ProgressDeadlineExceeded",
  );
  if (deadline) {
    return {
      ...base,
      state: "degraded",
      podCount: 0,
      message: deadline.message ?? "Kubernetes reports that the rollout exceeded its progress deadline.",
    };
  }

  const deploymentUid = deployment.metadata?.uid;
  const ownedReplicaSetUids = new Set(
    replicaSets
      .filter((replicaSet) =>
        replicaSet.metadata?.ownerReferences?.some(
          (owner) => owner.kind === "Deployment" && owner.uid === deploymentUid,
        ),
      )
      .map((replicaSet) => replicaSet.metadata?.uid)
      .filter((uid): uid is string => Boolean(uid)),
  );
  const activePods = pods.filter(
    (pod) =>
      pod.metadata?.deletionTimestamp == null &&
      pod.status?.phase !== "Succeeded" &&
      pod.status?.phase !== "Failed" &&
      pod.metadata?.ownerReferences?.some(
        (owner) => owner.kind === "ReplicaSet" && ownedReplicaSetUids.has(owner.uid),
      ),
  );

  if (
    observedGeneration < generation ||
    counts.updatedReplicas !== desired ||
    counts.readyReplicas !== desired ||
    counts.availableReplicas !== desired ||
    activePods.length !== desired
  ) {
    return {
      ...base,
      state: "progressing",
      podCount: activePods.length,
      message:
        `Rollout incomplete: ${counts.updatedReplicas}/${desired} updated, ` +
        `${counts.readyReplicas}/${desired} ready, ${counts.availableReplicas}/${desired} available, ` +
        `${activePods.length}/${desired} active pods.`,
    };
  }

  const digests = new Set<string>();
  for (const pod of activePods) {
    const declared = pod.spec?.containers.find((container) => container.name === target.service);
    const runtime = pod.status?.containerStatuses?.find(
      (container) => container.name === target.service,
    );
    const podReady = pod.status?.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    );
    if (
      !imageMatchesExpected(target.expectedImage, declared?.image) ||
      !runtime?.ready ||
      !podReady
    ) {
      return {
        ...base,
        state: "progressing",
        podCount: activePods.length,
        message: `Pod ${pod.metadata?.name ?? "(unknown)"} is not Ready on ${target.expectedImage}.`,
      };
    }
    const digest = digestOf(runtime.imageID);
    if (!digest) {
      return {
        ...base,
        state: "progressing",
        podCount: activePods.length,
        message: `Pod ${pod.metadata?.name ?? "(unknown)"} has not reported an immutable image digest.`,
      };
    }
    digests.add(digest);
  }

  if (digests.size !== 1) {
    return {
      ...base,
      state: "degraded",
      podCount: activePods.length,
      message: `Active replicas run ${digests.size} different image digests.`,
    };
  }

  const observedDigest = [...digests][0];
  const expectedDigest = target.expectedImage.match(
    /@((?:sha256|sha512):[a-f0-9]+)$/i,
  )?.[1]?.toLowerCase();
  if (expectedDigest && observedDigest !== expectedDigest) {
    return {
      ...base,
      state: "degraded",
      podCount: activePods.length,
      observedDigest,
      message: `Runtime digest ${observedDigest} does not match expected ${expectedDigest}.`,
    };
  }

  return {
    ...base,
    state: "released",
    podCount: activePods.length,
    observedDigest,
  };
}

function emptyStatus(
  target: ReleaseDeploymentTarget,
  state: "missing" | "unavailable",
  message: string,
): DeploymentTargetStatus {
  return {
    ...target,
    state,
    desiredReplicas: 0,
    updatedReplicas: 0,
    readyReplicas: 0,
    availableReplicas: 0,
    podCount: 0,
    message,
  };
}

function digestOf(imageId: string | undefined): string | undefined {
  return imageId?.match(/@((?:sha256|sha512):[a-f0-9]+)$/i)?.[1]?.toLowerCase();
}

/**
 * A manifest that omits `image` produces a bare reference such as
 * `webportal:1.2.3`, while Kubernetes reports the registry-qualified image.
 * In that case the repository path and tag/digest are authoritative. An
 * explicitly registry-qualified manifest image still requires an exact match.
 */
function imageMatchesExpected(
  expectedImage: string,
  observedImage: string | undefined,
): boolean {
  if (!observedImage) return false;
  if (observedImage === expectedImage) return true;

  const expected = splitImageReference(expectedImage);
  const observed = splitImageReference(observedImage);
  if (!expected || !observed || expected.reference !== observed.reference) return false;
  if (hasExplicitRegistry(expected.repository)) return false;
  return (
    observed.repository === expected.repository ||
    observed.repository.endsWith(`/${expected.repository}`)
  );
}

function splitImageReference(
  image: string,
): { repository: string; reference: string } | undefined {
  const digestAt = image.lastIndexOf("@");
  if (digestAt > 0) {
    return {
      repository: image.slice(0, digestAt),
      reference: image.slice(digestAt + 1).toLowerCase(),
    };
  }

  const tagAt = image.lastIndexOf(":");
  if (tagAt <= image.lastIndexOf("/")) return undefined;
  return {
    repository: image.slice(0, tagAt),
    reference: image.slice(tagAt + 1),
  };
}

function hasExplicitRegistry(repository: string): boolean {
  const firstSegment = repository.split("/", 1)[0] ?? "";
  return (
    repository.includes("/") &&
    (firstSegment === "localhost" ||
      firstSegment.includes(".") ||
      firstSegment.includes(":"))
  );
}

function statusCodeOf(error: unknown): number | undefined {
  if (error == null || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === "number") return record.code;
  if (typeof record.statusCode === "number") return record.statusCode;
  if (
    record.response != null &&
    typeof record.response === "object" &&
    typeof (record.response as Record<string, unknown>).statusCode === "number"
  ) {
    return (record.response as Record<string, number>).statusCode;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
