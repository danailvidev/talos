import { type ReactNode, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  api,
  CUSTOM_LOOP_DEFINITION_ID,
  type JiraIssueView,
  type MergeRequestView,
  type TaskSummary,
  type Trigger,
} from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { FIELD_CLASS, Field, FormActions } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { CustomLoopForm } from "./CustomLoopForm.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command.tsx";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "./components/ui/popover.tsx";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { useDebounced } from "./useDebounced.ts";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { PAGE_TITLE_CLASS } from "./typography-styles.ts";
import { cn } from "./lib/utils.ts";

const PANEL_SECTION_CLASS =
  "flex max-w-170 flex-wrap items-start gap-x-4 gap-y-2.5 [&>[data-slot=field]]:min-w-50 [&>[data-slot=field]]:flex-[1_1_230px]";
const PANEL_FIELD_CLASS = `${FIELD_CLASS} min-w-50 flex-[1_1_230px]`;
const TAG_CLASS =
  "inline-flex items-center gap-1 rounded-[var(--radius)] bg-[var(--bg-hover)] px-1.5 py-0.5 text-sm text-foreground [&_button]:cursor-pointer [&_button]:border-0 [&_button]:bg-transparent [&_button]:p-0 [&_button]:text-muted-foreground";

/** Jira keys as they appear in branch names (`fix/TP-3012`) and MR titles. */
const JIRA_ISSUE_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

function jiraKeyFromMr(mr?: MergeRequestView): string | undefined {
  if (!mr) return undefined;
  const match = `${mr.sourceBranch} ${mr.title}`.toUpperCase().match(JIRA_ISSUE_KEY);
  return match?.[1];
}

function AutocompleteResults<T>({
  open,
  onOpenChange,
  search,
  onSearchChange,
  placeholder,
  results,
  loading,
  error,
  loadingLabel,
  emptyLabel,
  getKey,
  getValue,
  renderResult,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: string;
  onSearchChange: (search: string) => void;
  placeholder: string;
  results: T[];
  loading: boolean;
  error?: string;
  loadingLabel: string;
  emptyLabel: string;
  getKey: (result: T) => string;
  getValue: (result: T) => string;
  renderResult: (result: T) => ReactNode;
  onSelect: (result: T) => void;
}) {
  const visibleResults = error ? [] : results;
  const emptyState = error ? error : loading ? loadingLabel : emptyLabel;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Command
        shouldFilter={false}
        className="h-auto overflow-visible rounded-none bg-transparent p-0 text-foreground [&_[data-slot=command-input-wrapper]]:p-0 [&_[data-slot=input-group]]:h-auto! [&_[data-slot=input-group]]:rounded-md! [&_[data-slot=input-group]]:border-border [&_[data-slot=input-group]]:bg-background! [&_[data-slot=input-group]]:shadow-none! [&_[data-slot=input-group-addon]]:hidden [&_[data-slot=command-input]]:px-2 [&_[data-slot=command-input]]:py-1 [&_[data-slot=command-input]]:text-base"
      >
        <PopoverAnchor asChild>
          <CommandInput
            value={search}
            onValueChange={(next) => {
              onSearchChange(next);
              onOpenChange(true);
            }}
            onFocus={() => onOpenChange(true)}
            placeholder={placeholder}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-trigger-width)] gap-0 overflow-hidden rounded-[var(--radius)] border border-border bg-background p-0 shadow-none"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <CommandList className="max-h-[140px]">
            <CommandEmpty className="px-2 py-3 text-left text-muted-foreground">
              {emptyState}
            </CommandEmpty>
            {visibleResults.map((result) => (
              <CommandItem
                key={getKey(result)}
                value={getValue(result)}
                className="cursor-pointer rounded-none bg-background px-2 py-1.5 text-left font-[inherit] text-sm text-foreground data-selected:bg-[var(--bg-hover)]"
                onSelect={() => onSelect(result)}
              >
                <span className="min-w-0 flex-1 truncate">{renderResult(result)}</span>
              </CommandItem>
            ))}
          </CommandList>
        </PopoverContent>
      </Command>
    </Popover>
  );
}

/** The repository offered before the group listing loads, and always offered even if it fails. */
const DEFAULT_REPO = "example-org/webapp";
/** Where the rest of the repository dropdown's options come from. */
const REPO_GROUP = "example-org/services";
/** Sentinel for "every project the token user is a reviewer on". */
const ALL_PROJECTS = "__all__";

/**
 * Creates a new named instance of an instantiable definition, inline in the
 * same content container `TaskDetail` renders into — not a dialog, so it
 * reads as part of the Loops workspace rather than an interruption on top of it.
 *
 * Reached from the Loops page only, now that the ad-hoc Tasks page is retired, so
 * the definitions offered are the `kind: "loop"` ones. `fix-jira-issue` used to
 * have a field set here; it is triggered from a ticket on the graph instead.
 *
 * Each known definition gets its own field set below rather than a generic
 * schema-driven form — nested gitlab/jira blocks do not flatten into inputs
 * automatically (see `describeParamsSchemaLoosely`), and a new shape should
 * get a new `if`, not a bigger generic one.
 */
export function CreateTaskPanel({
  definitions,
  onCancel,
  onCreated,
}: {
  definitions: TaskSummary[];
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [definitionId, setDefinitionId] = useState(definitions[0]?.id ?? "");
  const create = useAction();

  // gitlab-ci-failure fields.
  const [gitlabProject, setGitlabProject] = useState(DEFAULT_REPO);
  const [jiraProject, setJiraProject] = useState("");
  const [triggerType, setTriggerType] = useState<Trigger["type"]>("manual");
  const [cron, setCron] = useState("*/10 * * * *");

  // gitlab-code-review / gitlab-review-requested fields.
  const [repoProject, setRepoProject] = useState(DEFAULT_REPO);
  const [groupFilter, setGroupFilter] = useState("");
  const [scope, setScope] = useState<"choose" | "branch" | "issue">("choose");
  const [mrSearch, setMrSearch] = useState("");
  // Explicit rather than derived from the results array: picking a result
  // clears the search box, which re-triggers the lookup below and would
  // otherwise repopulate the results and pop the list straight back open
  // right after a selection — fixed here rather than avoiding the clear,
  // since the box should still read empty afterwards, ready for the next
  // search. Shared by the merge-request, branch and Jira-issue pickers below,
  // since only one is ever visible at a time.
  const [mrListOpen, setMrListOpen] = useState(false);
  const [selectedMr, setSelectedMr] = useState<MergeRequestView>();

  const [branchSearch, setBranchSearch] = useState("");
  const [branchListOpen, setBranchListOpen] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string>();

  const [issueSearch, setIssueSearch] = useState("");
  const [issueListOpen, setIssueListOpen] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<JiraIssueView>();

  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (definitions.some((d) => d.id === definitionId)) return;
    setDefinitionId(definitions[0]?.id ?? "");
  }, [definitions, definitionId]);

  const isCodeReview = definitionId === "gitlab-code-review";
  const isReviewRequested = definitionId === "gitlab-review-requested";
  const isMrFollowUp = definitionId === "gitlab-mr-follow-up";
  const needsRepoList = isCodeReview || isReviewRequested || isMrFollowUp;

  useEffect(() => {
    if (!isReviewRequested && !isMrFollowUp) return;
    setTriggerType("cron");
    // Fifteen minutes, matching REVIEW_REQUESTED_CRON: the sweep is the safety
    // net behind the webhook now, not the clock the loop runs on.
    setCron(isMrFollowUp ? "0 * * * *" : "*/15 * * * *");
    setRepoProject(ALL_PROJECTS);
  }, [isReviewRequested, isMrFollowUp]);

  /**
   * The four pickers. Each is one query whose *key* carries the debounced search
   * term, so narrowing a list is an autocomplete rather than a request per
   * keystroke — and typing back over a term already typed answers from cache
   * without a request at all, which the old debounce-the-request version could
   * not do however long its timer was.
   *
   * The `project` a picker is given is empty whenever it should not be asking:
   * the registry disables a query with no project, which is what used to be the
   * early return that cleared the results array. A failed lookup leaves the list
   * empty rather than raising — an autocomplete that cannot reach the forge has
   * nothing to offer, and a banner over a form field would be worse than none.
   */
  const debouncedMrSearch = useDebounced(mrSearch, 250);
  const debouncedBranchSearch = useDebounced(branchSearch, 250);
  const debouncedIssueSearch = useDebounced(issueSearch.trim(), 250);

  // The group holds dozens of projects and barely changes, so this is read once
  // and then shared by every panel opened in the next ten minutes.
  const repos = useApi(queries.gitlabProjects(needsRepoList ? REPO_GROUP : ""));
  const repoOptions = repos.data?.projects ?? [];

  const pickerProject =
    isCodeReview && repoProject && repoProject !== ALL_PROJECTS ? repoProject : "";
  const mrs = useApi(
    queries.gitlabMergeRequests(scope === "choose" ? pickerProject : "", debouncedMrSearch),
  );
  const mrResults = mrs.data?.mergeRequests ?? [];
  const branches = useApi(
    queries.gitlabBranches(scope === "branch" ? pickerProject : "", debouncedBranchSearch),
  );
  const branchResults = branches.data?.branches ?? [];
  const issues = useApi(
    queries.jiraIssues(isCodeReview && scope === "issue" ? debouncedIssueSearch : ""),
  );
  const issueResults = issues.data?.issues ?? [];

  // The custom loop has no field set here: nothing it asks for maps onto the
  // gitlab/jira params blocks below, its name is typed rather than derived, and
  // its schedule is decided on the form instead of on the detail page after.
  // So it gets its own component — handed the definition list so the choice
  // stays reversible from there. Placed after every hook above rather than at
  // the top of the function: an early return before them would change how many
  // hooks this component calls depending on the dropdown.
  if (definitionId === CUSTOM_LOOP_DEFINITION_ID) {
    return (
      <CustomLoopForm
        definitions={definitions}
        onDefinitionChange={setDefinitionId}
        onCancel={onCancel}
        onCreated={onCreated}
      />
    );
  }

  const mrJiraKey = scope === "choose" ? jiraKeyFromMr(selectedMr) : undefined;

  // No "Name" field: the operator already said everything the name would
  // otherwise ask for by picking a scope (or a GitLab project), so a system
  // name derived from that is one less thing to type and never blank.
  const name = isCodeReview
    ? scope === "choose" && selectedMr
      ? `AI Code Review ${selectedMr.title}`
      : scope === "branch" && selectedBranch
        ? `AI Code Review ${selectedBranch}`
        : scope === "issue" && selectedIssue
          ? `AI Code Review ${selectedIssue.key}`
          : `AI Code Review`
    : isReviewRequested
      ? repoProject !== ALL_PROJECTS
        ? `Review requests (${repoProject})`
        : groupFilter.trim()
          ? `Review requests (${groupFilter.trim()})`
          : "GitLab review requests"
      : isMrFollowUp
        ? repoProject !== ALL_PROJECTS
          ? `MR follow-up (${repoProject})`
          : groupFilter.trim()
            ? `MR follow-up (${groupFilter.trim()})`
            : "GitLab MR follow-up"
      : gitlabProject.trim()
        ? `GitLab CI failures (${gitlabProject.trim()})`
        : "GitLab CI failures";

  const canCreate =
    !create.busy &&
    (isCodeReview
      ? Boolean(repoProject) &&
        repoProject !== ALL_PROJECTS &&
        ((scope === "choose" && Boolean(selectedMr)) ||
          (scope === "branch" && Boolean(selectedBranch)) ||
          (scope === "issue" && Boolean(selectedIssue)))
      : isReviewRequested || isMrFollowUp
        ? true
        : gitlabProject.trim().length > 0 && jiraProject.trim().length > 0);

  const handleCreate = () =>
    create.run(async () => {
      const detail = isCodeReview
        ? await api.createInstance({
            definitionId,
            name,
            visibility: visible ? "public" : "private",
            params: {
              gitlab: {
                projectId: repoProject,
                ...(scope === "choose"
                  ? {
                      mrIid: selectedMr?.iid,
                      ...(mrJiraKey ? { jiraIssueKey: mrJiraKey } : {}),
                    }
                  : {}),
                ...(scope === "branch" ? { branch: selectedBranch } : {}),
                ...(scope === "issue" ? { jiraIssueKey: selectedIssue?.key } : {}),
              },
            },
            schedule: { enabled: false, trigger: { type: "manual" } },
          })
        : isReviewRequested || isMrFollowUp
          ? await api.createInstance({
              definitionId,
              name,
              visibility: visible ? "public" : "private",
              params: reviewRequestedParams(repoProject, groupFilter),
              schedule: {
                enabled: triggerType === "cron",
                trigger:
                  triggerType === "cron"
                    ? { type: "cron", expression: cron }
                    : { type: "manual" },
              },
            })
          : await api.createInstance({
              definitionId,
              name,
              visibility: visible ? "public" : "private",
              params: {
                gitlab: { projectId: gitlabProject.trim() },
                jira: { project: jiraProject.trim() },
              },
              schedule: {
                enabled: triggerType === "cron",
                trigger:
                  triggerType === "cron"
                    ? { type: "cron", expression: cron }
                    : { type: "manual" },
              },
            });
      // The run endpoint returns as soon as the row is open; the detail pane
      // polls for the rest. For review-requested this is the seed run.
      await api.runTask(detail.id);
      onCreated(detail.id);
    });

  // Grouped by scope so the dropdown reads as "Default" plus a "Services"
  // category, rather than one flat list of forty-odd project paths. The
  // default repo is always offered, even before (or if) the group listing
  // loads, and is not duplicated if the group happens to contain it.
  const repoCategories: { label: string; paths: string[] }[] = [
    { label: "Default", paths: [DEFAULT_REPO] },
    {
      label: "Services",
      paths: repoOptions.map((p) => p.pathWithNamespace).filter((p) => p !== DEFAULT_REPO),
    },
  ];

  const subtitle = isCodeReview
    ? "MRs · Branch · Issue"
    : isReviewRequested
      ? "Creates one review task per assigned non-draft MR."
      : isMrFollowUp
        ? "Fixes or answers new feedback on your authored MRs."
      : "Files one Jira ticket per failing spec file.";

  return (
    <div>
      <div>
        <h1 className={PAGE_TITLE_CLASS}>{name}</h1>
        <div className="mb-3.5 text-[0.9375rem] text-[var(--text-dim)]">{subtitle}</div>
      </div>

      <motion.section
        className={PANEL_SECTION_CLASS}
        layout
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        {definitions.length > 1 ? (
          <Field label="Automation">
            <Select value={definitionId} onValueChange={setDefinitionId}>
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

        {isCodeReview ? (
          <>
            <Field label="Repository">
              <Select value={repoProject} onValueChange={setRepoProject}>
                <SelectTrigger>
                  <SelectValue />
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

            <div className="flex w-full flex-[1_1_100%] items-start gap-3.5">
              <div className={cn(FIELD_CLASS, "shrink-0")}>
                Scope
                <div className="relative flex overflow-hidden rounded-[var(--radius)] border border-border">
                  <motion.div
                    className="absolute inset-y-0 left-0 z-0 bg-[var(--bg-hover)]"
                    layout
                    layoutId="scope-pill"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                    style={{
                      width: "33.333%",
                      left: scope === "choose" ? "0%" : scope === "branch" ? "33.333%" : "66.666%",
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(
                      "relative z-1 h-auto flex-1 rounded-none border-0 bg-transparent px-2 py-1.5 text-sm text-muted-foreground hover:bg-transparent",
                      scope === "choose" && "font-medium text-foreground",
                    )}
                    onClick={() => setScope("choose")}
                  >
                    MRs
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(
                      "relative z-1 h-auto flex-1 rounded-none border-0 border-l border-border bg-transparent px-2 py-1.5 text-sm text-muted-foreground hover:bg-transparent",
                      scope === "branch" && "font-medium text-foreground",
                    )}
                    onClick={() => setScope("branch")}
                  >
                    Branch
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(
                      "relative z-1 h-auto flex-1 rounded-none border-0 border-l border-border bg-transparent px-2 py-1.5 text-sm text-muted-foreground hover:bg-transparent",
                      scope === "issue" && "font-medium text-foreground",
                    )}
                    onClick={() => setScope("issue")}
                  >
                    Issue
                  </Button>
                </div>
              </div>

            <AnimatePresence mode="wait" initial={false}>
              {scope === "choose" ? (
                <motion.div
                  key="choose"
                  className={PANEL_FIELD_CLASS}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.13 }}
                >
                  Merge request
                  {selectedMr ? (
                    <div className="flex flex-wrap gap-1">
                      <motion.span
                        className={TAG_CLASS}
                        initial={{ opacity: 0, scale: 0.92 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.12 }}
                      >
                        !{selectedMr.iid} {selectedMr.title}
                        <button
                          type="button"
                          aria-label={`Remove !${selectedMr.iid}`}
                          onClick={() => setSelectedMr(undefined)}
                        >
                          ×
                        </button>
                      </motion.span>
                    </div>
                  ) : (
                    <AutocompleteResults
                      open={mrListOpen}
                      onOpenChange={setMrListOpen}
                      search={mrSearch}
                      onSearchChange={setMrSearch}
                      placeholder="Search open merge requests…"
                      results={mrResults}
                      loading={mrs.loading}
                      error={mrs.error}
                      loadingLabel="Loading merge requests…"
                      emptyLabel="No open merge requests found"
                      getKey={(mr) => String(mr.iid)}
                      getValue={(mr) => `${mr.iid} ${mr.title}`}
                      renderResult={(mr) => `!${mr.iid} ${mr.title}`}
                      onSelect={(mr) => {
                        setSelectedMr(mr);
                        setMrSearch("");
                        setMrListOpen(false);
                      }}
                    />
                  )}
                </motion.div>
              ) : null}

              {scope === "branch" ? (
                <motion.div
                  key="branch"
                  className={PANEL_FIELD_CLASS}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.13 }}
                >
                  Branch
                  {selectedBranch ? (
                    <div className="flex flex-wrap gap-1">
                      <motion.span
                        className={TAG_CLASS}
                        initial={{ opacity: 0, scale: 0.92 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.12 }}
                      >
                        {selectedBranch}
                        <button
                          type="button"
                          aria-label={`Remove ${selectedBranch}`}
                          onClick={() => setSelectedBranch(undefined)}
                        >
                          ×
                        </button>
                      </motion.span>
                    </div>
                  ) : (
                    <AutocompleteResults
                      open={branchListOpen}
                      onOpenChange={setBranchListOpen}
                      search={branchSearch}
                      onSearchChange={setBranchSearch}
                      placeholder="Search branches…"
                      results={branchResults}
                      loading={branches.loading}
                      error={branches.error}
                      loadingLabel="Loading branches…"
                      emptyLabel="No branches found"
                      getKey={(branch) => branch.name}
                      getValue={(branch) => branch.name}
                      renderResult={(branch) => branch.name}
                      onSelect={(branch) => {
                        setSelectedBranch(branch.name);
                        setBranchSearch("");
                        setBranchListOpen(false);
                      }}
                    />
                  )}
                </motion.div>
              ) : null}

              {scope === "issue" ? (
                <motion.div
                  key="issue"
                  className={PANEL_FIELD_CLASS}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.13 }}
                >
                  Jira issue
                  {selectedIssue ? (
                    <div className="flex flex-wrap gap-1">
                      <motion.span
                        className={TAG_CLASS}
                        initial={{ opacity: 0, scale: 0.92 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.12 }}
                      >
                        {selectedIssue.key}
                        {selectedIssue.summary ? ` ${selectedIssue.summary}` : ""}
                        <button
                          type="button"
                          aria-label={`Remove ${selectedIssue.key}`}
                          onClick={() => setSelectedIssue(undefined)}
                        >
                          ×
                        </button>
                      </motion.span>
                    </div>
                  ) : (
                    <AutocompleteResults
                      open={issueListOpen}
                      onOpenChange={setIssueListOpen}
                      search={issueSearch}
                      onSearchChange={setIssueSearch}
                      placeholder="Search Jira issues, e.g. TP-3012…"
                      results={issueResults}
                      loading={issues.loading}
                      error={issues.error}
                      loadingLabel="Loading Jira issues…"
                      emptyLabel="No Jira issues found"
                      getKey={(issue) => issue.key}
                      getValue={(issue) => `${issue.key} ${issue.summary}`}
                      renderResult={(issue) => `${issue.key} ${issue.summary}`}
                      onSelect={(issue) => {
                        setSelectedIssue(issue);
                        setIssueSearch("");
                        setIssueListOpen(false);
                      }}
                    />
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>
            </div>

          </>
        ) : isReviewRequested || isMrFollowUp ? (
          <>
            <Field label="Repository">
              <Select value={repoProject} onValueChange={setRepoProject}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
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

            <Field label="Group prefix">
              <Input
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                placeholder="optional, e.g. example-org"
              />
            </Field>

            <Field label="Schedule">
              <Select
                value={triggerType}
                onValueChange={(value) => setTriggerType(value as Trigger["type"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="cron">Cron</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <AnimatePresence>
              {triggerType === "cron" ? (
                <motion.label
                  className={PANEL_FIELD_CLASS}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.13 }}
                >
                  Cron expression
                  <Input value={cron} onChange={(e) => setCron(e.target.value)} className="mono" />
                </motion.label>
              ) : null}
            </AnimatePresence>
          </>
        ) : (
          <>
            <Field label="GitLab project">
              <Input
                value={gitlabProject}
                onChange={(e) => setGitlabProject(e.target.value)}
                placeholder="group/project or numeric id"
              />
            </Field>

            <Field label="Jira project key">
              <Input
                value={jiraProject}
                onChange={(e) => setJiraProject(e.target.value)}
                placeholder="e.g. SP"
              />
            </Field>

            <Field label="Schedule">
              <Select
                value={triggerType}
                onValueChange={(value) => setTriggerType(value as Trigger["type"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="cron">Cron</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <AnimatePresence>
              {triggerType === "cron" ? (
                <motion.label
                  className={PANEL_FIELD_CLASS}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.13 }}
                >
                  Cron expression
                  <Input value={cron} onChange={(e) => setCron(e.target.value)} className="mono" />
                </motion.label>
              ) : null}
            </AnimatePresence>
          </>
        )}

        <Field className="w-full flex-[1_1_100%] flex-row items-center gap-2" label="Team visible">
          <Checkbox checked={visible} onCheckedChange={(checked) => setVisible(checked === true)} />
        </Field>

        {create.error ? <ErrorBox>{create.error}</ErrorBox> : null}

        <FormActions className="m-0 w-full flex-[1_1_100%]">
          <Button type="button" disabled={!canCreate} onClick={handleCreate}>
            {create.busy ? "Creating…" : "Create"}
          </Button>
          <Button type="button" variant="outline" disabled={create.busy} onClick={onCancel}>
            Cancel
          </Button>
        </FormActions>
      </motion.section>
    </div>
  );
}

function reviewRequestedParams(
  repoProject: string,
  groupFilter: string,
): { gitlab?: { projectId?: string; group?: string } } {
  const gitlab: { projectId?: string; group?: string } = {};
  if (repoProject && repoProject !== ALL_PROJECTS) gitlab.projectId = repoProject;
  const group = groupFilter.trim();
  if (group) gitlab.group = group;
  return Object.keys(gitlab).length > 0 ? { gitlab } : {};
}
