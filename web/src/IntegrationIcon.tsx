import type { ReactElement } from "react";

import type { IntegrationId } from "../../shared/integrations.ts";
import { DatadogIcon } from "./DatadogIcon.tsx";
import { GitLabIcon } from "./GitLabIcon.tsx";
import { JiraIcon } from "./JiraIcon.tsx";
import { LogRocketIcon } from "./LogRocketIcon.tsx";
import { SlackIcon } from "./SlackIcon.tsx";

/**
 * A provider's mark, by catalog id.
 *
 * Its own module because two surfaces render the same cards from the same
 * catalog now — Settings → Integrations for the instance settings, My provider
 * access for the personal identities — and the alternative was one of them
 * importing the other's page for a lookup table.
 *
 * Partial, and rendered as nothing when a provider has no mark: an integration
 * added to the catalog should show up on the page that owns it whether or not
 * anybody has drawn its logo yet.
 */
const INTEGRATION_ICONS: Partial<
  Record<IntegrationId, (props: { size?: number }) => ReactElement>
> = {
  gitlab: GitLabIcon,
  jira: JiraIcon,
  slack: SlackIcon,
  logrocket: LogRocketIcon,
  datadog: DatadogIcon,
};

export function IntegrationIcon({
  id,
  size = 16,
}: {
  id: IntegrationId;
  size?: number;
}): ReactElement | null {
  const Icon = INTEGRATION_ICONS[id];
  return Icon ? <Icon size={size} /> : null;
}
