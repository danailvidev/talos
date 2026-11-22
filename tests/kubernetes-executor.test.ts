import { describe, expect, test } from "bun:test";
import {
  buildKubernetesJobManifest,
  KubernetesJobExecutor,
} from "../src/infrastructure/agent/kubernetes-executor.ts";
import {
  KubernetesApiError,
  type KubernetesJobClient,
} from "../src/connectors/kubernetes/client.ts";
import type { KubernetesRuntimeConfig } from "../src/config/runtime.ts";

const config: KubernetesRuntimeConfig = {
  namespace: "talos",
  agentImage: "registry/agent@sha256:" + "a".repeat(64),
  e2eImage: "registry/e2e@sha256:" + "b".repeat(64),
  workerServiceAccount: "talos-worker",
  jobTtlSeconds: 600,
  pollIntervalMs: 10,
  cpuRequest: "500m",
  cpuLimit: "2",
  memoryRequest: "1Gi",
  memoryLimit: "4Gi",
};

describe("Kubernetes worker manifests", () => {
  test("runs without an API token and uses bounded resources and cleanup", () => {
    const manifest = buildKubernetesJobManifest(
      config,
      {
        executionId: "run-1",
        image: config.agentImage,
        timeoutMs: 90_000,
        env: { PROMPT: "review" },
        args: ["--model", "sonnet"],
      },
      "talos-agent-run-1",
      "talos-agent-run-1-input",
    ) as any;

    expect(manifest.spec.backoffLimit).toBe(0);
    expect(manifest.spec.ttlSecondsAfterFinished).toBe(600);
    expect(manifest.spec.activeDeadlineSeconds).toBe(90);
    const pod = manifest.spec.template.spec;
    expect(pod.serviceAccountName).toBe("talos-worker");
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.containers[0].image).toBe(config.agentImage);
    expect(pod.containers[0].securityContext.capabilities.drop).toEqual(["ALL"]);
    expect(pod.containers[0].securityContext.readOnlyRootFilesystem).toBe(true);
    expect(pod.containers[0].volumeMounts).toContainEqual({
      name: "work",
      mountPath: "/workspace",
      subPath: "workspace",
    });
    expect(pod.containers[0].resources.limits.memory).toBe("4Gi");
    expect(JSON.stringify(manifest)).not.toContain("gitlab-token");
  });

  test("streams redacted logs and removes the short-lived input Secret", async () => {
    const deleted: string[] = [];
    let jobDeleted = false;
    let createdSecret: any;
    const client: KubernetesJobClient = {
      createSecret: async (_namespace, manifest) => {
        createdSecret = manifest;
        return {};
      },
      createJob: async () => ({ metadata: { uid: "job-uid" } }),
      listJobs: async () => ({ items: [] }),
      listPods: async () => ({
        items: [{ metadata: { name: "worker-pod" }, status: {} }],
      }),
      readPodLog: async () => "working with token-secret\ncomplete\n",
      readJob: async () => {
        if (jobDeleted) throw new KubernetesApiError(404, "not found");
        return { status: { succeeded: 1 } };
      },
      deleteJob: async (_namespace, name) => {
        jobDeleted = true;
        deleted.push(`job:${name}`);
      },
      deleteSecret: async (_namespace, name) => { deleted.push(`secret:${name}`); },
    };
    const executor = new KubernetesJobExecutor(config, client);
    const lines: string[] = [];
    const result = await executor.run({
      executionId: "run-logs",
      name: "agent",
      image: config.agentImage,
      timeoutMs: 10_000,
      env: {},
      files: { "agent-secrets/token": "token-secret" },
      secrets: ["token-secret"],
      onStdoutLine: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(["working with [redacted]", "complete"]);
    expect(createdSecret.metadata.ownerReferences[0]).toMatchObject({
      kind: "Job",
      uid: "job-uid",
    });
    expect(deleted.some((entry) => entry.startsWith("job:"))).toBe(true);
    expect(deleted.some((entry) => entry.startsWith("secret:"))).toBe(true);
  });

  test("deletes the Job and Secret when cancellation is already requested", async () => {
    const deleted: string[] = [];
    let jobDeleted = false;
    const client: KubernetesJobClient = {
      createSecret: async () => ({}),
      createJob: async () => ({ metadata: { uid: "job-uid" } }),
      listJobs: async () => ({ items: [] }),
      listPods: async () => ({ items: [] }),
      readPodLog: async () => "",
      readJob: async () => {
        if (jobDeleted) throw new KubernetesApiError(404, "not found");
        return { status: {} };
      },
      deleteJob: async (_namespace, name) => {
        jobDeleted = true;
        deleted.push(`job:${name}`);
      },
      deleteSecret: async (_namespace, name) => { deleted.push(`secret:${name}`); },
    };
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    const executor = new KubernetesJobExecutor(config, client);

    await expect(executor.run({
      executionId: "run-cancel",
      name: "agent",
      image: config.agentImage,
      timeoutMs: 10_000,
      env: {},
      files: {},
      secrets: [],
      signal: controller.signal,
      onStdoutLine: () => {},
    })).rejects.toThrow("cancelled by test");
    expect(deleted.some((entry) => entry.startsWith("job:"))).toBe(true);
    expect(deleted.some((entry) => entry.startsWith("secret:"))).toBe(true);
  });
});
