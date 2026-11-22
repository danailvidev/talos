import { describe, expect, test } from "bun:test";

import type {
  AgentAccountsView,
  ProviderAccessView,
} from "../../shared/api-contract.ts";
import { setupStatus } from "../src/setup-status.ts";

const connectedAgents: AgentAccountsView = {
  secretsEnabled: true,
  catalog: [
    {
      provider: "claude",
      name: "Claude",
      tagline: "Agent",
      docs: "https://example.com",
      options: [],
      accounts: [
        {
          id: "agent-1",
          provider: "claude",
          label: "Work account",
          method: "key",
          optionId: "claude:key",
          usedForRuns: true,
          createdAt: "2026-10-06T00:00:00.000Z",
        },
      ],
    },
  ],
};

const connectedProviders: ProviderAccessView = {
  enabled: true,
  supported: ["GITLAB_TOKEN", "JIRA_EMAIL", "JIRA_TOKEN"],
  fields: [
    {
      name: "GITLAB_TOKEN",
      origin: "user",
      value: null,
      updatedAt: "2026-10-06T00:00:00.000Z",
    },
    {
      name: "JIRA_EMAIL",
      origin: "user",
      value: "developer@example.com",
      updatedAt: "2026-10-06T00:00:00.000Z",
    },
    {
      name: "JIRA_TOKEN",
      origin: "user",
      value: null,
      updatedAt: "2026-10-06T00:00:00.000Z",
    },
  ],
};

describe("setup status", () => {
  test("is complete when an agent and both provider identities are connected", () => {
    expect(setupStatus(connectedAgents, connectedProviders)).toEqual({
      agentConnected: true,
      missingProviders: [],
      complete: true,
    });
  });

  test("reports partial or unreadable provider identities as missing", () => {
    const access: ProviderAccessView = {
      ...connectedProviders,
      fields: connectedProviders.fields.map((field) =>
        field.name === "GITLAB_TOKEN"
          ? { ...field, unreadable: true }
          : field.name === "JIRA_TOKEN"
            ? { ...field, origin: "shared" }
            : field,
      ),
    };

    expect(setupStatus(connectedAgents, access)).toEqual({
      agentConnected: true,
      missingProviders: ["gitlab", "jira"],
      complete: false,
    });
  });

  test("does not count the host fallback or an unreadable account as connected", () => {
    const agents: AgentAccountsView = {
      ...connectedAgents,
      catalog: connectedAgents.catalog.map((entry) => ({
        ...entry,
        hostRuntime: { path: "/home/talos/.claude" },
        accounts: entry.accounts.map((account) => ({ ...account, unreadable: true })),
      })),
    };

    expect(setupStatus(agents, connectedProviders)).toEqual({
      agentConnected: false,
      missingProviders: [],
      complete: false,
    });
  });
});
