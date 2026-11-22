import { describe, expect, test } from "bun:test";
import type { KubernetesRuntimeConfig } from "../../src/config/runtime.ts";
import { KubernetesJobExecutor } from "../../src/infrastructure/agent/kubernetes-executor.ts";

const enabled = process.env.TALOS_KIND_TEST === "1";
const integrationTest = enabled ? test : test.skip;

const config: KubernetesRuntimeConfig = {
  namespace: process.env.TALOS_KIND_NAMESPACE ?? "talos-executor-test",
  agentImage: "node:22-alpine@sha256:" + "0".repeat(64),
  e2eImage: "node:22-alpine@sha256:" + "0".repeat(64),
  workerServiceAccount: "talos-worker",
  jobTtlSeconds: 60,
  pollIntervalMs: 250,
  cpuRequest: "10m",
  cpuLimit: "250m",
  memoryRequest: "32Mi",
  memoryLimit: "128Mi",
};

describe("kind Kubernetes executor", () => {
  integrationTest("streams successful logs with secret redaction", async () => {
    const executor = new KubernetesJobExecutor(config);
    const lines: string[] = [];
    const result = await executor.run({
      executionId: crypto.randomUUID(),
      name: "kind-success",
      image: "node:22-alpine",
      timeoutMs: 60_000,
      env: {},
      command: ["node"],
      args: ["-e", "console.log('hello kind-secret')"],
      files: {},
      secrets: ["kind-secret"],
      onStdoutLine: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(0);
    expect(lines.join("\n")).toContain("hello [redacted]");
  }, 70_000);

  integrationTest("deletes a running Job when cancelled", async () => {
    const executor = new KubernetesJobExecutor(config);
    const controller = new AbortController();
    const run = executor.run({
      executionId: crypto.randomUUID(),
      name: "kind-cancel",
      image: "node:22-alpine",
      timeoutMs: 60_000,
      env: {},
      command: ["node"],
      args: ["-e", "setTimeout(() => {}, 60000)"],
      files: {},
      secrets: [],
      signal: controller.signal,
      onStdoutLine: () => {},
    });
    setTimeout(() => controller.abort(new Error("test cancellation")), 1500);
    await expect(run).rejects.toThrow("test cancellation");
  }, 70_000);
});
