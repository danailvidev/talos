import { describe, expect, test } from "bun:test";
import { loadRuntimeConfig } from "../src/config/runtime.ts";

describe("runtime configuration", () => {
  test("keeps local execution on Docker and filesystem artifacts", () => {
    const config = loadRuntimeConfig({});
    expect(config.executor).toBe("docker");
    expect(config.artifactBackend).toBe("filesystem");
    expect(config.secureCookies).toBe(false);
  });

  test("requires immutable images and HTTPS for Kubernetes", () => {
    expect(() => loadRuntimeConfig({ TALOS_EXECUTOR: "kubernetes" })).toThrow(
      "TALOS_PUBLIC_URL",
    );
    expect(() =>
      loadRuntimeConfig({
        TALOS_EXECUTOR: "kubernetes",
        TALOS_PUBLIC_URL: "http://talos.example.com",
      }),
    ).toThrow("HTTPS");
  });

  test("loads a complete Kubernetes and S3 configuration", () => {
    const digest = "a".repeat(64);
    const config = loadRuntimeConfig({
      TALOS_EXECUTOR: "kubernetes",
      TALOS_PUBLIC_URL: "https://talos.example.com/",
      TALOS_AGENT_IMAGE: `example.com/talos-agent@sha256:${digest}`,
      TALOS_E2E_IMAGE: `example.com/talos-e2e@sha256:${digest}`,
      TALOS_ARTIFACT_S3_BUCKET: "talos-artifacts",
    });
    expect(config.secureCookies).toBe(true);
    expect(config.publicUrl?.origin).toBe("https://talos.example.com");
    expect(config.kubernetes?.namespace).toBe("talos");
    expect(config.s3?.prefix).toBe("talos/e2e");
  });
});
