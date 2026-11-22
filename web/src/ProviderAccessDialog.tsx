import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import {
  api,
  type ProviderAccessView,
  type ProviderCredentialState,
  type SlackConnectionView,
} from "./api.ts";
import {
  fieldsInScope,
  integrationsInScope,
  type Integration,
  type IntegrationId,
} from "../../shared/integrations.ts";
import { applyEdit, CredentialFieldRow } from "./CredentialField.tsx";
import { Button } from "./components/ui/button.tsx";
import { FormActions } from "./components/ui/field.tsx";
import { Modal } from "./components/ui/modal.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { IntegrationIcon } from "./IntegrationIcon.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { Tip } from "./Tip.tsx";
import { ago } from "./format.ts";
import { queries } from "./queries.ts";
import { toMessage } from "./errors.ts";
import { useApi } from "./useApi.ts";
import { useFormat } from "./FormatContext.tsx";
import { cn } from "./lib/utils.ts";
import {
  INTEGRATION_CARD_ACTIONS_CLASS,
  INTEGRATION_CARD_CLASS,
  INTEGRATION_CARD_DESCRIPTION_CLASS,
  INTEGRATION_CARD_HEAD_CLASS,
  INTEGRATION_CARD_TITLE_CLASS,
  INTEGRATION_STATUS_CLASS,
  INTEGRATION_STATUS_TONE,
} from "./integration-styles.ts";

/**
 * My provider access: the GitLab and Jira identity *your* work authenticates as.
 *
 * The per-developer half of `shared/integrations.ts` — every field it marks
 * `scope: "user"`, which is the same catalog Settings → Integrations renders the
 * instance half of. So the cards here are not a second list to keep in step:
 * marking one more field `"user"` moves it from that page to this dialog.
 *
 * Why it is a personal surface rather than a settings tab. A token here is an
 * identity, not a configuration: `actorSecretStore` hands your GitLab token to
 * your runs, so the review comment lands under your name and "my merge requests"
 * has a meaning. Fifteen of these cannot live on one instance-wide page — and
 * before this dialog existed the only way to store one was the CLI, which is why
 * the empty state of the merge request list used to name a shell command.
 *
 * A credential you have not stored is missing, not defaulted, and the cards say
 * so plainly. The instance has tokens of its own for the loops that run without
 * an actor, but they are not an identity anybody can be attributed to, so this
 * dialog does not offer them as a fallback: work that has to act as you is work
 * TALOS cannot do until you store your own. `ProviderAccessNotice` is the
 * other half of that promise — it says the same thing on the pages where the
 * missing token is about to matter.
 *
 * Tokens are write-only, here as everywhere: the server never sends one back, so
 * an input starts empty and says what is stored beside it instead. Leaving one
 * blank therefore means "leave it alone", which is why Clear is its own button.
 */
export function ProviderAccessDialog({ onClose }: { onClose: () => void }) {
  const access = useApi(queries.providerAccess());

  return (
    <Modal
      onClose={onClose}
      className="sm:max-w-180"
      title={
        <>
          My provider access
          <TitleInfo>
            The GitLab, Jira, and Slack accounts TALOS uses for your work. Yours alone —
            nothing here changes anything for anybody else, and anything you have not stored is
            work TALOS cannot do on your behalf. The site URLs these authenticate against are
            instance-wide and live under Settings → Integrations.
          </TitleInfo>
        </>
      }
    >
      {access.error ? (
        <ErrorBox>{access.error}</ErrorBox>
      ) : access.loading && !access.data ? (
        <Loading>Loading your access…</Loading>
      ) : access.data ? (
        <ProviderAccessForm data={access.data} onClose={onClose} />
      ) : null}
    </Modal>
  );
}

/** Why a field cannot be typed into. */
const NO_KEY_REASON = "Needs TALOS_SECRET_KEY";

function ProviderAccessForm({
  data,
  onClose,
}: {
  data: ProviderAccessView;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const state = new Map(data.fields.map((field) => [field.name, field]));
  // Only what has been typed. A name absent from this map is not sent, which is
  // what makes saving one card leave the other provider's credentials alone.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<IntegrationId | null>(null);
  const [errorId, setErrorId] = useState<{ id: IntegrationId; message: string } | null>(null);
  const [savedId, setSavedId] = useState<IntegrationId | null>(null);
  // Expanded by default, and folded away by choice — the two inputs are what the
  // dialog is for, so opening it onto a pair of closed headers would be a click
  // for nothing. The chevron is for the provider you are not here about.
  const [expanded, setExpanded] = useState<Set<IntegrationId>>(
    () => new Set(integrationsInScope("user").map((integration) => integration.id)),
  );

  // A refetch should discard half-typed input rather than leave it sitting over
  // values that have since changed. Which card is open is the reader's doing, not
  // the data's, so it survives.
  useEffect(() => {
    setEdits({});
    setSavedId(null);
  }, [data]);

  async function save(id: IntegrationId, credentials: Record<string, string | null>) {
    setSavingId(id);
    setErrorId(null);
    setSavedId(null);
    try {
      await api.updateProviderAccess({ credentials });
      setSavedId(id);
      // Everything, not just this query. Which account answers a GitLab or Jira
      // read just changed, so every cached page that came from one was fetched as
      // somebody else — wrongly attributed rather than merely stale, and cheaper
      // to re-earn than to enumerate.
      void queryClient.invalidateQueries();
    } catch (err) {
      setErrorId({ id, message: toMessage(err) });
    } finally {
      setSavingId(null);
    }
  }

  return (
    <>
      {data.enabled ? null : (
        <ErrorBox>
          <strong>Your own credentials are locked.</strong> This install has no encryption key,
          so TALOS will not store a personal token next to the loops that use it. Nothing
          below can be saved until an operator adds{" "}
          <span className="mono">TALOS_SECRET_KEY</span> to{" "}
          <span className="mono">config/.env</span>.
        </ErrorBox>
      )}

      <div className="mt-3 flex flex-col gap-2.5">
        <SlackProviderCard connection={data.slack} />
        {integrationsInScope("user").map((integration) => (
          <ProviderCard
            key={integration.id}
            integration={integration}
            state={state}
            edits={edits}
            enabled={data.enabled}
            disabled={savingId !== null}
            saving={savingId === integration.id}
            saved={savedId === integration.id}
            error={errorId?.id === integration.id ? errorId.message : undefined}
            expanded={expanded.has(integration.id)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(integration.id)) {
                  next.delete(integration.id);
                } else {
                  next.add(integration.id);
                }
                return next;
              })
            }
            onEdit={(name, value, isSecret) =>
              setEdits((prev) => applyEdit(prev, name, value, isSecret))
            }
            onDiscard={(names) =>
              setEdits((prev) => {
                const next = { ...prev };
                for (const name of names) delete next[name];
                return next;
              })
            }
            onSave={(credentials) => save(integration.id, credentials)}
            onClear={(name) => save(integration.id, { [name]: null })}
          />
        ))}
      </div>

      {/* Said once, below the cards, rather than repeated on each: what these
          tokens are *for* is the thing people get wrong about this surface. */}
      <p className="mt-3 block max-w-[62ch] text-[0.7812rem] leading-normal text-[var(--text-faint)]">
        Your work authenticates as what you store here, from your next run onwards. Anything you
        leave blank is simply missing — reading your merge requests, commenting as you, or
        moving one of your tickets needs the token for that provider.
      </p>

      <FormActions>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </FormActions>
    </>
  );
}

function SlackProviderCard({ connection }: { connection?: SlackConnectionView }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const started = await api.startSlackOAuth();
      window.location.assign(started.authorizeUrl);
    } catch (err) {
      setError(toMessage(err));
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await api.disconnectSlack();
      await queryClient.invalidateQueries({ queryKey: ["slack"] });
      await queryClient.invalidateQueries({ queryKey: queries.providerAccess().queryKey });
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const connected = connection?.configured === true;
  return (
    <section className={INTEGRATION_CARD_CLASS}>
      <div className={cn(INTEGRATION_CARD_HEAD_CLASS, "cursor-default hover:bg-transparent")}>
        <span className="flex min-w-0 items-center gap-2">
          <IntegrationIcon id="slack" />
          <h2 className={INTEGRATION_CARD_TITLE_CLASS}>Slack inbox</h2>
        </span>
        <span
          className={cn(
            INTEGRATION_STATUS_CLASS,
            connected ? INTEGRATION_STATUS_TONE.ok : INTEGRATION_STATUS_TONE.partial,
          )}
        >
          {connected ? "Connected" : "Missing"}
        </span>
      </div>
      <p className={cn(INTEGRATION_CARD_DESCRIPTION_CLASS, "whitespace-normal")}>
        Read, send, react, and share images in your direct and group messages plus
        selected channels.
      </p>
      <div className="flex flex-col gap-2 px-3 pb-3">
        {connected ? (
          <>
            <div className="text-sm text-muted-foreground">
              {connection.userName ?? connection.userId} ·{" "}
              {connection.workspaceName ?? connection.workspaceId}
            </div>
            {connection.groupDmsEnabled === false ? (
              <div className="text-xs text-muted-foreground">
                1:1 DMs are connected. Reconnect after adding{" "}
                <span className="mono">mpim:read</span> and{" "}
                <span className="mono">mpim:history</span> to include group DMs.
              </div>
            ) : null}
            {connection.reliableUnreadEnabled === false ? (
              <div className="text-xs text-muted-foreground">
                Add <span className="mono">search:read</span> and reconnect for
                reliable unread detection in inactive DMs.
              </div>
            ) : null}
            {connection.postingEnabled === false ? (
              <div className="text-xs text-muted-foreground">
                Add the <span className="mono">chat:write</span> user scope and
                reconnect to send messages as yourself.
              </div>
            ) : null}
            {connection.reactionsEnabled === false ? (
              <div className="text-xs text-muted-foreground">
                Add <span className="mono">reactions:write</span> and reconnect to
                react to messages as yourself.
              </div>
            ) : null}
            {connection.imageUploadsEnabled === false ? (
              <div className="text-xs text-muted-foreground">
                Add <span className="mono">files:read</span> and{" "}
                <span className="mono">files:write</span>, then reconnect to paste
                or attach images.
              </div>
            ) : null}
            {connection.readSyncAvailable === false ? (
              <div className="text-xs text-muted-foreground">
                Add <span className="mono">channels:write</span>,{" "}
                <span className="mono">groups:write</span>,{" "}
                <span className="mono">im:write</span> and{" "}
                <span className="mono">mpim:write</span>, then reconnect to enable
                optional Slack read-state synchronization.
              </div>
            ) : null}
          </>
        ) : connection?.unreadable ? (
          <ErrorBox>The stored Slack connection cannot be decrypted. Reconnect it.</ErrorBox>
        ) : null}
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <div className="flex justify-end gap-2">
          {connected ? (
            <Button type="button" variant="outline" disabled={busy} onClick={disconnect}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={busy || connection?.storable === false}
            onClick={connect}
          >
            {busy ? "Connecting…" : connected ? "Reconnect" : "Connect Slack"}
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * Whether this provider is usable, from its fields alone.
 *
 * Set or not set — there is no third answer worth a badge. An earlier version
 * distinguished "yours" from the instance's shared account, which read as
 * reassurance ("Shared — fine, something is configured") for the state that
 * actually breaks the work: a shared account is not your identity, and the
 * operations these tokens are for have to act as you.
 *
 * Partial is its own state because a Jira identity is an email *and* a token:
 * one without the other authenticates as nobody and fails like an unset one.
 */
function statusOf(
  integration: Integration,
  state: Map<string, ProviderCredentialState>,
): { label: string; tone: "ok" | "partial" | "unset"; tip: string } {
  const fields = fieldsInScope(integration, "user");
  const set = fields.filter((field) => isSet(state.get(field.name)));

  if (set.length === fields.length) {
    return {
      label: "Connected",
      tone: "ok",
      tip: `TALOS acts as you on ${integration.name}.`,
    };
  }
  if (set.length === 0) {
    return {
      label: "Missing",
      tone: "partial",
      tip: `${integration.name} operations will not run until you store your token.`,
    };
  }
  return {
    label: `${set.length}/${fields.length} set`,
    tone: "partial",
    tip: `Half an identity authenticates as nobody — fill in the rest to use ${integration.name}.`,
  };
}

/**
 * Whether this credential is in effect for you.
 *
 * `"shared"` is not: the instance's own token exists for the loops that run
 * without an actor, and borrowing it would attribute your comments and merge
 * requests to somebody else. So it counts as missing here, exactly as `"unset"`
 * does — and `unreadable` does too, being stored but not decryptable.
 */
export function isSet(state?: ProviderCredentialState): boolean {
  return state?.origin === "user" && !state.unreadable;
}

function ProviderCard({
  integration,
  state,
  edits,
  enabled,
  disabled,
  saving,
  saved,
  error,
  expanded,
  onToggle,
  onEdit,
  onDiscard,
  onSave,
  onClear,
}: {
  integration: Integration;
  state: Map<string, ProviderCredentialState>;
  edits: Record<string, string>;
  enabled: boolean;
  disabled: boolean;
  saving: boolean;
  saved: boolean;
  error?: string;
  expanded: boolean;
  onToggle: () => void;
  onEdit: (name: string, value: string, isSecret: boolean) => void;
  onDiscard: (names: string[]) => void;
  onSave: (credentials: Record<string, string>) => void;
  onClear: (name: string) => void;
}) {
  const fields = fieldsInScope(integration, "user");
  const status = statusOf(integration, state);

  const fieldNames = fields.map((field) => field.name);
  const cardEdits = Object.fromEntries(
    Object.entries(edits).filter(([name]) => fieldNames.includes(name)),
  );
  const dirty = Object.keys(cardEdits).length > 0;

  return (
    <section className={INTEGRATION_CARD_CLASS}>
      <Button
        type="button"
        variant="ghost"
        className={INTEGRATION_CARD_HEAD_CLASS}
        onClick={onToggle}
      >
        <span className="flex min-w-0 items-center gap-2">
          <IntegrationIcon id={integration.id} />
          <h2 className={INTEGRATION_CARD_TITLE_CLASS}>{integration.name}</h2>
        </span>
        <span className="flex items-center gap-2">
          <Tip label={status.tip}>
            <span
              className={cn(INTEGRATION_STATUS_CLASS, INTEGRATION_STATUS_TONE[status.tone])}
            >
              {status.label}
            </span>
          </Tip>
          {/* Always the right-pointing one: `.is-expanded` rotates it a quarter
              turn, which is the animation. Swapping in a down chevron as well
              would rotate that, and point it at the wrong wall. */}
          <ChevronRight
            className={cn(
              "shrink-0 text-[var(--text-faint)] transition-transform",
              expanded && "rotate-90",
            )}
            size={14}
            strokeWidth={2.5}
          />
        </span>
      </Button>
      <p className={cn(INTEGRATION_CARD_DESCRIPTION_CLASS, expanded && "whitespace-normal")}>
        {integration.description}
      </p>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            className="flex flex-col overflow-hidden"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
          >
            {integration.id === "gitlab" ? <GitLabTokenHelp /> : null}
            {integration.id === "jira" ? <JiraTokenHelp /> : null}

            {fields.map((field) => {
              const fieldState = state.get(field.name);
              const origin = fieldState?.origin ?? "unset";
              return (
                <CredentialFieldRow
                  key={field.name}
                  field={field}
                  // Your own non-secret value comes back and is edited in place; a
                  // token never does, so its input is a new value or nothing.
                  value={edits[field.name] ?? (field.secret ? "" : (fieldState?.value ?? ""))}
                  // Only your own counts: the "leave blank to keep" placeholder
                  // would otherwise promise to keep a token that is not yours.
                  configured={isSet(fieldState)}
                  disabled={disabled || !enabled}
                  lockedReason={enabled ? undefined : NO_KEY_REASON}
                  origin={<CredentialOrigin state={fieldState} />}
                  onEdit={(value) => onEdit(field.name, value, field.secret)}
                  // Only what is actually stored for you can be cleared, and
                  // clearing it means this provider stops working for you rather
                  // than quietly reverting to something else.
                  onClear={origin === "user" ? () => onClear(field.name) : undefined}
                />
              );
            })}

            {error ? <ErrorBox>{error}</ErrorBox> : null}

            {/* Per card, so Save commits one identity: storing your Jira email and
                token together is one act, and mixing it with GitLab's would make a
                failure hard to attribute. */}
            <div className={INTEGRATION_CARD_ACTIONS_CLASS}>
              {saved && !error ? (
                <span className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</span>
              ) : null}
              {dirty ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onDiscard(fieldNames)}
                >
                  Discard
                </Button>
              ) : null}
              <Button type="button" disabled={disabled || !dirty} onClick={() => onSave(cardEdits)}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

function GitLabTokenHelp() {
  return (
    <div className="mx-3 mb-3 rounded-md border border-border bg-[var(--bg-deep)] px-3 py-2.5 text-sm text-muted-foreground">
      <h3 className="font-medium text-foreground">How to create a GitLab personal access token</h3>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5">
        <li>
          In GitLab, open your avatar → <strong>Preferences</strong> or{" "}
          <strong>Edit profile</strong> → <strong>Access tokens</strong>.
        </li>
        <li>
          Create a personal access token named <span className="font-mono">TALOS</span> and
          choose an expiration date that follows your organization&apos;s policy.
        </li>
        <li>
          Select the <span className="font-mono">api</span> scope. TALOS needs it for merge
          request reads, comments, branches, and releases.
        </li>
        <li>
          Create the token, copy the <span className="font-mono">glpat-…</span> value while
          GitLab shows it, paste it below, and select <strong>Save</strong>.
        </li>
      </ol>
      <a
        className="mt-2 inline-flex items-center gap-1 text-action hover:underline"
        href="https://gitlab.com/-/user_settings/personal_access_tokens"
        target="_blank"
        rel="noreferrer"
      >
        Create a GitLab personal access token
        <ExternalLink size={12} strokeWidth={2} />
      </a>
    </div>
  );
}

function JiraTokenHelp() {
  return (
    <div className="mx-3 mb-3 rounded-md border border-border bg-[var(--bg-deep)] px-3 py-2.5 text-sm text-muted-foreground">
      <h3 className="font-medium text-foreground">Create a Jira API token</h3>
      <p className="mt-2">
        Open your Atlassian account&apos;s API tokens, create a token for{" "}
        <span className="font-mono">TALOS</span>, then copy it into the API token field below.
      </p>
      <a
        className="mt-2 inline-flex items-center gap-1 text-action hover:underline"
        href="https://id.atlassian.com/manage-profile/security/api-tokens"
        target="_blank"
        rel="noreferrer"
      >
        Create an Atlassian API token
        <ExternalLink size={12} strokeWidth={2} />
      </a>
    </div>
  );
}

/**
 * Whether this one credential is in effect, and since when.
 *
 * Worth the pixels for the same reason the settings page's origin badge is: "I
 * stored a token and it still 401s" is otherwise unanswerable from the screen.
 * And an unreadable credential — stored, but not in effect because the encryption
 * key changed — looks exactly like a working one unless it says so.
 */
function CredentialOrigin({ state }: { state?: ProviderCredentialState }) {
  const fmt = useFormat();

  if (state?.unreadable) {
    return (
      <span className="text-xs text-destructive whitespace-nowrap">
        unreadable — key changed
      </span>
    );
  }
  if (isSet(state)) {
    return (
      <span
        className="text-xs text-muted-foreground whitespace-nowrap"
        // Relative inline, absolute on hover — and through `stamp`, so it lands in
        // the instance's configured zone like every other date on the page.
        title={state?.updatedAt ? fmt.stamp(state.updatedAt) : undefined}
      >
        set{state?.updatedAt ? ` · ${ago(state.updatedAt)}` : ""}
      </span>
    );
  }
  return <span className="text-xs text-destructive whitespace-nowrap">not set</span>;
}
