import type { IntegrationId } from "../../../shared/integrations.ts";

/**
 * Live datasets that read GitLab or Jira as the signed-in user.
 *
 * Stored datasets (pipelines, loop runs, agent usage) stay off this list:
 * they do not need a personal token, so a dashboard made only of them has
 * nothing to ask for.
 */
const DATASET_PROVIDER: Partial<Record<string, IntegrationId>> = {
  "gitlab.merge_requests": "gitlab",
  "jira.issues": "jira",
};

/** The provider a widget queries as the viewer, when it has one. */
export function providerForDataset(dataset: string): IntegrationId | undefined {
  return DATASET_PROVIDER[dataset];
}

/** GitLab first, then Jira — the same order the access notice names them in. */
const PROVIDER_ORDER = ["gitlab", "jira"] as const;

/** Providers the widgets on screen actually call. */
export function providersForWidgets(
  widgets: readonly { query: { dataset: string } }[],
): IntegrationId[] {
  const found = new Set<IntegrationId>();
  for (const widget of widgets) {
    const provider = DATASET_PROVIDER[widget.query.dataset];
    if (provider) found.add(provider);
  }
  return PROVIDER_ORDER.filter((id) => found.has(id));
}

/**
 * What the access notice says it cannot do. Names only the providers still
 * missing, so a stored GitLab token does not get blamed for an empty Jira table.
 */
export function dashboardAccessPurpose(providers: readonly IntegrationId[]): string {
  const gitlab = providers.includes("gitlab");
  const jira = providers.includes("jira");
  if (gitlab && jira) return "Showing merge requests and tickets on this dashboard";
  if (gitlab) return "Showing merge requests on this dashboard";
  if (jira) return "Showing tickets on this dashboard";
  return "Showing this dashboard";
}
