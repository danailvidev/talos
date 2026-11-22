import type {
  AgentAccountsView,
  ProviderAccessView,
} from "../../shared/api-contract.ts";
import {
  fieldsInScope,
  integrationsInScope,
  type IntegrationId,
} from "../../shared/integrations.ts";

export const SETUP_PROVIDERS = ["gitlab", "jira"] as const satisfies readonly IntegrationId[];
export type SetupProvider = (typeof SETUP_PROVIDERS)[number];

export interface SetupStatus {
  agentConnected: boolean;
  missingProviders: SetupProvider[];
  complete: boolean;
}

/**
 * The personal connections a developer needs before TALOS can work as them.
 *
 * A host agent runtime is intentionally not a connection: it is borrowed from
 * the machine running TALOS and does not follow the developer to another
 * installation. Likewise, an instance provider token is not the developer's
 * identity, so only readable user-owned fields count.
 */
export function setupStatus(
  agents: AgentAccountsView,
  access: ProviderAccessView,
): SetupStatus {
  const credentialState = new Map(access.fields.map((field) => [field.name, field]));
  const personalIntegrations = integrationsInScope("user");
  const missingProviders = SETUP_PROVIDERS.filter((provider) => {
    const integration = personalIntegrations.find(({ id }) => id === provider);
    if (!integration) return false;
    return fieldsInScope(integration, "user").some((field) => {
      const state = credentialState.get(field.name);
      return state?.origin !== "user" || state.unreadable === true;
    });
  });

  // An empty catalog means this installation exposes no personal agent
  // connection to complete, so provider access alone can finish onboarding.
  const agentConnected =
    agents.catalog.length === 0 ||
    agents.catalog.some((entry) =>
      entry.accounts.some((account) => account.unreadable !== true),
    );

  return {
    agentConnected,
    missingProviders,
    complete: agentConnected && missingProviders.length === 0,
  };
}
