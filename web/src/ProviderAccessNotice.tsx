import { AnimatePresence } from "motion/react";
import { Info, KeyRound } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  fieldsInScope,
  integrationsInScope,
  type IntegrationId,
} from "../../shared/integrations.ts";
import { Button } from "./components/ui/button.tsx";
import { isSet, ProviderAccessDialog } from "./ProviderAccessDialog.tsx";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { INFO_BOX_CLASS, INFO_ICON_CLASS } from "./state-styles.ts";

/*
 * The other half of My provider access: saying so on the page where the missing
 * token is about to matter.
 *
 * A developer's GitLab and Jira tokens are not defaulted — the instance's own
 * exist for the loops that run without an actor, and borrowing one would
 * attribute this person's comments to somebody else. So work that has to act as
 * them cannot run as them until they store their own, and the worst way to say
 * that is an empty page: "you have no open merge requests" and "TALOS cannot
 * see your merge requests" look identical and mean opposite things.
 *
 * Read from `/api/me/credentials` rather than from each page's own payload,
 * because it answers the question this asks — *is a credential of mine missing* —
 * for a page that has not made the call yet. Pages that learn it from the server
 * on the way past (the merge request list, whose `unavailable` names the forge it
 * could not ask) keep using that and only borrow the button.
 */

/** One provider this developer cannot be acted for on. */
export interface MissingProviderAccess {
  id: IntegrationId;
  name: string;
  /** The credential names they have nothing stored under. */
  missing: string[];
}

/**
 * Which of these providers this developer is not connected to.
 *
 * Empty while the read is in flight, so a page does not flash a notice at
 * somebody who turns out to be fully set up. Partial counts as missing: a Jira
 * email without a token authenticates as nobody.
 */
export function useMissingProviderAccess(
  providers: readonly IntegrationId[],
): { missing: MissingProviderAccess[]; storable: boolean; ready: boolean } {
  const access = useApi(queries.providerAccess());
  const state = new Map((access.data?.fields ?? []).map((field) => [field.name, field]));

  if (!access.data) return { missing: [], storable: true, ready: !access.loading };

  const missing = integrationsInScope("user")
    .filter((integration) => providers.includes(integration.id))
    .map((integration) => ({
      id: integration.id,
      name: integration.name,
      missing: fieldsInScope(integration, "user")
        .filter((field) => !isSet(state.get(field.name)))
        .map((field) => field.name),
    }))
    .filter((provider) => provider.missing.length > 0);

  return { missing, storable: access.data.enabled, ready: true };
}

/**
 * A way to open My provider access from wherever the gap was noticed.
 *
 * The dialog is hosted by the caller rather than lifted into a context: it takes
 * only an `onClose`, nothing outside needs to know whether it is open, and a piece
 * of local state per notice is cheaper than a provider around the whole app. The
 * user menu keeps its own copy for the same reason.
 *
 * Headless because the two callers do not look alike — an info panel's button and
 * a graph warning's inline link — and passing a class name through would make this
 * own an appearance it has no opinion about.
 *
 * Render `dialog` somewhere that outlives the notice around it. Storing a token is
 * exactly what stops such a notice being true, so a dialog mounted inside one
 * vanishes mid-save: the first credential saves, the warning unmounts, and the
 * dialog goes with it before the second one can be typed.
 */
export function useProviderAccessDialog(): { open: () => void; dialog: ReactNode } {
  const [open, setOpen] = useState(false);

  return {
    open: () => setOpen(true),
    dialog: (
      <AnimatePresence>
        {open ? <ProviderAccessDialog onClose={() => setOpen(false)} /> : null}
      </AnimatePresence>
    ),
  };
}

/** The button, for the panels that want one. The dialog is the caller's to host. */
export function ProviderAccessButton({
  onOpen,
  children = "Set up my access",
  variant = "outline",
}: {
  onOpen: () => void;
  children?: string;
  variant?: "default" | "outline";
}) {
  return (
    <Button type="button" variant={variant} onClick={onOpen}>
      <KeyRound size={14} strokeWidth={2} /> {children}
    </Button>
  );
}

/**
 * "This needs a token of yours, and you have not stored one."
 *
 * An info panel and not an error, like the merge request list's: nothing has gone
 * wrong, the platform simply cannot act for this person yet. It names the
 * credential as well as the provider, because "store your GitLab token" and
 * "store `GITLAB_TOKEN`" are the same instruction only to somebody who already
 * knows the mapping.
 */
export function ProviderAccessNotice({
  providers,
  purpose,
}: {
  providers: readonly IntegrationId[];
  /**
   * What cannot be done, in the reader's terms — "Uploading a release".
   * A function is called with the providers still missing, so the sentence can
   * name only those. The notice itself stays mounted either way.
   */
  purpose: string | ((missing: readonly IntegrationId[]) => string);
}) {
  const { missing, storable } = useMissingProviderAccess(providers);
  const access = useProviderAccessDialog();

  const names = missing.map((provider) => provider.name).join(" and ");
  const credentials = missing.flatMap((provider) => provider.missing);
  const purposeText = typeof purpose === "function"
    ? purpose(missing.map((provider) => provider.id))
    : purpose;

  // The panel goes when it stops being true; the dialog keeps its place in the
  // tree either way. Saving a token is what makes this notice untrue, so hanging
  // the dialog off the panel would tear it down mid-save — one credential stored
  // and the box for the next one gone.
  return (
    <>
      {missing.length === 0 ? null : (
        <div className={INFO_BOX_CLASS}>
          <Info size={16} strokeWidth={2} className={INFO_ICON_CLASS} />
          <div>
            <strong>No {names} access stored for you.</strong> {purposeText} needs TALOS to act
            as you on {names}, which it cannot do until you store{" "}
            {credentials.map((name, index) => (
              <span key={name}>
                {index > 0 ? (index === credentials.length - 1 ? " and " : ", ") : null}
                <code className="mono">{name}</code>
              </span>
            ))}
            .
            {storable ? null : (
              <>
                {" "}
                This install has no encryption key yet, so an operator has to add{" "}
                <code className="mono">TALOS_SECRET_KEY</code> before a personal token can
                be saved.
              </>
            )}
            <div className="mt-2.5">
              <ProviderAccessButton onOpen={access.open} />
            </div>
          </div>
        </div>
      )}
      {access.dialog}
    </>
  );
}
