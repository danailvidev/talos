import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, type NotificationSubscriptionsView } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { FormActions } from "./components/ui/field.tsx";
import { Modal } from "./components/ui/modal.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { TitleInfo } from "./TitleInfo.tsx";
import { useApi } from "./useApi.ts";
import { useAction } from "./useAction.ts";
import { SETTINGS_SECTION_CLASS } from "./settings-layout.ts";
import { SECTION_TITLE_CLASS } from "./typography-styles.ts";

/**
 * Which notifications reach the bell in the top bar.
 *
 * Per-developer, which is why it lives behind the user icon next to Agent
 * connections rather than among the Settings tabs: nothing here changes what
 * anybody else's bell shows, and a subscription list on an instance-wide page
 * reads like one that does.
 *
 * Subtractive: everything is on until you turn it off, so a notification kind
 * added in a later release arrives without anybody having to come here and opt in.
 * Unsubscribing hides that kind from your bell entirely — the list and the unread
 * badge are filtered by the same rule server-side (see `visibleNotifications`), so
 * an unsubscribed kind cannot leave a count you have no way to clear.
 *
 * It does not stop the notification being *raised*: the table is install-wide, and
 * somebody else may well want the one you muted. This is a view over it.
 */
export function NotificationsDialog({ onClose }: { onClose: () => void }) {
  const subscriptions = useApi(queries.notificationSubscriptions());

  return (
    <Modal
      onClose={onClose}
      className="sm:max-w-180"
      title={
        <>
          My notifications
          <TitleInfo>
            What the bell in the top bar shows you. Yours alone — other people's bells are
            unaffected.
          </TitleInfo>
        </>
      }
    >
      {subscriptions.error ? (
        <ErrorBox>{subscriptions.error}</ErrorBox>
      ) : subscriptions.loading && !subscriptions.data ? (
        <Loading>Loading notification settings…</Loading>
      ) : subscriptions.data ? (
        <SubscriptionForm saved={subscriptions.data} onClose={onClose} />
      ) : null}
    </Modal>
  );
}

/**
 * The toggles, held locally until Save.
 *
 * A form rather than a row of controls that each write on click: eight switches is
 * a set of decisions taken together, and eight requests to record them is eight
 * chances to half-apply the change. The dirty state also gives the reader a way
 * back — Discard — which a control that saves itself cannot offer.
 */
function SubscriptionForm({
  saved,
  onClose,
}: {
  saved: NotificationSubscriptionsView;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => toMap(saved));
  const save = useAction();

  // A refetch landing behind an open dialog should win over an untouched draft —
  // but not over one being edited, so this only resets when the saved data itself
  // changes identity, exactly as the settings forms do.
  useEffect(() => setDraft(toMap(saved)), [saved]);

  const dirty = saved.subscriptions.filter((row) => draft[row.kind] !== row.subscribed);
  const mutedCount = saved.subscriptions.filter((row) => draft[row.kind] === false).length;

  const handleSave = () =>
    save.run(async () => {
      const result = await api.setNotificationSubscriptions({
        // Only what changed. The endpoint leaves omitted kinds alone, so a kind this
        // build has never heard of survives a save from it.
        subscriptions: dirty.map((row) => ({ kind: row.kind, subscribed: draft[row.kind]! })),
      });
      queryClient.setQueryData(keys.me.notificationSubscriptions(), result);
      // The bell is now showing a list filtered by a rule that just changed.
      void queryClient.invalidateQueries({ queryKey: keys.notifications() });
    });

  return (
    <>
      <div className="mt-1 flex flex-col gap-5">
        <section className={SETTINGS_SECTION_CLASS}>
          <h3 className={SECTION_TITLE_CLASS}>What reaches your bell</h3>
          <div className="mt-1.5 text-sm text-[var(--text-faint)]">
            Everything is on by default, including kinds added by a future release.
            {mutedCount > 0
              ? ` ${mutedCount} turned off — those are hidden from your bell and left out of its unread count.`
              : ""}
          </div>
          <ul className="mt-2 flex list-none flex-col gap-0.5 p-0">
            {saved.subscriptions.map((row) => (
              <li
                key={row.kind}
                className="flex items-start justify-between gap-4 rounded-[var(--radius)] p-2.5 hover:bg-[var(--bg-hover)] [&_[data-slot=switch]]:mt-px [&_[data-slot=switch]]:shrink-0"
              >
                <label
                  className="flex cursor-pointer flex-col gap-0.5"
                  htmlFor={`notif-${row.kind}`}
                >
                  <strong className="text-[0.9375rem] font-medium text-foreground">
                    {row.label}
                  </strong>
                  <small className="text-sm text-[var(--text-faint)]">
                    {row.description}
                  </small>
                </label>
                <Switch
                  id={`notif-${row.kind}`}
                  checked={draft[row.kind] ?? true}
                  disabled={save.busy}
                  onCheckedChange={(checked) =>
                    setDraft((prev) => ({ ...prev, [row.kind]: checked }))
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      </div>

      {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
      {save.done && dirty.length === 0 ? (
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</div>
      ) : null}

      <FormActions>
        <Button type="button" disabled={save.busy || dirty.length === 0} onClick={handleSave}>
          {save.busy ? "Saving…" : "Save"}
        </Button>
        {dirty.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            disabled={save.busy}
            onClick={() => setDraft(toMap(saved))}
          >
            Discard
          </Button>
        ) : null}
        <Button type="button" variant="outline" disabled={save.busy} onClick={onClose}>
          Close
        </Button>
      </FormActions>
    </>
  );
}

function toMap(view: NotificationSubscriptionsView): Record<string, boolean> {
  return Object.fromEntries(view.subscriptions.map((row) => [row.kind, row.subscribed]));
}
