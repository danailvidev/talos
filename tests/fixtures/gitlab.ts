/**
 * Recorded GitLab.com REST v4 payloads, trimmed to the fields the client reads
 * plus a few it ignores — the extra fields are the point, since they prove the
 * schemas tolerate GitLab adding to its responses.
 */

export const GITLAB_USER = {
  id: 4001,
  username: "talos-bot",
  name: "Talos Bot",
  state: "active",
  web_url: "https://gitlab.com/talos-bot",
};

export const GITLAB_PROJECT = {
  id: 42,
  name: "webportal",
  path_with_namespace: "acme/webportal",
  web_url: "https://gitlab.com/acme/webportal",
  default_branch: "main",
  visibility: "private",
  // Not in our schema; must survive parsing.
  statistics: { repository_size: 1234 },
};

export function pipeline(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001,
    iid: 12,
    project_id: 42,
    sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
    ref: "main",
    status: "failed",
    source: "push",
    created_at: "2026-08-20T09:58:00.000Z",
    updated_at: "2026-08-20T10:02:11.000Z",
    web_url: "https://gitlab.com/acme/webportal/-/pipelines/9001",
    name: null,
    ...overrides,
  };
}

export function discussion(overrides: Record<string, unknown> = {}) {
  return {
    id: "discussion-1",
    individual_note: false,
    notes: [
      {
        id: 501,
        body: "Could you handle the empty value here?",
        author: { id: 6001, username: "reviewer", name: "Reviewer" },
        created_at: "2026-08-25T10:05:00.000Z",
        updated_at: "2026-08-25T10:05:00.000Z",
        system: false,
        resolvable: true,
        resolved: false,
      },
    ],
    ...overrides,
  };
}

export const PIPELINE_DETAIL = {
  ...pipeline(),
  duration: 251,
  started_at: "2026-08-20T09:58:05.000Z",
  finished_at: "2026-08-20T10:02:11.000Z",
  user: { id: 5001, username: "adevs", name: "A Developer" },
  commit: {
    id: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
    title: "Tighten checkout validation",
    author_name: "A Developer",
    author_email: "adev@example.com",
  },
};

export const PIPELINE_SCHEDULE_DETAIL = {
  id: 22,
  description: "Scheduled pipeline for webportal tests",
  ref: "refs/heads/develop",
  cron: "0 2 * * *",
  cron_timezone: "UTC",
  next_run_at: "2026-09-25T02:00:00.000Z",
  active: true,
  created_at: "2026-07-01T09:00:00.000Z",
  updated_at: "2026-09-24T02:04:12.000Z",
  last_pipeline: {
    id: 9001,
    sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
    ref: "develop",
    status: "failed",
  },
  owner: { id: 5001, username: "adevs", name: "A Developer" },
};

export const PIPELINE_TEST_REPORT_SUMMARY = {
  total: {
    time: 7.25,
    count: 3,
    success: 1,
    failed: 1,
    skipped: 1,
    error: 0,
    suite_error: null,
  },
  test_suites: [
    {
      name: "unit",
      total_time: 7.25,
      total_count: 3,
      success_count: 1,
      failed_count: 1,
      skipped_count: 1,
      error_count: 0,
      build_ids: [7001],
      suite_error: null,
    },
  ],
};

export const PIPELINE_TEST_REPORT = {
  total_time: 7.25,
  total_count: 3,
  success_count: 1,
  failed_count: 1,
  skipped_count: 1,
  error_count: 0,
  test_suites: [
    {
      name: "unit",
      total_time: 7.25,
      total_count: 3,
      success_count: 1,
      failed_count: 1,
      skipped_count: 1,
      error_count: 0,
      test_cases: [
        {
          status: "failed",
          name: "applies a percentage discount",
          classname: "checkout",
          file: "web/tests/checkout.test.ts",
          attachment_url:
            "https://gitlab.com/example-org/qa/test-automation/-/jobs/16698778194/artifacts/file/web/target/screenshots/foo.png",
          execution_time: 0.12,
          system_output: "Expected 90, received 100",
          stack_trace: "at tests/checkout.test.ts:41:29",
        },
        {
          status: "success",
          name: "totals a single line item",
          classname: "checkout",
          execution_time: 0.03,
          system_output: null,
          stack_trace: null,
        },
        {
          status: "skipped",
          name: "requires a feature flag",
          classname: "checkout",
          execution_time: 0,
          system_output: { message: "Feature flag is disabled" },
          stack_trace: null,
        },
      ],
    },
  ],
};

export function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 7001,
    name: "test:unit",
    stage: "test",
    status: "failed",
    failure_reason: "script_failure",
    allow_failure: false,
    ref: "main",
    duration: 91.2,
    created_at: "2026-08-20T09:58:10.000Z",
    started_at: "2026-08-20T09:58:20.000Z",
    finished_at: "2026-08-20T09:59:51.000Z",
    web_url: "https://gitlab.com/acme/webportal/-/jobs/7001",
    runner: { id: 12, description: "shared runner" },
    ...overrides,
  };
}

/** A realistic failing job log: setup at the head, the assertion at the tail. */
export const JOB_TRACE = `Running with gitlab-runner 17.4.0
Preparing the "docker" executor
$ bun install --frozen-lockfile
bun install v1.3.14
Checked 412 installs across 380 packages
$ bun test
tests/checkout.test.ts:
  ✓ totals a single line item
  ✗ applies a percentage discount

 1 fail, 24 pass

error: expect(received).toBe(expected)

Expected: 90
Received: 100

      at tests/checkout.test.ts:41:29
ERROR: Job failed: exit status 1
`;

export function mergeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    iid: 6193,
    project_id: 42,
    source_project_id: 42,
    target_project_id: 42,
    title: "Tighten checkout validation",
    state: "opened",
    source_branch: "fix/TP-3012",
    target_branch: "main",
    sha: "abcdef12deadbeef",
    web_url: "https://gitlab.com/acme/webportal/-/merge_requests/6193",
    updated_at: "2026-08-25T10:00:00.000Z",
    author: { id: 5001, username: "adevs", name: "A Developer" },
    references: { short: "!6193", relative: "!6193", full: "acme/webportal!6193" },
    draft: false,
    work_in_progress: false,
    ...overrides,
  };
}
