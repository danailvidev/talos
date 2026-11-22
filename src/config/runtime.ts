import { ConfigError } from "../core/errors.ts";

export type ExecutorMode = "docker" | "kubernetes";
export type ArtifactBackend = "filesystem" | "s3";

export interface KubernetesRuntimeConfig {
  namespace: string;
  agentImage: string;
  e2eImage: string;
  workerServiceAccount: string;
  jobTtlSeconds: number;
  pollIntervalMs: number;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
}

export interface S3ArtifactConfig {
  bucket: string;
  prefix: string;
  region?: string;
}

export interface RuntimeConfig {
  executor: ExecutorMode;
  publicUrl?: URL;
  secureCookies: boolean;
  artifactBackend: ArtifactBackend;
  kubernetes?: KubernetesRuntimeConfig;
  s3?: S3ArtifactConfig;
}

export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeConfig {
  const executor = enumValue(env.TALOS_EXECUTOR, "TALOS_EXECUTOR", [
    "docker",
    "kubernetes",
  ] as const, "docker");
  const publicUrl = optionalUrl(env.TALOS_PUBLIC_URL);
  const artifactBackend = enumValue(
    env.TALOS_ARTIFACT_BACKEND,
    "TALOS_ARTIFACT_BACKEND",
    ["filesystem", "s3"] as const,
    executor === "kubernetes" ? "s3" : "filesystem",
  );

  if (executor === "kubernetes" && !publicUrl) {
    throw new ConfigError("TALOS_PUBLIC_URL is required when TALOS_EXECUTOR=kubernetes.");
  }
  if (executor === "kubernetes" && publicUrl?.protocol !== "https:") {
    throw new ConfigError("TALOS_PUBLIC_URL must use HTTPS in Kubernetes mode.");
  }

  const s3 = artifactBackend === "s3"
    ? {
        bucket: required(env.TALOS_ARTIFACT_S3_BUCKET, "TALOS_ARTIFACT_S3_BUCKET"),
        prefix: normalizedPrefix(env.TALOS_ARTIFACT_S3_PREFIX ?? "talos/e2e"),
        ...(env.AWS_REGION?.trim() ? { region: env.AWS_REGION.trim() } : {}),
      }
    : undefined;

  const kubernetes = executor === "kubernetes"
    ? {
        namespace: dnsLabel(env.TALOS_KUBERNETES_NAMESPACE ?? "talos", "TALOS_KUBERNETES_NAMESPACE"),
        agentImage: immutableImage(
          required(env.TALOS_AGENT_IMAGE, "TALOS_AGENT_IMAGE"),
          "TALOS_AGENT_IMAGE",
        ),
        e2eImage: immutableImage(
          required(env.TALOS_E2E_IMAGE, "TALOS_E2E_IMAGE"),
          "TALOS_E2E_IMAGE",
        ),
        workerServiceAccount: dnsLabel(
          env.TALOS_WORKER_SERVICE_ACCOUNT ?? "talos-worker",
          "TALOS_WORKER_SERVICE_ACCOUNT",
        ),
        jobTtlSeconds: positiveInteger(env.TALOS_JOB_TTL_SECONDS, 3600, "TALOS_JOB_TTL_SECONDS"),
        pollIntervalMs: positiveInteger(
          env.TALOS_KUBERNETES_POLL_MS,
          1000,
          "TALOS_KUBERNETES_POLL_MS",
        ),
        cpuRequest: env.TALOS_WORKER_CPU_REQUEST?.trim() || "500m",
        cpuLimit: env.TALOS_WORKER_CPU_LIMIT?.trim() || "2",
        memoryRequest: env.TALOS_WORKER_MEMORY_REQUEST?.trim() || "1Gi",
        memoryLimit: env.TALOS_WORKER_MEMORY_LIMIT?.trim() || "4Gi",
      }
    : undefined;

  return {
    executor,
    publicUrl,
    secureCookies: publicUrl?.protocol === "https:",
    artifactBackend,
    ...(kubernetes ? { kubernetes } : {}),
    ...(s3 ? { s3 } : {}),
  };
}

function optionalUrl(raw: string | undefined): URL | undefined {
  if (!raw?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("TALOS_PUBLIC_URL must be an absolute HTTP or HTTPS URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new ConfigError("TALOS_PUBLIC_URL must be an absolute HTTP or HTTPS URL without credentials.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function required(raw: string | undefined, name: string): string {
  const value = raw?.trim();
  if (!value) throw new ConfigError(`${name} is required.`);
  return value;
}

function immutableImage(value: string, name: string): string {
  if (!/@sha256:[a-f0-9]{64}$/i.test(value)) {
    throw new ConfigError(`${name} must reference an immutable sha256 image digest.`);
  }
  return value;
}

function dnsLabel(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(normalized) || normalized.length > 253) {
    throw new ConfigError(`${name} must be a valid lowercase Kubernetes DNS name.`);
  }
  return normalized;
}

function normalizedPrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.includes("..")) {
    throw new ConfigError("TALOS_ARTIFACT_S3_PREFIX must be a non-empty safe object prefix.");
  }
  return prefix;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer.`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  raw: string | undefined,
  name: string,
  values: T,
  fallback: T[number],
): T[number] {
  const value = raw?.trim() || fallback;
  if (!values.includes(value)) {
    throw new ConfigError(`${name} must be one of: ${values.join(", ")}.`);
  }
  return value as T[number];
}
