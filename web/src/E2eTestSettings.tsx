import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { api, type E2eTestSettingsView } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { keys } from "./query-keys.ts";
import { queries } from "./queries.ts";
import { SETTINGS_FORM_CLASS } from "./settings-layout.ts";
import { TitleInfo } from "./TitleInfo.tsx";
import { PAGE_TITLE_CLASS } from "./typography-styles.ts";
import { useAction } from "./useAction.ts";
import { useApi } from "./useApi.ts";

export function E2eTestSettings() {
  const queryClient = useQueryClient();
  const settings = useApi(queries.e2eTestSettings());

  if (settings.error) return <ErrorBox>{settings.error}</ErrorBox>;
  if (!settings.data) {
    return settings.loading ? <Loading>Loading E2E test settings…</Loading> : null;
  }
  return (
    <E2eTestSettingsForm
      initial={settings.data}
      onSaved={(saved) => queryClient.setQueryData(keys.e2eTestSettings(), saved)}
    />
  );
}

function E2eTestSettingsForm({
  initial,
  onSaved,
}: {
  initial: E2eTestSettingsView;
  onSaved: (saved: E2eTestSettingsView) => void;
}) {
  const [agentInstructions, setAgentInstructions] = useState(
    initial.agentInstructionsOverride ?? "",
  );
  const [runtimeConfig, setRuntimeConfig] = useState(initial.runtimeConfigOverride ?? "");
  const [additionalInstructions, setAdditionalInstructions] = useState(
    initial.additionalInstructions ?? "",
  );
  const save = useAction();

  useEffect(() => {
    setAgentInstructions(initial.agentInstructionsOverride ?? "");
    setRuntimeConfig(initial.runtimeConfigOverride ?? "");
    setAdditionalInstructions(initial.additionalInstructions ?? "");
  }, [initial]);

  const agentValue = agentInstructions.trim() || null;
  const runtimeValue = runtimeConfig.trim() || null;
  const additionalValue = additionalInstructions.trim() || null;
  const dirty =
    agentValue !== initial.agentInstructionsOverride ||
    runtimeValue !== initial.runtimeConfigOverride ||
    initial.runtimeConfigUnreadable ||
    additionalValue !== initial.additionalInstructions;

  const handleSave = () =>
    save.run(async () => {
      onSaved(await api.updateE2eTestSettings({
        agentInstructionsOverride: agentValue,
        runtimeConfigOverride: runtimeValue,
        additionalInstructions: additionalValue,
      }));
    });

  const handleReset = () =>
    save.run(async () => {
      onSaved(
        await api.updateE2eTestSettings({
          agentInstructionsOverride: null,
          runtimeConfigOverride: null,
          additionalInstructions: null,
        }),
      );
    });

  return (
    <div className={SETTINGS_FORM_CLASS}>
      <h1 className={PAGE_TITLE_CLASS}>
        E2E tests
        <TitleInfo>
          Instance-wide inputs for the agent started from a ticket's E2E test action. Changes
          apply to new runs without rebuilding the agent image.
        </TitleInfo>
      </h1>

      <FileOverrideCard
        title="QA exploratory tester prompt"
        description={
          <>
            Replaces <SourcePath initial={initial} path={initial.sources.agentInstructionsPath} />.
            The runner's QA target, credential protection, read-only repository rule, and response
            schema remain enforced by its system prompt.
          </>
        }
        value={agentInstructions}
        onValueChange={setAgentInstructions}
        placeholder="# QA exploratory tester…"
      />

      <FileOverrideCard
        title="QA runtime config"
        description={
          <>
            Fully replaces{" "}
            <SourcePath initial={initial} path={initial.sources.runtimeConfigPath} /> for the run.
            Requires <code>webSettings.baseUrl</code> and the main portal{" "}
            <code>userSettings.principalEmail</code>/<code>principalPass</code> credentials.
            Student and parent portal settings are optional. Credentials are encrypted at rest.
          </>
        }
        value={runtimeConfig}
        onValueChange={setRuntimeConfig}
        placeholder={'webSettings {\n  baseUrl = "https://…"\n}'}
        disabled={!initial.secretsEnabled && !initial.runtimeConfigUnreadable}
        warning={
          initial.runtimeConfigUnreadable
            ? "The stored runtime override cannot be decrypted with the current TALOS_SECRET_KEY. Enter a replacement, or save the empty box to use the repository default."
            : !initial.secretsEnabled
              ? "Set TALOS_SECRET_KEY and restart before storing a runtime override."
              : undefined
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Additional agent instructions</CardTitle>
          <CardDescription>
            Natural-language commands for every E2E agent, mounted as{" "}
            <code>.talos/operator-instructions.md</code>. This does not execute host shell commands
            or expand the agent's tool permissions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            className="min-h-40 font-mono text-sm"
            rows={8}
            value={additionalInstructions}
            onChange={(event) => setAdditionalInstructions(event.target.value)}
            placeholder="For this run, prioritize…"
            spellCheck={false}
          />
          <div className="mt-2 text-sm text-[var(--text-faint)]">
            Leave empty to send no additional instructions.
          </div>
        </CardContent>
      </Card>

      {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
      {save.done ? <div className="text-sm text-[var(--text-faint)]">Saved.</div> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={save.busy || !dirty} onClick={handleSave}>
          {save.busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={save.busy || (
            initial.agentInstructionsOverride == null &&
            initial.runtimeConfigOverride == null &&
            !initial.runtimeConfigUnreadable &&
            initial.additionalInstructions == null
          )}
          onClick={handleReset}
        >
          Revert all to repository defaults
        </Button>
      </div>
    </div>
  );
}

function FileOverrideCard({
  title,
  description,
  value,
  onValueChange,
  placeholder,
  disabled = false,
  warning,
}: {
  title: string;
  description: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  warning?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {warning ? <div className="mb-2 text-sm text-[var(--text-faint)]">{warning}</div> : null}
        <Textarea
          className="min-h-64 font-mono text-sm"
          rows={12}
          value={value}
          disabled={disabled}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
        <div className="mt-2 text-sm text-[var(--text-faint)]">
          Leave empty to use the repository default.
        </div>
      </CardContent>
    </Card>
  );
}

function SourcePath({
  initial,
  path,
}: {
  initial: E2eTestSettingsView;
  path: string;
}) {
  return (
    <code>
      {initial.sources.project}@{initial.sources.ref}/{path}
    </code>
  );
}
