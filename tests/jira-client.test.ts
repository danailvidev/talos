import { describe, expect, test } from "bun:test";
import {
  JiraClient,
  JiraConfigSchema,
  MAX_SUMMARY_CHARS,
  confluencePageId,
  createJiraClient,
  normaliseSite,
  truncateSummary,
} from "../src/connectors/jira/client.ts";
import { doc, paragraph } from "../src/connectors/jira/adf.ts";
import { ConfigError } from "../src/core/errors.ts";
import { currentSprintOf } from "../src/connectors/jira/types.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { FakeHttp, type RecordedCall, type Route } from "./fixtures/http.ts";
import {
  JIRA_ACTIVE_SPRINT,
  JIRA_BOARDS,
  JIRA_CREATED_ISSUE,
  JIRA_FIELDS,
  JIRA_MYSELF,
  JIRA_NO_SPRINT,
  JIRA_ONE_BOARD,
  JIRA_PROJECT,
  JIRA_USERS_AMBIGUOUS,
  JIRA_USER_NO_EMAIL,
  JIRA_USER_WITH_EMAIL,
  issueResponse,
  searchResult,
} from "./fixtures/jira.ts";

const SITE = "https://jira.test";

function harness(routes: Route[]) {
  const http = new FakeHttp(routes);
  return {
    http,
    jira: new JiraClient({
      baseUrl: SITE,
      email: "bot@example.com",
      token: "jira-token",
      fetch: http.fetch,
    }),
  };
}

const MYSELF: Route = { match: "/rest/api/3/myself", respond: { json: JIRA_MYSELF } };
const PROJECT: Route = { match: "/rest/api/3/project/TP", respond: { json: JIRA_PROJECT } };
const FIELDS: Route = { match: "/rest/api/3/field", respond: { json: JIRA_FIELDS } };

const DESCRIPTION = doc(paragraph("Two tests failed."));

/** FakeHttp records the raw request body, so assertions parse it back. */
function jsonBody(call: RecordedCall): {
  fields: Record<string, unknown>;
  [key: string]: unknown;
} {
  return JSON.parse(call.body ?? "{}");
}

describe("normaliseSite", () => {
  test("keeps the origin and drops path, query and trailing slash", () => {
    expect(normaliseSite("https://site.atlassian.net")).toBe("https://site.atlassian.net");
    expect(normaliseSite("https://site.atlassian.net/")).toBe("https://site.atlassian.net");
    // Pasting the API path would otherwise yield /rest/api/3/rest/api/3/myself.
    expect(normaliseSite("https://site.atlassian.net/rest/api/3")).toBe(
      "https://site.atlassian.net",
    );
    expect(normaliseSite("  https://site.atlassian.net/jira/software  ")).toBe(
      "https://site.atlassian.net",
    );
  });

  test("rejects an empty, unparseable, or plaintext URL", () => {
    expect(() => normaliseSite("")).toThrow(ConfigError);
    expect(() => normaliseSite("   ")).toThrow(ConfigError);
    expect(() => normaliseSite("site.atlassian.net")).toThrow(ConfigError);
    // Basic auth over http would put the token on the wire in the clear.
    expect(() => normaliseSite("http://site.atlassian.net")).toThrow(ConfigError);
  });
});

describe("truncateSummary", () => {
  test("flattens whitespace and leaves a short summary alone", () => {
    expect(truncateSummary("  Unit test failure:\n  foo.spec.ts ")).toBe(
      "Unit test failure: foo.spec.ts",
    );
  });

  test("caps at Jira's limit with an ellipsis", () => {
    const long = truncateSummary("x".repeat(400));
    expect(long).toHaveLength(MAX_SUMMARY_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("JiraClient credentials", () => {
  test("requires an email and a token", () => {
    expect(() => new JiraClient({ baseUrl: SITE, email: "", token: "t" })).toThrow(
      ConfigError,
    );
    expect(() => new JiraClient({ baseUrl: SITE, email: "a@b.c", token: "" })).toThrow(
      ConfigError,
    );
  });

  test("authenticates with a basic Authorization header, never a query parameter", async () => {
    const { http, jira } = harness([MYSELF]);
    await jira.myself();

    const call = http.calls[0]!;
    expect(call.headers.authorization).toBe(
      `Basic ${Buffer.from("bot@example.com:jira-token").toString("base64")}`,
    );
    expect(String(call.url)).not.toContain("jira-token");
  });

  test("createJiraClient reads the site, email and token from the secret store", async () => {
    const http = new FakeHttp([MYSELF]);
    const secrets = new EnvSecretStore({
      JIRA_BASE_URL: SITE,
      JIRA_EMAIL: "bot@example.com",
      JIRA_TOKEN: "jira-token",
    });

    const jira = createJiraClient(secrets, { fetch: http.fetch });
    await jira.myself();
    expect(http.calls).toHaveLength(1);
  });

  test("createJiraClient fails loudly when a credential is missing", () => {
    const secrets = new EnvSecretStore({ JIRA_EMAIL: "bot@example.com" });
    expect(() => createJiraClient(secrets)).toThrow();
  });
});

describe("JiraClient.issueUrl", () => {
  test("builds a browse link, which Jira's own create response omits", () => {
    const { jira } = harness([]);
    expect(jira.issueUrl("TP-1")).toBe("https://jira.test/browse/TP-1");
    expect(jira.siteUrl).toBe(SITE);
  });
});

describe("JiraClient Confluence previews", () => {
  test("decodes same-site tiny links and rejects credential forwarding off-site", () => {
    expect(
      confluencePageId("https://jira.test/wiki/x/AoBLfQ?xpis=smart-link", SITE),
    ).toBe("2102099970");
    expect(
      confluencePageId(
        "https://jira.test/wiki/spaces/TP/pages/2102099970/Edit+Mode",
        SITE,
      ),
    ).toBe("2102099970");
    expect(
      confluencePageId("https://attacker.test/wiki/x/AoBLfQ", SITE),
    ).toBeUndefined();
  });

  test("fetches and parses a Confluence ADF page body", async () => {
    const { http, jira } = harness([
      {
        match:
          "/wiki/api/v2/pages/2102099970?body-format=atlas_doc_format",
        respond: {
          json: {
            id: "2102099970",
            title: "Edit Mode in Summary Table",
            body: {
              atlas_doc_format: {
                representation: "atlas_doc_format",
                value: JSON.stringify(doc(paragraph("Requirements"))),
              },
            },
          },
        },
      },
    ]);

    const page = await jira.confluencePage("https://jira.test/wiki/x/AoBLfQ");

    expect(page).toEqual({
      id: "2102099970",
      title: "Edit Mode in Summary Table",
      body: doc(paragraph("Requirements")),
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.headers.authorization).toStartWith("Basic ");
  });

  test("lists direct child pages from a Confluence index page", async () => {
    const { jira } = harness([
      {
        match: "/wiki/api/v2/pages/33271/children?limit=250",
        respond: {
          json: {
            results: [
              { id: "40001", title: "4.2.142-a Sept 11 Hotfix Release" },
              { id: "40002", title: "4.2.143 September Release" },
            ],
          },
        },
      },
    ]);

    await expect(
      jira.confluenceChildPages(
        "https://jira.test/wiki/spaces/QA/pages/33271/Release+Notes",
      ),
    ).resolves.toEqual([
      { id: "40001", title: "4.2.142-a Sept 11 Hotfix Release" },
      { id: "40002", title: "4.2.143 September Release" },
    ]);
  });
});

describe("JiraClient attachments", () => {
  test("returns Jira's signed Atlassian Media redirect without downloading the file", async () => {
    const signed =
      "https://api.media.atlassian.com/file/file-id/binary?token=temporary";
    const { http, jira } = harness([
      {
        match: "/rest/api/3/attachment/content/89514",
        respond: { status: 303, headers: { location: signed } },
      },
    ]);

    expect(await jira.attachmentDownloadUrl("89514")).toBe(signed);
    expect(http.calls).toHaveLength(1);
  });

  test("rejects non-numeric ids before making a request", async () => {
    const { http, jira } = harness([]);
    await expect(jira.attachmentDownloadUrl("../secrets")).rejects.toThrow(
      "Invalid Jira attachment id",
    );
    expect(http.calls).toHaveLength(0);
  });

  test("reads a bounded plain-text attachment preview", async () => {
    const { jira } = harness([
      {
        match: "/rest/api/3/attachment/content/12",
        respond: { text: "Session Support Information\nBrowser: Chrome" },
      },
    ]);

    expect(await jira.attachmentText("12")).toEqual({
      text: "Session Support Information\nBrowser: Chrome",
      truncated: false,
    });
  });
});

describe("JiraClient issue types", () => {
  test("reads types from the project, not the site-wide list", async () => {
    const { http, jira } = harness([PROJECT]);
    expect(await jira.issueTypeId("TP", "Bug")).toBe("10024");

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url.pathname).toContain("/project/TP");
    expect(http.callsTo("/issuetype")).toHaveLength(0);
  });

  test("matches the name case-insensitively", async () => {
    const { jira } = harness([PROJECT]);
    expect(await jira.issueTypeId("TP", "  bUg ")).toBe("10024");
  });

  test("caches the project lookup", async () => {
    const { http, jira } = harness([PROJECT]);
    await jira.issueTypeId("TP", "Bug");
    await jira.issueTypeId("TP", "Task");
    expect(http.calls).toHaveLength(1);
  });

  test("names the available types when the configured one does not exist", async () => {
    const { jira } = harness([PROJECT]);
    // The whole point of resolving up front: Jira's own 400 lists nothing.
    await expect(jira.issueTypeId("TP", "Defect")).rejects.toThrow(/Available: .*Bug/);
  });
});

describe("JiraClient.accountIdForEmail", () => {
  test("answers the token's own email from /myself, without searching", async () => {
    const { http, jira } = harness([MYSELF]);
    expect(await jira.accountIdForEmail("Bot@Example.com")).toBe(JIRA_MYSELF.accountId);
    // /user/search needs a permission the token may not hold; not needing it at
    // all is why this is the common path.
    expect(http.callsTo("/user/search")).toHaveLength(0);
  });

  test("accepts a unique hit whose email Jira withheld", async () => {
    // GDPR: the search matched on the address but does not return it.
    const { jira } = harness([
      MYSELF,
      { match: "/rest/api/3/user/search", respond: { json: JIRA_USER_NO_EMAIL } },
    ]);
    expect(await jira.accountIdForEmail("rowan@example.com")).toBe(
      "612a1b2c3d4e5f6789012345",
    );
  });

  test("prefers an exact email match and skips app accounts", async () => {
    const { jira } = harness([
      MYSELF,
      { match: "/rest/api/3/user/search", respond: { json: JIRA_USER_WITH_EMAIL } },
    ]);
    expect(await jira.accountIdForEmail("rowan@example.com")).toBe(
      "612a1b2c3d4e5f6789012345",
    );
  });

  test("refuses to guess between several matches", async () => {
    const { jira } = harness([
      MYSELF,
      { match: "/rest/api/3/user/search", respond: { json: JIRA_USERS_AMBIGUOUS } },
    ]);
    await expect(jira.accountIdForEmail("sam@example.com")).rejects.toThrow(
      /matched 2 Jira users/,
    );
  });

  test("explains what permission is missing when nobody matches", async () => {
    const { jira } = harness([MYSELF, { match: "/rest/api/3/user/search", respond: { json: [] } }]);
    await expect(jira.accountIdForEmail("nobody@example.com")).rejects.toThrow(
      /Browse users/,
    );
  });

  test("rejects an empty email before making a request", async () => {
    const { http, jira } = harness([]);
    await expect(jira.accountIdForEmail("  ")).rejects.toThrow(ConfigError);
    expect(http.calls).toHaveLength(0);
  });

  test("caches a resolved account id", async () => {
    const { http, jira } = harness([
      MYSELF,
      { match: "/rest/api/3/user/search", respond: { json: JIRA_USER_NO_EMAIL } },
    ]);
    await jira.accountIdForEmail("rowan@example.com");
    await jira.accountIdForEmail("ROWAN@example.com");
    expect(http.callsTo("/user/search")).toHaveLength(1);
  });

  test("shares the identity read while resolving several team emails", async () => {
    const { http, jira } = harness([
      MYSELF,
      { match: "/rest/api/3/user/search", respond: { json: JIRA_USER_NO_EMAIL } },
    ]);

    await Promise.all([
      jira.accountIdForEmail("rowan@example.com"),
      jira.accountIdForEmail("other@example.com"),
    ]);

    expect(http.callsTo("/myself")).toHaveLength(1);
    expect(http.callsTo("/user/search")).toHaveLength(2);
  });
});

describe("JiraClient assignable users", () => {
  test("searches within a project and removes inactive and app accounts", async () => {
    const { jira, http } = harness([
      {
        match: "/rest/api/3/user/assignable/search",
        respond: {
          json: [
            { accountId: "active", displayName: "Active Dev", active: true, accountType: "atlassian" },
            { accountId: "inactive", displayName: "Former Dev", active: false, accountType: "atlassian" },
            { accountId: "app", displayName: "Build App", active: true, accountType: "app" },
          ],
        },
      },
    ]);

    await expect(jira.searchAssignableUsers(" tp ", " Alice ")).resolves.toEqual([
      { accountId: "active", displayName: "Active Dev", active: true, accountType: "atlassian" },
    ]);
    expect(http.calls[0]!.url.searchParams.get("project")).toBe("TP");
    expect(http.calls[0]!.url.searchParams.get("query")).toBe("Alice");
    expect(http.calls[0]!.url.searchParams.get("startAt")).toBe("0");
    expect(http.calls[0]!.url.searchParams.get("maxResults")).toBe("1000");
  });

  test("resolves a saved account id for display", async () => {
    const { jira, http } = harness([
      {
        match: "/rest/api/3/user",
        respond: { json: { accountId: "account-7", displayName: "Saved Dev" } },
      },
    ]);

    await expect(jira.userByAccountId("account-7")).resolves.toMatchObject({
      displayName: "Saved Dev",
    });
    expect(http.calls[0]!.url.searchParams.get("accountId")).toBe("account-7");
  });
});

describe("JiraClient.findSprintFieldId", () => {
  test("finds the field by its gh-sprint marker, not by a hard-coded id", async () => {
    const { http, jira } = harness([FIELDS]);
    expect(await jira.findSprintFieldId()).toBe("customfield_10020");
    // Cached: the id is stable for a site's lifetime.
    await jira.findSprintFieldId();
    expect(http.calls).toHaveLength(1);
  });

  test("returns undefined on a site with no sprint field", async () => {
    // A site without Jira Software: a reason to file into the backlog, not to fail.
    const { jira } = harness([
      { match: "/rest/api/3/field", respond: { json: [{ id: "summary", name: "Summary" }] } },
    ]);
    expect(await jira.findSprintFieldId()).toBeUndefined();
  });
});

describe("JiraClient.extraSelectFields", () => {
  test("resolves select fields by name, not by a hard-coded id", async () => {
    const { jira } = harness([FIELDS]);
    expect(await jira.extraSelectFields([
      { name: "Bug found by", value: "automation" },
      { name: "fe/be/ux", value: "FE" },
    ])).toEqual({
      customfield_10101: { value: "automation" },
      customfield_10102: { value: "FE" },
    });
  });

  test("lists known custom fields when the name is unknown", async () => {
    const { jira } = harness([FIELDS]);
    await expect(jira.extraSelectFields([{ name: "Priority Score", value: "1" }])).rejects.toThrow(
      /No Jira field named 'Priority Score'/,
    );
    await expect(jira.extraSelectFields([{ name: "Priority Score", value: "1" }])).rejects.toThrow(
      /Bug found by/,
    );
  });
});

describe("JiraClient sprint resolution", () => {
  test("the issue-field helper also picks the newest parallel active sprint", () => {
    expect(
      currentSprintOf([
        { id: 1, name: "July", state: "active", startDate: "2026-07-01T00:00:00Z" },
        { id: 2, name: "October", state: "active", startDate: "2026-09-11T00:00:00Z" },
      ])?.id,
    ).toBe(2);
  });

  test("uses a configured board directly, without enumerating boards", async () => {
    const { http, jira } = harness([
      { match: "/rest/agile/1.0/board/21/sprint", respond: { json: JIRA_ACTIVE_SPRINT } },
    ]);

    const { sprint } = await jira.resolveActiveSprint({ projectKey: "TP", boardId: 21 });
    expect(sprint?.id).toBe(3128);
    // `/board` itself — enumerating boards — as opposed to `/board/21/sprint`.
    expect(http.calls.filter((c) => c.url.pathname.endsWith("/board"))).toHaveLength(0);
  });

  test("discovers the board when the project has exactly one scrum board", async () => {
    const { jira } = harness([
      { match: /\/rest\/agile\/1\.0\/board$/, respond: { json: JIRA_ONE_BOARD } },
      { match: "/rest/agile/1.0/board/40/sprint", respond: { json: JIRA_ACTIVE_SPRINT } },
    ]);

    const { sprint } = await jira.resolveActiveSprint({ projectKey: "AUT" });
    expect(sprint?.id).toBe(3128);
  });

  test("refuses to choose between several scrum boards", async () => {
    const { http, jira } = harness([
      { match: /\/rest\/agile\/1\.0\/board$/, respond: { json: JIRA_BOARDS } },
    ]);

    const { sprint, reason } = await jira.resolveActiveSprint({ projectKey: "TP" });
    // Filing into the wrong team's sprint is worse than filing into the backlog.
    expect(sprint).toBeUndefined();
    expect(reason).toMatch(/2 scrum boards/);
    expect(reason).toMatch(/jira\.boardId/);
    // Kanban boards have no sprints, so they are not part of the ambiguity.
    expect(reason).not.toMatch(/Tablets/);
    expect(http.callsTo("/sprint")).toHaveLength(0);
  });

  test("reports a board with no active sprint as a reason, not an error", async () => {
    const { jira } = harness([
      { match: "/rest/agile/1.0/board/21/sprint", respond: { json: JIRA_NO_SPRINT } },
    ]);

    const { sprint, reason } = await jira.resolveActiveSprint({
      projectKey: "TP",
      boardId: 21,
    });
    expect(sprint).toBeUndefined();
    expect(reason).toMatch(/no active sprint/);
  });

  test("picks the most recently started sprint when a board runs parallel sprints", async () => {
    const { jira } = harness([
      {
        match: "/rest/agile/1.0/board/21/sprint",
        respond: {
          json: {
            values: [
              { id: 1, name: "earlier", state: "active", startDate: "2026-07-01T00:00:00Z" },
              { id: 2, name: "later", state: "active", startDate: "2026-08-01T00:00:00Z" },
            ],
            isLast: true,
          },
        },
      },
    ]);

    const { sprint } = await jira.resolveActiveSprint({ projectKey: "TP", boardId: 21 });
    expect(sprint?.id).toBe(2);
  });

  test("prefers the highest release number across parallel active sprints", async () => {
    const { jira } = harness([
      {
        match: "/rest/agile/1.0/board/21/sprint",
        respond: {
          json: {
            values: [
              {
                id: 143,
                name: "TP 4.2.143 October 2",
                state: "active",
                startDate: "2026-10-20T00:00:00Z",
              },
              {
                id: 144,
                name: "TP 4.2.144 October 23",
                state: "active",
                // Deliberately earlier: the name's release sequence wins.
                startDate: "2026-10-01T00:00:00Z",
              },
            ],
            isLast: true,
          },
        },
      },
    ]);

    const { sprint } = await jira.resolveActiveSprint({
      projectKey: "TP",
      boardId: 21,
    });
    expect(sprint?.id).toBe(144);
  });

  test("asks only for active sprints", async () => {
    const { http, jira } = harness([
      { match: "/rest/agile/1.0/board/21/sprint", respond: { json: JIRA_ACTIVE_SPRINT } },
    ]);
    await jira.activeSprint(21);
    expect(http.calls[0]!.url.search).toContain("state=active");
  });
});

describe("JiraClient board view", () => {
  test("reads Jira's real status-to-column mapping", async () => {
    const { jira } = harness([
      {
        match: "/rest/agile/1.0/board/20/configuration",
        respond: {
          json: {
            id: 20,
            name: "Web Portal",
            location: {
              type: "project",
              projectKey: "TP",
              projectName: "Teacher Portal",
            },
            columnConfig: {
              columns: [
                {
                  name: "Dev Queue",
                  statuses: [{ id: "1" }, { id: "10010" }],
                },
              ],
            },
          },
        },
      },
    ]);

    const board = await jira.boardConfiguration(20);
    expect(board.location).toMatchObject({
      projectKey: "TP",
      projectName: "Teacher Portal",
    });
    expect(board.columnConfig.columns[0]).toEqual({
      name: "Dev Queue",
      statuses: [{ id: "1" }, { id: "10010" }],
    });
  });

  test("paginates board issues so counts are not capped at one Jira page", async () => {
    const page = searchResult(
      Array.from({ length: 50 }, (_, index) => ({ key: `TP-${index + 1}` })),
    ).issues;
    const { http, jira } = harness([
      {
        match: "/rest/agile/1.0/board/20/issue",
        respond: (call) => ({
          json:
            call.routeCallCount === 1
              ? { issues: page, startAt: 0, maxResults: 50, total: 51 }
              : {
                  issues: searchResult([{ key: "TP-51" }]).issues,
                  startAt: 50,
                  maxResults: 50,
                  total: 51,
                },
        }),
      },
    ]);

    const issues = await jira.boardIssues(20, "assignee = currentUser()");
    expect(issues).toHaveLength(51);
    expect(http.calls[1]!.url.searchParams.get("startAt")).toBe("50");
  });

  test("can use only the board's saved filter for a Team view", async () => {
    const { http, jira } = harness([
      {
        match: "/rest/agile/1.0/board/20/issue",
        respond: {
          json: {
            issues: [
              {
                id: "20001",
                key: "TP-1",
                fields: {
                  summary: "Unassigned work",
                  assignee: null,
                  priority: null,
                  reporter: null,
                  parent: null,
                },
              },
            ],
            startAt: 0,
            maxResults: 50,
            total: 1,
          },
        },
      },
    ]);

    const issues = await jira.boardIssues(20);
    expect(http.calls[0]!.url.searchParams.has("jql")).toBe(false);
    expect(issues[0]?.fields).toMatchObject({
      assignee: null,
      priority: null,
      reporter: null,
      parent: null,
    });
  });
});

describe("JiraClient.createIssue", () => {
  const CREATE: Route = {
    match: "/rest/api/3/issue",
    method: "POST",
    respond: { json: JIRA_CREATED_ISSUE },
  };

  function createRoutes(): Route[] {
    return [PROJECT, FIELDS, CREATE];
  }

  test("sends the resolved issue type id, an ADF description and an assignee object", async () => {
    const { http, jira } = harness(createRoutes());

    const created = await jira.createIssue({
      projectKey: "TP",
      parentKey: "TP-100",
      summary: "Unit test failure: foo.spec.ts",
      description: DESCRIPTION,
      issueType: "Bug",
      assigneeAccountId: "acct-1",
    });

    expect(created.key).toBe("TP-4242");

    const body = jsonBody(http.callsTo("/issue")[0]!);
    expect(body.fields.issuetype).toEqual({ id: "10024" });
    expect(body.fields.project).toEqual({ key: "TP" });
    expect(body.fields.parent).toEqual({ key: "TP-100" });
    expect(body.fields.assignee).toEqual({ id: "acct-1" });
    // A plain string description is rejected by REST v3.
    expect(body.fields.description).toEqual(DESCRIPTION);
  });

  test("puts a bare sprint id in the discovered custom field", async () => {
    const { http, jira } = harness(createRoutes());

    await jira.createIssue({
      projectKey: "TP",
      summary: "s",
      description: DESCRIPTION,
      issueType: "Bug",
      sprintId: 3128,
    });

    const body = jsonBody(http.callsTo("/issue")[0]!);
    // Unlike every other reference field, the sprint field takes the id itself.
    expect(body.fields.customfield_10020).toBe(3128);
  });

  test("does not touch /field when no sprint was requested", async () => {
    const { http, jira } = harness(createRoutes());
    await jira.createIssue({
      projectKey: "TP",
      summary: "s",
      description: DESCRIPTION,
      issueType: "Bug",
    });
    expect(http.callsTo("/field")).toHaveLength(0);
  });

  test("fails when a sprint is requested on a site that has no sprint field", async () => {
    const { jira } = harness([
      PROJECT,
      { match: "/rest/api/3/field", respond: { json: [{ id: "summary", name: "Summary" }] } },
      CREATE,
    ]);

    await expect(
      jira.createIssue({
        projectKey: "TP",
        summary: "s",
        description: DESCRIPTION,
        issueType: "Bug",
        sprintId: 3128,
      }),
    ).rejects.toThrow(/no sprint field/);
  });

  test("caps the summary and dashes whitespace out of labels", async () => {
    const { http, jira } = harness(createRoutes());

    await jira.createIssue({
      projectKey: "TP",
      summary: "y".repeat(400),
      description: DESCRIPTION,
      issueType: "Bug",
      labels: ["talos", "spec file"],
    });

    const body = jsonBody(http.callsTo("/issue")[0]!);
    expect(String(body.fields.summary)).toHaveLength(MAX_SUMMARY_CHARS);
    // Jira rejects a label containing whitespace with an unhelpful error.
    expect(body.fields.labels).toEqual(["talos", "spec-file"]);
  });

  test("attaches extra select fields by their site-specific ids", async () => {
    const { http, jira } = harness(createRoutes());
    await jira.createIssue({
      projectKey: "TP",
      summary: "s",
      description: DESCRIPTION,
      issueType: "Bug",
      extraFields: {
        customfield_10101: { value: "automation" },
        customfield_10102: { value: "FE" },
      },
    });

    const fields = jsonBody(http.callsTo("/issue")[0]!).fields;
    expect(fields.customfield_10101).toEqual({ value: "automation" });
    expect(fields.customfield_10102).toEqual({ value: "FE" });
  });

  test("omits assignee and labels rather than sending empty values", async () => {
    const { http, jira } = harness(createRoutes());
    await jira.createIssue({
      projectKey: "TP",
      summary: "s",
      description: DESCRIPTION,
      issueType: "Bug",
      labels: [],
    });

    const fields = jsonBody(http.callsTo("/issue")[0]!).fields;
    expect("assignee" in fields).toBe(false);
    expect("labels" in fields).toBe(false);
  });

  test("does not create anything when the issue type is wrong", async () => {
    const { http, jira } = harness(createRoutes());
    await expect(
      jira.createIssue({
        projectKey: "TP",
        summary: "s",
        description: DESCRIPTION,
        issueType: "Defect",
      }),
    ).rejects.toThrow(ConfigError);
    expect(http.callsTo("/issue")).toHaveLength(0);
  });
});

describe("JiraClient.addComment", () => {
  test("posts an ADF body to the issue's comment endpoint", async () => {
    const { http, jira } = harness([
      {
        match: "/rest/api/3/issue/TP-1/comment",
        method: "POST",
        respond: { json: { id: "90001" } },
      },
    ]);

    await jira.addComment("TP-1", doc(paragraph("still failing")));

    expect(jsonBody(http.calls[0]!).body).toEqual(doc(paragraph("still failing")));
  });
});

describe("JiraClient.issue", () => {
  test("returns the issue with its status category", async () => {
    const { jira } = harness([
      { match: "/rest/api/3/issue/TP-1", respond: { json: issueResponse("TP-1", "done") } },
    ]);

    const issue = await jira.issue("TP-1");
    expect(issue?.fields?.status?.statusCategory?.key).toBe("done");
  });

  test("maps 404 to null — a deleted ticket means refile, not fail", async () => {
    const { jira } = harness([
      { match: "/rest/api/3/issue/TP-9", respond: { status: 404, json: { errorMessages: [] } } },
    ]);
    expect(await jira.issue("TP-9")).toBeNull();
  });

  test("propagates a 401 rather than reporting the issue as gone", async () => {
    // Otherwise a revoked token would look like "every ticket was deleted" and
    // refile all of them.
    const { jira } = harness([
      { match: "/rest/api/3/issue/TP-9", respond: { status: 401, json: {} } },
    ]);
    await expect(jira.issue("TP-9")).rejects.toThrow();
  });
});

describe("JiraClient board transitions", () => {
  test("matches a destination status id when the column name is not a Jira status", async () => {
    const { http, jira } = harness([
      {
        match: "/rest/api/3/issue/TP-1/transitions",
        method: "GET",
        respond: {
          json: {
            transitions: [
              { id: "31", name: "Start work", to: { id: "1", name: "New" } },
            ],
          },
        },
      },
      {
        match: "/rest/api/3/issue/TP-1/transitions",
        method: "POST",
        respond: { status: 204 },
      },
    ]);

    await jira.transitionIssueToColumn("TP-1", {
      name: "Dev Queue",
      statusIds: ["1", "10010"],
    });
    expect(jsonBody(http.calls[1]!).transition).toEqual({ id: "31" });
  });
});

describe("JiraClient.searchIssues", () => {
  test("POSTs JQL and returns the issues", async () => {
    const { http, jira } = harness([
      {
        match: "/rest/api/3/search/jql",
        method: "POST",
        respond: { json: searchResult([{ key: "TP-1" }, { key: "TP-2" }]) },
      },
    ]);

    const issues = await jira.searchIssues('project = "TP"', { limit: 5 });
    expect(issues.map((i) => i.key)).toEqual(["TP-1", "TP-2"]);

    const body = jsonBody(http.calls[0]!);
    expect(body.jql).toBe('project = "TP"');
    expect(body.maxResults).toBe(5);
  });

  test("follows enhanced-search page tokens up to the requested limit", async () => {
    const { http, jira } = harness([
      {
        match: "/rest/api/3/search/jql",
        method: "POST",
        respond: (call) => ({
          json:
            call.routeCallCount === 1
              ? { ...searchResult([{ key: "TP-1" }]), nextPageToken: "page-2" }
              : searchResult([{ key: "TP-2" }]),
        }),
      },
    ]);

    const issues = await jira.searchIssues("assignee = currentUser()", { limit: 2 });
    expect(issues.map((issue) => issue.key)).toEqual(["TP-1", "TP-2"]);
    expect(jsonBody(http.calls[1]!).nextPageToken).toBe("page-2");
  });
});

describe("JiraClient.check", () => {
  test("reports the per-site ids an operator has to put in config", async () => {
    const { jira } = harness([
      MYSELF,
      PROJECT,
      FIELDS,
      { match: "/rest/agile/1.0/board/21/sprint", respond: { json: JIRA_ACTIVE_SPRINT } },
      {
        match: "/rest/api/3/search/jql",
        method: "POST",
        respond: { json: searchResult([{ key: "TP-7" }]) },
      },
    ]);

    const health = await jira.check({
      projectKey: "TP",
      issueType: "Bug",
      boardId: 21,
    });

    expect(health.ok).toBe(true);
    const detail = (name: string) => health.checks.find((c) => c.name === name)?.detail;
    expect(detail("authentication")).toContain("Talos Bot");
    expect(detail("project access")).toContain("id 10012");
    expect(detail("issue types")).toContain("id 10024");
    expect(detail("active sprint")).toContain("id 3128");
    expect(detail("create permission")).toContain("TP-7");
  });

  test("stops after authentication fails instead of repeating the same 401", async () => {
    const { http, jira } = harness([
      { match: "/rest/api/3/myself", respond: { status: 401, json: {} } },
    ]);

    const health = await jira.check({ projectKey: "TP", issueType: "Bug" });
    expect(health.ok).toBe(false);
    expect(http.callsTo("/project")).toHaveLength(0);
  });

  test("treats a missing active sprint as healthy — the backlog is a valid home", async () => {
    const { jira } = harness([
      MYSELF,
      PROJECT,
      FIELDS,
      { match: "/rest/agile/1.0/board/21/sprint", respond: { json: JIRA_NO_SPRINT } },
      {
        match: "/rest/api/3/search/jql",
        method: "POST",
        respond: { json: searchResult([]) },
      },
    ]);

    const health = await jira.check({ projectKey: "TP", issueType: "Bug", boardId: 21 });
    expect(health.ok).toBe(true);
    expect(health.checks.find((c) => c.name === "active sprint")?.detail).toContain(
      "backlog",
    );
  });

  test("never creates an issue while checking create permission", async () => {
    const { http, jira } = harness([
      MYSELF,
      PROJECT,
      FIELDS,
      { match: "/rest/agile/1.0/board/21/sprint", respond: { json: JIRA_ACTIVE_SPRINT } },
      {
        match: "/rest/api/3/search/jql",
        method: "POST",
        respond: { json: searchResult([]) },
      },
    ]);

    await jira.check({ projectKey: "TP", issueType: "Bug", boardId: 21 });
    expect(http.calls.filter((c) => c.method === "POST" && /\/issue$/.test(c.url.pathname))).toHaveLength(
      0,
    );
  });

  test("skips project checks when no task configures a Jira project", async () => {
    const { jira } = harness([MYSELF]);
    const health = await jira.check();
    expect(health.ok).toBe(true);
    expect(health.checks.find((c) => c.name === "project access")?.detail).toContain(
      "skipped",
    );
  });
});

describe("JiraConfigSchema", () => {
  test("upper-cases the project key and defaults the rest", () => {
    const config = JiraConfigSchema.parse({ project: " tp " });
    expect(config.project).toBe("TP");
    expect(config.issueType).toBe("Bug");
    expect(config.useActiveSprint).toBe(true);
    expect(config.labels).toEqual(["talos", "ci-failure"]);
    expect(config.bugFoundBy).toBe("automation");
    expect(config.feBeUx).toBe("FE");
  });

  test("rejects a missing project and a non-positive board id", () => {
    expect(() => JiraConfigSchema.parse({})).toThrow();
    expect(() => JiraConfigSchema.parse({ project: "TP", boardId: 0 })).toThrow();
    expect(() => JiraConfigSchema.parse({ project: "TP", boardId: 1.5 })).toThrow();
  });
});
