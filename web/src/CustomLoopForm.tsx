import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus, X } from "lucide-react";

import {
  api,
  agentLlmCapabilities,
  CUSTOM_LOOP_DEFINITION_ID,
  LLM_MODEL_VERSIONS,
  type AgentConnectionView,
  type AgentProvider,
  type CustomLoopPermission,
  type CustomLoopRepository,
  type LlmEffort,
  type LlmModel,
  type TaskSummary,
} from "./api.ts";
import { AgentIcon } from "./AgentIcon.tsx";
import { Button } from "./components/ui/button.tsx";
import { FIELD_CLASS, Field, FormActions } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { queries } from "./queries.ts";
import { buildTrigger, type LoopFrequency } from "./schedule-trigger.ts";
import { TimezoneSelect } from "./TimezoneSelect.tsx";
import { useApi } from "./useApi.ts";
import { useTimezone } from "./TimezoneContext.tsx";
import { utcToWallClock } from "./zoned-time.ts";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { PAGE_TITLE_CLASS, SECTION_TITLE_CLASS } from "./typography-styles.ts";
import { cn } from "./lib/utils.ts";

const CUSTOM_SECTION_CLASS =
  "mt-1 block max-w-180 border-t border-border pt-3.5 first-of-type:border-t-0 first-of-type:pt-0 [&>*+*]:mt-2.5";
const FIELD_ROW_CLASS = "flex items-start gap-3.5 [&>[data-slot=field]]:min-w-0 [&>[data-slot=field]]:flex-1";

/** Always offered, ahead of (and never duplicated by) the group listing. */
const DEFAULT_REPO = "example-org/webapp";
/** Where the rest of the repository dropdown's options come from. */
const REPO_GROUP = "example-org/services";

/** `Select` cannot hold an empty string, so "inherit the instance default" needs a sentinel. */
const INHERIT = "__inherit__";

const MODEL_LABELS: Record<LlmModel, string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
  fable: "Fable",
  "us.anthropic.claude-sonnet-5": "Sonnet 5 (Bedrock ID)",
  "us.anthropic.claude-opus-5": "Opus 5 (Bedrock ID)",
};

const EFFORT_LABELS: Record<LlmEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const PERMISSIONS: { value: CustomLoopPermission; label: string; hint: string }[] = [
  {
    value: "read-only",
    label: "Read-only",
    hint: "The agent reads the checkout and reports what it found. Nothing is committed.",
  },
  {
    value: "push",
    label: "Commit & push",
    hint: "Commits its changes onto the branch you picked. Refuses if someone else pushed while it worked.",
  },
  {
    value: "push-mr",
    label: "Push branch & open MR",
    hint: "Pushes a new branch and opens a draft merge request against the branch you picked.",
  },
];

/** A minute from now, rounded up, in the operator's own zone. */
function defaultFirstRun(timeZone: string): string {
  const at = new Date(Date.now() + 60_000);
  at.setSeconds(0, 0);
  return utcToWallClock(at.toISOString(), timeZone);
}

/**
 * The form behind "Create Loop": a loop the operator writes themselves, rather
 * than a named instance of a behaviour somebody already coded.
 *
 * It asks for four things in the order they are decided — what it is called, what
 * it runs against, when it runs, and what it should do — and it is its own
 * component rather than another branch of `CreateTaskPanel` because it is the only
 * one of them whose fields are not derived from a task we wrote: no field set
 * here maps onto a `gitlab`/`jira` params block, the name is typed rather than
 * generated, and the schedule is decided up front instead of on the detail page
 * afterwards.
 *
 * Everything is created in one POST: `params` for the agent, `schedule` for the
 * clock. Repositories are a list because "run this against these four services"
 * is the request that made a custom loop worth having, and each one is a separate
 * agent run — see `tasks/custom-loop`.
 */
export function CustomLoopForm({
  definitions = [],
  onDefinitionChange,
  onCancel,
  onCreated,
}: {
  /**
   * The other loops that can be instantiated, so the "Automation" dropdown works
   * in both directions: `CreateTaskPanel` hands over to this form when its
   * selection is the custom loop, and this form has to be able to hand back.
   */
  definitions?: TaskSummary[];
  onDefinitionChange?: (id: string) => void;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const browserZone = useTimezone();

  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");

  const [repositories, setRepositories] = useState<CustomLoopRepository[]>([]);
  const [draftRepo, setDraftRepo] = useState("");
  const [draftBranch, setDraftBranch] = useState("");

  const [firstRun, setFirstRun] = useState(() => defaultFirstRun(browserZone));
  const [timeZone, setTimeZone] = useState(browserZone);
  const [frequency, setFrequency] = useState<LoopFrequency>("daily");
  const [customCron, setCustomCron] = useState("0 9 * * 1-5");

  const [provider, setProvider] = useState<AgentProvider>("claude");
  const [model, setModel] = useState<string>(INHERIT);
  const [effort, setEffort] = useState<string>(INHERIT);
  const [permissions, setPermissions] = useState<CustomLoopPermission>("read-only");
  const [prompt, setPrompt] = useState("");

  const create = useAction();

  const repos = useApi(queries.gitlabProjects(REPO_GROUP));
  const repoOptions = repos.data?.projects ?? [];
  // Branches are only asked for once a repository is chosen; the empty project
  // disables the query rather than firing one that cannot mean anything. No
  // search term: this is a dropdown over the twenty most recent branches, not the
  // autocomplete `CreateTaskPanel` needs for its single-branch scope.
  const branches = useApi(queries.gitlabBranches(draftRepo, ""));
  const branchOptions = branches.data?.branches ?? [];

  const agents = useApi(queries.agents());
  const detected = agents.data?.agents ?? [];

  // Whatever the host can actually drive, preferring the operator's existing
  // choice. Claude is first in the API's own order, so this lands on it in
  // practice; it is written as "the first runnable one" rather than "claude" so
  // the day a second runner ships, this needs no edit.
  useEffect(() => {
    if (detected.length === 0) return;
    if (detected.some((agent) => agent.provider === provider && agent.runnable)) return;
    const runnable = detected.find((agent) => agent.runnable);
    if (runnable) setProvider(runnable.provider);
  }, [detected, provider]);

  const selectedAgent = detected.find((agent) => agent.provider === provider);
  const agentLlm = agentLlmCapabilities(provider);

  useEffect(() => {
    if (model !== INHERIT && !agentLlm.models.includes(model as LlmModel)) {
      setModel(INHERIT);
    }
    if (effort !== INHERIT && !agentLlm.efforts.includes(effort as LlmEffort)) {
      setEffort(INHERIT);
    }
  }, [agentLlm.efforts, agentLlm.models, effort, model]);

  // Choosing a repository clears the branch under it: a branch name from the
  // previous repository is worse than an empty field, because it might exist in
  // both and quietly point somewhere else.
  function chooseRepo(next: string) {
    setDraftRepo(next);
    setDraftBranch("");
  }

  function addRepository() {
    if (!draftRepo || !draftBranch) return;
    setRepositories((current) =>
      current.some((repo) => repo.projectId === draftRepo && repo.branch === draftBranch)
        ? current
        : [...current, { projectId: draftRepo, branch: draftBranch }],
    );
    setDraftBranch("");
  }

  function removeRepository(index: number) {
    setRepositories((current) => current.filter((_, i) => i !== index));
  }

  // Grouped so the dropdown reads as "Default" plus a "Services" category rather
  // than one flat list of forty-odd paths, and so the default repo is offered
  // before — or instead of — the group listing arriving.
  const repoCategories = useMemo(
    () => [
      { label: "Default", paths: [DEFAULT_REPO] },
      {
        label: "Services",
        paths: repoOptions
          .map((project) => project.pathWithNamespace)
          .filter((path) => path !== DEFAULT_REPO),
      },
    ],
    [repoOptions],
  );

  // A loop with no repository runs in a scratch workspace, so there is nothing to
  // push to and the writing permissions stop meaning anything.
  const canWrite = repositories.length > 0;
  useEffect(() => {
    if (!canWrite) setPermissions("read-only");
  }, [canWrite]);

  const canCreate = !create.busy && name.trim().length > 0 && prompt.trim().length > 0;

  const handleCreate = () =>
    create.run(async () => {
      // Throws on an unparseable date or a too-short cron, which is why it runs
      // in here rather than being computed with the rest of the params.
      const trigger = buildTrigger(frequency, firstRun, timeZone, customCron);
      const detail = await api.createInstance({
        definitionId: CUSTOM_LOOP_DEFINITION_ID,
        name: name.trim(),
        visibility,
        params: {
          prompt: prompt.trim(),
          repositories,
          agent: {
            provider,
            ...(selectedAgent?.account ? { account: selectedAgent.account } : {}),
          },
          llm: {
            ...(model !== INHERIT ? { model } : {}),
            ...(effort !== INHERIT ? { effort } : {}),
          },
          permissions,
        },
        // Enabled on creation: the operator just told us when it should run, and
        // a loop that has a first run and is switched off is a trap.
        schedule: { enabled: true, trigger },
      });
      onCreated(detail.id);
    });

  return (
    <div>
      <div>
        <h1 className={PAGE_TITLE_CLASS}>{name.trim() || "New loop"}</h1>
        <div className="mb-3.5 text-[0.9375rem] text-[var(--text-dim)]">
          Your own instructions, run by an agent on your schedule.
        </div>
      </div>

      <section className={CUSTOM_SECTION_CLASS}>
        {definitions.length > 1 && onDefinitionChange ? (
          <Field label="Automation">
            <Select value={CUSTOM_LOOP_DEFINITION_ID} onValueChange={onDefinitionChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {definitions.map((definition) => (
                  <SelectItem key={definition.id} value={definition.id}>
                    {definition.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        <div className={FIELD_ROW_CLASS}>
          <Field className="grow" label="Name">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Nightly dependency audit"
              autoFocus
            />
          </Field>

          <Field label="Visibility">
            <Select
              value={visibility}
              onValueChange={(value) => setVisibility(value as "private" | "public")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private — only me</SelectItem>
                <SelectItem value="public">Team — everyone can see it</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </section>

      <section className={CUSTOM_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>
          Repositories{" "}
          <span className="text-[0.7812rem] font-normal tracking-[0.04em] text-muted-foreground uppercase">
            optional
          </span>
        </h2>
        <p className="block text-sm leading-[1.45] text-muted-foreground">
          One agent run per repository. Leave this empty and the loop runs with no
          checkout at all — for instructions that are not about code.
        </p>

        {repositories.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {repositories.map((repo, index) => (
              <motion.span
                key={`${repo.projectId}@${repo.branch}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background py-[3px] pr-1 pl-2.5 text-sm"
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.12 }}
              >
                <span className="text-foreground">{repo.projectId}</span>
                <span className="border-l border-border pl-1.5 font-mono text-[0.7812rem] text-muted-foreground">
                  {repo.branch}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-4.5 rounded-full p-0 text-muted-foreground hover:bg-border hover:text-foreground"
                  aria-label={`Remove ${repo.projectId} ${repo.branch}`}
                  onClick={() => removeRepository(index)}
                >
                  <X size={12} strokeWidth={2.5} />
                </Button>
              </motion.span>
            ))}
          </div>
        ) : null}

        <div className={FIELD_ROW_CLASS}>
          <Field className="grow" label="Repository">
            <Select value={draftRepo || undefined} onValueChange={chooseRepo}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a repository…" />
              </SelectTrigger>
              <SelectContent>
                {repoCategories
                  .filter((category) => category.paths.length > 0)
                  .map((category) => (
                    <SelectGroup key={category.label}>
                      <SelectLabel>{category.label}</SelectLabel>
                      {category.paths.map((path) => (
                        <SelectItem key={path} value={path}>
                          {path}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
              </SelectContent>
            </Select>
          </Field>

          <AnimatePresence initial={false}>
            {draftRepo ? (
              <motion.label
                className={cn(FIELD_CLASS, "grow")}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.13 }}
              >
                Branch
                <Select
                  value={draftBranch || undefined}
                  onValueChange={setDraftBranch}
                  disabled={branchOptions.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        branches.loading
                          ? "Loading branches…"
                          : branchOptions.length === 0
                            ? "No branches found"
                            : "Pick a branch…"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {branchOptions.map((branch) => (
                      <SelectItem key={branch.name} value={branch.name}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </motion.label>
            ) : null}
          </AnimatePresence>

          <Button
            type="button"
            variant="outline"
            className="self-end"
            disabled={!draftRepo || !draftBranch}
            onClick={addRepository}
          >
            <Plus size={14} strokeWidth={2.5} />
            Add
          </Button>
        </div>
      </section>

      <section className={CUSTOM_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>When</h2>

        <div className={FIELD_ROW_CLASS}>
          <Field label="First run">
            <Input
              type="datetime-local"
              value={firstRun}
              onChange={(event) => setFirstRun(event.target.value)}
            />
          </Field>

          <Field label="Frequency">
            <Select
              value={frequency}
              onValueChange={(value) => setFrequency(value as LoopFrequency)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="once">Once</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="custom">Custom cron</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field className="grow" label="Time zone">
            <TimezoneSelect value={timeZone} onChange={setTimeZone} />
          </Field>
        </div>

        <AnimatePresence initial={false}>
          {frequency === "custom" ? (
            <motion.label
              className={FIELD_CLASS}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.13 }}
            >
              Cron expression
              <Input
                className="mono"
                value={customCron}
                onChange={(event) => setCustomCron(event.target.value)}
                placeholder="0 9 * * 1-5"
              />
            </motion.label>
          ) : null}
        </AnimatePresence>
      </section>

      <section className={CUSTOM_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>Instructions</h2>

        <div className={FIELD_ROW_CLASS}>
          <Field className="grow" label="Agent">
            <Select value={provider} onValueChange={(value) => setProvider(value as AgentProvider)}>
              <SelectTrigger>
                <SelectValue
                  placeholder={agents.loading ? "Looking for agents…" : "No agents detected"}
                />
              </SelectTrigger>
              <SelectContent>
                {detected.map((agent) => (
                  <SelectItem key={agent.provider} value={agent.provider} disabled={!agent.runnable}>
                    <AgentRow agent={agent} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Model">
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>Instance default</SelectItem>
                {agentLlm.models.map((option) => (
                  <SelectItem key={option} value={option}>
                    {MODEL_LABELS[option]}
                    <span className="ml-2 text-muted-foreground">
                      {LLM_MODEL_VERSIONS[option]}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Effort">
            <Select value={effort} onValueChange={setEffort}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>Model default</SelectItem>
                {agentLlm.efforts.map((option) => (
                  <SelectItem key={option} value={option}>
                    {EFFORT_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {detected.length > 0 && !detected.some((agent) => agent.runnable) ? (
          <div className="block text-sm leading-[1.45] text-warning">
            None of the agents signed in on this host can be driven by TALOS yet.
            Sign in with Claude Code to run a loop.
          </div>
        ) : null}

        <div className={FIELD_CLASS}>
          Permissions
          <div className="flex flex-col gap-1.5">
            {PERMISSIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="outline"
                className={cn(
                  "h-auto flex-col items-start gap-0.5 rounded-[var(--radius)] bg-background px-2.5 py-2 text-left font-[inherit] hover:border-muted-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-45",
                  permissions === option.value &&
                    "border-action shadow-[inset_0_0_0_1px_var(--action)]",
                )}
                aria-pressed={permissions === option.value}
                // A disabled button eats the pointer events a tooltip needs, so the
                // reason it is off lives in the hint under the list instead.
                disabled={option.value !== "read-only" && !canWrite}
                onClick={() => setPermissions(option.value)}
              >
                <span className="text-[0.9375rem] text-foreground">{option.label}</span>
                <span className="text-[0.7812rem] leading-[1.4] text-muted-foreground">
                  {option.hint}
                </span>
              </Button>
            ))}
          </div>
          {canWrite ? null : (
            <span className="block text-sm leading-[1.45] text-muted-foreground">
              Add a repository to let the loop write — there is nothing to push to
              without one.
            </span>
          )}
        </div>

        <Field label="Prompt">
          <Textarea
            className="mono min-h-40 text-[0.9375rem] leading-normal"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={8}
            placeholder={
              "What should the agent do every time this loop runs?\n\n" +
              "e.g. Check every direct dependency for a published security advisory. " +
              "Report the package, the advisory and the version that fixes it."
            }
          />
        </Field>

        {create.error ? <ErrorBox>{create.error}</ErrorBox> : null}

        <FormActions>
          <Button type="button" disabled={!canCreate} onClick={handleCreate}>
            {create.busy ? "Creating…" : "Create loop"}
          </Button>
          <Button type="button" variant="outline" disabled={create.busy} onClick={onCancel}>
            Cancel
          </Button>
        </FormActions>
      </section>
    </div>
  );
}

/** Icon, product name, and the account the host is signed in as. */
function AgentRow({ agent }: { agent: AgentConnectionView }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <AgentIcon provider={agent.provider} size={15} />
      <span>{agent.name}</span>
      <span className="overflow-hidden text-ellipsis text-[0.7812rem] text-muted-foreground">
        {agent.account ?? "signed in"}
      </span>
      {agent.runnable ? null : (
        <span className="rounded-full border border-border px-[5px] text-xs tracking-[0.04em] text-muted-foreground uppercase">
          soon
        </span>
      )}
    </span>
  );
}
