import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Plug,
  Sparkles,
} from "lucide-react";

import { AgentConnectionsDialog } from "./AgentConnectionsDialog.tsx";
import { ProviderAccessDialog } from "./ProviderAccessDialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { FormActions } from "./components/ui/field.tsx";
import { Modal } from "./components/ui/modal.tsx";
import { queries } from "./queries.ts";
import { setupStatus } from "./setup-status.ts";
import { useApi } from "./useApi.ts";

type SetupScreen = "reminder" | "agents" | "providers";

/**
 * A post-sign-in checklist for developers whose personal connections are not
 * ready yet. The two setup screens remain the source of truth; this dialog only
 * points at them and disappears as soon as their queries report completion.
 */
export function SetupReminderDialog({ onClose }: { onClose: () => void }) {
  const agents = useApi(queries.agentAccounts());
  const access = useApi(queries.providerAccess());
  const [screen, setScreen] = useState<SetupScreen>("reminder");
  const status =
    agents.data && access.data ? setupStatus(agents.data, access.data) : undefined;

  useEffect(() => {
    if (status?.complete) onClose();
  }, [status?.complete, onClose]);

  // Do not interrupt sign-in with a loading shell or with a setup prompt whose
  // state could not be established.
  if (!status || status.complete) return null;

  return (
    <AnimatePresence mode="wait">
      {screen === "agents" ? (
        <AgentConnectionsDialog
          key="agents"
          onClose={() => setScreen("reminder")}
        />
      ) : screen === "providers" ? (
        <ProviderAccessDialog
          key="providers"
          onClose={() => setScreen("reminder")}
        />
      ) : (
        <Modal
          key="reminder"
          onClose={onClose}
          className="sm:max-w-150"
          title={
            <>
              <Sparkles size={19} className="text-action" />
              Finish your setup
            </>
          }
        >
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Connect your accounts so TALOS can run agents and work in GitLab and
            Jira as you. You can do this later; we will remind you after your next
            sign-in.
          </p>

          <div className="mt-3 flex flex-col gap-2.5">
            <SetupItem
              icon={<Plug size={17} />}
              title="Agent connections"
              description="Choose the personal AI agent account used for your runs."
              complete={status.agentConnected}
              incompleteLabel="No agent account connected"
              onOpen={() => setScreen("agents")}
            />
            <SetupItem
              icon={<KeyRound size={17} />}
              title="Provider access"
              description="Add your personal credentials so TALOS can read and act as you."
              complete={status.missingProviders.length === 0}
              incompleteLabel={`${status.missingProviders
                .map((provider) => (provider === "gitlab" ? "GitLab" : "Jira"))
                .join(" and ")} access missing`}
              onOpen={() => setScreen("providers")}
            />
          </div>

          <FormActions>
            <Button type="button" variant="outline" onClick={onClose}>
              Remind me next time
            </Button>
          </FormActions>
        </Modal>
      )}
    </AnimatePresence>
  );
}

function SetupItem({
  icon,
  title,
  description,
  complete,
  incompleteLabel,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  complete: boolean;
  incompleteLabel: string;
  onOpen: () => void;
}) {
  return (
    <section className="flex items-center gap-3 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] p-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--bg-hover)] text-action">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-[0.9375rem] font-medium text-foreground">
          {title}
        </strong>
        <span className="mt-0.5 block text-[0.7812rem] leading-normal text-muted-foreground">
          {description}
        </span>
        <span
          className={
            complete
              ? "mt-1 inline-flex items-center gap-1 text-xs text-[var(--success)]"
              : "mt-1 inline-flex items-center gap-1 text-xs text-[var(--warn)]"
          }
        >
          {complete ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}
          {complete ? "Connected" : incompleteLabel}
        </span>
      </span>
      <Button type="button" variant={complete ? "outline" : "default"} onClick={onOpen}>
        {complete ? "Manage" : "Set up"}
      </Button>
    </section>
  );
}
