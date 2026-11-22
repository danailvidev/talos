import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, type PromptTemplateView, type TaskDetail } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { keys } from "./query-keys.ts";
import { queries } from "./queries.ts";
import { SECTION_TITLE_CLASS } from "./typography-styles.ts";
import { useAction } from "./useAction.ts";
import { useApi } from "./useApi.ts";

/** The configurable prompt used by each agent-backed loop definition. */
const LOOP_PROMPT_IDS: Record<string, string> = {
  "gitlab-code-review": "code-review",
  "gitlab-mr-follow-up": "mr-follow-up",
  "jira-ticket-to-mr": "jira-ticket-to-mr",
};

export function loopHasPrompt(definitionId: string): boolean {
  return LOOP_PROMPT_IDS[definitionId] !== undefined;
}

/**
 * Edits the prompt that this loop will actually use.
 *
 * A registered definition has no instance row, so editing it changes the
 * global prompt inherited by its instances. A created loop owns an optional
 * override and can return to inheriting that global prompt at any time.
 */
export function LoopPromptSettings({
  task,
  onChanged,
  onToast,
}: {
  task: TaskDetail;
  onChanged: () => void;
  onToast?: (text: string) => void;
}) {
  const promptId = LOOP_PROMPT_IDS[task.definitionId]!;
  const prompts = useApi(queries.prompts());
  const prompt = prompts.data?.prompts.find((candidate) => candidate.id === promptId);

  if (prompts.error) return <ErrorBox>{prompts.error}</ErrorBox>;
  if (!prompt) return prompts.loading ? <Loading>Loading prompt…</Loading> : null;

  return (
    <PromptEditor
      key={`${task.id}:${prompt.id}`}
      task={task}
      prompt={prompt}
      onChanged={onChanged}
      onToast={onToast}
    />
  );
}

function PromptEditor({
  task,
  prompt,
  onChanged,
  onToast,
}: {
  task: TaskDetail;
  prompt: PromptTemplateView;
  onChanged: () => void;
  onToast?: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const isInstance = task.createdAt !== undefined;
  const effectiveTemplate = task.promptTemplate ?? prompt.template;
  const [template, setTemplate] = useState(effectiveTemplate);
  const save = useAction();

  useEffect(() => {
    setTemplate(effectiveTemplate);
    save.clear();
  }, [effectiveTemplate, task.id]);

  const dirty = template !== effectiveTemplate;
  const hasOverride = isInstance ? task.promptTemplate !== undefined : prompt.origin === "db";

  const handleSave = () =>
    save.run(async () => {
      if (!template.trim()) throw new Error("Prompt cannot be empty.");

      if (isInstance) {
        const updated = await api.updateInstance(task.id, { promptTemplate: template });
        queryClient.setQueryData(keys.task(task.id), updated);
      } else {
        const updated = await api.updatePrompts({ [prompt.id]: template });
        queryClient.setQueryData(keys.prompts(), updated);
      }
      onChanged();
      onToast?.("Prompt saved");
    });

  const handleReset = () =>
    save.run(async () => {
      if (isInstance) {
        const updated = await api.updateInstance(task.id, { promptTemplate: null });
        queryClient.setQueryData(keys.task(task.id), updated);
      } else {
        const updated = await api.updatePrompts({ [prompt.id]: null });
        queryClient.setQueryData(keys.prompts(), updated);
      }
      onChanged();
      onToast?.(isInstance ? "Loop now uses the global prompt" : "Prompt reverted to default");
    });

  const status = isInstance
    ? task.promptTemplate !== undefined
      ? "This loop uses its own custom prompt."
      : `This loop inherits the ${prompt.origin === "db" ? "customized global" : "built-in default"} prompt.`
    : `Loops without their own override inherit this ${prompt.origin === "db" ? "customized global" : "built-in default"} prompt.`;

  return (
    <section className="mb-5.5">
      <h2 className={SECTION_TITLE_CLASS}>{prompt.label} prompt</h2>
      <p className="mb-2 max-w-180 text-sm text-muted-foreground">{prompt.description}</p>
      <p className="mb-2 text-sm text-[var(--text-faint)]">
        Variables: {prompt.variables.map((variable) => `{{${variable}}}`).join(", ")}
      </p>
      <Textarea
        className="min-h-64 max-w-180 font-mono text-sm"
        rows={12}
        value={template}
        disabled={save.busy}
        onChange={(event) => {
          setTemplate(event.target.value);
          save.clear();
        }}
        spellCheck={false}
      />
      <p className="mt-1.5 text-sm text-[var(--text-faint)]">{status}</p>
      {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
      <div className="mt-2 flex gap-2">
        <Button type="button" size="sm" disabled={save.busy || !dirty} onClick={handleSave}>
          {save.busy ? "Saving…" : isInstance ? "Save custom prompt" : "Save global prompt"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={save.busy || !hasOverride}
          onClick={handleReset}
        >
          {isInstance ? "Use global prompt" : "Revert to built-in default"}
        </Button>
      </div>
    </section>
  );
}
