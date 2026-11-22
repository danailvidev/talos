import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, type FixIssueDefaultsView } from "./api.ts";
import { Field } from "./components/ui/field.tsx";
import { Button } from "./components/ui/button.tsx";
import { queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { useAction } from "./useAction.ts";
import { ErrorBox, QueryState } from "./components/ui/query-state.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { Input } from "./components/ui/input.tsx";
import { SETTINGS_FORM_CLASS, SETTINGS_SECTION_CLASS } from "./settings-layout.ts";
import { PAGE_TITLE_CLASS, SECTION_TITLE_CLASS } from "./typography-styles.ts";

/**
 * Where this developer's "Fix this issue" clicks land.
 *
 * A Jira ticket names no repository, so the ticket graph's button has nothing to
 * infer a project from — and inventing one would mean an agent pushing a branch
 * somewhere nobody chose. Per-developer rather than instance-wide for the same
 * reason the Team MRs filter is: which repo your tickets belong in is a fact about
 * your work, not the team's.
 */
export function FixIssueDefaultsSettings() {
  const queryClient = useQueryClient();
  const defaults = useApi(queries.fixIssueDefaults());

  return (
    <QueryState query={defaults} loading="Loading…">
      {(data) => (
        <FixIssueDefaultsForm
          initial={data}
          onSaved={(saved) => {
            queryClient.setQueryData(keys.me.fixIssueDefaults(), saved);
            // The graph too, not just this form: it derives each ticket's
            // "why is Fix this issue disabled?" explanation from these defaults
            // (`src/api/graph-view.ts`), so without this the button stays greyed
            // out with a stale reason until something else refetches it.
            void queryClient.invalidateQueries({ queryKey: keys.allGraph() });
          }}
        />
      )}
    </QueryState>
  );
}

const EMPTY: FixIssueDefaultsView = { projectId: "", targetBranch: "develop" };

const INPUT_CLASS =
  "w-96";

function FixIssueDefaultsForm({
  initial,
  onSaved,
}: {
  initial: FixIssueDefaultsView | null;
  onSaved: (saved: FixIssueDefaultsView) => void;
}) {
  const [form, setForm] = useState<FixIssueDefaultsView>(initial ?? EMPTY);
  const save = useAction();

  // A save elsewhere (or opening this tab again) should show what is actually
  // stored, not whatever was left half-typed on a previous visit.
  useEffect(() => {
    setForm(initial ?? EMPTY);
  }, [initial]);

  const handleSave = () =>
    save.run(async () => {
      const result = await api.setFixIssueDefaults({
        projectId: form.projectId.trim(),
        targetBranch: form.targetBranch.trim(),
      });
      setForm(result);
      onSaved(result);
    });

  const complete = form.projectId.trim() !== "" && form.targetBranch.trim() !== "";
  const dirty =
    form.projectId !== (initial?.projectId ?? "") ||
    form.targetBranch !== (initial?.targetBranch ?? EMPTY.targetBranch);

  return (
    <div className={SETTINGS_FORM_CLASS}>
      <h1 className={PAGE_TITLE_CLASS}>
        Fixing tickets
        <TitleInfo>
          Yours alone — where the ticket graph's <span className="mono">Fix this issue</span>{" "}
          button opens its merge request.
        </TitleInfo>
      </h1>

      <section className={SETTINGS_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>Default project</h2>
        <Field label="Project">
          <Input
            className={`${INPUT_CLASS} mono`}
            value={form.projectId}
            placeholder="group/project"
            onChange={(event) => setForm({ ...form, projectId: event.target.value })}
          />
        </Field>
        <Field className="mt-3" label="Target branch">
          <Input
            className={`${INPUT_CLASS} mono`}
            value={form.targetBranch}
            placeholder="develop"
            onChange={(event) => setForm({ ...form, targetBranch: event.target.value })}
          />
        </Field>

        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          The branch the fix is cut from and the draft merge request targets. Until both are
          set, the button on a ticket stays disabled rather than guessing — an agent pushes a
          real branch to a real repository.
        </div>
      </section>

      {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
      {save.done ? <div className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</div> : null}

      <div className="flex gap-2">
        <Button type="button" disabled={save.busy || !dirty || !complete} onClick={handleSave}>
          {save.busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
