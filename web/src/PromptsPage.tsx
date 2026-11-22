import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { api, type PromptsView, type PromptTemplateView } from "./api.ts";
import { queries } from "./queries.ts";
import { TitleInfo } from "./TitleInfo.tsx";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { SETTINGS_FORM_CLASS } from "./settings-layout.ts";
import { PAGE_TITLE_CLASS } from "./typography-styles.ts";

/**
 * The LLM prompt templates the agent tasks (`gitlab-code-review`,
 * `gitlab-mr-follow-up`, `jira-ticket-to-mr`) send to Claude. Backed by
 * `prompt_templates` — see `src/persistence/prompt-template-store.ts` — which
 * layers over the hardcoded default in each task's own file rather than
 * replacing it, so "Revert to default" is always available and never loses
 * the original wording.
 */
export function PromptsPage() {
  const queryClient = useQueryClient();
  const prompts = useApi(queries.prompts());

  if (prompts.error) {
    return <ErrorBox>{prompts.error}</ErrorBox>;
  }

  if (prompts.loading && !prompts.data) {
    return <Loading>Loading prompts…</Loading>;
  }

  if (!prompts.data) return null;

  return (
    <div className={SETTINGS_FORM_CLASS}>
      <header>
        <h1 className={PAGE_TITLE_CLASS}>
          Prompts
          <TitleInfo>
            The exact prompt each loop sends to Claude. Edit one to change how that loop's agent
            behaves — variables in <code>{"{{double braces}}"}</code> are filled in per run.
          </TitleInfo>
        </h1>
      </header>

      <div className="flex flex-col gap-4">
        {prompts.data.prompts.map((prompt) => (
          <PromptCard
            key={prompt.id}
            prompt={prompt}
            // `PUT /api/prompts` returns every template, not just the edited
            // one, so one card's save refreshes the whole page from the
            // response — and `TaskDetail`, which reads the same entry.
            onSaved={(saved) => queryClient.setQueryData(keys.prompts(), saved)}
          />
        ))}
      </div>
    </div>
  );
}

function PromptCard({
  prompt,
  onSaved,
}: {
  prompt: PromptTemplateView;
  onSaved: (saved: PromptsView) => void;
}) {
  const [template, setTemplate] = useState(prompt.template);
  // Shared by Save and "Revert to default": both write this one template.
  const save = useAction();

  // A save from elsewhere (or a page revisit) should show the current value,
  // not whatever was left half-edited in a previous mount.
  useEffect(() => {
    setTemplate(prompt.template);
  }, [prompt.template]);

  const dirty = template !== prompt.template;

  const handleSave = () =>
    save.run(async () => {
      onSaved(await api.updatePrompts({ [prompt.id]: template }));
    });

  const handleReset = () =>
    save.run(async () => {
      onSaved(await api.updatePrompts({ [prompt.id]: null }));
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{prompt.label}</CardTitle>
        <CardDescription>{prompt.description}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          Variables: {prompt.variables.map((v) => `{{${v}}}`).join(", ")}
        </div>

        <Textarea
          className="min-h-64 font-mono text-sm"
          rows={12}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          spellCheck={false}
        />

        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          {prompt.origin === "default" ? "Currently the built-in default." : "Customized."}
        </div>

        {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
        {save.done ? <div className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</div> : null}
      </CardContent>

      <CardFooter className="gap-2">
        <Button type="button" disabled={save.busy || !dirty} onClick={handleSave}>
          {save.busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={save.busy || prompt.origin === "default"}
          onClick={handleReset}
        >
          Revert to default
        </Button>
      </CardFooter>
    </Card>
  );
}
