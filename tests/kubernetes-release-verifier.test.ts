import { describe, expect, test } from "bun:test";
import type {
  KubeConfig,
  V1Deployment,
  V1Pod,
  V1ReplicaSet,
} from "@kubernetes/client-node";

import {
  createKubernetesClients,
  evaluateDeployment,
  KubernetesDeploymentVerifier,
  loadRuntimeKubeConfig,
  type KubernetesClients,
} from "../src/connectors/kubernetes/client.ts";

const target = { service: "web", expectedImage: "registry/web:1.2.3" };

function deployment(overrides: Partial<V1Deployment> = {}): V1Deployment {
  return {
    metadata: { name: "web", namespace: "prod", uid: "deployment-1", generation: 4 },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: "web" } },
      template: {
        metadata: { labels: { app: "web" } },
        spec: { containers: [{ name: "web", image: target.expectedImage }] },
      },
    },
    status: {
      observedGeneration: 4,
      replicas: 2,
      updatedReplicas: 2,
      readyReplicas: 2,
      availableReplicas: 2,
    },
    ...overrides,
  } as V1Deployment;
}

function replicaSet(): V1ReplicaSet {
  return {
    metadata: {
      name: "web-abc",
      uid: "replicaset-1",
      ownerReferences: [
        { apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "deployment-1" },
      ],
    },
  } as V1ReplicaSet;
}

function pod(
  name: string,
  imageID = "containerd://registry/web@sha256:aaaaaaaa",
  ready = true,
): V1Pod {
  return {
    metadata: {
      name,
      ownerReferences: [
        { apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-abc", uid: "replicaset-1" },
      ],
    },
    spec: { containers: [{ name: "web", image: target.expectedImage }] },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
      containerStatuses: [
        {
          name: "web",
          image: target.expectedImage,
          imageID,
          ready,
          restartCount: 0,
        },
      ],
    },
  } as V1Pod;
}

describe("Kubernetes release verification", () => {
  test("uses host kubeconfig outside Kubernetes and ServiceAccount credentials inside it", () => {
    const hostCalls: string[] = [];
    loadRuntimeKubeConfig(trackingConfig(hostCalls), {});
    expect(hostCalls).toEqual(["default"]);

    const clusterCalls: string[] = [];
    loadRuntimeKubeConfig(trackingConfig(clusterCalls), {
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      KUBERNETES_SERVICE_PORT: "443",
    });
    expect(clusterCalls).toEqual(["cluster"]);
  });

  test("honors an explicit KUBECONFIG inside Kubernetes", () => {
    const calls: string[] = [];
    loadRuntimeKubeConfig(trackingConfig(calls), {
      KUBECONFIG: "/credentials/config",
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      KUBERNETES_SERVICE_PORT: "443",
    });
    expect(calls).toEqual(["default"]);
  });

  test("passes kubeconfig authentication and CA data to Bun fetch", async () => {
    let authCalls = 0;
    const config = {
      getCurrentCluster: () => ({ server: "https://cluster.example" }),
      applyToHTTPSOptions: async (options: {
        ca?: Buffer;
        headers?: Record<string, string>;
      }) => {
        authCalls += 1;
        options.ca = Buffer.from("cluster-ca");
        options.headers = { Authorization: `Bearer token-${authCalls}` };
      },
    } as unknown as KubeConfig;
    const calls: Array<{ url: string; init?: BunFetchRequestInit }> = [];
    const fetcher = (async (
      input: string | URL | Request,
      init?: BunFetchRequestInit,
    ) => {
      calls.push({ url: String(input), init });
      return Response.json({ items: [] });
    }) as typeof fetch;
    const clients = createKubernetesClients(config, fetcher);

    await clients.core.listNamespacedPod({ namespace: "dev" });
    await clients.core.listNamespacedPod({ namespace: "dev" });

    expect(calls[0]?.url).toBe("https://cluster.example/api/v1/namespaces/dev/pods");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(
      "Bearer token-1",
    );
    expect(calls[0]?.init?.tls?.ca).toEqual(Buffer.from("cluster-ca"));
    expect(new Headers(calls[1]?.init?.headers).get("Authorization")).toBe(
      "Bearer token-2",
    );
  });

  test("releases only when every replica is ready on one immutable digest", () => {
    expect(
      evaluateDeployment(target, deployment(), replicaSetList(), [
        pod("web-1"),
        pod("web-2"),
      ]),
    ).toEqual(
      expect.objectContaining({
        state: "released",
        desiredReplicas: 2,
        readyReplicas: 2,
        podCount: 2,
        observedDigest: "sha256:aaaaaaaa",
      }),
    );
  });

  test("accepts a registry-qualified runtime image when the manifest uses a bare image name", () => {
    const bareTarget = { service: "web", expectedImage: "web:1.2.3" };
    const qualifiedImage =
      "123456789012.dkr.ecr.us-east-1.amazonaws.com/services/web:1.2.3";
    const qualifiedDeployment = deployment();
    qualifiedDeployment.spec!.template.spec!.containers[0]!.image = qualifiedImage;
    const pods = [pod("web-1"), pod("web-2")];
    for (const item of pods) {
      item.spec!.containers[0]!.image = qualifiedImage;
    }

    expect(
      evaluateDeployment(
        bareTarget,
        qualifiedDeployment,
        replicaSetList(),
        pods,
      ),
    ).toMatchObject({
      state: "released",
      readyReplicas: 2,
      podCount: 2,
    });
  });

  test("accepts a registry prefix before a relative manifest repository path", () => {
    const relativeTarget = {
      service: "web",
      expectedImage: "archive/sample-app:1.3.0",
    };
    const qualifiedImage =
      "123456789012.dkr.ecr.us-east-1.amazonaws.com/archive/sample-app:1.3.0";
    const qualifiedDeployment = deployment();
    qualifiedDeployment.spec!.template.spec!.containers[0]!.image = qualifiedImage;
    const pods = [pod("web-1"), pod("web-2")];
    for (const item of pods) {
      item.spec!.containers[0]!.image = qualifiedImage;
    }

    expect(
      evaluateDeployment(
        relativeTarget,
        qualifiedDeployment,
        replicaSetList(),
        pods,
      ).state,
    ).toBe("released");
  });

  test("does not ignore the repository when the manifest specifies one", () => {
    const explicitTarget = {
      service: "web",
      expectedImage: "registry-a.example/services/web:1.2.3",
    };
    const otherRegistryDeployment = deployment();
    otherRegistryDeployment.spec!.template.spec!.containers[0]!.image =
      "registry-b.example/services/web:1.2.3";

    expect(
      evaluateDeployment(
        explicitTarget,
        otherRegistryDeployment,
        replicaSetList(),
        [pod("web-1"), pod("web-2")],
      ),
    ).toMatchObject({
      state: "pending",
      message: expect.stringContaining(explicitTarget.expectedImage),
    });
  });

  test("rejects mixed runtime digests even when Deployment counts are healthy", () => {
    expect(
      evaluateDeployment(target, deployment(), replicaSetList(), [
        pod("web-1"),
        pod("web-2", "containerd://registry/web@sha256:bbbbbbbb"),
      ]),
    ).toMatchObject({
      state: "degraded",
      message: "Active replicas run 2 different image digests.",
    });
  });

  test("matches an explicit expected digest to runtime evidence", () => {
    const digestTarget = {
      service: "web",
      expectedImage: "registry/web@sha256:aaaaaaaa",
    };
    const digestDeployment = deployment();
    digestDeployment.spec!.template.spec!.containers[0]!.image =
      digestTarget.expectedImage;
    const first = pod("web-1", "containerd://registry/web@sha256:bbbbbbbb");
    const second = pod("web-2", "containerd://registry/web@sha256:bbbbbbbb");
    first.spec!.containers[0]!.image = digestTarget.expectedImage;
    second.spec!.containers[0]!.image = digestTarget.expectedImage;

    expect(
      evaluateDeployment(
        digestTarget,
        digestDeployment,
        replicaSetList(),
        [first, second],
      ).state,
    ).toBe("degraded");
  });

  test("reports pending while the Deployment still references the old image", () => {
    const oldDeployment = deployment();
    oldDeployment.spec!.template.spec!.containers[0]!.image =
      "registry/web:1.2.2";

    expect(
      evaluateDeployment(target, oldDeployment, replicaSetList(), [
        pod("web-1"),
        pod("web-2"),
      ]),
    ).toMatchObject({
      state: "pending",
      message: expect.stringContaining("waiting for registry/web:1.2.3"),
    });
  });

  test("keeps an incomplete or unready rollout progressing", () => {
    const result = evaluateDeployment(
      target,
      deployment({
        status: {
          observedGeneration: 3,
          updatedReplicas: 1,
          readyReplicas: 1,
          availableReplicas: 1,
        },
      }),
      replicaSetList(),
      [pod("web-1"), pod("web-2", undefined, false)],
    );
    expect(result.state).toBe("progressing");
    expect(result.message).toContain("Rollout incomplete");
  });

  test("reports a completed rollout that later lost availability as degraded", () => {
    const result = evaluateDeployment(
      target,
      deployment({
        status: {
          observedGeneration: 4,
          replicas: 2,
          updatedReplicas: 2,
          readyReplicas: 0,
          availableReplicas: 0,
          unavailableReplicas: 2,
          conditions: [
            {
              type: "Progressing",
              status: "True",
              reason: "NewReplicaSetAvailable",
            },
            {
              type: "Available",
              status: "False",
              reason: "MinimumReplicasUnavailable",
              message: "Deployment does not have minimum availability.",
            },
          ],
        },
      }),
      replicaSetList(),
      [pod("web-1", undefined, false), pod("web-2", undefined, false)],
    );

    expect(result).toMatchObject({
      state: "degraded",
      message: "Deployment does not have minimum availability.",
    });
  });

  test("surfaces Kubernetes progress deadline failures", () => {
    const result = evaluateDeployment(
      target,
      deployment({
        status: {
          observedGeneration: 4,
          updatedReplicas: 1,
          readyReplicas: 1,
          availableReplicas: 1,
          conditions: [
            {
              type: "Progressing",
              status: "False",
              reason: "ProgressDeadlineExceeded",
              message: "ReplicaSet did not progress.",
            },
          ],
        },
      }),
      replicaSetList(),
      [pod("web-1")],
    );
    expect(result).toMatchObject({
      state: "degraded",
      message: "ReplicaSet did not progress.",
    });
  });

  test("distinguishes a missing workload from a Kubernetes API outage", async () => {
    const verifier = new KubernetesDeploymentVerifier(
      clients(async () => {
        throw { code: 404 };
      }),
    );
    await expect(verifier.verify("PROD", [target])).resolves.toEqual([
      expect.objectContaining({ state: "missing", service: "web" }),
    ]);

    const unavailable = new KubernetesDeploymentVerifier(
      clients(async () => {
        throw new Error("connection refused");
      }),
    );
    await expect(unavailable.verify("PROD", [target])).resolves.toEqual([
      expect.objectContaining({
        state: "unavailable",
        message: "connection refused",
      }),
    ]);
  });
});

function trackingConfig(calls: string[]): KubeConfig {
  return {
    loadFromCluster: () => calls.push("cluster"),
    loadFromDefault: () => calls.push("default"),
  } as unknown as KubeConfig;
}

function replicaSetList(): V1ReplicaSet[] {
  return [replicaSet()];
}

function clients(
  readDeployment: () => Promise<V1Deployment>,
): KubernetesClients {
  return {
    apps: {
      listNamespacedReplicaSet: async () => ({ items: replicaSetList() }),
      readNamespacedDeployment: readDeployment,
    },
    core: {
      listNamespacedPod: async () => ({ items: [] }),
    },
  };
}
