import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { ShieldAlert } from "lucide-react";

import { api, type ProfileView } from "./api.ts";
import {
  DATE_FORMAT_OPTIONS,
  DATE_FORMAT_PREFERENCE,
  FORMAT_SAMPLE_DATE,
  FORMAT_SAMPLE_NUMBER,
  NUMBER_FORMAT_OPTIONS,
  NUMBER_FORMAT_PREFERENCE,
  formatDateTime,
  formatNumber,
  parseDateFormat,
  parseNumberFormat,
  type DateFormat,
  type NumberFormat,
} from "./formats.ts";
import { usePreference } from "./PreferencesContext.tsx";
import { Button } from "./components/ui/button.tsx";
import { Field, FormActions } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Modal } from "./components/ui/modal.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";

import { queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { useAction } from "./useAction.ts";
import { useFormat } from "./FormatContext.tsx";
import { SETTINGS_SECTION_CLASS } from "./settings-layout.ts";
import { DIALOG_BODY_CLASS, SECTION_TITLE_CLASS } from "./typography-styles.ts";
import { cn } from "./lib/utils.ts";

/**
 * My profile: the signed-in developer's own account — who they are here, when
 * the account was made, and the way out.
 *
 * In the user menu rather than Settings, alongside Agent connections and My
 * provider access, for the reason those two are: Settings is the instance, one row
 * in the database and the same for everybody, and putting a personal account
 * screen among its tabs invited the reading that renaming yourself renames
 * something shared. Everything behind the user icon is yours alone.
 *
 * The email address is shown but not editable because it is the login.
 */
export function ProfileDialog({
  onClose,
  onRenamed,
}: {
  onClose: () => void;
  /** So the menu header and the top bar stop showing the old name. */
  onRenamed: (name: string) => void;
}) {
  const profile = useApi(queries.profile());

  return (
    <Modal
      onClose={onClose}
      className="sm:max-w-180"
      title="My profile"
    >
      {profile.error ? (
        <ErrorBox>{profile.error}</ErrorBox>
      ) : profile.loading && !profile.data ? (
        <Loading>Loading your profile…</Loading>
      ) : profile.data ? (
        <ProfileForm profile={profile.data} onClose={onClose} onRenamed={onRenamed} />
      ) : null}
    </Modal>
  );
}

function ProfileForm({
  profile,
  onClose,
  onRenamed,
}: {
  profile: ProfileView;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const fmt = useFormat();
  const [name, setName] = useState(profile.name);
  const [confirming, setConfirming] = useState(false);
  const save = useAction();

  // A refetch landing, or another tab's rename, should win over a half-typed
  // field left behind by a previous mount — same rule as the general settings form.
  useEffect(() => setName(profile.name), [profile]);

  const handleSave = () =>
    save.run(async () => {
      const trimmed = name.trim();
      if (trimmed.length < 2) throw new Error("Name must be at least 2 characters.");
      const saved = await api.updateProfile({ name: trimmed });
      queryClient.setQueryData(keys.me.profile(), saved);
      // The session is React state in `App`, not a query, so it does not learn
      // about the rename on its own — and the menu this dialog was opened from is
      // showing the old name two inches away.
      onRenamed(saved.name);
    });

  return (
    <>
      <div className="mt-1 flex flex-col gap-5">
        <section className={SETTINGS_SECTION_CLASS}>
          <h3 className={SECTION_TITLE_CLASS}>Display name</h3>
          <Field
            label="Name"
            hint={
              profile.builtIn
                ? "Built-in accounts are defined in the source and cannot be renamed."
                : undefined
            }
          >
            <Input
              className="w-72"
              value={name}
              disabled={profile.builtIn}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
          {save.done ? <div className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</div> : null}
          {profile.builtIn ? null : (
            <FormActions>
              <Button
                type="button"
                disabled={save.busy || name.trim() === profile.name}
                onClick={handleSave}
              >
                {save.busy ? "Saving…" : "Save name"}
              </Button>
            </FormActions>
          )}
        </section>

        <section className={SETTINGS_SECTION_CLASS}>
          <h3 className={SECTION_TITLE_CLASS}>Email</h3>
          <div className="grid grid-cols-[120px_1fr] items-baseline gap-x-4 gap-y-2">
            <ProfileFact label="Address" value={profile.email} />
            <ProfileFact
              label="Member since"
              value={profile.createdAt ? fmt.stamp(profile.createdAt) : "—"}
            />
          </div>
        </section>

        <FormatSection />

        <section className={SETTINGS_SECTION_CLASS}>
          <h3 className={SECTION_TITLE_CLASS}>Delete account</h3>
          {profile.builtIn ? null : (
            <FormActions>
              <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>
                <ShieldAlert size={15} />
                Delete my account
              </Button>
            </FormActions>
          )}
        </section>
      </div>

      <FormActions>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </FormActions>

      {/* A sibling of this dialog's body but rendered from inside it, so the
          confirmation sits on top of the profile it is about. */}
      <AnimatePresence>
        {confirming ? <DeleteAccountDialog onClose={() => setConfirming(false)} /> : null}
      </AnimatePresence>
    </>
  );
}

/**
 * How this developer wants dates and numbers written.
 *
 * A draft held locally until Save, like the two sections above it and like My
 * notifications — not click-to-apply, even though the underlying `usePreference`
 * write is instant and every other preference in the console does apply on click.
 * Consistency is per screen before it is per mechanism: a titled section sitting
 * between "Save name" and "Delete my account" cannot have a different idea of when
 * a change takes effect than its neighbours, and Save is the one that lets a reader
 * back out. The exception left standing is Theme, whose preview is the app behind
 * the dialog, so a pending change there means choosing a theme you cannot see.
 *
 * Which is affordable here precisely because the samples make the choice legible
 * before it is applied: every option is previewed against the same fixed instant and
 * the same number, so the captions differ only in the thing being chosen — and the
 * 8th of September is picked because `08/09` and `09/08` are different days.
 *
 * The timezone is not offered here. It is instance-wide, on the Settings page: the
 * whole team should read one run's start time as the same moment, and only the
 * notation is a matter of where you learned to read.
 */
function FormatSection() {
  const { timeZone } = useFormat();
  const [dateFormat, setDateFormat] = usePreference(DATE_FORMAT_PREFERENCE, parseDateFormat);
  const [numberFormat, setNumberFormat] = usePreference(
    NUMBER_FORMAT_PREFERENCE,
    parseNumberFormat,
  );
  const [draft, setDraft] = useState({ date: dateFormat, number: numberFormat });
  const [saved, setSaved] = useState(false);

  // The stored values landing — the first fetch, or another tab — should win over an
  // untouched draft, same rule as the forms above.
  useEffect(
    () => setDraft({ date: dateFormat, number: numberFormat }),
    [dateFormat, numberFormat],
  );

  const dirty = draft.date !== dateFormat || draft.number !== numberFormat;

  /**
   * No busy or error state, unlike the sections above: `PreferencesContext.set` is a
   * local write with a fire-and-forget PUT behind it, so there is nothing to await
   * and nothing that can come back a failure. "Saving…" would be a lie for one frame.
   */
  function handleSave() {
    if (draft.date !== dateFormat) setDateFormat(draft.date);
    if (draft.number !== numberFormat) setNumberFormat(draft.number);
    setSaved(true);
  }

  function choose(next: Partial<{ date: DateFormat; number: NumberFormat }>) {
    setDraft((prev) => ({ ...prev, ...next }));
    setSaved(false);
  }

  return (
    <section className={SETTINGS_SECTION_CLASS}>
      <h3 className={SECTION_TITLE_CLASS}>Dates &amp; numbers</h3>

      <Field label="Date and time">
        <div className="mt-1 grid grid-cols-2 gap-2">
          {DATE_FORMAT_OPTIONS.map((option) => (
            <Button
              key={option.id}
              type="button"
              variant="outline"
              className={cn(
                "h-auto flex-col items-start gap-0.5 rounded-[var(--radius)] bg-[var(--bg-raised)] px-3 py-2.5 text-left transition-[border-color,background] hover:bg-[var(--bg-hover)] [&_strong]:text-sm [&_strong]:font-medium [&_strong]:text-muted-foreground",
                draft.date === option.id &&
                  "border-action [&_strong]:text-foreground",
              )}
              aria-pressed={draft.date === option.id}
              onClick={() => choose({ date: option.id })}
            >
              <span className="font-mono text-[0.9062rem] text-foreground tabular-nums">
                {formatDateTime(FORMAT_SAMPLE_DATE, { timeZone, format: option.id })}
              </span>
              <strong>{option.label}</strong>
            </Button>
          ))}
        </div>
      </Field>

      <Field label="Numbers">
        <div className="mt-1 grid grid-cols-2 gap-2">
          {NUMBER_FORMAT_OPTIONS.map((option) => (
            <Button
              key={option.id}
              type="button"
              variant="outline"
              className={cn(
                "h-auto flex-col items-start gap-0.5 rounded-[var(--radius)] bg-[var(--bg-raised)] px-3 py-2.5 text-left transition-[border-color,background] hover:bg-[var(--bg-hover)] [&_strong]:text-sm [&_strong]:font-medium [&_strong]:text-muted-foreground",
                draft.number === option.id &&
                  "border-action [&_strong]:text-foreground",
              )}
              aria-pressed={draft.number === option.id}
              onClick={() => choose({ number: option.id })}
            >
              <span className="font-mono text-[0.9062rem] text-foreground tabular-nums">
                {formatNumber(FORMAT_SAMPLE_NUMBER, option.id)}
              </span>
              <strong>{option.label}</strong>
            </Button>
          ))}
        </div>
      </Field>

      {saved && !dirty ? (
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</div>
      ) : null}
      <FormActions>
        <Button type="button" disabled={!dirty} onClick={handleSave}>
          Save formats
        </Button>
        {dirty ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setDraft({ date: dateFormat, number: numberFormat })}
          >
            Discard
          </Button>
        ) : null}
      </FormActions>
    </section>
  );
}

function ProfileFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="col-span-full grid grid-cols-subgrid">
      <span className="text-sm text-[var(--text-faint)]">{label}</span>
      <span className="text-[0.9375rem] text-foreground [overflow-wrap:anywhere]">{value}</span>
    </div>
  );
}

/**
 * The confirmation, with the password re-entry the endpoint requires.
 *
 * Not `ConfirmDialog`: that one is a body and a button, and this needs a field —
 * a session cookie alone should not be enough to end an account from an unattended
 * laptop.
 *
 * On success it reloads rather than calling back into the app. The session cookie
 * is already cleared server-side and every cached query describes an account that
 * no longer exists, so the honest next screen is a cold boot, which lands on the
 * login page.
 */
function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const action = useAction();

  const confirm = () =>
    action.run(async () => {
      await api.deleteAccount(password);
      window.location.href = "/login";
    });

  return (
    <Modal onClose={action.busy ? () => {} : onClose} title="Delete your account">
      <p className={DIALOG_BODY_CLASS}>
        This removes your account and everything that is only yours — tokens, agent
        accounts, preferences and your private loops. It cannot be undone. Enter your
        password to confirm.
      </p>
      <Field label="Password">
        <Input
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      {action.error ? <ErrorBox>{action.error}</ErrorBox> : null}
      <FormActions>
        <Button
          type="button"
          variant="destructive"
          disabled={action.busy || password.length === 0}
          onClick={confirm}
        >
          {action.busy ? "Deleting…" : "Delete account"}
        </Button>
        <Button type="button" variant="outline" disabled={action.busy} onClick={onClose}>
          Cancel
        </Button>
      </FormActions>
    </Modal>
  );
}
