import { useQueryClient } from "@tanstack/react-query";
import { useAbility } from "@casl/react";
import { useEffect, useState } from "react";
import { Field } from "./components/ui/field.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import {
  api,
  LLM_EFFORTS,
  LLM_MODEL_VERSIONS,
  LLM_MODELS,
  LOG_LEVELS,
  type GeneralSettings,
  type LogLevel,
} from "./api.ts";
import { queries } from "./queries.ts";
import { TitleInfo } from "./TitleInfo.tsx";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { PromptsPage } from "./PromptsPage.tsx";
import { FixIssueDefaultsSettings } from "./FixIssueDefaultsSettings.tsx";
import { IntegrationsSettings } from "./IntegrationsSettings.tsx";
import { PullRequestRepoSettings } from "./PullRequestRepoSettings.tsx";
import { ReleaseConfigSettings } from "./ReleaseConfigSettings.tsx";
import { E2eTestSettings } from "./E2eTestSettings.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs.tsx";
import type { SettingsTab } from "./route-state.ts";
import { Input } from "./components/ui/input.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { SETTINGS_FORM_CLASS, SETTINGS_SECTION_CLASS } from "./settings-layout.ts";
import { ago } from "./format.ts";
import { PAGE_TITLE_CLASS, SECTION_TITLE_CLASS } from "./typography-styles.ts";
import type { AppAbility } from "../../shared/authorization.ts";
import {
  EFFORT_LABELS,
  fromLlmSelectValue,
  LLM_DEFAULT,
  MODEL_LABELS,
  toLlmSelectValue,
} from "./llm-options.ts";

/**
 * The tabs, in the order they appear.
 *
 * This page is the *instance*: log level, timezone, LLM defaults, integration site
 * URLs, prompts and release config are one row in the database, the same for
 * everybody, and changing one changes it for the team.
 *
 * So nothing per-developer belongs here. Your account, your notification
 * subscriptions, your theme, your GitLab and Jira identities and the AI agent your
 * runs bill to all live behind the user icon in the top bar instead — a screen that
 * only ever describes you. Pull requests is the one holdout, and only because the
 * repo filter and the fix-issue defaults are about a page rather than an identity.
 */
const TABS: readonly { key: SettingsTab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "integrations", label: "Integrations" },
  { key: "prompts", label: "Prompts" },
  { key: "e2e-tests", label: "E2E tests" },
  { key: "pull-requests", label: "Pull requests" },
  { key: "releases", label: "Releases" },
];

export function SettingsPage({
  settingsTab,
  onSetSettingsTab,
}: {
  settingsTab?: SettingsTab;
  onSetSettingsTab: (tab: SettingsTab) => void;
}) {
  const ability = useAbility<AppAbility>();
  const canManageInstance = ability.can("manage", "InstanceSettings");
  const tabs = canManageInstance
    ? TABS
    : TABS.filter(({ key }) => key === "pull-requests");
  const requestedTab = settingsTab ?? "general";
  const activeTab = tabs.some(({ key }) => key === requestedTab)
    ? requestedTab
    : "pull-requests";

  useEffect(() => {
    if (activeTab !== requestedTab) onSetSettingsTab(activeTab);
  }, [activeTab, requestedTab, onSetSettingsTab]);

  return (
    <div className="flex h-full flex-col overflow-hidden pt-4">
      <Tabs
        value={activeTab}
        onValueChange={(value) => onSetSettingsTab(value as SettingsTab)}
        className="min-h-0 flex-1"
      >
        <TabsList variant="line" className="px-4 min-[901px]:px-8">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {canManageInstance ? (
          <>
            <TabsContent value="general" className="tab-panel min-h-0 flex-1 overflow-y-auto text-inherit">
              <GeneralSettings />
            </TabsContent>
            <TabsContent value="integrations" className="tab-panel min-h-0 flex-1 overflow-y-auto text-inherit">
              <IntegrationsSettings />
            </TabsContent>
            <TabsContent value="prompts" className="tab-panel min-h-0 flex-1 overflow-y-auto text-inherit">
              <PromptsPage />
            </TabsContent>
            <TabsContent value="e2e-tests" className="tab-panel min-h-0 flex-1 overflow-y-auto text-inherit">
              <E2eTestSettings />
            </TabsContent>
          </>
        ) : null}
        <TabsContent value="pull-requests" className="tab-panel min-h-0 flex-1 overflow-y-auto text-inherit">
          {/* Both per-user and both about the same day's work — which merge
              requests you watch, and where a fix you start ends up. */}
          <>
            <PullRequestRepoSettings />
            <FixIssueDefaultsSettings />
          </>
        </TabsContent>
        {canManageInstance ? (
          <TabsContent value="releases" className="tab-panel min-h-0 flex-1 overflow-y-auto text-inherit">
            <ReleaseConfigSettings />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

/**
 * The instance-wide general settings, and the read they depend on.
 *
 * The fetch lives here rather than in `SettingsPage` so that an instance whose
 * `/api/settings` is failing still opens every other tab — Prompts and Pull
 * requests have nothing to do with `general_config`, and gating the whole page on
 * it made a broken instance-wide read look like a broken Settings screen.
 */
function GeneralSettings() {
  const queryClient = useQueryClient();
  const settings = useApi(queries.settings());

  if (settings.error) return <ErrorBox>{settings.error}</ErrorBox>;
  if (!settings.data) {
    return settings.loading ? <Loading>Loading settings…</Loading> : null;
  }

  return (
    <SettingsForm
      initial={settings.data}
      // `PUT /api/settings` answers with the whole saved view, so writing it
      // straight into the cache costs no round trip — and updates the timezone
      // every date on screen is formatted in (`TimezoneContext` reads this same
      // entry) at the same moment.
      onSaved={(saved) => queryClient.setQueryData(keys.settings(), saved)}
    />
  );
}

function SettingsForm({
  initial,
  onSaved,
}: {
  initial: GeneralSettings;
  onSaved: (saved: GeneralSettings) => void;
}) {
  const [logLevel, setLogLevel] = useState<LogLevel>(initial.logLevel);
  const [timezone, setTimezone] = useState(initial.timezone ?? "");
  const [llmProvider, setLlmProvider] = useState(initial.llm.provider);
  const [llmModel, setLlmModel] = useState(toLlmSelectValue(initial.llm.model));
  const [llmEffort, setLlmEffort] = useState(toLlmSelectValue(initial.llm.effort));
  const [llmMaxTokens, setLlmMaxTokens] = useState(String(initial.llm.maxTokens));
  // What each alias actually resolved to on its most recent run — the ground
  // truth `LLM_MODEL_VERSIONS` above is only advisory about.
  const resolvedModels = useApi(queries.resolvedModels());
  // Shared by Save and "Revert to defaults": both write the same record, so
  // they share "busy" and the error line.
  const save = useAction();

  // A save from elsewhere (or a page revisit) should show the current values,
  // not whatever was left half-typed in a previous mount.
  useEffect(() => {
    setLogLevel(initial.logLevel);
    setTimezone(initial.timezone ?? "");
    setLlmProvider(initial.llm.provider);
    setLlmModel(toLlmSelectValue(initial.llm.model));
    setLlmEffort(toLlmSelectValue(initial.llm.effort));
    setLlmMaxTokens(String(initial.llm.maxTokens));
  }, [initial]);

  const handleSave = () =>
    save.run(async () => {
      const maxTokens = Number(llmMaxTokens);
      if (!Number.isInteger(maxTokens) || maxTokens < 1) {
        throw new Error("Max tokens must be a positive integer.");
      }

      onSaved(
        await api.updateSettings({
          logLevel,
          timezone: timezone.trim() || null,
          llm: {
            provider: llmProvider.trim() || null,
            model: fromLlmSelectValue(llmModel),
            effort: fromLlmSelectValue(llmEffort),
            maxTokens,
          },
        }),
      );
    });

  const handleReset = () =>
    save.run(async () => {
      onSaved(
        await api.updateSettings({
          logLevel: null,
          timezone: null,
          llm: { provider: null, model: null, effort: null, maxTokens: null },
        }),
      );
    });

  const extraModel =
    llmModel !== LLM_DEFAULT && !(LLM_MODELS as readonly string[]).includes(llmModel)
      ? llmModel
      : null;
  const extraEffort =
    llmEffort !== LLM_DEFAULT && !(LLM_EFFORTS as readonly string[]).includes(llmEffort)
      ? llmEffort
      : null;

  return (
    <div className={SETTINGS_FORM_CLASS}>
      <h1 className={PAGE_TITLE_CLASS}>
        Settings
        <TitleInfo>
          Instance-wide defaults — not user-specific. Changes apply live, no restart required.
        </TitleInfo>
      </h1>

      <section className={SETTINGS_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>Logging</h2>
        <Field label="Log level">
          <Select value={logLevel} onValueChange={(value) => setLogLevel(value as LogLevel)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOG_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {initial.logLevelOrigin === "default" ? (
          <div className="mt-1.5 text-sm text-[var(--text-faint)]">Currently the YAML default.</div>
        ) : null}
      </section>

      <section className={SETTINGS_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>Scheduling</h2>
        <Field label="Default timezone">
          <Input
            className="w-48"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="e.g. Europe/Berlin"
          />
        </Field>
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          Applies to cron triggers that do not set their own timezone.
          {initial.timezoneOrigin === "default" ? " Currently the YAML default." : ""}
        </div>
      </section>

      <section className={SETTINGS_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>Loop agent defaults</h2>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Model">
            <Select value={llmModel} onValueChange={setLlmModel}>
              <SelectTrigger className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LLM_DEFAULT}>Claude default</SelectItem>
                {LLM_MODELS.map((model) => (
                  <SelectItem key={model} value={model}>
                    {MODEL_LABELS[model]}
                    <span className="ml-2 text-muted-foreground">
                      {LLM_MODEL_VERSIONS[model]}
                    </span>
                  </SelectItem>
                ))}
                {extraModel ? <SelectItem value={extraModel}>{extraModel}</SelectItem> : null}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Effort">
            <Select value={llmEffort} onValueChange={setLlmEffort}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LLM_DEFAULT}>Model default</SelectItem>
                {LLM_EFFORTS.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {EFFORT_LABELS[effort]}
                  </SelectItem>
                ))}
                {extraEffort ? <SelectItem value={extraEffort}>{extraEffort}</SelectItem> : null}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          Used by scheduled loops and the work they discover. Agent actions started directly by a
          developer use that person's defaults under Agent connections. The alias is what reaches{" "}
          <code>claude --model</code>; the version beside it is what that alias currently tracks.
          The run log's “claude started (…)” line says which model actually ran.
          {initial.llmOrigin === "default" ? " Currently the YAML defaults." : ""}
        </div>
        {resolvedModels.data ? (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-faint)]">
            {LLM_MODELS.map((model) => {
              const resolved = resolvedModels.data![model];
              return (
                <span key={model}>
                  <code>{model}</code> last ran as{" "}
                  {resolved
                    ? (
                      <>
                        <code>{resolved.model}</code> ({ago(resolved.ts)})
                      </>
                    )
                    : "no runs yet"}
                </span>
              );
            })}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <Field label="Provider">
            <Input
              className="w-40"
              value={llmProvider}
              onChange={(e) => setLlmProvider(e.target.value)}
            />
          </Field>
          <Field label="Max tokens">
            <Input
              className="w-28"
              type="number"
              min={1}
              value={llmMaxTokens}
              onChange={(e) => setLlmMaxTokens(e.target.value)}
            />
          </Field>
        </div>
      </section>

      {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
      {save.done ? <div className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</div> : null}

      <div className="flex gap-2">
        <Button type="button" disabled={save.busy} onClick={handleSave}>
          {save.busy ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="outline" disabled={save.busy} onClick={handleReset}>
          Revert all to defaults
        </Button>
      </div>
    </div>
  );
}
