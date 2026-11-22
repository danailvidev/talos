import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { api, type IntegrationsView, type IntegrationFieldState } from "./api.ts";
import {
  fieldsInScope,
  integrationsInScope,
  type Integration,
  type IntegrationField,
  type IntegrationId,
} from "../../shared/integrations.ts";
import { Button } from "./components/ui/button.tsx";
import { IntegrationIcon } from "./IntegrationIcon.tsx";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { useFormat } from "./FormatContext.tsx";
import { ago } from "./format.ts";
import { ErrorBox, QueryState } from "./components/ui/query-state.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { applyEdit, CredentialFieldRow } from "./CredentialField.tsx";
import { toMessage } from "./errors.ts";
import { PAGE_TITLE_CLASS } from "./typography-styles.ts";
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
 * Settings → Integrations: the instance-wide integration settings, editable
 * without a shell on the host.
 *
 * Instance-wide, and layered *over* `config/.env` — what is saved here is what
 * every loop authenticates with. The catalog of fields comes from
 * `shared/integrations.ts`, so this file renders whatever is in it and adding an
 * integration means touching neither.
 *
 * Only the `"instance"` scope of that catalog. The personal identities —
 * GitLab's token, Jira's email and token — are each developer's own and live in
 * My provider access; one person editing the whole team's GitLab identity from a
 * settings page was the thing to stop. Both cards stay here for what genuinely
 * is instance-wide, which for GitLab and Jira is the endpoint: the API URL and
 * the site everybody's tokens authenticate against.
 *
 * One card per integration rather than a single stacked form: the list is only
 * going to grow, and eight sections down one column is a scroll with no shape to
 * it. A card carries its own "configured / partly / not set" verdict, so finding
 * the one that needs attention is a glance rather than a read.
 *
 * Secret fields are write-only: the server never sends a token back, so the
 * input starts empty and shows what is configured beside it instead. Leaving one
 * blank therefore means "leave it alone", which is why clearing needs its own
 * button — an empty input cannot mean both.
 */
export function IntegrationsSettings() {
  const queryClient = useQueryClient();
  const integrations = useApi(queries.integrations());

  return (
    <QueryState query={integrations} loading="Loading integrations…">
      {(data) => (
        <IntegrationsForm
          initial={data}
          onSaved={() => {
            // The one place a blanket invalidation is right, and the one place the
            // response body is *not* worth writing straight into the cache. The
            // tokens just changed, so every cached answer that came from GitLab,
            // Jira, LogRocket or Datadog was fetched with credentials no longer in
            // force — wrongly attributed rather than merely stale. Cheaper to
            // re-earn all of it than to enumerate which entries were forge-derived.
            void queryClient.invalidateQueries();
          }}
        />
      )}
    </QueryState>
  );
}

/** Why a secret field cannot be typed into. Null when it can. */
const NO_KEY_REASON = "Needs TALOS_SECRET_KEY";

function IntegrationsForm({
  initial,
  onSaved,
}: {
  initial: IntegrationsView;
  onSaved: () => void;
}) {
  const state = new Map(initial.fields.map((field) => [field.name, field]));
  // Only what has been typed. A field absent from this map is not sent, which is
  // what makes "save" leave every token the operator did not touch in place.
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Save/discard live on each card rather than the page, so at most one
  // integration is ever mid-save — tracking it by id (instead of a plain
  // boolean) is what lets "Saving…" and "Saved." land on the card that
  // triggered them instead of every card at once.
  const [savingId, setSavingId] = useState<IntegrationId | null>(null);
  const [errorId, setErrorId] = useState<{ id: IntegrationId; message: string } | null>(null);
  const [savedId, setSavedId] = useState<IntegrationId | null>(null);
  // Expanded by default: the fields are the reason this page exists, and the
  // status badge alone doesn't say *which* field is missing. The chevron is
  // still there for anyone who wants to fold a card away.
  const [expanded, setExpanded] = useState<Set<IntegrationId>>(
    () => new Set(integrationsInScope("instance").map((integration) => integration.id)),
  );

  // A reload (or another tab's save) should discard half-typed input rather than
  // leave it sitting over values that have since changed.
  useEffect(() => {
    setEdits({});
    setSavedId(null);
  }, [initial]);

  async function save(id: IntegrationId, overrides: Record<string, string | null>) {
    setSavingId(id);
    setErrorId(null);
    setSavedId(null);
    try {
      await api.updateIntegrations({ overrides });
      setSavedId(id);
      onSaved();
    } catch (err) {
      setErrorId({ id, message: toMessage(err) });
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="flex min-h-0 w-full flex-col gap-5 overflow-y-auto px-8 pt-7 pb-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className={PAGE_TITLE_CLASS}>
            Integrations
            <TitleInfo>
              Instance-wide settings. What you save here overrides{" "}
              <span className="mono">config/.env</span> for everyone and takes effect on the
              next request — no restart. Your own GitLab and Jira identity is not here: those
              belong to you rather than to the install, and live under{" "}
              <strong>My provider access</strong> in the user menu.
            </TitleInfo>
          </h1>
        </div>
      </header>

      {initial.secretsEnabled ? null : (
        <ErrorBox>
          <strong>Tokens are locked.</strong> Every secret field below is read-only until
          this install has an encryption key — TALOS will not store a credential in
          plaintext next to the loops that use it. Add one to{" "}
          <span className="mono">config/.env</span> and restart:
          <pre className="mono my-2 rounded-[var(--radius)] bg-[var(--bg-deep)] px-2.5 py-2 text-[0.8125rem] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
            {'echo "TALOS_SECRET_KEY=$(openssl rand -hex 32)" >> config/.env'}
          </pre>
          Back it up with the database and do not rotate it casually. The non-secret
          fields (site URLs, project keys) save without it.
        </ErrorBox>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,300px))] items-start gap-3.5">
        {integrationsInScope("instance").map((integration) => (
          <IntegrationCard
            key={integration.id}
            integration={integration}
            state={state}
            edits={edits}
            disabled={savingId !== null}
            saving={savingId === integration.id}
            error={errorId?.id === integration.id ? errorId.message : undefined}
            saved={savedId === integration.id}
            secretsEnabled={initial.secretsEnabled}
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
            onSave={(overrides) => save(integration.id, overrides)}
            onClear={(name) => save(integration.id, { [name]: null })}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * How configured an integration is, from its required fields alone.
 *
 * Optional fields are excluded on purpose — see `IntegrationField.optional`. The
 * verdict is about the effective value, not about where it came from: a token in
 * `config/.env` is configured, and an override that cannot be decrypted is not.
 *
 * Null when the card has nothing required left to judge — GitLab's instance scope
 * is one optional self-hosted URL, and a green "Configured" badge for having
 * filled in nothing would be a verdict on the identity that is no longer here.
 */
function statusOf(
  fields: readonly IntegrationField[],
  state: Map<string, IntegrationFieldState>,
): { label: string; tone: "ok" | "partial" | "unset" } | null {
  const required = fields.filter((field) => !field.optional);
  if (required.length === 0) return null;
  const set = required.filter((field) => state.get(field.name)?.origin !== "unset");

  if (set.length === required.length) return { label: "Configured", tone: "ok" };
  if (set.length === 0) return { label: "Not set", tone: "unset" };
  return { label: `${set.length}/${required.length} set`, tone: "partial" };
}

function IntegrationCard({
  integration,
  state,
  edits,
  disabled,
  saving,
  error,
  saved,
  secretsEnabled,
  expanded,
  onToggle,
  onEdit,
  onDiscard,
  onSave,
  onClear,
}: {
  integration: Integration;
  state: Map<string, IntegrationFieldState>;
  edits: Record<string, string>;
  disabled: boolean;
  saving: boolean;
  error?: string;
  saved: boolean;
  secretsEnabled: boolean;
  expanded: boolean;
  onToggle: () => void;
  onEdit: (name: string, value: string, isSecret: boolean) => void;
  onDiscard: (names: string[]) => void;
  onSave: (overrides: Record<string, string>) => void;
  onClear: (name: string) => void;
}) {
  // Only what this page owns. A user-scoped field is still in the catalog — the
  // stored value behind it is the shared fallback — but it is not this surface's
  // to show, so it is filtered here rather than removed there.
  const fields = fieldsInScope(integration, "instance");
  const status = statusOf(fields, state);

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
          {status ? (
            <span
              className={cn(INTEGRATION_STATUS_CLASS, INTEGRATION_STATUS_TONE[status.tone])}
            >
              {status.label}
            </span>
          ) : null}
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
            {fields.map((field) => {
              const fieldState = state.get(field.name);
              return (
                <CredentialFieldRow
                  key={field.name}
                  field={field}
                  // A non-secret value comes back from the server and is edited in
                  // place; a secret one never does, so its input is a new value or
                  // nothing.
                  value={
                    edits[field.name] ?? (field.secret ? "" : (fieldState?.value ?? ""))
                  }
                  configured={(fieldState?.origin ?? "unset") !== "unset"}
                  disabled={disabled || (field.secret && !secretsEnabled)}
                  // Why it is disabled, when the reason is the missing key rather
                  // than a save in flight. Shown on the field itself: a banner at
                  // the top of the page is not an answer to "why can I not type
                  // in this box".
                  lockedReason={field.secret && !secretsEnabled ? NO_KEY_REASON : undefined}
                  origin={<FieldOrigin state={fieldState} />}
                  onEdit={(value) => onEdit(field.name, value, field.secret)}
                  // Only an override is this page's to clear. A value from
                  // `config/.env` is not stored here and there is nothing to
                  // delete.
                  onClear={
                    fieldState?.origin === "override" ? () => onClear(field.name) : undefined
                  }
                />
              );
            })}
            {error ? <ErrorBox>{error}</ErrorBox> : null}
            {/* Its own footer rather than one action row for the page: with a
                card per integration, "Save" should commit only what changed on
                that card, and stay right under the fields it acted on. */}
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

/**
 * Which layer the effective value comes from.
 *
 * Worth the pixels: "I saved a token and it still 401s" is otherwise
 * unanswerable from the page, and an unreadable override — stored, but not in
 * effect because the encryption key changed — looks exactly like a working one.
 */
function FieldOrigin({ state }: { state?: IntegrationFieldState }) {
  const fmt = useFormat();

  if (state?.unreadable) {
    return (
      <span className="text-xs text-destructive whitespace-nowrap">
        unreadable — key changed
      </span>
    );
  }
  if (state?.origin === "override") {
    return (
      <span
        className="text-xs text-muted-foreground whitespace-nowrap"
        // Relative inline, absolute on hover — and through `stamp`, so the
        // timestamp lands in the instance's configured zone like every other
        // date on the page rather than the browser's.
        title={state.updatedAt ? fmt.stamp(state.updatedAt) : undefined}
      >
        set here{state.updatedAt ? ` · ${ago(state.updatedAt)}` : ""}
      </span>
    );
  }
  if (state?.origin === "environment") {
    return (
      <span className="text-xs text-muted-foreground whitespace-nowrap">from config/.env</span>
    );
  }
  return <span className="text-xs text-muted-foreground whitespace-nowrap">not set</span>;
}
