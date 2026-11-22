import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { App } from "../src/app.ts";
import { groupIntoProblems } from "../src/application/datadog-problems.ts";
import { productionOnlyQuery } from "../src/application/datadog-scan.ts";
import { severityOf } from "../src/application/datadog-triage.ts";
import { DatadogClient } from "../src/connectors/datadog/client.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteDatadogServiceTargetStore } from "../src/persistence/datadog-service-target-store.ts";
import { SqliteDatadogAiTriageStore } from "../src/persistence/datadog-ai-triage-store.ts";
import {
  datadogScanTaskId,
  defaultDatadogServiceTarget,
} from "../src/api/datadog-actions.ts";
import { DatadogScanParamsSchema } from "../src/tasks/datadog-scan/index.ts";
import { FakeHttp } from "./fixtures/http.ts";

describe("Datadog production coverage", () => {
  test("validates saved Jira ticket settings", () => {
    expect(
      DatadogScanParamsSchema.parse({
        jira: {
          project: "tp",
          assigneeMode: "fixed",
          assignee: "alice-account",
        },
      }).jira,
    ).toMatchObject({
      project: "TP",
      issueType: "Bug",
      assigneeMode: "fixed",
      assignee: "alice-account",
      useActiveSprint: true,
      labels: ["talos", "datadog"],
    });
    expect(
      DatadogScanParamsSchema.safeParse({
        jira: { project: "TP", assigneeMode: "fixed" },
      }).success,
    ).toBe(false);
  });

  test("runs the public configured instance behind the Datadog page", () => {
    const app = {
      instances: {
        all: () => [
          {
            id: "5373b0f8-9fed-4862-85a7-f4ab65c0f7cc",
            definitionId: "datadog-scan",
            name: "Datadog error scan",
            visibility: "public",
            createdAt: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      },
    } as unknown as App;

    expect(datadogScanTaskId(app)).toBe("5373b0f8-9fed-4862-85a7-f4ab65c0f7cc");
  });

  test("hard-scopes custom queries to production", () => {
    expect(productionOnlyQuery("status:error")).toBe("(status:error) AND env:prod");
    expect(productionOnlyQuery("status:error env:prod")).toBe(
      "(status:error env:prod) AND env:prod",
    );
    expect(productionOnlyQuery("env:staging service:checkout")).toBe(
      "(env:staging service:checkout) AND env:prod",
    );
    expect(productionOnlyQuery("env:prod OR env:staging")).toBe(
      "(env:prod OR env:staging) AND env:prod",
    );
  });

  test("uses the operator-visible severity thresholds", () => {
    expect(severityOf({ status: "error", eventCount: 10, isNew: true })).toBe(
      "critical",
    );
    expect(
      severityOf({
        status: "error",
        eventCount: 300,
        previousEventCount: 100,
        isNew: false,
      }),
    ).toBe("critical");
    expect(
      severityOf({
        status: "error",
        eventCount: 150,
        previousEventCount: 100,
        isNew: false,
      }),
    ).toBe("high");
    expect(
      severityOf({
        status: "error",
        eventCount: 80,
        previousEventCount: 100,
        isNew: false,
      }),
    ).toBe("low");
    expect(
      severityOf({
        status: "warning",
        eventCount: 500,
        previousEventCount: 100,
        isNew: false,
      }),
    ).toBe("medium");
  });

  test("paginates every service aggregation bucket", async () => {
    const http = new FakeHttp([
      {
        match: "/api/v2/logs/analytics/aggregate",
        method: "POST",
        respond: (call) => {
          const body = JSON.parse(call.body ?? "{}") as { page?: { cursor?: string } };
          return body.page?.cursor
            ? {
                json: {
                  data: { buckets: [{ by: { service: "billing" }, computes: { c0: 4 } }] },
                  meta: { status: "done" },
                },
              }
            : {
                json: {
                  data: { buckets: [{ by: { service: "checkout" }, computes: { c0: 9 } }] },
                  meta: { status: "done", page: { after: "next-services" } },
                },
              };
        },
      },
    ]);
    const client = new DatadogClient({
      token: "ddpat_test",
      site: "datadoghq.com",
      fetch: http.fetch,
    });

    const result = await client.countAllBy(
      {
        query: "status:error env:prod",
        from: new Date("2026-09-22T00:00:00Z"),
        to: new Date("2026-09-23T00:00:00Z"),
      },
      [{ facet: "service", limit: 20, sortByCount: true }],
    );

    expect(result).toEqual({
      groups: [
        { value: "checkout", count: 9, by: { service: "checkout" } },
        { value: "billing", count: 4, by: { service: "billing" } },
      ],
      partial: false,
    });
    expect(http.calls).toHaveLength(2);
    expect(JSON.parse(http.calls[0]!.body ?? "{}").group_by[0].sort).toEqual({
      type: "alphabetical",
      order: "asc",
    });
    expect(JSON.parse(http.calls[1]!.body ?? "{}").page).toEqual({
      cursor: "next-services",
    });
  });
});

describe("Datadog service repository boundaries", () => {
  test("groups related signatures within a service but never across services", () => {
    const problems = groupIntoProblems([
      {
        service: "checkout",
        signature: "CheckoutWorker.processPayment failed",
        sampleStack: "at CheckoutWorker.processPayment",
        eventCount: 20,
      },
      {
        service: "checkout",
        signature: "Payment wrapper failed",
        sampleStack: "caused by CheckoutWorker.processPayment",
        eventCount: 20,
      },
      {
        service: "ledger",
        signature: "CheckoutWorker.processPayment failed",
        sampleStack: "remote call CheckoutWorker.processPayment",
        eventCount: 12,
      },
    ]);

    expect(problems).toHaveLength(2);
    expect(problems.find((problem) => problem.service === "checkout")?.members).toHaveLength(2);
    expect(problems.find((problem) => problem.service === "ledger")?.members).toHaveLength(1);
  });

  test("includes the service in otherwise-identical problem keys", () => {
    const checkout = groupIntoProblems([
      { service: "checkout", signature: "SharedFailureCode", eventCount: 1 },
    ])[0]!;
    const ledger = groupIntoProblems([
      { service: "ledger", signature: "SharedFailureCode", eventCount: 1 },
    ])[0]!;

    expect(checkout.key).not.toBe(ledger.key);
  });
});

describe("Datadog service targets", () => {
  test("infers the Russian Math repository convention on master", () => {
    expect(defaultDatadogServiceTarget("assignment")).toEqual({
      projectId: "example-org/services/assignment",
      targetBranch: "master",
    });
  });

  test("upserts exact service mappings case-insensitively", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteDatadogServiceTargetStore(db);

    store.set("Checkout-API", {
      projectId: "platform/checkout",
      targetBranch: "main",
    });
    const updated = store.set("checkout-api", {
      projectId: "platform/checkout-v2",
      targetBranch: "develop",
    });

    expect(store.list()).toHaveLength(1);
    expect(updated).toMatchObject({
      service: "Checkout-API",
      projectId: "platform/checkout-v2",
      targetBranch: "develop",
    });
    expect(store.delete("CHECKOUT-API")).toBe(true);
    expect(store.list()).toEqual([]);
    db.close();
  });
});

describe("Datadog AI triage persistence", () => {
  test("keeps the latest explainable verdict for an issue", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteDatadogAiTriageStore(db);
    store.record({
      issueId: "issue-1",
      fingerprint: "fingerprint-1",
      verdict: "unknown",
      confidence: 0.3,
      rationale: "Insufficient evidence.",
      recommendation: "Collect a stack trace.",
      taskRunId: "run-1",
    });
    const updated = store.record({
      issueId: "issue-1",
      fingerprint: "fingerprint-2",
      verdict: "code",
      confidence: 0.9,
      rationale: "The throwing frame is in this repository.",
      recommendation: "Write a regression test.",
      taskRunId: "run-2",
    });

    expect(store.list()).toHaveLength(1);
    expect(updated).toMatchObject({
      verdict: "code",
      confidence: 0.9,
      taskRunId: "run-2",
    });
    db.close();
  });
});
