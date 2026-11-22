/**
 * Recorded Jira Cloud responses.
 *
 * Shapes are trimmed to the fields the client reads, but the *quirks* are kept
 * faithfully, because they are what the client exists to cope with: `/user/search`
 * withholding `emailAddress`, the sprint custom field having a per-site id, and a
 * project's issue types differing from the site-wide list.
 */

export const JIRA_MYSELF = {
  self: "https://jira.test/rest/api/3/myself",
  accountId: "5b10a2844c20165700ede21g",
  displayName: "Talos Bot",
  emailAddress: "bot@example.com",
  active: true,
};

export const JIRA_ISSUE_TYPES = [
  { id: "10022", name: "Task", subtask: false },
  { id: "10023", name: "Sub-task", subtask: true },
  { id: "10024", name: "Bug", subtask: false },
  { id: "10012", name: "Story", subtask: false },
];

export const JIRA_PROJECT = {
  id: "10012",
  key: "TP",
  name: "Teacher Portal",
  issueTypes: JIRA_ISSUE_TYPES,
};

/**
 * `/field`. The sprint field is identified by `schema.custom` ending in
 * `gh-sprint`, never by its id — which is `customfield_10020` here and something
 * else on the next site.
 */
export const JIRA_FIELDS = [
  { id: "summary", name: "Summary", custom: false },
  {
    id: "customfield_10014",
    name: "Epic Link",
    custom: true,
    schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
  },
  {
    id: "customfield_10020",
    name: "Sprint",
    custom: true,
    schema: { type: "array", custom: "com.pyxis.greenhopper.jira:gh-sprint" },
  },
  {
    id: "customfield_10101",
    name: "Bug found by",
    custom: true,
    schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
  },
  {
    id: "customfield_10102",
    name: "FE/BE/UX",
    custom: true,
    schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
  },
];

export const JIRA_BOARDS = {
  values: [
    { id: 20, name: "Web Portal", type: "scrum" },
    { id: 21, name: "WebPortal Test Queue", type: "scrum" },
    { id: 42, name: "Assignment mode on Tablets", type: "kanban" },
  ],
  isLast: true,
};

export const JIRA_ONE_BOARD = {
  values: [{ id: 40, name: "AUT board", type: "scrum" }],
  isLast: true,
};

export const JIRA_ACTIVE_SPRINT = {
  values: [
    {
      id: 3128,
      name: "TP 4.2.140 July 31",
      state: "active",
      startDate: "2026-07-13T15:03:12.890Z",
      endDate: "2026-07-31T04:00:00.000Z",
      originBoardId: 20,
    },
  ],
  isLast: true,
};

export const JIRA_NO_SPRINT = { values: [], isLast: true };

export const JIRA_CREATED_ISSUE = {
  id: "10501",
  key: "TP-4242",
  self: "https://jira.test/rest/api/3/issue/10501",
};

/**
 * A `/user/search` hit with **no** `emailAddress`.
 *
 * This is the normal case: Atlassian withholds the address unless the caller holds
 * "View user email addresses", even though the search itself matched on it. A
 * client that insists on matching the returned email finds nobody.
 */
export const JIRA_USER_NO_EMAIL = [
  {
    accountId: "612a1b2c3d4e5f6789012345",
    displayName: "Rowan Vance",
    active: true,
    accountType: "atlassian",
  },
];

export const JIRA_USERS_AMBIGUOUS = [
  { accountId: "aaa", displayName: "Sam Taylor", active: true, accountType: "atlassian" },
  { accountId: "bbb", displayName: "Sam T.", active: true, accountType: "atlassian" },
];

export const JIRA_USER_WITH_EMAIL = [
  {
    accountId: "612a1b2c3d4e5f6789012345",
    displayName: "Rowan Vance",
    emailAddress: "rowan@example.com",
    active: true,
    accountType: "atlassian",
  },
  {
    accountId: "app-account",
    displayName: "Some App",
    emailAddress: "rowan@example.com",
    active: true,
    accountType: "app",
  },
];

export function searchResult(
  issues: { key: string; status?: string; category?: string }[],
) {
  return {
    issues: issues.map((issue, index) => ({
      id: String(20000 + index),
      key: issue.key,
      fields: {
        summary: `Existing ${issue.key}`,
        status: {
          name: issue.status ?? "To Do",
          statusCategory: { key: issue.category ?? "new", name: "To Do" },
        },
      },
    })),
  };
}

/** An issue as `/issue/:key` returns it. */
export function issueResponse(key: string, category = "new") {
  return {
    id: "10501",
    key,
    fields: {
      summary: `Existing ${key}`,
      assignee: JIRA_MYSELF,
      status: {
        name: category === "done" ? "Done" : "To Do",
        statusCategory: { key: category, name: category === "done" ? "Done" : "To Do" },
      },
    },
  };
}
