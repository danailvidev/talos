import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";

import { AddAgentAccountDialog } from "./AddAgentAccountDialog.tsx";
import { AgentIcon } from "./AgentIcon.tsx";
import {
  api,
  agentLlmCapabilities,
  type AgentAccountView,
  type AgentAccountsView,
  type AgentCatalogEntry,
  type AgentHostRuntime,
  type LlmEffort,
  type LlmModel,
} from "./api.ts";
import { Field, FormActions } from "./components/ui/field.tsx";
import { Button } from "./components/ui/button.tsx";
import { Modal } from "./components/ui/modal.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Tip } from "./Tip.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { invalidate, queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { ICON_BUTTON_CLASS } from "./app-styles.ts";
import { cn } from "./lib/utils.ts";
import {
  EFFORT_LABELS,
  fromLlmSelectValue,
  LLM_DEFAULT,
  MODEL_LABELS,
  toLlmSelectValue,
} from "./llm-options.ts";

const ACCOUNT_ROW_CLASS =
  "flex items-center gap-2.5 rounded-[var(--radius)] border border-border px-2 py-1.5 text-sm";
const ACCOUNT_NAME_CLASS =
  "flex min-w-0 flex-1 flex-col [&_small]:text-[0.7812rem] [&_small]:text-[var(--text-faint)] [&_strong]:font-medium [&_strong]:text-foreground";

/**
 * The AI agent accounts you have connected, and the ones you could.
 *
 * A catalog rather than a list of what happens to be installed: this is the page
 * for "TALOS should run on my ChatGPT plan", so every vendor is on it whether
 * or not this host has been signed into it. What each card offers are that
 * vendor's *real* options — see `src/infrastructure/agent/catalog.ts`, which is
 * also where the finding behind the whole shape of this dialog is written down:
 * none of these vendors publish an OAuth app a third party can use, so a
 * subscription is reached either by pasting a token the vendor's CLI printed, or
 * by letting TALOS run that CLI's own login here.
 *
 * Accounts are per developer, and there is no way to spell somebody else's — the
 * endpoint has no id in its path. Credentials are write-only: nothing this dialog
 * can call returns one.
 *
 * Everything on this page is about *your* runs, and that is the load-bearing fact:
 * each developer connects their own agent and their own work authenticates as it,
 * the same way `ctx.secrets` already hands a task their GitLab token rather than a
 * shared one. Loops that belong to the install rather than to a person run as
 * whichever user owns them — a dedicated system account, whose connected agent is
 * an ordinary row here.
 *
 * Two kinds of row, and the difference matters. Accounts are what you added; they
 * carry their own connected state and their own disconnect. `hostRuntime` is the
 * login TALOS's runner mounts into your containers *while you have connected
 * nothing* — reported because your work runs on it, derived from the `docker run`
 * argv rather than from anyone's config file, and never dressed up as a connection:
 * it is borrowed, it is only on this one machine, and treating it as one is what
 * made a genuinely connected Bedrock account look unconnected.
 *
 * That last distinction is deliberate. An earlier version probed the host's home
 * directory for every vendor and listed what it found, which put the email behind
 * the operator's own Codex and Cursor sessions on this page without anyone asking.
 * Reporting "this directory is mounted into runs" needs no such reading, and says
 * nothing about who or what the login is authenticated as.
 */
export function AgentConnectionsDialog({ onClose }: { onClose: () => void }) {
  const accounts = useApi(queries.agentAccounts());
  const [adding, setAdding] = useState<AgentCatalogEntry>();

  return (
    <>
      <Modal
        onClose={onClose}
        className="sm:max-w-180"
        title={
          <>
            Agent connections
            <TitleInfo>
              The AI agent accounts TALOS may work on your behalf — your own subscriptions and
              keys, so a run bills where you expect it to. Listed here: the login this machine
              already runs on, and whatever you add. TALOS does not read your vendor config
              files to find others.
            </TitleInfo>
          </>
        }
      >
        {accounts.data ? <AgentRunDefaults accounts={accounts.data} /> : null}

        {accounts.error ? (
          <ErrorBox>{accounts.error}</ErrorBox>
        ) : accounts.loading ? (
          <Loading>Loading agents…</Loading>
        ) : (
          <div className="mt-3 flex flex-col gap-2.5">
            {(accounts.data?.catalog ?? []).map((entry) => (
              <AgentCard key={entry.provider} entry={entry} onAdd={() => setAdding(entry)} />
            ))}
          </div>
        )}

        {/* Said once here rather than repeated on every row: whose account a run
            uses is the thing people get wrong about this page. */}
        <p className="mt-3 block max-w-[62ch] text-[0.7812rem] leading-normal text-[var(--text-faint)]">
          Your agent runs authenticate as the account you connect here, so your work bills to
          your own plan and nothing you do on this page affects anyone else. Until you connect
          one, your runs borrow this machine's own login.
        </p>

        <FormActions>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </FormActions>
      </Modal>

      {/* A sibling rather than a child, for the reason the release confirmation is
          one: nesting means a click on this dialog's backdrop bubbles out and
          closes the catalog behind it too. */}
      <AnimatePresence>
        {adding ? (
          <AddAgentAccountDialog
            entry={adding}
            secretsEnabled={accounts.data?.secretsEnabled ?? false}
            onClose={() => setAdding(undefined)}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}

function AgentRunDefaults({ accounts }: { accounts: AgentAccountsView }) {
  const queryClient = useQueryClient();
  const preferences = useApi(queries.agentRunPreferences());
  const [model, setModel] = useState(LLM_DEFAULT);
  const [effort, setEffort] = useState(LLM_DEFAULT);
  const save = useAction();
  const claude = accounts.catalog.find((entry) => entry.provider === "claude");
  const runtimeAccount = claude?.accounts.find((account) => account.usedForRuns);
  const hasRuntime = runtimeAccount != null || claude?.hostRuntime != null;
  const capabilities = agentLlmCapabilities("claude", runtimeAccount?.optionId);
  const usesBedrock = runtimeAccount?.optionId.startsWith("claude:bedrock-") === true;

  useEffect(() => {
    if (!preferences.data) return;
    setModel(toLlmSelectValue(preferences.data.model));
    setEffort(toLlmSelectValue(preferences.data.effort));
  }, [preferences.data]);

  const dirty =
    preferences.data != null &&
    (model !== toLlmSelectValue(preferences.data.model) ||
      effort !== toLlmSelectValue(preferences.data.effort));

  const handleSave = () =>
    save.run(async () => {
      const saved = await api.setAgentRunPreferences({
        model: fromLlmSelectValue(model) as LlmModel | null,
        effort: fromLlmSelectValue(effort) as LlmEffort | null,
      });
      queryClient.setQueryData(keys.me.agentRunPreferences(), saved);
    });

  return (
    <section className="mt-3 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] px-3 py-[11px]">
      <h3 className="inline-flex items-center gap-1.5 text-[0.9375rem] font-medium text-foreground">
        Your run defaults
        <TitleInfo>
          Used by chat and agent actions you start. Scheduled loops and work they discover use
          the instance defaults in Settings. Model choices follow{" "}
          {runtimeAccount
            ? `${runtimeAccount.label} (${runtimeAccount.optionId})`
            : "this machine's Claude runtime"}
          ; other providers get their own choices when their runners are enabled.
        </TitleInfo>
      </h3>
      {usesBedrock ? (
        <p className="mt-1 text-[0.7812rem] leading-normal text-[var(--text-faint)]">
          Bedrock IAM and region settings may further restrict this list; a denied model is
          reported by the run rather than silently replaced.
        </p>
      ) : null}
      {!hasRuntime ? (
        <p className="mt-3 text-sm text-[var(--text-faint)]">
          Connect a runnable Claude account before choosing run defaults.
        </p>
      ) : preferences.error ? (
        <ErrorBox>{preferences.error}</ErrorBox>
      ) : preferences.loading && !preferences.data ? (
        <Loading>Loading run defaults…</Loading>
      ) : preferences.data ? (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Model">
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={LLM_DEFAULT}>Use instance default</SelectItem>
                  {capabilities.models.map((value) => (
                    <SelectItem key={value} value={value}>
                      {MODEL_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Effort">
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={LLM_DEFAULT}>Use instance default</SelectItem>
                  {capabilities.efforts.map((value) => (
                    <SelectItem key={value} value={value}>
                      {EFFORT_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button type="button" disabled={save.busy || !dirty} onClick={handleSave}>
              {save.busy ? "Saving…" : "Save defaults"}
            </Button>
          </div>
          {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
          {save.done && !dirty ? (
            <div className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function AgentCard({ entry, onAdd }: { entry: AgentCatalogEntry; onAdd: () => void }) {
  return (
    <section className="rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] px-3 py-[11px]">
      <header className="flex items-center gap-2.5">
        <AgentIcon provider={entry.provider} size={18} />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <strong className="text-[0.9375rem] font-medium text-foreground">{entry.name}</strong>
          <small className="text-[0.7812rem] text-muted-foreground">{entry.tagline}</small>
        </span>
        {/* Gone once a vendor has an account, rather than demoted or relabelled.
            The row below is the whole state of this card — it says the account is
            connected and its trash icon disconnects it — and a card still offering
            to add one read as "nothing here yet" no matter how it was worded.
            Disconnect first to connect something else. */}
        {entry.accounts.length === 0 ? (
          <Button type="button" variant="outline" onClick={onAdd}>
            <Plus size={13} strokeWidth={2} />
            Add account
          </Button>
        ) : null}
      </header>

      {entry.hostRuntime || entry.accounts.length > 0 ? (
        <ul className="mt-2.5 flex list-none flex-col gap-1.5 p-0">
          {/* Only ever sent while nothing is connected, so it is alone in the list
              when it appears at all — no ordering question to answer. */}
          {entry.hostRuntime ? (
            <HostRuntimeRow runtime={entry.hostRuntime} name={entry.name} />
          ) : null}
          {entry.accounts.map((account) => (
            <AccountRow key={account.id} account={account} entry={entry} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[0.7812rem] leading-normal text-[var(--text-faint)]">
          {/* "No account added" rather than "Not connected": this card knows only
              what is stored here, and the machine can be perfectly well signed in
              to the vendor's CLI — TALOS does not look, and either way that is
              not what this row is about. */}
          No account added.{" "}
          {/* The methods are named on the card rather than hidden behind the
              button: which ones a vendor actually supports is the question this
              page exists to answer, and Copilot having no scriptable login is
              worth knowing before you click. */}
          {entry.options.map((option) => option.label).join(" · ")}
        </p>
      )}
    </section>
  );
}

/**
 * The directory runs fall back to while nothing is connected — a stopgap, styled
 * as one.
 *
 * Deliberately not presented as a connected account, though work does go through
 * it today: it exists only on the machine TALOS happens to be running on, so an
 * install deployed anywhere else has nothing here and every run fails until
 * somebody adds an account. Sent by the server only while it is the fallback in
 * effect (see `AgentHostRuntime`), and there is nothing to disconnect — it belongs
 * to whoever runs the process, and `claude /logout` on the host is how it goes
 * away.
 *
 * Says nothing about the login behind it, and cannot: all the server reports is
 * the path `runAgentJob` mounts. Whether it is a subscription, an API key or
 * Bedrock is the vendor's config to know, and TALOS does not open it.
 */
function HostRuntimeRow({ runtime, name }: { runtime: AgentHostRuntime; name: string }) {
  return (
    <li
      className={cn(
        ACCOUNT_ROW_CLASS,
        "border-dashed border-[color-mix(in_srgb,var(--warn)_45%,var(--border))] bg-[color-mix(in_srgb,var(--bg-hover)_40%,transparent)]",
      )}
    >
      <span className={ACCOUNT_NAME_CLASS}>
        <strong>Falling back to this machine's {name} config</strong>
        <small className="mono">{runtime.path}</small>
      </span>
      <span className="text-[0.7812rem] text-muted-foreground">
        <Tip
          label={`Mounted read-only into every ${name} container while no account is connected. It only exists on this machine — a TALOS deployed elsewhere has no such directory, and runs there fail until an account is added. Adding one replaces this entirely.`}
        >
          <span className="whitespace-nowrap text-[0.7812rem] text-[var(--warn)]">
            local only · add an account
          </span>
        </Tip>
      </span>
    </li>
  );
}

function AccountRow({
  account,
  entry,
}: {
  account: AgentAccountView;
  entry: AgentCatalogEntry;
}) {
  const queryClient = useQueryClient();
  // One action for both buttons on the row, and it keeps the failure: these two
  // had a bare `try/finally`, so a disconnect the server refused re-enabled the
  // button and said nothing at all.
  const action = useAction();
  const option = entry.options.find((candidate) => candidate.id === account.optionId);

  const disconnect = () =>
    action.run(async () => {
      await api.deleteAgentAccount(account.id);
      invalidate.agentAccounts(queryClient);
    });

  const useForRuns = () =>
    action.run(async () => {
      await api.useAgentAccountForRuns(account.id);
      invalidate.agentAccounts(queryClient);
    });

  return (
    <li
      className={cn(
        ACCOUNT_ROW_CLASS,
        account.usedForRuns && "border-l-2 border-l-[var(--success)]",
      )}
    >
      <span className={ACCOUNT_NAME_CLASS}>
        <strong>{account.label}</strong>
        {account.account ? <small>{account.account}</small> : null}
      </span>
      <span className="text-[0.7812rem] text-muted-foreground">
        {option?.label ?? account.optionId}
      </span>
      {/* Which account your work bills to is the point of this page, so it is a
          state on the row rather than something to infer from an order. Only ever
          about your own runs — nominating an account changes nothing for anybody
          else. */}
      {account.usedForRuns ? (
        <Tip label="Your agent runs authenticate as this account. Everyone else's run on whatever they connected.">
          <span className="whitespace-nowrap text-[0.7812rem] text-[var(--success)]">
            connected · used by your runs
          </span>
        </Tip>
      ) : account.unreadable ? null : (
        <Tip label="Point your agent runs at this account instead, from your next run onwards.">
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-[0.7812rem] whitespace-nowrap text-muted-foreground underline decoration-dotted underline-offset-2 enabled:hover:text-[var(--success)]"
            disabled={action.busy}
            onClick={() => void useForRuns()}
          >
            Use for runs
          </Button>
        </Tip>
      )}
      {/* A stored credential this server can no longer decrypt: the row is there
          and the account does not work, which is worth saying out loud rather than
          discovering on the next run. */}
      {account.unreadable ? (
        <span
          className="inline-flex items-center gap-1 text-[0.7812rem] text-[var(--warn)]"
          title="Add the account again to fix this."
        >
          <AlertTriangle size={12} strokeWidth={2} />
          credential unreadable
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={ICON_BUTTON_CLASS}
        aria-label={`Disconnect ${account.label}`}
        disabled={action.busy}
        onClick={() => void disconnect()}
      >
        <Trash2 size={13} strokeWidth={2} />
      </Button>
      {action.error ? (
        <span className="inline-flex items-center gap-1 text-[0.7812rem] text-[var(--warn)]">
          {action.error}
        </span>
      ) : null}
    </li>
  );
}
