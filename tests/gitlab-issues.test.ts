import { describe, expect, test } from "bun:test";

import { GitLabIssuePublisher } from "../src/connectors/gitlab/issues.ts";
import { actorIdentitySecretStore } from "../src/secrets/actor-secrets.ts";
import { EnvSecretStore, type SecretStore } from "../src/secrets/secret-store.ts";

function secrets(token?: string): SecretStore {
  return {
    get: (name) => (name === "GITLAB_TOKEN" ? token : undefined),
    require(name) {
      const value = this.get(name);
      if (!value) throw new Error(`Missing ${name}`);
      return value;
    },
    values: () => (token ? [token] : []),
  };
}

describe("GitLabIssuePublisher", () => {
  test("does not fall back to the instance GitLab token", async () => {
    let fetched = false;
    const publisher = new GitLabIssuePublisher({
      secrets: actorIdentitySecretStore(
        new EnvSecretStore({ GITLAB_TOKEN: "shared-token" }),
        { id: "user-1", name: "User", email: "user@example.com" },
        {},
      ),
      project: "example-org/tools/talos",
      fetch: async () => {
        fetched = true;
        return Response.json([]);
      },
    });

    await expect(
      publisher.createIssue({
        idempotencyKey: "feedback_missing",
        title: "[Bug]: Missing PAT",
        body: "Body",
        labels: ["bug"],
      }),
    ).rejects.toThrow("GITLAB_TOKEN");
    expect(fetched).toBe(false);
  });

  test("creates a labelled issue in the configured private project", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const publisher = new GitLabIssuePublisher({
      secrets: secrets("glpat-test"),
      project: "example-org/tools/talos",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") return Response.json([]);
        return Response.json(
          {
            iid: 27,
            web_url: "https://gitlab.com/example-org/tools/talos/-/issues/27",
          },
          { status: 201 },
        );
      },
    });

    await expect(
      publisher.createIssue({
        idempotencyKey: "feedback_123",
        title: "[Bug]: Save freezes",
        body: "Steps to reproduce",
        labels: ["bug"],
      }),
    ).resolves.toEqual({
      number: 27,
      url: "https://gitlab.com/example-org/tools/talos/-/issues/27",
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(
      "https://gitlab.com/api/v4/projects/example-org%2Ftools%2Ftalos/issues",
    );
    expect(calls[1]!.init?.method).toBe("POST");
    expect(new Headers(calls[1]!.init?.headers).get("private-token")).toBe(
      "glpat-test",
    );
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      title: "[Bug]: Save freezes",
      description: "Steps to reproduce\n\n<!-- automesh-feedback:feedback_123 -->",
      labels: "bug",
    });
  });

  test("uploads images to the project and embeds them in the issue description", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const publisher = new GitLabIssuePublisher({
      secrets: secrets("glpat-test"),
      project: "example-org/tools/talos",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") return Response.json([]);
        if (url.endsWith("/uploads")) {
          return Response.json({
            markdown: "![panel mobile](/uploads/asset-id/panel-mobile.png)",
          });
        }
        return Response.json(
          {
            iid: 28,
            web_url: "https://gitlab.com/example-org/tools/talos/-/issues/28",
          },
          { status: 201 },
        );
      },
    });

    await publisher.createIssue({
      idempotencyKey: "feedback_456",
      title: "[Bug]: Panel is clipped",
      body: "The panel is clipped.",
      bodySuffix: "---\nSubmitted through Automesh by Admin.",
      labels: ["bug"],
      attachments: [
        {
          name: "panel-mobile.png",
          contentType: "image/png",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    });

    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe(
      "https://gitlab.com/api/v4/projects/example-org%2Ftools%2Ftalos/uploads",
    );
    expect(new Headers(calls[1]!.init?.headers).get("private-token")).toBe(
      "glpat-test",
    );
    const form = calls[1]!.init?.body as FormData;
    const uploaded = form.get("file") as File;
    expect(uploaded.name).toBe("panel-mobile.png");
    expect(uploaded.type).toBe("image/png");
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({
      title: "[Bug]: Panel is clipped",
      description:
        "The panel is clipped.\n\n" +
        "![panel mobile](/uploads/asset-id/panel-mobile.png)\n\n" +
        "---\nSubmitted through Automesh by Admin.\n\n" +
        "<!-- automesh-feedback:feedback_456 -->",
      labels: "bug",
    });
  });

  test("reuses an issue found by the stable feedback marker", async () => {
    const calls: string[] = [];
    const publisher = new GitLabIssuePublisher({
      secrets: secrets("glpat-user"),
      project: "example-org/tools/talos",
      fetch: async (url) => {
        calls.push(url);
        return Response.json([
          {
            iid: 31,
            web_url: "https://gitlab.com/example-org/tools/talos/-/issues/31",
            description: "Saved\n\n<!-- automesh-feedback:feedback_789 -->",
          },
        ]);
      },
    });

    await expect(
      publisher.createIssue({
        idempotencyKey: "feedback_789",
        title: "[Bug]: Already created",
        body: "Saved",
        labels: ["bug"],
      }),
    ).resolves.toEqual({
      number: 31,
      url: "https://gitlab.com/example-org/tools/talos/-/issues/31",
    });
    expect(calls).toHaveLength(1);
  });

  test("lists open and closed project issues across pages and extracts feedback markers", async () => {
    const calls: string[] = [];
    const publisher = new GitLabIssuePublisher({
      secrets: secrets("glpat-admin"),
      project: "example-org/tools/talos",
      fetch: async (url) => {
        calls.push(url);
        const page = new URL(url).searchParams.get("page");
        if (page === "1") {
          return Response.json(
            [
              {
                iid: 41,
                web_url: "https://gitlab.com/example-org/tools/talos/-/issues/41",
                state: "opened",
                title: "[Bug]: First",
                description: "Body\n\n<!-- automesh-feedback:feedback_page_1 -->",
                labels: ["bug"],
                created_at: "2026-10-15T10:00:00.000Z",
                updated_at: "2026-10-15T10:01:00.000Z",
              },
            ],
            { headers: { "x-next-page": "2" } },
          );
        }
        return Response.json([
          {
            iid: 40,
            web_url: "https://gitlab.com/example-org/tools/talos/-/issues/40",
            state: "closed",
            title: "Unrelated project issue",
            description: null,
            labels: [],
            created_at: "2026-10-14T10:00:00.000Z",
            updated_at: "2026-10-14T11:00:00.000Z",
          },
        ]);
      },
    });

    await expect(publisher.listIssues()).resolves.toEqual([
      {
        number: 41,
        url: "https://gitlab.com/example-org/tools/talos/-/issues/41",
        state: "opened",
        title: "[Bug]: First",
        description: "Body\n\n<!-- automesh-feedback:feedback_page_1 -->",
        labels: ["bug"],
        createdAt: new Date("2026-10-15T10:00:00.000Z"),
        updatedAt: new Date("2026-10-15T10:01:00.000Z"),
        feedbackId: "feedback_page_1",
      },
      {
        number: 40,
        url: "https://gitlab.com/example-org/tools/talos/-/issues/40",
        state: "closed",
        title: "Unrelated project issue",
        description: "",
        labels: [],
        createdAt: new Date("2026-10-14T10:00:00.000Z"),
        updatedAt: new Date("2026-10-14T11:00:00.000Z"),
      },
    ]);
    expect(calls).toHaveLength(2);
  });
});
