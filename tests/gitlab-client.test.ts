import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_TRACE_BYTES,
  GitLabClient,
  GitLabConfigSchema,
  MAX_GITLAB_IMAGE_BYTES,
  encodeProject,
} from "../src/connectors/gitlab/client.ts";
import {
  AuthenticationError,
  ConfigError,
  ConnectorError,
  ValidationError,
} from "../src/core/errors.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { createGitLabClient } from "../src/connectors/gitlab/client.ts";
import { FakeHttp, type Route } from "./fixtures/http.ts";
import {
  GITLAB_PROJECT,
  GITLAB_USER,
  JOB_TRACE,
  PIPELINE_DETAIL,
  PIPELINE_SCHEDULE_DETAIL,
  PIPELINE_TEST_REPORT,
  PIPELINE_TEST_REPORT_SUMMARY,
  discussion,
  job,
  mergeRequest,
  pipeline,
} from "./fixtures/gitlab.ts";
import {
  isDraftMergeRequest,
  MergeRequestDiscussionSchema,
  MergeRequestSchema,
  mergeRequestProjectPath,
} from "../src/connectors/gitlab/types.ts";
import { toThread } from "../src/connectors/gitlab/pull-requests.ts";

const BASE = "https://gitlab.test/api/v4";

function harness(routes: Route[]) {
  const http = new FakeHttp(routes);
  return {
    http,
    gitlab: new GitLabClient({ token: "glpat-test", baseUrl: BASE, fetch: http.fetch }),
  };
}

/** `x-next-page` empty is how GitLab signals the last page. */
const LAST_PAGE = { "x-next-page": "" };

describe("encodeProject", () => {
  test("passes a numeric id through", () => {
    expect(encodeProject(42)).toBe("42");
    expect(encodeProject("42")).toBe("42");
  });

  test("URL-encodes a namespaced path, slash included", () => {
    // An unencoded slash yields a 404 that reads like a missing project.
    expect(encodeProject("acme/webportal")).toBe("acme%2Fwebportal");
    expect(encodeProject("acme/sub/deep")).toBe("acme%2Fsub%2Fdeep");
  });

  test("rejects values that cannot identify a project", () => {
    expect(() => encodeProject("")).toThrow(ConfigError);
    expect(() => encodeProject("  ")).toThrow(ConfigError);
    expect(() => encodeProject(0)).toThrow(ConfigError);
    expect(() => encodeProject(-1)).toThrow(ConfigError);
    expect(() => encodeProject(1.5)).toThrow(ConfigError);
  });
});

describe("GitLabClient", () => {
  test("requires a token", () => {
    expect(() => new GitLabClient({ token: "" })).toThrow(ConfigError);
  });

  test("authenticates with the PRIVATE-TOKEN header, never a query parameter", async () => {
    const { http, gitlab } = harness([{ match: "/api/v4/user", respond: { json: GITLAB_USER } }]);

    const user = await gitlab.currentUser();

    expect(user.username).toBe("talos-bot");
    expect(http.calls[0]?.headers["private-token"]).toBe("glpat-test");
    // Query strings reach access logs and error messages; headers do not.
    expect(http.calls[0]?.url.search).toBe("");
  });

  test("a bad token surfaces as AuthenticationError, which is not retried", async () => {
    const { gitlab } = harness([
      { match: "/api/v4/user", respond: { status: 401, json: { message: "401 Unauthorized" } } },
    ]);

    const err = await gitlab.currentUser().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.retryable).toBe(false);
    expect(err.connector).toBe("gitlab");
  });

  test("assigns a new merge request to the authenticated user by default", async () => {
    const { http, gitlab } = harness([
      { match: "/api/v4/user", respond: { json: GITLAB_USER } },
      {
        match: "/api/v4/projects/acme%2Fwebportal/merge_requests",
        method: "POST",
        respond: { json: mergeRequest() },
      },
    ]);

    await gitlab.createMergeRequest("acme/webportal", {
      sourceBranch: "feat/TP-42",
      targetBranch: "main",
      title: "TP-42 add checkout coverage",
      draft: true,
    });

    expect(http.calls).toHaveLength(2);
    expect(JSON.parse(http.calls[1]!.body!)).toMatchObject({
      source_branch: "feat/TP-42",
      target_branch: "main",
      title: "Draft: TP-42 add checkout coverage",
      assignee_id: GITLAB_USER.id,
    });
  });

  test("uses an explicitly selected merge request assignee without resolving the current user", async () => {
    const { http, gitlab } = harness([
      {
        match: "/api/v4/projects/42/merge_requests",
        method: "POST",
        respond: { json: mergeRequest() },
      },
    ]);

    await gitlab.createMergeRequest(42, {
      sourceBranch: "release/42",
      targetBranch: "main",
      title: "Release 42",
      assigneeId: 9001,
    });

    expect(http.calls).toHaveLength(1);
    expect(JSON.parse(http.calls[0]!.body!)).toMatchObject({ assignee_id: 9001 });
  });

  test("uses GitLab's current auto-merge parameter", async () => {
    const { http, gitlab } = harness([
      {
        match: "/api/v4/projects/acme%2Fwebportal/merge_requests/6193/merge",
        method: "PUT",
        respond: {
          json: mergeRequest({ merge_when_pipeline_succeeds: true }),
        },
      },
    ]);

    const result = await gitlab.mergeMergeRequest(
      "acme/webportal",
      6193,
      { autoMerge: true },
    );

    expect(JSON.parse(http.calls[0]!.body!)).toEqual({ auto_merge: true });
    expect(result.merge_when_pipeline_succeeds).toBe(true);
  });

  test("downloads a Markdown image through the authenticated project API", async () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const { http, gitlab } = harness([
      {
        match: `/api/v4/projects/acme%2Fwebportal/uploads/${secret}/screen%20shot.png`,
        respond: { bytes, headers: { "content-type": "image/png" } },
      },
    ]);

    const upload = await gitlab.markdownUpload(
      "acme/webportal",
      secret,
      "screen shot.png",
    );

    expect(upload).toEqual({ body: bytes, contentType: "image/png", filename: "screen shot.png" });
    expect(http.calls[0]?.headers["private-token"]).toBe("glpat-test");
    expect(http.calls[0]?.headers.accept).toBe("image/*");
  });

  test("recognizes PNG bytes when GitLab reports a generic binary content type", async () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const { gitlab } = harness([
      {
        match: `/api/v4/projects/acme%2Fwebportal/uploads/${secret}/screen.png`,
        respond: { bytes, headers: { "content-type": "application/octet-stream" } },
      },
    ]);

    const upload = await gitlab.markdownUpload("acme/webportal", secret, "screen.png");

    expect(upload.contentType).toBe("image/png");
    expect(upload.body).toEqual(bytes);
  });

  test("falls back to the authenticated project upload URL on older GitLab versions", async () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const { http, gitlab } = harness([
      {
        match: `/api/v4/projects/acme%2Fwebportal/uploads/${secret}/screen.png`,
        respond: { status: 400, json: { message: "Unsupported endpoint" } },
      },
      {
        match: `/acme/webportal/uploads/${secret}/screen.png`,
        respond: { bytes, headers: { "content-type": "image/png" } },
      },
    ]);

    const upload = await gitlab.markdownUpload("acme/webportal", secret, "screen.png");

    expect(upload.body).toEqual(bytes);
    expect(http.calls[1]?.headers.authorization).toBe("Bearer glpat-test");
    expect(http.calls[1]?.headers["private-token"]).toBe("glpat-test");
  });

  test("refuses to proxy a Markdown upload that is not an image", async () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const { gitlab } = harness([
      {
        match: `/api/v4/projects/acme%2Fwebportal/uploads/${secret}/payload.html`,
        respond: { text: "<script>bad()</script>", headers: { "content-type": "text/html" } },
      },
    ]);

    await expect(
      gitlab.markdownUpload("acme/webportal", secret, "payload.html"),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  test("refuses generic binary content without a recognized image signature", async () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const { gitlab } = harness([
      {
        match: `/api/v4/projects/acme%2Fwebportal/uploads/${secret}/payload.bin`,
        respond: {
          bytes: new Uint8Array([0, 1, 2, 3]),
          headers: { "content-type": "application/octet-stream" },
        },
      },
    ]);

    await expect(
      gitlab.markdownUpload("acme/webportal", secret, "payload.bin"),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  describe("jobArtifactFile", () => {
    test("encodes every safe artifact path segment and returns a declared PNG", async () => {
      const bytes = new Uint8Array([137, 80, 78, 71]);
      const { http, gitlab } = harness([
        {
          match:
            "/api/v4/projects/acme%2Fwebportal/jobs/7001/artifacts/" +
            "web/target/screen%20shots/failure%20%231.png",
          respond: { bytes, headers: { "content-type": "image/png; charset=binary" } },
        },
      ]);

      const artifact = await gitlab.jobArtifactFile(
        "acme/webportal",
        7001,
        "web/target/screen shots/failure #1.png",
      );

      expect(http.calls[0]?.url.pathname).toBe(
        "/api/v4/projects/acme%2Fwebportal/jobs/7001/artifacts/" +
          "web/target/screen%20shots/failure%20%231.png",
      );
      expect(artifact).toEqual({
        body: bytes,
        contentType: "image/png",
        filename: "failure #1.png",
      });
    });

    test("sniffs a raster image when GitLab declares octet-stream", async () => {
      const bytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]);
      const { gitlab } = harness([
        {
          match: "/api/v4/projects/42/jobs/7001/artifacts/screenshots/failure.webp",
          respond: { bytes, headers: { "content-type": "application/octet-stream" } },
        },
      ]);

      const artifact = await gitlab.jobArtifactFile(
        42,
        7001,
        "screenshots/failure.webp",
      );

      expect(artifact.contentType).toBe("image/webp");
      expect(artifact.body).toEqual(bytes);
    });

    test("rejects SVG, HTML, and generic non-image artifact responses", async () => {
      for (const [filename, contentType, bytes] of [
        ["failure.svg", "image/svg+xml", new TextEncoder().encode("<svg/>")],
        ["failure.html", "text/html", new TextEncoder().encode("<script/>")],
        ["failure.bin", "application/octet-stream", new Uint8Array([0, 1, 2, 3])],
      ] as const) {
        const { gitlab } = harness([
          {
            match: `/api/v4/projects/42/jobs/7001/artifacts/screenshots/${filename}`,
            respond: { bytes, headers: { "content-type": contentType } },
          },
        ]);

        await expect(
          gitlab.jobArtifactFile(42, 7001, `screenshots/${filename}`),
        ).rejects.toBeInstanceOf(ConnectorError);
      }
    });

    test("rejects an artifact response truncated at the 20 MiB limit", async () => {
      const bytes = new Uint8Array(MAX_GITLAB_IMAGE_BYTES + 1);
      const { gitlab } = harness([
        {
          match: "/api/v4/projects/42/jobs/7001/artifacts/screenshots/failure.png",
          respond: { bytes, headers: { "content-type": "image/png" } },
        },
      ]);

      await expect(
        gitlab.jobArtifactFile(42, 7001, "screenshots/failure.png"),
      ).rejects.toThrow(/20.*byte limit|20971520-byte limit/);
    });

    test("rejects unsafe artifact path segments before making a request", async () => {
      const { http, gitlab } = harness([]);

      for (const path of ["../secret.png", "screenshots//failure.png", "a\\b.png"]) {
        await expect(gitlab.jobArtifactFile(42, 7001, path)).rejects.toBeInstanceOf(
          ConfigError,
        );
      }
      expect(http.calls).toHaveLength(0);
    });
  });

  test("reads a project, tolerating fields we do not model", async () => {
    const { gitlab } = harness([
      { match: "/api/v4/projects/acme%2Fwebportal", respond: { json: GITLAB_PROJECT } },
    ]);

    const project = await gitlab.project("acme/webportal");
    expect(project).toMatchObject({ id: 42, path_with_namespace: "acme/webportal" });
  });

  describe("listPipelines", () => {
    test("passes the watermark as updated_after and orders oldest first", async () => {
      const since = new Date("2026-08-20T10:00:00.000Z");
      const { http, gitlab } = harness([
        {
          match: /\/pipelines/,
          respond: { json: [pipeline()], headers: LAST_PAGE },
        },
      ]);

      await gitlab.listPipelines({ project: 42, updatedAfter: since, ref: "main" });

      const query = http.calls[0]!.url.searchParams;
      // Filtering server-side keeps the response small; filtering here would not.
      expect(query.get("updated_after")).toBe(since.toISOString());
      expect(query.get("ref")).toBe("main");
      // Ascending, so a capped run does not strand older pipelines behind the
      // watermark it is about to advance.
      expect(query.get("sort")).toBe("asc");
      expect(query.get("order_by")).toBe("updated_at");
    });

    test("fetches descending when newestFirst is set", async () => {
      const { http, gitlab } = harness([
        { match: /\/pipelines/, respond: { json: [pipeline()], headers: LAST_PAGE } },
      ]);

      await gitlab.listPipelines({ project: 42, limit: 5, newestFirst: true });

      // A capped ascending query returns the *start* of history, so no amount of
      // client-side trimming reaches the recent end — the sort has to change.
      expect(http.calls[0]!.url.searchParams.get("sort")).toBe("desc");
    });

    test("returns oldest-first even when fetched descending", async () => {
      const older = pipeline({ id: 1, updated_at: "2026-08-01T00:00:00.000Z" });
      const newer = pipeline({ id: 2, updated_at: "2026-08-20T00:00:00.000Z" });
      const { gitlab } = harness([
        // As the API returns them for sort=desc.
        { match: /\/pipelines/, respond: { json: [newer, older], headers: LAST_PAGE } },
      ]);

      const out = await gitlab.listPipelines({ project: 42, newestFirst: true });

      // newestFirst changes which end a cap keeps, not the order returned —
      // callers rely on ascending regardless.
      expect(out.map((p) => p.id)).toEqual([1, 2]);
    });

    test("newestFirst keeps the newest when the limit bites", async () => {
      const pipelines = [
        pipeline({ id: 1, updated_at: "2026-08-01T00:00:00.000Z" }),
        pipeline({ id: 2, updated_at: "2026-08-02T00:00:00.000Z" }),
        pipeline({ id: 3, updated_at: "2026-08-03T00:00:00.000Z" }),
      ];
      const { gitlab } = harness([
        { match: /\/pipelines/, respond: { json: pipelines, headers: LAST_PAGE } },
      ]);

      const newest = await gitlab.listPipelines({ project: 42, limit: 2, newestFirst: true });
      expect(newest.map((p) => p.id)).toEqual([2, 3]);
    });

    test("without newestFirst the limit keeps the oldest, for the watermark", async () => {
      const pipelines = [
        pipeline({ id: 1, updated_at: "2026-08-01T00:00:00.000Z" }),
        pipeline({ id: 2, updated_at: "2026-08-02T00:00:00.000Z" }),
        pipeline({ id: 3, updated_at: "2026-08-03T00:00:00.000Z" }),
      ];
      const { gitlab } = harness([
        { match: /\/pipelines/, respond: { json: pipelines, headers: LAST_PAGE } },
      ]);

      // The poller must not skip past unprocessed pipelines it has not advanced
      // its watermark beyond.
      const oldest = await gitlab.listPipelines({ project: 42, limit: 2 });
      expect(oldest.map((p) => p.id)).toEqual([1, 2]);
    });

    test("omits filters that were not supplied", async () => {
      const { http, gitlab } = harness([
        { match: /\/pipelines/, respond: { json: [], headers: LAST_PAGE } },
      ]);

      await gitlab.listPipelines({ project: 42 });

      const query = http.calls[0]!.url.searchParams;
      expect(query.has("updated_after")).toBe(false);
      expect(query.has("ref")).toBe(false);
      expect(query.has("status")).toBe(false);
    });

    test("parses timestamps into Dates at the boundary", async () => {
      const { gitlab } = harness([
        { match: /\/pipelines/, respond: { json: [pipeline()], headers: LAST_PAGE } },
      ]);

      const [first] = await gitlab.listPipelines({ project: 42 });
      // Tasks compare against a watermark Date; string comparison would be
      // a silent lexicographic bug across timezone formats.
      expect(first!.updated_at).toBeInstanceOf(Date);
      expect(first!.updated_at.toISOString()).toBe("2026-08-20T10:02:11.000Z");
    });

    test("follows x-next-page until GitLab says there is no more", async () => {
      const { http, gitlab } = harness([
        {
          match: /\/pipelines/,
          respond: (call) =>
            call.routeCallCount === 1
              ? { json: [pipeline({ id: 1 }), pipeline({ id: 2 })], headers: { "x-next-page": "2" } }
              : { json: [pipeline({ id: 3 })], headers: LAST_PAGE },
        },
      ]);

      const pipelines = await gitlab.listPipelines({ project: 42, limit: 100 });

      expect(pipelines.map((p) => p.id)).toEqual([1, 2, 3]);
      expect(http.calls).toHaveLength(2);
      expect(http.calls[1]!.url.searchParams.get("page")).toBe("2");
    });

    test("stops paging once the limit is reached", async () => {
      const { http, gitlab } = harness([
        {
          match: /\/pipelines/,
          // A route that always claims another page: only `limit` stops this.
          respond: { json: [pipeline({ id: 1 }), pipeline({ id: 2 })], headers: { "x-next-page": "2" } },
        },
      ]);

      const pipelines = await gitlab.listPipelines({ project: 42, limit: 2 });

      expect(pipelines).toHaveLength(2);
      expect(http.calls).toHaveLength(1);
    });

    test("a page count that will not terminate is bounded, not walked forever", async () => {
      const { http, gitlab } = harness([
        {
          match: /\/pipelines/,
          respond: { json: [pipeline()], headers: { "x-next-page": "99" } },
        },
      ]);

      // A wrong updated_after must not turn into thousands of pipelines in one
      // poll; MAX_PAGES is the backstop.
      const pipelines = await gitlab.listPipelines({ project: 42, limit: 10_000 });
      expect(http.calls.length).toBeLessThanOrEqual(20);
      expect(pipelines.length).toBe(http.calls.length);
    });

    test("listFailedPipelines asks GitLab for failed only", async () => {
      const { http, gitlab } = harness([
        { match: /\/pipelines/, respond: { json: [], headers: LAST_PAGE } },
      ]);

      await gitlab.listFailedPipelines({ project: 42 });
      expect(http.calls[0]!.url.searchParams.get("status")).toBe("failed");
    });

    test("an unknown pipeline status fails at the boundary instead of silently", async () => {
      const { gitlab } = harness([
        {
          match: /\/pipelines/,
          respond: { json: [pipeline({ status: "teleported" })], headers: LAST_PAGE },
        },
      ]);

      const err = await gitlab.listPipelines({ project: 42 }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
    });
  });

  test("pipeline detail includes the commit and the triggering user", async () => {
    const { gitlab } = harness([
      { match: "/api/v4/projects/42/pipelines/9001", respond: { json: PIPELINE_DETAIL } },
    ]);

    const detail = await gitlab.pipeline(42, 9001);
    expect(detail.commit?.title).toBe("Tighten checkout validation");
    expect(detail.user?.username).toBe("adevs");
    expect(detail.finished_at).toBeInstanceOf(Date);
  });

  test("reads schedule detail metadata and its last pipeline", async () => {
    const { http, gitlab } = harness([
      {
        match: "/api/v4/projects/acme%2Fwebportal/pipeline_schedules/22",
        respond: { json: PIPELINE_SCHEDULE_DETAIL },
      },
    ]);

    const schedule = await gitlab.schedule("acme/webportal", 22);

    expect(http.calls[0]?.url.search).toBe("");
    expect(schedule.next_run_at).toBeInstanceOf(Date);
    expect(schedule.next_run_at?.toISOString()).toBe("2026-09-25T02:00:00.000Z");
    expect(schedule.last_pipeline).toMatchObject({ id: 9001, status: "failed" });
  });

  test("lists a schedule's pipelines with server-side filters and a bounded page size", async () => {
    const updatedAfter = new Date("2026-09-20T00:00:00.000Z");
    const updatedBefore = new Date("2026-09-25T00:00:00.000Z");
    const createdAfter = new Date("2026-09-19T00:00:00.000Z");
    const createdBefore = new Date("2026-09-24T00:00:00.000Z");
    const newer = pipeline({ id: 2, updated_at: "2026-09-23T00:00:00.000Z" });
    const older = pipeline({ id: 1, updated_at: "2026-09-22T00:00:00.000Z" });
    const { http, gitlab } = harness([
      {
        match: /\/pipeline_schedules\/22\/pipelines$/,
        respond: (call) =>
          call.routeCallCount === 1
            ? { json: [newer], headers: { "x-next-page": "2" } }
            : { json: [older], headers: { "x-next-page": "3" } },
      },
    ]);

    const pipelines = await gitlab.listSchedulePipelines(42, 22, {
      updatedAfter,
      updatedBefore,
      createdAfter,
      createdBefore,
      status: "failed",
      newestFirst: true,
      limit: 2,
    });

    const query = http.calls[0]!.url.searchParams;
    expect(http.calls[0]!.url.pathname).toBe(
      "/api/v4/projects/42/pipeline_schedules/22/pipelines",
    );
    expect(query.get("updated_after")).toBe(updatedAfter.toISOString());
    expect(query.get("updated_before")).toBe(updatedBefore.toISOString());
    expect(query.get("created_after")).toBe(createdAfter.toISOString());
    expect(query.get("created_before")).toBe(createdBefore.toISOString());
    expect(query.get("status")).toBe("failed");
    expect(query.get("sort")).toBe("desc");
    expect(query.get("per_page")).toBe("2");
    expect(http.calls[1]!.url.searchParams.get("page")).toBe("2");
    expect(http.calls[1]!.url.searchParams.get("per_page")).toBe("1");
    expect(http.calls).toHaveLength(2);
    expect(pipelines.map((item) => item.id)).toEqual([1, 2]);
  });

  test("parses a pipeline test report summary", async () => {
    const { http, gitlab } = harness([
      {
        match: "/api/v4/projects/42/pipelines/9001/test_report_summary",
        respond: { json: PIPELINE_TEST_REPORT_SUMMARY, headers: LAST_PAGE },
      },
    ]);

    const summary = await gitlab.pipelineTestReportSummary(42, 9001);

    expect(http.calls[0]?.url.pathname).toBe(
      "/api/v4/projects/42/pipelines/9001/test_report_summary",
    );
    expect(http.calls[0]?.url.searchParams.get("per_page")).toBe("100");
    expect(summary.total).toMatchObject({ count: 3, failed: 1, skipped: 1 });
    expect(summary.test_suites[0]).toMatchObject({
      name: "unit",
      build_ids: [7001],
      failed_count: 1,
    });
  });

  test("parses a full pipeline test report and its test cases", async () => {
    const { http, gitlab } = harness([
      {
        match: "/api/v4/projects/acme%2Fwebportal/pipelines/9001/test_report",
        respond: { json: PIPELINE_TEST_REPORT, headers: LAST_PAGE },
      },
    ]);

    const report = await gitlab.pipelineTestReport("acme/webportal", 9001);

    expect(http.calls[0]?.url.pathname).toBe(
      "/api/v4/projects/acme%2Fwebportal/pipelines/9001/test_report",
    );
    expect(report).toMatchObject({ total_count: 3, failed_count: 1 });
    expect(report.test_suites[0]?.test_cases[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        classname: "checkout",
        file: "web/tests/checkout.test.ts",
        attachment_url:
          "https://gitlab.com/example-org/qa/test-automation/-/jobs/16698778194/artifacts/file/web/target/screenshots/foo.png",
        execution_time: 0.12,
        stack_trace: "at tests/checkout.test.ts:41:29",
      }),
    );
    expect(report.test_suites[0]?.test_cases[1]?.system_output).toBeNull();
    expect(report.test_suites[0]?.test_cases[2]?.system_output).toBe(
      "Feature flag is disabled",
    );
  });

  describe("scheduleDescription", () => {
    const SCHEDULES = [
      { id: 11, description: "test", ref: "refs/heads/develop", active: false },
      // With a trailing space, as gitlab.com actually returns for this project —
      // invisible in the UI and easy to save by accident.
      {
        id: 22,
        description: "Scheduled pipeline for webportal tests ",
        ref: "refs/heads/develop",
        active: true,
      },
    ];

    test("resolves a description to the schedule's own pipelines endpoint", async () => {
      const { http, gitlab } = harness([
        { match: /\/pipeline_schedules$/, respond: { json: SCHEDULES, headers: LAST_PAGE } },
        {
          match: /\/pipeline_schedules\/22\/pipelines/,
          respond: { json: [pipeline()], headers: LAST_PAGE },
        },
      ]);

      const out = await gitlab.listPipelines({
        project: 42,
        scheduleDescription: "Scheduled pipeline for webportal tests",
      });

      // The list endpoint's `name` is null unless a project sets workflow:name:,
      // so a schedule can only be targeted through its own endpoint.
      expect(out).toHaveLength(1);
      expect(http.calls[1]!.url.pathname).toContain("/pipeline_schedules/22/pipelines");
    });

    test("matches trimmed, so an invisible trailing space is not a dead end", async () => {
      const { gitlab } = harness([
        { match: /\/pipeline_schedules$/, respond: { json: SCHEDULES, headers: LAST_PAGE } },
        {
          match: /\/pipeline_schedules\/22\/pipelines/,
          respond: { json: [], headers: LAST_PAGE },
        },
      ]);

      const schedule = await gitlab.scheduleByDescription(
        42,
        "Scheduled pipeline for webportal tests",
      );
      expect(schedule.id).toBe(22);
    });

    test("passes status to the schedule endpoint instead of scanning all statuses", async () => {
      const { http, gitlab } = harness([
        { match: /\/pipeline_schedules$/, respond: { json: SCHEDULES, headers: LAST_PAGE } },
        {
          match: /\/pipeline_schedules\/22\/pipelines/,
          respond: {
            json: [pipeline({ id: 2, status: "failed" })],
            headers: LAST_PAGE,
          },
        },
      ]);

      const out = await gitlab.listFailedPipelines({
        project: 42,
        scheduleDescription: "Scheduled pipeline for webportal tests",
      });

      expect(out.map((p) => p.id)).toEqual([2]);
      expect(http.calls[1]!.url.searchParams.get("status")).toBe("failed");
    });

    test("names the known schedules when the description matches none", async () => {
      const { gitlab } = harness([
        { match: /\/pipeline_schedules$/, respond: { json: SCHEDULES, headers: LAST_PAGE } },
      ]);

      // A typo should be answerable from the error alone.
      await expect(gitlab.scheduleByDescription(42, "nightly")).rejects.toThrow(
        /Known schedules: 'test', 'Scheduled pipeline for webportal tests'/,
      );
    });

    test("refuses to guess between two schedules with the same description", async () => {
      const { gitlab } = harness([
        {
          match: /\/pipeline_schedules$/,
          respond: {
            json: [
              { id: 1, description: "nightly", ref: "main" },
              { id: 2, description: "nightly", ref: "develop" },
            ],
            headers: LAST_PAGE,
          },
        },
      ]);

      await expect(gitlab.scheduleByDescription(42, "nightly")).rejects.toThrow(ConfigError);
    });
  });

  describe("listFailedJobs", () => {
    test("keeps genuinely failed jobs and drops the rest", async () => {
      const { http, gitlab } = harness([
        {
          match: /\/jobs$/,
          respond: {
            json: [
              job({ id: 7001, name: "test:unit", status: "failed" }),
              job({ id: 7002, name: "build", status: "success" }),
              job({ id: 7003, name: "deploy", status: "skipped" }),
            ],
            headers: LAST_PAGE,
          },
        },
      ]);

      const failed = await gitlab.listFailedJobs(42, 9001);

      expect(failed.map((j) => j.id)).toEqual([7001]);
      // Retried jobs are excluded server-side, so a job that failed then passed
      // on retry never reaches us.
      expect(http.calls[0]!.url.searchParams.get("include_retried")).toBe("false");
    });

    test("excludes allow_failure jobs, which failed by design", async () => {
      const { gitlab } = harness([
        {
          match: /\/jobs$/,
          respond: {
            json: [
              job({ id: 7001, name: "lint", status: "failed", allow_failure: true }),
              job({ id: 7002, name: "test:unit", status: "failed", allow_failure: false }),
            ],
            headers: LAST_PAGE,
          },
        },
      ]);

      // The pipeline did not fail because of the allowed failure; putting it in a
      // ticket buries the real cause.
      const failed = await gitlab.listFailedJobs(42, 9001);
      expect(failed.map((j) => j.name)).toEqual(["test:unit"]);
    });

    test("includes allow_failure jobs on request", async () => {
      const { gitlab } = harness([
        {
          match: /\/jobs$/,
          respond: {
            json: [
              job({ id: 7001, name: "Unit Test", status: "failed", allow_failure: true }),
              job({ id: 7002, name: "build", status: "success" }),
            ],
            headers: LAST_PAGE,
          },
        },
      ]);

      // A test job marked allow_failure so it never blocks a deploy is a common
      // setup, and there the failing job is the only thing worth a ticket — the
      // pipeline reports success while the tests are broken.
      const failed = await gitlab.listFailedJobs(42, 9001, {
        includeAllowedFailures: true,
      });
      expect(failed.map((j) => j.name)).toEqual(["Unit Test"]);
    });

    test("carries failure_reason through, so infrastructure noise is separable", async () => {
      const { gitlab } = harness([
        {
          match: /\/jobs$/,
          respond: {
            json: [job({ failure_reason: "runner_system_failure" })],
            headers: LAST_PAGE,
          },
        },
      ]);

      const [failed] = await gitlab.listFailedJobs(42, 9001);
      expect(failed!.failure_reason).toBe("runner_system_failure");
    });

    test("pages through jobs", async () => {
      const { gitlab } = harness([
        {
          match: /\/jobs$/,
          respond: (call) =>
            call.routeCallCount === 1
              ? { json: [job({ id: 1 })], headers: { "x-next-page": "2" } }
              : { json: [job({ id: 2 })], headers: LAST_PAGE },
        },
      ]);

      expect((await gitlab.listJobs(42, 9001)).map((j) => j.id)).toEqual([1, 2]);
    });
  });

  test("retryJob posts to the failed job retry endpoint", async () => {
    const { gitlab } = harness([
      {
        match: "/api/v4/projects/acme%2Fweb/jobs/7001/retry",
        method: "POST",
        respond: {
          json: job({
            id: 8001,
            status: "pending",
            web_url: "https://gitlab.test/jobs/8001",
          }),
        },
      },
    ]);

    const retried = await gitlab.retryJob("acme/web", 7001);
    expect(retried).toMatchObject({
      id: 8001,
      status: "pending",
      web_url: "https://gitlab.test/jobs/8001",
    });
  });

  describe("jobTrace", () => {
    test("returns the whole log when it fits", async () => {
      const { http, gitlab } = harness([
        { match: "/api/v4/projects/42/jobs/7001/trace", respond: { text: JOB_TRACE } },
      ]);

      const trace = await gitlab.jobTrace(42, { id: 7001, name: "test:unit" });

      expect(trace.truncated).toBe(false);
      expect(trace.text).toContain("Expected: 90");
      expect(trace.jobName).toBe("test:unit");
      expect(http.calls[0]?.headers.accept).toBe("text/plain");
    });

    test("truncates at fetch, keeping the head and the failing tail", async () => {
      // 4MB of noise around the two lines that matter.
      const body = `SETUP LINE\n${"noise ".repeat(700_000)}\nERROR: Job failed: exit status 1\n`;
      const { gitlab } = harness([
        { match: /\/trace$/, respond: { text: body } },
      ]);

      const trace = await gitlab.jobTrace(42, { id: 7001, name: "test:unit" }, { maxBytes: 2_000 });

      expect(trace.truncated).toBe(true);
      expect(trace.bytes).toBeGreaterThan(4_000_000);
      // Truncation here rather than at the LLM step protects the SQLite row and
      // the Jira description too, not only the token budget.
      expect(new TextEncoder().encode(trace.text).byteLength).toBeLessThan(2_200);
      expect(trace.text).toContain("SETUP LINE");
      expect(trace.text).toContain("ERROR: Job failed");
    });

    test("defaults to a cap rather than unbounded", async () => {
      const { gitlab } = harness([
        { match: /\/trace$/, respond: { text: "z".repeat(DEFAULT_MAX_TRACE_BYTES + 5_000) } },
      ]);

      const trace = await gitlab.jobTrace(42, { id: 7001, name: "j" });
      expect(trace.truncated).toBe(true);
    });
  });

  describe("jobTraces", () => {
    test("caps each job and reports the aggregate", async () => {
      const { gitlab } = harness([
        { match: /\/trace$/, respond: { text: "a".repeat(5_000) } },
      ]);

      const { traces, omittedJobs } = await gitlab.jobTraces(
        42,
        [
          { id: 1, name: "a" },
          { id: 2, name: "b" },
        ],
        { maxBytesPerJob: 1_000 },
      );

      expect(traces).toHaveLength(2);
      expect(omittedJobs).toBe(0);
      expect(traces.every((t) => t.truncated)).toBe(true);
    });

    test("stops once the total budget is spent and says how many it skipped", async () => {
      const { gitlab } = harness([
        { match: /\/trace$/, respond: { text: "a".repeat(50_000) } },
      ]);

      const { traces, omittedJobs } = await gitlab.jobTraces(
        42,
        [
          { id: 1, name: "a" },
          { id: 2, name: "b" },
          { id: 3, name: "c" },
        ],
        { maxBytesPerJob: 10_000, maxTotalBytes: 12_000 },
      );

      // Reported, not inferred from a short list: a caller that silently drops
      // jobs produces a ticket that looks complete and is not.
      expect(traces.length).toBeLessThan(3);
      expect(omittedJobs).toBe(3 - traces.length);
    });
  });

  describe("check", () => {
    test("reports the authenticated identity and project access", async () => {
      const { gitlab } = harness([
        { match: "/api/v4/user", respond: { json: GITLAB_USER } },
        { match: "/api/v4/projects/42", respond: { json: GITLAB_PROJECT } },
        { match: /\/pipelines/, respond: { json: [pipeline()], headers: LAST_PAGE } },
      ]);

      const health = await gitlab.check({ project: 42 });

      expect(health.ok).toBe(true);
      expect(health.checks.map((c) => c.name)).toEqual([
        "authentication",
        "project access",
        "pipeline read (read_api)",
      ]);
      expect(health.checks[0]!.detail).toContain("talos-bot");
      expect(health.checks[1]!.detail).toContain("acme/webportal");
    });

    test("reports every failure, not just the first", async () => {
      const { gitlab } = harness([
        { match: "/api/v4/user", respond: { json: GITLAB_USER } },
        { match: "/api/v4/projects/42", respond: { status: 404, json: { message: "404 Not found" } } },
        { match: /\/pipelines/, respond: { status: 403, json: { message: "insufficient scope" } } },
      ]);

      const health = await gitlab.check({ project: 42 });

      // An operator with a wrong project id and a token missing read_api should
      // learn both in one run.
      expect(health.ok).toBe(false);
      expect(health.checks.filter((c) => !c.ok)).toHaveLength(2);
      expect(health.checks[2]!.detail).toContain("insufficient scope");
    });

    test("a bad token stops the report instead of repeating the same 401", async () => {
      // No project or pipeline routes are registered: FakeHttp throws on an
      // unstubbed call, so this fails loudly if check() tries them anyway.
      const { http, gitlab } = harness([
        { match: "/api/v4/user", respond: { status: 401, json: { message: "401 Unauthorized" } } },
      ]);

      const health = await gitlab.check({ project: 42 });

      expect(health.ok).toBe(false);
      expect(health.checks[0]!.detail).toContain("401");
      expect(health.checks[1]!.detail).toContain("fix authentication first");
      expect(http.calls).toHaveLength(1);
    });

    test("says so plainly when no project is configured", async () => {
      const { gitlab } = harness([{ match: "/api/v4/user", respond: { json: GITLAB_USER } }]);

      const health = await gitlab.check();
      expect(health.ok).toBe(true);
      expect(health.checks[1]!.detail).toContain("skipped");
    });

    test("an empty project reads as healthy, not broken", async () => {
      const { gitlab } = harness([
        { match: "/api/v4/user", respond: { json: GITLAB_USER } },
        { match: "/api/v4/projects/42", respond: { json: GITLAB_PROJECT } },
        { match: /\/pipelines/, respond: { json: [], headers: LAST_PAGE } },
      ]);

      const health = await gitlab.check({ project: 42 });
      expect(health.ok).toBe(true);
      expect(health.checks[2]!.detail).toContain("no pipelines yet");
    });
  });

  test("pages merge request diffs the way the Changes tab does", async () => {
    const { gitlab } = harness([
      {
        match: /\/merge_requests\/6193\/diffs/,
        respond: (call) =>
          call.routeCallCount === 1
            ? {
                json: [{ old_path: "a.ts", new_path: "a.ts", diff: "+one\n" }],
                headers: { "x-next-page": "2" },
              }
            : {
                json: [{ old_path: "b.ts", new_path: "b.ts", diff: "+two\n" }],
                headers: LAST_PAGE,
              },
      },
    ]);

    const diffs = await gitlab.mergeRequestDiffs("acme/webportal", 6193);
    expect(diffs.map((d) => d.new_path)).toEqual(["a.ts", "b.ts"]);
  });

  test("lists every commit on a merge request", async () => {
    const { gitlab } = harness([
      {
        match: /\/merge_requests\/6193\/commits/,
        respond: {
          json: [
            { id: "aaa", short_id: "aaa", title: "fix 1" },
            { id: "bbb", short_id: "bbb", title: "fix 2" },
          ],
          headers: LAST_PAGE,
        },
      },
    ]);

    const commits = await gitlab.mergeRequestCommits(42, 6193);
    expect(commits).toHaveLength(2);
    expect(commits[1]?.title).toBe("fix 2");
  });

  test("lists the pipelines associated with a merge request", async () => {
    const { http, gitlab } = harness([
      {
        match: /\/merge_requests\/6193\/pipelines/,
        respond: {
          json: [
            {
              id: 901,
              project_id: 42,
              status: "success",
              ref: "fix/TP-3012",
              sha: "abcdef123456",
              web_url: "https://gitlab.example/pipelines/901",
              updated_at: "2026-09-12T10:00:00.000Z",
            },
          ],
          headers: LAST_PAGE,
        },
      },
    ]);

    const pipelines = await gitlab.mergeRequestPipelines(42, 6193, { limit: 5 });
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.status).toBe("success");
    expect(http.calls[0]?.url.toString()).toContain("/merge_requests/6193/pipelines");
    expect(http.calls[0]?.url.toString()).toContain("per_page=5");
  });

  test("updates an existing merge request note", async () => {
    const { http, gitlab } = harness([
      {
        match: /\/merge_requests\/6193\/notes\/99$/,
        method: "PUT",
        respond: {
          json: {
            id: 99,
            body: "done",
            created_at: "2026-08-25T10:00:00.000Z",
          },
        },
      },
    ]);

    const note = await gitlab.updateMergeRequestNote("acme/webportal", 6193, 99, "done");
    expect(note.id).toBe(99);
    expect(http.calls[0]?.method).toBe("PUT");
    expect(http.calls[0]?.body).toContain("done");
  });

  test("counts every open project merge request without downloading the collection", async () => {
    const { http, gitlab } = harness([
      {
        match: "/api/v4/projects/acme%2Fwebportal/merge_requests",
        respond: {
          json: [mergeRequest()],
          headers: { "x-total": "4", "x-next-page": "2" },
        },
      },
    ]);

    expect(await gitlab.countOpenMergeRequests("acme/webportal")).toBe(4);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url.searchParams.get("state")).toBe("opened");
    expect(http.calls[0]?.url.searchParams.get("per_page")).toBe("1");
  });

  test("lists merge requests the token user is reviewing, not their own", async () => {
    const { http, gitlab } = harness([
      {
        match: "/api/v4/merge_requests",
        respond: { json: [mergeRequest()], headers: LAST_PAGE },
      },
    ]);

    const mrs = await gitlab.listMergeRequestsForReview();
    expect(mrs).toHaveLength(1);
    expect(mrs[0]?.iid).toBe(6193);
    expect(http.calls[0]?.url.searchParams.get("scope")).toBe("reviews_for_me");
    expect(http.calls[0]?.url.searchParams.get("state")).toBe("opened");
    expect(http.calls[0]?.url.searchParams.get("wip")).toBe("no");
    expect(http.calls[0]?.url.pathname).toBe("/api/v4/merge_requests");
  });

  test("drops draft merge requests that GitLab still returned", async () => {
    const { gitlab } = harness([
      {
        match: "/api/v4/merge_requests",
        respond: {
          json: [
            mergeRequest({ iid: 1, draft: true, work_in_progress: true }),
            mergeRequest({ iid: 2, draft: false, work_in_progress: false }),
          ],
          headers: LAST_PAGE,
        },
      },
    ]);

    const mrs = await gitlab.listMergeRequestsForReview();
    expect(mrs.map((mr) => mr.iid)).toEqual([2]);
  });

  test("pages review-request listings", async () => {
    const { gitlab } = harness([
      {
        match: "/api/v4/merge_requests",
        respond: (call) =>
          call.routeCallCount === 1
            ? {
                json: [mergeRequest({ iid: 1, references: { full: "acme/webportal!1" } })],
                headers: { "x-next-page": "2" },
              }
            : {
                json: [mergeRequest({ iid: 2, references: { full: "acme/webportal!2" } })],
                headers: LAST_PAGE,
              },
      },
    ]);

    const mrs = await gitlab.listMergeRequestsForReview({ limit: 2 });
    expect(mrs.map((mr) => mr.iid)).toEqual([1, 2]);
  });

  test("lists non-draft merge requests authored by the token user", async () => {
    const { http, gitlab } = harness([
      {
        match: "/api/v4/merge_requests",
        respond: {
          json: [mergeRequest(), mergeRequest({ iid: 2, draft: true })],
          headers: LAST_PAGE,
        },
      },
    ]);

    const mrs = await gitlab.listMergeRequestsAuthoredByMe();
    expect(mrs.map((mr) => mr.iid)).toEqual([6193]);
    expect(http.calls[0]?.url.searchParams.get("scope")).toBe("created_by_me");
    expect(http.calls[0]?.url.searchParams.get("wip")).toBe("no");
  });

  test("lists discussions and replies in the original thread", async () => {
    const { http, gitlab } = harness([
      {
        match: /\/merge_requests\/6193\/discussions$/,
        method: "GET",
        respond: { json: [discussion()], headers: LAST_PAGE },
      },
      {
        match: /\/merge_requests\/6193\/discussions\/discussion-1\/notes$/,
        method: "POST",
        respond: {
          json: {
            id: 502,
            body: "Handled.",
            created_at: "2026-08-25T10:10:00.000Z",
          },
        },
      },
      {
        match: /\/merge_requests\/6193\/discussions\/discussion-1\/notes\/501$/,
        method: "PUT",
        respond: {
          json: {
            ...discussion().notes[0],
            resolved: true,
          },
        },
      },
    ]);

    const discussions = await gitlab.listMergeRequestDiscussions("acme/webportal", 6193);
    expect(discussions[0]?.notes[0]?.resolved).toBe(false);
    const reply = await gitlab.createMergeRequestDiscussionNote(
      "acme/webportal",
      6193,
      "discussion-1",
      "Handled.",
    );
    expect(reply.id).toBe(502);
    expect(http.calls[1]?.body).toContain("Handled.");
    const resolved = await gitlab.resolveMergeRequestDiscussion(
      "acme/webportal",
      6193,
      "discussion-1",
      501,
    );
    expect(resolved.resolved).toBe(true);
    expect(http.calls[2]?.body).toContain('"resolved":true');
  });

  test("preserves a multi-line discussion position", () => {
    const base = discussion();
    const parsed = MergeRequestDiscussionSchema.parse({
      ...base,
      notes: [
        {
          ...base.notes[0],
          position: {
            new_path: "src/models/mux-video-feedback.ts",
            old_path: "src/models/mux-video-feedback.ts",
            new_line: 60,
            old_line: null,
            line_range: {
              start: {
                line_code: "hash_0_57",
                type: "new",
                old_line: null,
                new_line: 57,
              },
              end: {
                line_code: "hash_0_60",
                type: "new",
                old_line: null,
                new_line: 60,
              },
            },
          },
        },
      ],
    });

    expect(toThread(parsed).anchor).toEqual({
      path: "src/models/mux-video-feedback.ts",
      line: 60,
      newLine: 60,
      range: {
        start: { newLine: 57 },
        end: { newLine: 60 },
      },
    });
  });
});

describe("isDraftMergeRequest", () => {
  test("treats GitLab draft flags as draft", () => {
    expect(isDraftMergeRequest(MergeRequestSchema.parse(mergeRequest()))).toBe(false);
    expect(
      isDraftMergeRequest(MergeRequestSchema.parse(mergeRequest({ draft: true }))),
    ).toBe(true);
    expect(
      isDraftMergeRequest(
        MergeRequestSchema.parse(mergeRequest({ draft: false, work_in_progress: true })),
      ),
    ).toBe(true);
  });

  test("treats Draft:/WIP: titles as draft when flags are missing", () => {
    expect(
      isDraftMergeRequest(
        MergeRequestSchema.parse(
          mergeRequest({ draft: undefined, work_in_progress: undefined, title: "Draft: checkout" }),
        ),
      ),
    ).toBe(true);
    expect(
      isDraftMergeRequest(
        MergeRequestSchema.parse(
          mergeRequest({ draft: undefined, work_in_progress: undefined, title: "WIP: checkout" }),
        ),
      ),
    ).toBe(true);
  });
});

describe("mergeRequestProjectPath", () => {
  test("reads the group/project from references.full", () => {
    expect(mergeRequestProjectPath(MergeRequestSchema.parse(mergeRequest()))).toBe(
      "acme/webportal",
    );
  });

  test("falls back to web_url when references.full is missing", () => {
    const mr = MergeRequestSchema.parse(mergeRequest({ references: undefined }));
    expect(mergeRequestProjectPath(mr)).toBe("acme/webportal");
  });

  test("keeps a subgroup path", () => {
    const mr = MergeRequestSchema.parse(
      mergeRequest({
        iid: 12,
        references: { full: "acme/services/api!12" },
        web_url: "https://gitlab.com/acme/services/api/-/merge_requests/12",
      }),
    );
    expect(mergeRequestProjectPath(mr)).toBe("acme/services/api");
  });

  test("is undefined when neither source names a project", () => {
    const mr = MergeRequestSchema.parse(
      mergeRequest({ references: undefined, web_url: "not-a-url" }),
    );
    expect(mergeRequestProjectPath(mr)).toBeUndefined();
  });
});

describe("GitLabClient notes", () => {
  test("deletes a merge request note", async () => {
    const { http, gitlab } = harness([
      {
        match: /\/merge_requests\/6193\/notes\/99$/,
        method: "DELETE",
        respond: { status: 204 },
      },
    ]);

    await gitlab.deleteMergeRequestNote("acme/webportal", 6193, 99);
    expect(http.calls[0]?.method).toBe("DELETE");
    expect(http.calls[0]?.url.pathname).toContain("/notes/99");
  });
});

describe("GitLabConfigSchema", () => {
  test("accepts an id or a path and defaults the trace cap", () => {
    expect(GitLabConfigSchema.parse({ projectId: 42 })).toEqual({
      projectId: 42,
      maxTraceBytes: DEFAULT_MAX_TRACE_BYTES,
    });
    expect(GitLabConfigSchema.parse({ projectId: "acme/webportal" }).projectId).toBe(
      "acme/webportal",
    );
  });

  test("rejects a missing project and a nonsensical cap", () => {
    expect(GitLabConfigSchema.safeParse({}).success).toBe(false);
    expect(GitLabConfigSchema.safeParse({ projectId: 42, maxTraceBytes: 0 }).success).toBe(false);
    expect(GitLabConfigSchema.safeParse({ projectId: 42, maxTraceBytes: -1 }).success).toBe(false);
  });
});

describe("GitLabClient.commitMergeRequests", () => {
  test("reads merge requests associated with a repository commit", async () => {
    const { gitlab, http } = harness([
      {
        match:
          "/api/v4/projects/acme%2Freleases/repository/commits/abc123/merge_requests",
        respond: {
          json: [
            mergeRequest({
              iid: 42,
              state: "merged",
              target_branch: "main",
              merged_at: "2026-09-16T10:00:00.000Z",
            }),
          ],
        },
      },
    ]);

    const result = await gitlab.commitMergeRequests(
      "acme/releases",
      "abc123",
    );

    expect(result).toEqual([
      expect.objectContaining({ iid: 42, state: "merged", target_branch: "main" }),
    ]);
    expect(http.calls).toHaveLength(1);
  });
});

describe("createGitLabClient", () => {
  test("names the missing variable rather than failing at the first request", () => {
    expect(() => createGitLabClient(new EnvSecretStore({}))).toThrow(/GITLAB_TOKEN/);
  });

  test("builds a client from the secret store", () => {
    const client = createGitLabClient(new EnvSecretStore({ GITLAB_TOKEN: "glpat-x" }));
    expect(client.name).toBe("gitlab");
  });
});
