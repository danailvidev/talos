import { describe, expect, test } from "bun:test";
import {
  applyChanges,
  deploymentTargetFor,
} from "../src/application/releases.ts";
import {
  revertChanges,
  type ReleaseDeployment,
} from "../src/application/release-service.ts";

describe("release manifest edits", () => {
  test("changes only the requested scalar without normalizing the manifest", () => {
    const manifest = [
      "applications:",
      "- name: web",
      "  image: registry/web",
      "  version: 1.0.0",
      "- name: admin",
      "  image: registry/admin",
      "  version: 2.0.0",
      "services:",
      "- name: api",
      "  version: 3.0.0",
      "",
    ].join("\r\n");

    const updated = applyChanges(manifest, "DEV/cluster.yaml", [
      {
        environment: "DEV",
        service: "web",
        version: "1.1.0",
        section: "applications",
      },
    ]);

    expect(updated).toBe(manifest.replace("version: 1.0.0", "version: 1.1.0"));
  });

  test("preserves scalar quoting and inline comments", () => {
    const manifest = [
      "applications:",
      "  - name: web",
      '    version: "1.0.0" # deployed version',
      "services:",
      "  - name: api",
      "    version: '2.0.0'",
      "",
    ].join("\n");

    const updated = applyChanges(manifest, "DEV/cluster.yaml", [
      {
        environment: "DEV",
        service: "web",
        version: "1.1.0",
        section: "applications",
      },
      {
        environment: "DEV",
        service: "api",
        version: "2.1.0",
        section: "services",
      },
    ]);

    expect(updated).toBe(
      manifest
        .replace('"1.0.0"', '"1.1.0"')
        .replace("'2.0.0'", "'2.1.0'"),
    );
  });
});

describe("release deployment targets", () => {
  test("uses the manifest image and new immutable version", () => {
    expect(
      deploymentTargetFor(
        {
          name: "web",
          image: "registry.example/team/web",
          version: "1.0.0",
          section: "applications",
        },
        "1.1.0",
      ),
    ).toEqual({
      service: "web",
      expectedImage: "registry.example/team/web:1.1.0",
    });
  });

  test("uses a digest version as a digest reference", () => {
    expect(
      deploymentTargetFor(
        { name: "api", version: "old", section: "services" },
        "sha256:abcdef",
      ).expectedImage,
    ).toBe("api@sha256:abcdef");
  });
});

describe("release revert changes", () => {
  const deployment: ReleaseDeployment = {
    environment: "DEV",
    sha: "abcdef123456",
    shortSha: "abcdef12",
    title: "DEV Services: api 2.0.0",
    authorName: "Developer",
    authorEmail: "dev@example.com",
    committedAt: new Date("2026-09-28T10:00:00Z"),
    webUrl: "https://gitlab.example/commit/abcdef123456",
    changes: [
      {
        service: "api",
        section: "services",
        from: "1.0.0",
        to: "2.0.0",
      },
    ],
  };

  test("restores only versions changed by the latest deployment", () => {
    expect(
      revertChanges("DEV", deployment, [
        { name: "api", version: "2.0.0", section: "services" },
        { name: "worker", version: "9.0.0", section: "services" },
      ]),
    ).toEqual([
      {
        environment: "DEV",
        service: "api",
        section: "services",
        version: "1.0.0",
      },
    ]);
  });

  test("refuses to overwrite a service that moved after the deployment", () => {
    expect(() =>
      revertChanges("DEV", deployment, [
        { name: "api", version: "3.0.0", section: "services" },
      ]),
    ).toThrow("current version is 3.0.0");
  });

  test("refuses a deployment that added an entry because a version edit cannot delete it", () => {
    expect(() =>
      revertChanges(
        "DEV",
        {
          ...deployment,
          changes: [{ service: "api", section: "services", from: null, to: "2.0.0" }],
        },
        [{ name: "api", version: "2.0.0", section: "services" }],
      ),
    ).toThrow("cannot be reverted as a version change");
  });
});
