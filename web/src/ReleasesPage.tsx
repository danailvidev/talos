import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence } from "motion/react";
import {
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  Copy,
  ExternalLink,
  GitBranch,
  History as HistoryIcon,
  ListFilter,
  RefreshCw,
  Rocket,
  RotateCcw,
  Search,
  Settings,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  api,
  type DeployWatchStateView,
  type DeploymentTargetStatusView,
  type DeploymentVerificationStateView,
  type DeployWatchView,
  type EnvironmentVersionView,
  type ManifestSection,
  type ReleaseHistoryEntryView,
  type ReleasesView,
  type ReleaseUploadResultView,
} from "./api.ts";
import { useFormat, type Formatters } from "./FormatContext.tsx";
import { ago } from "./format.ts";
import {
  buildReleaseDescription,
  buildReleaseTitle,
  type FormatChange,
} from "../../shared/release-format.ts";
import { Field, FormActions } from "./components/ui/field.tsx";
import { Button } from "./components/ui/button.tsx";
import { ButtonGroup } from "./components/ui/button-group.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./components/ui/card.tsx";
import { Modal } from "./components/ui/modal.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import {
  invalidate,
  queries,
  refresh as forgeRefresh,
  refreshReleasesAwait,
} from "./queries.ts";
import { keys } from "./query-keys.ts";
import {
  ProviderAccessButton,
  ProviderAccessNotice,
  useProviderAccessDialog,
} from "./ProviderAccessNotice.tsx";
import { useApi } from "./useApi.ts";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { cn } from "./lib/utils.ts";
import {
  differingServiceKeys,
  lowerServiceVersionKeys,
  sameDayDeploymentWarnings,
  serviceVersionKey as keyOf,
  type SameDayDeploymentWarning,
} from "./release-comparison.ts";
import {
  CONFIRM_DIALOG_CLASS,
  CONFIRM_STEP_CLASS,
  CONFIRM_STEP_DETAIL_CLASS,
  CONFIRM_STEP_NUMBER_CLASS,
  CONFIRM_STEP_TITLE_CLASS,
  CONFIRM_STEPS_CLASS,
  CONFIRM_TARGET_CLASS,
} from "./confirmation-dialog-styles.ts";
import { OBSERVABILITY_LINK_CLASS } from "./observability-styles.ts";
import { PAGE_META_CLASS, PAGE_TITLE_CLASS } from "./typography-styles.ts";
import type { ToastOptions } from "./Toast.tsx";
import {
  applyConfluenceRelease,
  isProdEnvironment,
} from "./confluence-release.ts";
import { startOfCalendarDay } from "./zoned-time.ts";

type ReleasesTab = "environments" | "history" | "watch";

/**
 * How many commits of the manifest repo the history tab reads, and the wider
 * windows it offers. A number of commits rather than of days: a repo that
 * releases once a week and one that releases thirty times a day both want "the
 * last few dozen deployments", and the cost of the read is per commit.
 */
const HISTORY_WINDOWS = [50, 150, 400] as const;
const HISTORY_STORAGE_KEY = "talos.releases.historyLimit";
const CONFLUENCE_RELEASE_PAGE_SIZE = 5;
const SHOW_MORE_RELEASES_VALUE = "__show-more-releases__";
const TOGGLE_CONFLUENCE_RELEASES_VALUE = "__toggle-confluence-releases__";
const CONFLUENCE_RELEASE_VALUE_PREFIX = "confluence-release:";
const ENVIRONMENT_VALUE_PREFIX = "environment:";

const PAGE_CLASS =
  "flex min-h-0 w-full flex-col gap-5 overflow-y-auto px-4 pt-5 pb-8 min-[901px]:px-[34px] min-[901px]:pt-8 min-[901px]:pb-12";
const TOOLBAR_CLASS = "mb-5 flex flex-wrap items-center gap-2";
const SEARCH_CLASS = "relative max-w-80 flex-1";
const SEARCH_INPUT_CLASS =
  "w-full bg-[var(--bg-raised)] py-1.5 pr-7.5 pl-7.5 text-[0.9375rem] placeholder:text-[var(--text-faint)]";
const SEARCH_CLEAR_CLASS =
  "absolute top-[5px] right-1.5 inline-flex size-5.5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-foreground";
const RELEASE_ROW_CLASS =
  "flex flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-2.5";
const RELEASE_ROW_HEAD_CLASS = "flex flex-wrap items-baseline gap-2.5";
const RELEASE_SECTION_CLASS = "mt-3.5 first:mt-0";
const RELEASE_SECTION_TITLE_CLASS =
  "mb-1 text-[0.7812rem] font-semibold tracking-[0.05em] text-muted-foreground uppercase";

const DEPLOYMENT_LABEL: Record<DeploymentVerificationStateView, string> = {
  released: "K8s released",
  pending: "K8s pending",
  progressing: "K8s deploying",
  degraded: "K8s degraded",
  missing: "K8s missing",
  unavailable: "K8s unavailable",
};

const DEPLOYMENT_BADGE_CLASS: Record<DeploymentVerificationStateView, string> = {
  released:
    "border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]",
  pending:
    "border-[color-mix(in_srgb,var(--warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] text-[var(--warn)]",
  progressing:
    "border-[color-mix(in_srgb,var(--warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] text-[var(--warn)]",
  degraded: "border-destructive/40 bg-destructive/10 text-destructive",
  missing: "border-destructive/40 bg-destructive/10 text-destructive",
  unavailable:
    "border-[color-mix(in_srgb,var(--warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] text-[var(--warn)]",
};

const DEPLOYMENT_DOT_CLASS: Record<DeploymentVerificationStateView, string> = {
  released: "bg-[var(--success)]",
  pending: "bg-[var(--warn)]",
  progressing: "bg-[var(--warn)]",
  degraded: "bg-destructive",
  missing: "bg-destructive",
  unavailable: "bg-[var(--warn)]",
};

/**
 * The Releases page: the current version of every service in every environment,
 * read from the manifest in the configured repo, plus an "upload" action that
 * edits one environment's versions and opens a merge request — replacing the
 * IDE → edit → commit → push loop.
 */
/** The manifest's two lists, in display order, with human labels. */
const SECTIONS: { section: ManifestSection; label: string }[] = [
  { section: "applications", label: "Applications" },
  { section: "services", label: "Services" },
];

const ENVIRONMENTS_STORAGE_KEY = "talos.releases.environments";

/**
 * A single string or boolean preference, persisted per-browser in localStorage
 * under `key` — this is how one person likes to view the list, not shared team
 * configuration.
 */
function usePersisted<T extends string | boolean>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      return (typeof initial === "boolean" ? raw === "true" : raw) as T;
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // A browser with storage disabled still works, it just won't remember.
      }
    },
    [key],
  );

  return [value, set] as const;
}

function usePersistedStringList(key: string) {
  const [value, setValue] = useState<string[]>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  });

  const set = useCallback(
    (next: string[]) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // A browser with storage disabled still keeps the filter for this session.
      }
    },
    [key],
  );

  return [value, set] as const;
}

/** The manifest lives in a repository, so every read on this page is a forge read. */
const RELEASE_PROVIDERS = ["gitlab"] as const;

export function ReleasesPage({
  initialTab = "environments",
  onToast,
  onOpenSettings,
}: {
  initialTab?: ReleasesTab;
  onToast: (text: string, options?: ToastOptions) => void;
  onOpenSettings?: () => void;
}) {
  const queryClient = useQueryClient();
  const providerAccess = useProviderAccessDialog();
  const [uploadEnv, setUploadEnv] = useState<string>();
  const [revertEnv, setRevertEnv] = useState<string>();
  const [tab, setTab] = useState<ReleasesTab>(initialTab);
  const [selectedEnvironments, setSelectedEnvironments] = usePersistedStringList(
    ENVIRONMENTS_STORAGE_KEY,
  );
  const [comparisonMode, setComparisonMode] = useState(false);
  // Kept here rather than inside the history section so the page's refresh button
  // can bypass the cache for the window that is actually on screen.
  const [historyLimitRaw, setHistoryLimitRaw] = usePersisted<string>(
    HISTORY_STORAGE_KEY,
    String(HISTORY_WINDOWS[0]),
  );
  const historyLimit = HISTORY_WINDOWS.find((w) => String(w) === historyLimitRaw)
    ?? HISTORY_WINDOWS[0];
  // A `listTree` plus one `getFileRaw` per environment, so never polled — but
  // cached for two minutes, because the manifest only changes when an MR merges.
  const releases = useApi(queries.releases());
  const deploymentStatus = useApi(
    queries.releaseDeploymentStatus(
      releases.data?.environments ?? [],
      tab === "environments" && releases.data?.configured === true,
    ),
  );
  const previousWaitingForMerge = useRef<Set<string> | undefined>(undefined);
  const [refreshingAfterMerge, setRefreshingAfterMerge] = useState<Set<string>>(
    () => new Set(),
  );
  const [deploymentNotificationsPending, setDeploymentNotificationsPending] =
    useState<Set<string>>(() => new Set());

  // The cheap status poll learns that the backend's MR watcher has finished
  // before the forge-backed manifest query does. Refresh that manifest first;
  // only its new versions are valid Kubernetes targets for the merged release.
  useLayoutEffect(() => {
    const environments = deploymentStatus.data?.environments;
    if (!environments) return;

    const next = new Set(
      environments
        .filter((environment) => environment.waitingForMerge)
        .map((environment) => environment.name),
    );
    const previous = previousWaitingForMerge.current;
    const merged = previous
      ? [...previous].filter((environment) => !next.has(environment))
      : [];
    previousWaitingForMerge.current = next;
    if (merged.length === 0) return;

    setRefreshingAfterMerge((current) => new Set([...current, ...merged]));
    setDeploymentNotificationsPending(
      (current) => new Set([...current, ...merged]),
    );
    void refreshReleasesAwait(queryClient).finally(() => {
      setRefreshingAfterMerge((current) => {
        const remaining = new Set(current);
        for (const environment of merged) remaining.delete(environment);
        return remaining;
      });
    });
  }, [deploymentStatus.data, queryClient]);

  useEffect(() => {
    const environments = deploymentStatus.data?.environments;
    if (!environments) return;

    // Only announce environments whose release watcher was observed waiting
    // and then finishing. A generic Kubernetes recovery in another environment
    // is useful status, but it must not masquerade as the release just uploaded.
    const newlyReleased = environments
      .filter(
        (environment) =>
          deploymentNotificationsPending.has(environment.name) &&
          !refreshingAfterMerge.has(environment.name) &&
          aggregateDeploymentState(environment.services) === "released",
      )
      .map((environment) => environment.name);
    if (newlyReleased.length === 1) {
      onToast(`${newlyReleased[0]} now fully matches Kubernetes.`, {
        severity: "success",
      });
    } else if (newlyReleased.length > 1) {
      onToast(
        `${newlyReleased.join(", ")} now fully match Kubernetes.`,
        { severity: "success" },
      );
    }
    if (newlyReleased.length > 0) {
      setDeploymentNotificationsPending((current) => {
        const remaining = new Set(current);
        for (const environment of newlyReleased) remaining.delete(environment);
        return remaining;
      });
    }
  }, [
    deploymentNotificationsPending,
    deploymentStatus.data,
    onToast,
    refreshingAfterMerge,
  ]);
  /**
   * The manifest and the watch list together: an upload opens a merge request
   * against the manifest *and*, for a production environment, starts a watch.
   * Not the release config — that is not something reading this page can change.
   */
  const refresh = () => {
    // Bypassing rather than invalidating: both callers — the button and a finished
    // upload — are asking about the repo, not about this cache, and the server
    // holds its own copy for two minutes. An invalidation would refetch and be
    // answered from that copy, so the manifest you just changed would still read
    // as it was before you changed it.
    forgeRefresh.releases(queryClient);
    // Only the window on screen: the history read costs one forge call per commit
    // in it, so refreshing every window a browser has ever opened would multiply
    // that by the sizes nobody is looking at.
    if (tab === "history") forgeRefresh.releaseHistory(queryClient, historyLimit);
    void queryClient.invalidateQueries({ queryKey: keys.releaseWatches() });
    void queryClient.invalidateQueries({
      queryKey: ["releases", "deployment-status"],
    });
    // And the merge request lists, because that is what an upload produces: the
    // one it just opened against the manifest is now somebody's to review.
    void queryClient.invalidateQueries({ queryKey: keys.allPrs() });
    invalidate.graph(queryClient);
  };

  const data = releases.data;

  if (releases.loading && !data) {
    return <Loading>Loading releases…</Loading>;
  }
  if (releases.error) {
    return <ErrorBox>{releases.error}</ErrorBox>;
  }
  if (!data) return null;

  if (!data.configured) {
    const needsGitLabAccess = data.setupRequired === "gitlab-access";
    return (
      <div className={PAGE_CLASS}>
        <ReleasesHeader
          data={data}
          fetching={releases.fetching}
          onRefresh={refresh}
        />
        <div className="mt-1.5 max-w-160 text-sm text-[var(--text-faint)]">
          {data.error ?? "Releases are not configured yet."}
          {needsGitLabAccess
            ? null
            : onOpenSettings
              ? " Set the repository, manifest path and target branch in Settings to get started."
              : " Ask an administrator to configure the repository, manifest path and target branch."}
        </div>
        <div className="flex gap-2">
          {needsGitLabAccess ? (
            <ProviderAccessButton onOpen={providerAccess.open}>
              Set up my GitLab access
            </ProviderAccessButton>
          ) : onOpenSettings ? (
            <Button type="button" variant="outline" onClick={onOpenSettings}>
              <Settings size={14} strokeWidth={2} /> Open Releases settings
            </Button>
          ) : null}
        </div>
        {providerAccess.dialog}
      </div>
    );
  }

  const editing = uploadEnv
    ? data.environments.find((env) => env.name === uploadEnv)
    : undefined;
  const reverting = revertEnv
    ? data.environments.find((env) => env.name === revertEnv)
    : undefined;

  // Ignore environments removed from the manifest so an old saved filter cannot
  // leave the page empty with no visible chip explaining why.
  const availableEnvironmentNames = new Set(data.environments.map((environment) => environment.name));
  const activeSelectedEnvironments = selectedEnvironments.filter((name) =>
    availableEnvironmentNames.has(name),
  );
  const selectedEnvironmentSet = new Set(activeSelectedEnvironments);
  const visibleEnvironments = data.environments.filter(
    (environment) =>
      selectedEnvironmentSet.size === 0 || selectedEnvironmentSet.has(environment.name),
  );
  const filtering = selectedEnvironmentSet.size > 0;
  const canCompare = visibleEnvironments.length === 2;
  const comparing = comparisonMode && canCompare;
  const comparedEnvironments =
    comparing
      ? ([visibleEnvironments[0]!, visibleEnvironments[1]!] as const)
      : null;
  const comparisonKeys = comparedEnvironments
    ? differingServiceKeys(comparedEnvironments[0], comparedEnvironments[1])
    : null;
  const lowerComparisonKeys = comparedEnvironments
    ? lowerServiceVersionKeys(comparedEnvironments[0], comparedEnvironments[1])
    : null;
  const comparisonRowsBySection = comparedEnvironments
    ? Object.fromEntries(
        SECTIONS.map(({ section }) => [
          section,
          [
            ...new Set(
              comparedEnvironments.flatMap((environment) =>
                environment.services
                  .filter((service) => service.section === section)
                  .map((service) => service.name),
              ),
            ),
          ].sort((left, right) => left.localeCompare(right)),
        ]),
      ) as Record<ManifestSection, string[]>
    : null;
  const deploymentByEnvironment = new Map(
    deploymentStatus.data?.environments.map((environment) => [
      environment.name,
      environment.services,
    ]) ?? [],
  );

  return (
    <div className={PAGE_CLASS}>
      <ReleasesHeader
        data={data}
        fetching={releases.fetching}
        onRefresh={refresh}
      />

      {/* Above the tabs, because it is about the whole page: the manifest is read
          from GitLab and an upload opens a merge request against it, both as the
          person clicking. Without their token there is nothing here to do. */}
      <ProviderAccessNotice providers={RELEASE_PROVIDERS} purpose="Reading and updating releases" />

      <Tabs value={tab} onValueChange={(value) => setTab(value as ReleasesTab)}>
        <TabsList variant="line">
          <TabsTrigger value="environments">
            Environments
          </TabsTrigger>
          <TabsTrigger value="history">
            History
          </TabsTrigger>
          <TabsTrigger value="watch">
            Post-deploy watch
          </TabsTrigger>
        </TabsList>

        <TabsContent value="watch" className="tab-panel flex-none text-inherit">
          <DeployWatchesSection />
        </TabsContent>
        <TabsContent value="history" className="tab-panel flex-none text-inherit">
          <ReleaseHistorySection
            limit={historyLimit}
            onLimitChange={(next) => setHistoryLimitRaw(String(next))}
          />
        </TabsContent>
        <TabsContent value="environments" className="tab-panel flex-none text-inherit">
          <>
            {data.error ? <ErrorBox>{data.error}</ErrorBox> : null}

            {data.environments.length === 0 ? (
              <div className="mt-1.5 text-sm text-[var(--text-faint)]">
                The manifest has no environments to show.
              </div>
            ) : (
              <>
                <div className={TOOLBAR_CLASS}>
                  <EnvironmentFilter
                    environments={data.environments.map((environment) => environment.name)}
                    selected={activeSelectedEnvironments}
                    onChange={(next) => {
                      setSelectedEnvironments(next);
                      setComparisonMode(false);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className={cn(
                      "h-8 gap-1.5 text-[0.9062rem]",
                      comparing && "border-primary/40 bg-primary/10 text-primary",
                    )}
                    disabled={!canCompare}
                    aria-pressed={comparing}
                    title={
                      canCompare
                        ? comparing
                          ? "Stop comparing environments"
                          : "Compare the two visible environments"
                        : "Select exactly two environments to compare"
                    }
                    onClick={() => setComparisonMode((enabled) => !enabled)}
                  >
                    <ArrowLeftRight size={14} strokeWidth={2} />
                    Compare
                  </Button>
                </div>

                {comparedEnvironments && comparisonKeys ? (
                  <div className="-mt-3 mb-5 text-sm text-[var(--text-faint)]">
                    Comparing <span className="mono font-medium">{comparedEnvironments[0].name}</span>{" "}
                    and <span className="mono font-medium">{comparedEnvironments[1].name}</span>
                    {" — "}
                    {comparisonKeys.size === 0
                      ? "all service versions match."
                      : `${comparisonKeys.size} service difference${comparisonKeys.size === 1 ? "" : "s"} highlighted.`}
                  </div>
                ) : null}

                {visibleEnvironments.length === 0 ? (
                  <div className="mt-1.5 text-sm text-[var(--text-faint)]">
                    No environments match{filtering ? " your filters" : ""}.
                  </div>
                ) : (
                <div
                  className={cn(
                    "grid gap-4",
                    visibleEnvironments.length <= 2
                      ? "grid-cols-[repeat(auto-fit,minmax(min(360px,100%),640px))]"
                      : "grid-cols-[repeat(auto-fit,minmax(min(360px,100%),1fr))]",
                  )}
                >
                {visibleEnvironments.map((env, environmentIndex) => {
                  const refreshingMergedManifest = refreshingAfterMerge.has(env.name);
                  const runtimeServices = refreshingMergedManifest
                    ? undefined
                    : deploymentByEnvironment.get(env.name);
                  const isRightComparison = comparing && environmentIndex === 1;
                  return (
                  <Card key={env.name} className="gap-0 overflow-visible py-0">
                    <CardHeader className="sticky -top-8 z-10 flex flex-row items-center justify-between border-b border-border bg-card py-2 shadow-sm">
                      <div className="flex items-center gap-2">
                        <CardTitle className="mono text-[1.2em] font-bold tracking-[-0.01em] text-primary">
                          {env.name}
                        </CardTitle>
                        {comparing ? null : (
                          <EnvironmentDeploymentBadge
                            services={runtimeServices}
                            checking={
                              refreshingMergedManifest ||
                              (deploymentStatus.loading && !deploymentStatus.data)
                            }
                            unavailable={Boolean(deploymentStatus.error)}
                          />
                        )}
                      </div>
                      <EnvironmentActions
                        environment={env.name}
                        onDeploy={() => setUploadEnv(env.name)}
                        onRevert={() => setRevertEnv(env.name)}
                      />
                    </CardHeader>
                    <CardContent className="py-4">
                      {env.services.length === 0 && !comparisonRowsBySection ? (
                        <div className="mt-1.5 text-sm text-[var(--text-faint)]">No services.</div>
                      ) : (
                        SECTIONS.map(({ section, label }) => {
                          const rows = env.services.filter((s) => s.section === section);
                          const rowsByName = new Map(rows.map((service) => [service.name, service]));
                          const rowNames =
                            comparisonRowsBySection?.[section] ?? rows.map((service) => service.name);
                          if (rowNames.length === 0) return null;
                          return (
                            <div key={section} className={RELEASE_SECTION_CLASS}>
                              <h3 className={RELEASE_SECTION_TITLE_CLASS}>{label}</h3>
                              <table
                                className={cn(
                                  "w-full border-collapse",
                                  comparisonRowsBySection && "table-fixed",
                                )}
                              >
                                {comparisonRowsBySection ? (
                                  <colgroup>
                                    <col className={isRightComparison ? "w-[32%]" : "w-[68%]"} />
                                    <col className={isRightComparison ? "w-[68%]" : "w-[32%]"} />
                                  </colgroup>
                                ) : null}
                                <tbody>
                                  {rowNames.map((serviceName) => {
                                    const svc = rowsByName.get(serviceName);
                                    const comparisonKey = keyOf({ name: serviceName, section });
                                    const runtime = svc
                                      ? runtimeServices?.find(
                                          (status) => status.service === svc.name,
                                        )
                                      : undefined;
                                    const lowerVersion =
                                      svc &&
                                      lowerComparisonKeys?.[environmentIndex].has(
                                        comparisonKey,
                                      );
                                    const otherEnvironment = comparedEnvironments?.[
                                      environmentIndex === 0 ? 1 : 0
                                    ];
                                    const otherVersion = otherEnvironment?.services.find(
                                      (service) => keyOf(service) === comparisonKey,
                                    )?.version;
                                    const lowerVersionIndicator = lowerVersion ? (
                                      <span
                                        className={cn(
                                          "inline-flex align-[-2px] text-destructive",
                                          isRightComparison ? "ml-1" : "mr-1",
                                        )}
                                        aria-label={`Lower version than ${otherVersion} in ${otherEnvironment?.name}`}
                                        title={`Lower than ${otherVersion} in ${otherEnvironment?.name}`}
                                      >
                                        <ChevronDown
                                          size={13}
                                          strokeWidth={2.5}
                                          aria-hidden="true"
                                        />
                                      </span>
                                    ) : null;
                                    const serviceCell = (
                                      <td
                                        className={cn(
                                          "border-b border-border py-[5px] align-middle text-[0.9375rem] font-medium text-foreground",
                                          comparisonRowsBySection &&
                                            "h-8 overflow-hidden py-0 text-ellipsis whitespace-nowrap",
                                          comparisonRowsBySection &&
                                            (isRightComparison ? "text-left" : "text-right"),
                                        )}
                                        title={
                                          svc?.image
                                            ? `${serviceName} (${svc.image})`
                                            : serviceName
                                        }
                                      >
                                        {serviceName}
                                        {svc?.image ? (
                                          <span className="mono text-[0.7812rem] font-normal text-muted-foreground">
                                            {" "}
                                            ({svc.image})
                                          </span>
                                        ) : null}
                                      </td>
                                    );
                                    const versionCell = (
                                      <td
                                        className={cn(
                                          "mono border-b border-border py-[5px] text-right align-middle text-[0.9375rem] text-muted-foreground",
                                          comparisonRowsBySection &&
                                            "h-8 overflow-hidden py-0 text-ellipsis whitespace-nowrap",
                                          isRightComparison && "text-left",
                                        )}
                                        title={svc?.version ?? "Not present"}
                                      >
                                        {svc ? (
                                          <>
                                            {isRightComparison
                                              ? null
                                              : lowerVersionIndicator}
                                            <span>{svc.version}</span>
                                            {isRightComparison
                                              ? lowerVersionIndicator
                                              : null}
                                            {runtime && !comparing ? (
                                              <span
                                                className={cn(
                                                  "ml-1.5 inline-block size-1.5 rounded-full",
                                                  DEPLOYMENT_DOT_CLASS[runtime.state],
                                                )}
                                                title={deploymentStatusTitle(runtime)}
                                              />
                                            ) : null}
                                          </>
                                        ) : (
                                          <span className="font-sans text-xs italic">
                                            Not present
                                          </span>
                                        )}
                                      </td>
                                    );
                                    return (
                                      <tr
                                        className={cn(
                                          "last:[&_td]:border-b-0",
                                          comparisonRowsBySection && "h-8",
                                          comparisonKeys?.has(comparisonKey) && "bg-primary/12",
                                        )}
                                        key={serviceName}
                                      >
                                        {isRightComparison ? (
                                          <>
                                            {versionCell}
                                            {serviceCell}
                                          </>
                                        ) : (
                                          <>
                                            {serviceCell}
                                            {versionCell}
                                          </>
                                        )}
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          );
                        })
                      )}
                    </CardContent>
                  </Card>
                  );
                })}
                </div>
                )}
              </>
            )}
          </>
        </TabsContent>
      </Tabs>

      <AnimatePresence>
        {editing ? (
          <UploadDialog
            environment={editing}
            environments={data.environments}
            projectId={data.projectId ?? ""}
            targetBranch={data.targetBranch ?? ""}
            slackConfigured={data.slackConfigured}
            {...(data.slackChannel ? { slackChannel: data.slackChannel } : {})}
            onClose={() => setUploadEnv(undefined)}
            onUploaded={(result) => {
              setUploadEnv(undefined);
              refresh();
              // The Slack outcome is a suffix rather than another dimension of the
              // branch below: four merge outcomes times three notify outcomes would
              // be twelve sentences to maintain for one clause of information.
              const slack = result.notified
                ? " · Slack notified"
                : result.notifyError
                  ? " · Slack notification failed"
                  : "";
              onToast(
                (result.merged
                  ? `Merge request opened, approved and merged: ${result.mrUrl}`
                  : result.autoMergeEnabled
                    ? `Merge request opened and approved — it will merge automatically once its pipeline succeeds: ${result.mrUrl}`
                    : result.approved
                      ? `Merge request opened and approved (merge needs to be done manually): ${result.mrUrl}`
                      : `Merge request opened (approval and merge need to be done manually): ${result.mrUrl}`) +
                  slack,
              );
            }}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {reverting ? (
          <ReleaseRevertDialog
            environmentName={reverting.name}
            projectId={data.projectId ?? ""}
            targetBranch={data.targetBranch ?? ""}
            slackConfigured={data.slackConfigured}
            {...(data.slackChannel ? { slackChannel: data.slackChannel } : {})}
            onClose={() => setRevertEnv(undefined)}
            onReverted={(result) => {
              setRevertEnv(undefined);
              refresh();
              const slack = result.notified
                ? " · Slack notified"
                : result.notifyError
                  ? " · Slack notification failed"
                  : "";
              onToast(
                (result.merged
                  ? `Revert merge request opened, approved and merged: ${result.mrUrl}`
                  : result.autoMergeEnabled
                    ? `Revert merge request opened and approved — it will merge automatically once its pipeline succeeds: ${result.mrUrl}`
                    : result.approved
                      ? `Revert merge request opened and approved (merge needs to be done manually): ${result.mrUrl}`
                      : `Revert merge request opened (approval and merge need to be done manually): ${result.mrUrl}`) +
                  slack,
              );
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function EnvironmentFilter({
  environments,
  selected,
  onChange,
}: {
  environments: string[];
  selected: string[];
  onChange: (environments: string[]) => void;
}) {
  const selectedSet = new Set(selected);

  function toggle(environment: string) {
    onChange(
      selectedSet.has(environment)
        ? selected.filter((name) => name !== environment)
        : [...selected, environment],
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-8 gap-1.5 text-[0.9062rem] font-medium"
            aria-label="Filter environments"
          >
            <ListFilter size={14} strokeWidth={2} />
            {selected.length === 0
              ? "All environments"
              : `Environments (${selected.length})`}
            <ChevronDown className="text-muted-foreground" size={13} strokeWidth={2} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 gap-0 overflow-hidden p-0">
          <Command className="rounded-none p-0">
            <CommandInput placeholder="Find environments…" />
            <CommandList className="max-h-64 p-1">
              <CommandEmpty>No environments found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="All environments"
                  data-checked={selected.length === 0}
                  onSelect={() => onChange([])}
                >
                  All environments
                </CommandItem>
                {environments.map((environment) => (
                  <CommandItem
                    key={environment}
                    value={environment}
                    data-checked={selectedSet.has(environment)}
                    onSelect={() => toggle(environment)}
                  >
                    <span className="mono truncate">{environment}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selected.map((environment) => (
        <span
          key={environment}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-0.5 pr-1 pl-2.5 text-sm font-medium text-primary"
        >
          <span className="mono max-w-40 truncate">{environment}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded-full text-primary hover:bg-primary/15 hover:text-primary"
            aria-label={`Remove ${environment} filter`}
            onClick={() => toggle(environment)}
          >
            <X size={11} strokeWidth={2.5} />
          </Button>
        </span>
      ))}
    </div>
  );
}

/** The "no environment filter" value — Radix's Select cannot hold an empty string. */
const ALL_ENVIRONMENTS = "__all__";

function EnvironmentActions({
  environment,
  onDeploy,
  onRevert,
}: {
  environment: string;
  onDeploy: () => void;
  onRevert: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const openHistoryAfterMenuClose = useRef(false);

  return (
    <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
      <ButtonGroup>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setHistoryOpen(false);
            onDeploy();
          }}
        >
          <Rocket size={14} strokeWidth={2} />
          Deploy
        </Button>
        <DropdownMenu>
          <PopoverAnchor asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={`${environment} more release actions`}
                onClick={() => setHistoryOpen(false)}
              >
                <ChevronDown size={14} strokeWidth={2} />
              </Button>
            </DropdownMenuTrigger>
          </PopoverAnchor>
          <DropdownMenuContent
            align="end"
            className="min-w-44"
            onCloseAutoFocus={(event) => {
              if (!openHistoryAfterMenuClose.current) return;
              event.preventDefault();
              openHistoryAfterMenuClose.current = false;
              setHistoryOpen(true);
            }}
          >
            <DropdownMenuItem
              onSelect={() => {
                openHistoryAfterMenuClose.current = true;
              }}
            >
              <HistoryIcon size={14} strokeWidth={2} />
              History
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onRevert}>
              <RotateCcw size={14} strokeWidth={2} />
              Revert last deploy
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
      {historyOpen ? <EnvironmentHistoryPopover environment={environment} /> : null}
    </Popover>
  );
}

function EnvironmentHistoryPopover({ environment }: { environment: string }) {
  const history = useApi(
    queries.releaseHistory(HISTORY_WINDOWS[0], {
      environment,
    }),
  );

  return (
    <PopoverContent
      align="end"
      className="w-[min(28rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0"
    >
      <div className="border-b border-border px-3.5 py-3">
        <div className="flex items-center gap-2">
          <HistoryIcon size={15} strokeWidth={2} className="text-muted-foreground" />
          <h3 className="font-semibold">
            <span className="mono text-primary">{environment}</span> history
          </h3>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">Five most recent deployments</p>
      </div>

      <div className="max-h-[min(30rem,var(--radix-popover-content-available-height))] overflow-y-auto p-2">
        {history.loading ? (
          <Loading>Reading deployment history…</Loading>
        ) : history.error ? (
          <ErrorBox>{history.error}</ErrorBox>
        ) : history.data?.error ? (
          <ErrorBox>{history.data.error}</ErrorBox>
        ) : (history.data?.entries.length ?? 0) === 0 ? (
          <div className="px-1.5 py-4 text-center text-sm text-muted-foreground">
            No deployments found in the last {history.data?.commitsScanned ?? HISTORY_WINDOWS[0]}{" "}
            commits.
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {history.data?.entries.slice(0, 5).map((entry) => (
              <EnvironmentHistoryEntry key={entry.sha} entry={entry} />
            ))}
          </div>
        )}
      </div>

      {history.data && !history.data.error && history.data.entries.length > 0 ? (
        <div className="border-t border-border px-3.5 py-2 text-xs text-muted-foreground">
          From the last {history.data.commitsScanned} manifest commits
        </div>
      ) : null}
    </PopoverContent>
  );
}

function EnvironmentHistoryEntry({ entry }: { entry: ReleaseHistoryEntryView }) {
  const fmt = useFormat();

  return (
    <div className="flex flex-col gap-1.5 px-1.5 py-2.5 first:pt-1.5 last:pb-1.5">
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="truncate font-medium text-foreground" title={entry.authorEmail ?? undefined}>
          {entry.authorName}
        </span>
        <span
          className="shrink-0 text-muted-foreground"
          title={fmt.stamp(entry.committedAt)}
        >
          {ago(entry.committedAt)}
        </span>
        {entry.webUrl ? (
          <a
            className={cn(OBSERVABILITY_LINK_CLASS, "mono ml-auto shrink-0")}
            href={entry.webUrl}
            target="_blank"
            rel="noreferrer"
          >
            {entry.shortSha}
            <ExternalLink size={11} strokeWidth={2} />
          </a>
        ) : (
          <span className="mono ml-auto shrink-0 text-muted-foreground">{entry.shortSha}</span>
        )}
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[0.8125rem]">
        {entry.changes.map((change) => (
          <li
            className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-1.5 text-muted-foreground"
            key={`${change.section ?? ""}:${change.service}`}
          >
            <span className="truncate font-medium text-foreground" title={change.service}>
              {change.service}
            </span>
            <span className="mono max-w-28 truncate" title={change.from ?? undefined}>
              {change.from ?? "added"}
            </span>
            <ArrowRight size={11} strokeWidth={2} />
            <span
              className="mono max-w-28 truncate font-medium text-foreground"
              title={change.to}
            >
              {change.to}
            </span>
          </li>
        ))}
      </ul>
      <div className="truncate text-xs text-[var(--text-faint)]" title={entry.title}>
        {entry.title}
      </div>
    </div>
  );
}

/**
 * Every deployment the manifest repo remembers, newest first: who moved which
 * service from which version to which, in which environment.
 *
 * Read from the repo's commit history rather than from a record of uploads, so a
 * version somebody bumped from their IDE — or before this console existed — is in
 * here too. That is also why an entry names a commit author and not a Talos
 * account: the forge's authorship is the only attribution that covers both.
 */
function ReleaseHistorySection({
  limit,
  onLimitChange,
}: {
  limit: number;
  onLimitChange: (limit: number) => void;
}) {
  const history = useApi(queries.releaseHistory(limit));
  const fmt = useFormat();
  const [environment, setEnvironment] = useState<string>(ALL_ENVIRONMENTS);
  const [query, setQuery] = useState("");
  const data = history.data;

  if (history.loading && !data) {
    return <Loading>Reading deployment history…</Loading>;
  }
  if (history.error) {
    return <ErrorBox>{history.error}</ErrorBox>;
  }
  if (!data) return null;

  // Matches a service, either version, the person, or the commit subject — the
  // four things somebody looking back in time actually has to go on.
  const needle = query.trim().toLowerCase();
  const entries = data.entries.filter((entry) => {
    if (environment !== ALL_ENVIRONMENTS && entry.environment !== environment) return false;
    if (!needle) return true;
    return (
      entry.environment.toLowerCase().includes(needle) ||
      entry.title.toLowerCase().includes(needle) ||
      entry.authorName.toLowerCase().includes(needle) ||
      (entry.authorEmail?.toLowerCase().includes(needle) ?? false) ||
      entry.shortSha.toLowerCase().includes(needle) ||
      entry.changes.some(
        (change) =>
          change.service.toLowerCase().includes(needle) ||
          change.to.toLowerCase().includes(needle) ||
          (change.from?.toLowerCase().includes(needle) ?? false),
      )
    );
  });

  return (
    <section className="flex flex-col gap-3.5">
      {data.error ? <ErrorBox>{data.error}</ErrorBox> : null}

      <div className={TOOLBAR_CLASS}>
        <div className={SEARCH_CLASS}>
          <Search
            className="pointer-events-none absolute top-2 left-[9px] text-[var(--text-faint)]"
            size={14}
            strokeWidth={2}
          />
          <Input
            className={SEARCH_INPUT_CLASS}
            type="text"
            placeholder="Search service, version, person…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={SEARCH_CLEAR_CLASS}
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X size={13} strokeWidth={2} />
            </Button>
          ) : null}
        </div>
        <Select value={environment} onValueChange={setEnvironment}>
          <SelectTrigger
            className="h-8 w-auto min-w-42.5 text-[0.9062rem]"
            aria-label="Filter by environment"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ENVIRONMENTS}>All environments</SelectItem>
            {data.environments.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(limit)} onValueChange={(value) => onLimitChange(Number(value))}>
          <SelectTrigger
            className="h-8 w-auto min-w-42.5 text-[0.9062rem]"
            aria-label="How far back to look"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HISTORY_WINDOWS.map((window) => (
              <SelectItem key={window} value={String(window)}>
                Last {window} commits
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {entries.length === 0 ? (
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          {data.entries.length === 0
            ? `No version changes in the last ${data.commitsScanned} commits of the manifest repo.`
            : "No deployments match your filters."}
        </div>
      ) : (
        <div className="flex flex-col gap-4.5">
          {groupByDay(entries, fmt).map((group) => (
            <div key={group.day}>
              <h3 className="mb-2 text-[0.7812rem] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
                {group.day}
              </h3>
              <div className="flex flex-col gap-2">
                {group.entries.map((entry) => (
                  <ReleaseHistoryRow key={`${entry.sha}:${entry.environment}`} entry={entry} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-1.5 text-sm text-[var(--text-faint)]">
        {`From the last ${data.commitsScanned} commit${data.commitsScanned === 1 ? "" : "s"} of `}
        <span className="mono">{data.projectId}</span>
        {` @ ${data.targetBranch ?? ""} — merge commits excluded, since the commit they bring in is listed on its own.`}
      </div>
    </section>
  );
}

/**
 * Entries under the calendar day they landed on, in the browser's own timezone.
 * A date heading is what makes a long list scannable backwards: "who changed
 * what" is nearly always asked as "what happened around the day it broke".
 */
function groupByDay(
  entries: ReleaseHistoryEntryView[],
  fmt: Formatters,
): { day: string; entries: ReleaseHistoryEntryView[] }[] {
  const groups: { day: string; entries: ReleaseHistoryEntryView[] }[] = [];
  for (const entry of entries) {
    // Through the formatter, so the heading and the timestamps under it agree — and
    // so grouping happens in the instance's timezone rather than the browser's,
    // which used to put a late-evening deploy under the wrong day.
    const day = fmt.date(entry.committedAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

function ReleaseHistoryRow({ entry }: { entry: ReleaseHistoryEntryView }) {
  const fmt = useFormat();

  return (
    <div className={RELEASE_ROW_CLASS}>
      <div className={RELEASE_ROW_HEAD_CLASS}>
        <span className="mono font-bold text-primary">{entry.environment}</span>
        <span className="text-[0.9375rem] text-foreground" title={entry.authorEmail ?? undefined}>
          {entry.authorName}
        </span>
        <span className="text-[0.9062rem] text-muted-foreground" title={fmt.stamp(entry.committedAt)}>
          {ago(entry.committedAt)}
        </span>
        {entry.webUrl ? (
          <a
            className={cn(OBSERVABILITY_LINK_CLASS, "mono")}
            href={entry.webUrl}
            target="_blank"
            rel="noreferrer"
          >
            {entry.shortSha}
            <ExternalLink size={12} strokeWidth={2} />
          </a>
        ) : (
          <span className="mono text-[0.9062rem] text-muted-foreground">{entry.shortSha}</span>
        )}
      </div>
      <ul className="m-0 flex list-none flex-col gap-[3px] p-0 text-[0.9375rem]">
        {entry.changes.map((change) => (
          <li
            className="flex items-center gap-2 text-muted-foreground"
            key={`${change.section ?? ""}:${change.service}`}
          >
            <span className="min-w-37.5 shrink-0 font-medium text-foreground">
              {change.service}
            </span>
            <span className="mono text-sm">{change.from ?? "added"}</span>
            <ArrowRight size={12} strokeWidth={2} />
            <span className="mono text-sm font-medium text-foreground">{change.to}</span>
          </li>
        ))}
      </ul>
      {/* The commit subject last and quiet: for a release opened from here it only
          repeats the bumps above, and it earns its place on the ones edited by
          hand, where it is the only statement of intent there is. */}
      <div className="text-sm text-[var(--text-faint)]">{entry.title}</div>
    </div>
  );
}

function EnvironmentDeploymentBadge({
  services,
  checking,
  unavailable,
}: {
  services: DeploymentTargetStatusView[] | undefined;
  checking: boolean;
  unavailable: boolean;
}) {
  if (checking) {
    return (
      <span className="rounded-full border border-border px-1.5 py-px text-[0.625rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        checking
      </span>
    );
  }
  const state = unavailable
    ? "unavailable"
    : aggregateDeploymentState(services);
  if (!state) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[0.625rem] font-semibold tracking-[0.04em] uppercase",
        DEPLOYMENT_BADGE_CLASS[state],
      )}
      title={services?.find((service) => service.message)?.message ?? undefined}
    >
      {state === "pending" ? (
        <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      ) : null}
      {DEPLOYMENT_LABEL[state]}
    </span>
  );
}

function aggregateDeploymentState(
  services: DeploymentTargetStatusView[] | undefined,
): DeploymentVerificationStateView | undefined {
  if (!services || services.length === 0) return undefined;
  for (const state of [
    "unavailable",
    "degraded",
    "missing",
    "pending",
    "progressing",
  ] as const) {
    if (services.some((service) => service.state === state)) return state;
  }
  return "released";
}

function deploymentStatusTitle(status: DeploymentTargetStatusView): string {
  const replicas =
    `${status.readyReplicas}/${status.desiredReplicas} ready, ` +
    `${status.updatedReplicas}/${status.desiredReplicas} updated`;
  return status.message
    ? `${DEPLOYMENT_LABEL[status.state]} — ${status.message}`
    : `${DEPLOYMENT_LABEL[status.state]} — ${replicas}`;
}

const WATCH_STATE_LABEL: Record<DeployWatchStateView, string> = {
  "pending-merge": "waiting to merge",
  watching: "watching",
  done: "done",
  abandoned: "abandoned",
};

const WATCH_STATE_CLASS: Record<DeployWatchStateView, string> = {
  "pending-merge":
    "border-[color-mix(in_srgb,var(--warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] text-[var(--warn)]",
  watching:
    "border-[color-mix(in_srgb,var(--primary)_35%,transparent)] bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-primary",
  done: "border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]",
  abandoned:
    "border-[color-mix(in_srgb,var(--muted-foreground)_35%,transparent)] bg-[color-mix(in_srgb,var(--muted-foreground)_8%,transparent)] text-muted-foreground",
};

const WATCH_SOURCE_CLASS = {
  datadog:
    "border-[color-mix(in_srgb,var(--primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--primary)_8%,transparent)] text-primary",
  logrocket:
    "border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)] text-[var(--warn)]",
  "e2e tests":
    "border-dashed border-border bg-transparent text-muted-foreground opacity-45",
} as const;

/**
 * Production releases the post-deploy watcher is tracking or has finished with.
 *
 * Always rendered once loaded, even with nothing to show: a section that only
 * appears after the first production release has gone through it is a feature a
 * person can never discover exists until they happen to trigger it, which reads
 * as "invisible" rather than "quiet".
 */
function DeployWatchesSection() {
  const watches = useApi(queries.releaseWatches());
  const data = watches.data;
  if (!data) return null;

  return (
    <section className="flex flex-col gap-5">
      <DeployWatchExplanation />
      {data.watches.length === 0 ? (
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          No production release has gone through the watch yet. Uploading a release—or enabling
          GitLab polling in Settings—opens one automatically for PROD environments.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {data.watches.map((watch) => (
            <DeployWatchRow key={watch.id} watch={watch} />
          ))}
        </div>
      )}
    </section>
  );
}

function DeployWatchExplanation() {
  return (
    <section
      aria-labelledby="deploy-watch-title"
      className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-panel)] border border-border bg-[var(--bg-raised)] px-4 py-3.5"
    >
      <div>
        <h2 id="deploy-watch-title" className="m-0 text-base font-semibold text-foreground">
          Six-hour production watch
        </h2>
        <p className="mt-1 max-w-180 text-sm leading-relaxed text-muted-foreground">
          Findings from Datadog and LogRocket appear below. Talos uploads start a watch
          directly; external GitLab releases can be discovered by the release polling loop.
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        {(["datadog", "logrocket", "e2e tests"] as const).map((source) => (
          <span
            key={source}
            aria-disabled={source === "e2e tests"}
            title={source === "e2e tests" ? "Coming later" : undefined}
            className={cn(
              "rounded-full border px-1.5 py-px text-[0.625rem] font-semibold tracking-[0.04em] uppercase",
              WATCH_SOURCE_CLASS[source],
            )}
          >
            {source}
          </span>
        ))}
      </div>
    </section>
  );
}

function DeployWatchRow({ watch }: { watch: DeployWatchView }) {
  const fmt = useFormat();
  return (
    <div className={RELEASE_ROW_CLASS}>
      <div className={RELEASE_ROW_HEAD_CLASS}>
        <span
          className={cn(
            "whitespace-nowrap rounded-full border border-transparent px-2 py-px text-xs font-semibold tracking-[0.04em] uppercase",
            WATCH_STATE_CLASS[watch.state],
          )}
        >
          {WATCH_STATE_LABEL[watch.state]}
        </span>
        <span className="mono font-bold">{watch.environment}</span>
        <a
          className={cn(OBSERVABILITY_LINK_CLASS, "mono")}
          href={watch.releaseUrl}
          target="_blank"
          rel="noreferrer"
        >
          {watch.releaseLabel}
          <ExternalLink size={12} strokeWidth={2} />
        </a>
        <span className="text-[0.9062rem] text-muted-foreground">
          {watch.services.join(", ")}
          {watch.actorEmail
            ? ` · opened by ${watch.actorEmail}`
            : " · detected from GitLab"}{" "}
          · {ago(watch.openedAt)}
        </span>
      </div>
      {watch.findings.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 pt-1 text-[0.9375rem]">
          {watch.findings.map((finding, i) => (
            <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" key={i}>
              <span
                className={cn(
                  "rounded-full border px-1.5 py-px text-[0.6875rem] font-semibold tracking-[0.04em] uppercase",
                  WATCH_SOURCE_CLASS[finding.source],
                )}
              >
                {finding.source}
              </span>
              {finding.service ? <span className="mono">{finding.service}:</span> : null}
              {finding.externalUrl ? (
                <a
                  className={OBSERVABILITY_LINK_CLASS}
                  href={finding.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {finding.signature}
                  <ExternalLink size={12} strokeWidth={2} />
                </a>
              ) : (
                <span>{finding.signature}</span>
              )}
              {finding.issueType ? (
                <span className="text-xs text-[var(--text-faint)]">{finding.issueType}</span>
              ) : null}
              <span className="text-sm text-muted-foreground">
                —{" "}
                {finding.source === "logrocket"
                  ? `${fmt.number(finding.eventCount)} session${finding.eventCount === 1 ? "" : "s"}/alert${finding.eventCount === 1 ? "" : "s"}`
                  : `sampled ${fmt.number(finding.eventCount)}× since the merge`}
              </span>
            </li>
          ))}
        </ul>
      ) : watch.state === "watching" ? (
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">No new errors so far.</div>
      ) : null}
    </div>
  );
}

function ReleasesHeader({
  data,
  fetching,
  onRefresh,
}: {
  data: ReleasesView;
  fetching: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className={PAGE_TITLE_CLASS}>Releases</h1>
        {data.configured ? (
          <p className={cn(PAGE_META_CLASS, "mono break-all")}>
            {data.projectId} · {data.manifestPath} @ {data.targetBranch}
          </p>
        ) : null}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={fetching}>
        <RefreshCw size={14} strokeWidth={2} className={fetching ? "animate-spin" : ""} /> Refresh
      </Button>
    </header>
  );
}

function ReleaseRevertDialog({
  environmentName,
  projectId,
  targetBranch,
  slackConfigured,
  slackChannel,
  onClose,
  onReverted,
}: {
  environmentName: string;
  projectId: string;
  targetBranch: string;
  slackConfigured: boolean;
  slackChannel?: string;
  onClose: () => void;
  onReverted: (result: ReleaseUploadResultView) => void;
}) {
  const preview = useApi(queries.releaseRevertPreview(environmentName));
  const revert = useAction();
  const [notifySlack, setNotifySlack] = useState(true);
  const notify = notifySlack && slackConfigured;
  const deployment = preview.data?.deployment;

  async function handleRevert() {
    if (!deployment) return;
    await revert.run(async () => {
      onReverted(
        await api.revertRelease({
          environment: environmentName,
          sha: deployment.sha,
          notifySlack: notify,
        }),
      );
    });
  }

  return (
    <Modal
      onClose={onClose}
      className={cn(CONFIRM_DIALOG_CLASS, "sm:max-w-180")}
      title={
        <>
          <RotateCcw size={15} strokeWidth={2} />
          Revert last deploy
        </>
      }
    >
      <p className={CONFIRM_TARGET_CLASS}>
        <GitBranch size={13} strokeWidth={2} />
        <span>
          <span className="mono">{environmentName}</span> in{" "}
          <span className="mono">{projectId}</span>, into{" "}
          <span className="mono">{targetBranch}</span>
        </span>
      </p>

      {preview.loading && !preview.data ? (
        <div className="py-5 text-sm text-muted-foreground">
          Loading the latest {environmentName} deployment from GitLab…
        </div>
      ) : null}
      {preview.error ? <ErrorBox>{preview.error}</ErrorBox> : null}

      {deployment ? (
        <>
          <div className="rounded-lg border border-border bg-background/50 p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <strong className="text-sm text-foreground">{deployment.title}</strong>
              {deployment.webUrl ? (
                <a
                  className={cn(OBSERVABILITY_LINK_CLASS, "mono text-xs")}
                  href={deployment.webUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {deployment.shortSha}
                  <ExternalLink size={11} strokeWidth={2} />
                </a>
              ) : (
                <span className="mono text-xs text-muted-foreground">
                  {deployment.shortSha}
                </span>
              )}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Deployed by {deployment.authorName} {ago(deployment.committedAt)}
            </div>
            <ul className="mt-3 flex list-none flex-col gap-1 p-0 text-sm">
              {preview.data?.changes.map((change) => (
                <li
                  key={`${change.section}:${change.service}`}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="font-medium text-foreground">{change.service}</span>
                  <span className="mono text-right text-muted-foreground">
                    {change.from} <ArrowRight size={12} className="inline" /> {change.to}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <ol className={CONFIRM_STEPS_CLASS}>
            {[
              {
                title: "Open a revert merge request",
                detail: `Restore the versions that ${deployment.shortSha} replaced, without changing other ${environmentName} services.`,
              },
              {
                title: "Approve it",
                detail: "Approved for you automatically — no separate review step.",
              },
              {
                title: "Merge automatically",
                detail: "Set to merge on its own once the pipeline succeeds.",
              },
              ...(notify
                ? [{
                    title: "Notify Slack",
                    detail: `${slackChannel ?? "The team"} is told about the revert.`,
                  }]
                : []),
            ].map((step, index) => (
              <li className={CONFIRM_STEP_CLASS} key={step.title}>
                <span className={CONFIRM_STEP_NUMBER_CLASS}>{index + 1}</span>
                <span>
                  <strong className={CONFIRM_STEP_TITLE_CLASS}>{step.title}</strong>
                  <span className={CONFIRM_STEP_DETAIL_CLASS}>{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>

          <label className="mt-1 flex items-center gap-2 text-sm">
            <Checkbox
              checked={notify}
              disabled={!slackConfigured || revert.busy}
              onCheckedChange={(checked) => setNotifySlack(checked === true)}
            />
            Notify {slackChannel ?? "the team"} in Slack
          </label>
          {slackConfigured ? null : (
            <div className="text-sm text-[var(--text-faint)]">
              Connect Slack under Settings → Integrations to announce the revert.
            </div>
          )}
        </>
      ) : null}

      {revert.error ? <ErrorBox>{revert.error}</ErrorBox> : null}
      <FormActions>
        <Button
          type="button"
          variant="destructive"
          disabled={!deployment || preview.loading || revert.busy}
          onClick={() => void handleRevert()}
        >
          {revert.busy ? "Opening revert MR…" : "Revert and merge"}
        </Button>
        <Button type="button" variant="outline" disabled={revert.busy} onClick={onClose}>
          Cancel
        </Button>
      </FormActions>
    </Modal>
  );
}

/**
 * Edits one environment's service versions and opens an MR. Every service is
 * shown prefilled with its current version; only the rows the developer changed
 * are sent, so a submit that touches one service produces a one-line diff.
 */
function UploadDialog({
  environment,
  environments,
  projectId,
  targetBranch,
  slackConfigured,
  slackChannel,
  onClose,
  onUploaded,
}: {
  environment: EnvironmentVersionView;
  /** Every environment, so "Copy from" can offer every one but this. */
  environments: EnvironmentVersionView[];
  projectId: string;
  targetBranch: string;
  slackConfigured: boolean;
  slackChannel?: string;
  onClose: () => void;
  onUploaded: (result: ReleaseUploadResultView) => void;
}) {
  // Keyed by section+name: an application and a service could share a name, and
  // a change must name the section it edits.
  const current = useMemo(
    () => Object.fromEntries(environment.services.map((s) => [keyOf(s), s.version])),
    [environment],
  );
  const [versions, setVersions] = useState<Record<string, string>>(current);
  // null means "still following the generated text"; a string is the developer's
  // own override. So editing a version keeps the title/description in sync until
  // the moment the developer takes them over by typing.
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [descriptionOverride, setDescriptionOverride] = useState<string | null>(null);
  // On by default: a release the team is not told about is the problem this
  // solves, so the quiet release is the one that takes a deliberate click. Not
  // persisted — "don't announce this one" is about this release, not a setting.
  const [notifySlack, setNotifySlack] = useState(true);
  const upload = useAction();
  const fmt = useFormat();
  // Set once the developer clicks "Open and merge" on the edit form — the
  // confirmation dialog is a second screen, not a second click captured by the
  // same button, so a poll or an edit landing while it is open can't submit
  // anything by itself.
  const [confirming, setConfirming] = useState(false);
  const [confirmationOpenedAt, setConfirmationOpenedAt] = useState<Date>();
  const confirmationSince = useMemo(
    () =>
      confirmationOpenedAt
        ? startOfCalendarDay(confirmationOpenedAt, fmt.timeZone).toISOString()
        : "",
    [confirmationOpenedAt, fmt.timeZone],
  );
  const deploymentHistory = useApi(
    queries.releaseHistory(200, {
      environment: environment.name,
      since: confirmationSince,
      enabled: confirming && confirmationSince.length > 0,
      bypassCache: true,
    }),
  );

  const production = isProdEnvironment(environment.name);
  const [confluenceReleasesExpanded, setConfluenceReleasesExpanded] = useState(false);
  const confluence = useApi(
    queries.confluenceReleases(production || confluenceReleasesExpanded),
  );
  const confluenceReleases = confluence.data?.releases ?? [];
  const [releaseSelectOpen, setReleaseSelectOpen] = useState(false);
  const [selectedSourceValue, setSelectedSourceValue] = useState("");
  const [selectedSourceLabel, setSelectedSourceLabel] = useState("");
  const keepReleaseSelectOpen = useRef(false);
  const [visibleReleaseCount, setVisibleReleaseCount] = useState(
    CONFLUENCE_RELEASE_PAGE_SIZE,
  );
  const visibleConfluenceReleases = confluenceReleases.slice(0, visibleReleaseCount);
  const confluenceDetail = useAction();
  const [selectedRelease, setSelectedRelease] = useState<{
    pageId: string;
    title: string;
    applied: number;
    changed: number;
    missing: string[];
  }>();

  // Every other environment — copying from itself would be a no-op offered as
  // a choice.
  const copySources = environments.filter((env) => env.name !== environment.name);

  /**
   * Overwrites every row this environment shares with `sourceName` with that
   * environment's version. A service only `environment` has (or only the
   * source has) is left alone — there is nothing to copy for it either way.
   */
  function copyFrom(sourceName: string) {
    const source = environments.find((env) => env.name === sourceName);
    if (!source) return;
    const sourceVersions = Object.fromEntries(source.services.map((s) => [keyOf(s), s.version]));
    setVersions((prev) => {
      const next = { ...prev };
      for (const svc of environment.services) {
        const key = keyOf(svc);
        if (key in sourceVersions) next[key] = sourceVersions[key];
      }
      return next;
    });
    // The title/description were generated from the old diff — regenerated
    // from the new one rather than left describing edits that no longer match.
    setTitleOverride(null);
    setDescriptionOverride(null);
    setSelectedRelease(undefined);
    upload.clear();
  }

  async function applySuggestedVersions(pageId: string) {
    const option = confluenceReleases.find((candidate) => candidate.pageId === pageId);
    if (!option) return;

    setSelectedRelease(undefined);
    await confluenceDetail.run(async () => {
      const { release } = await api.confluenceRelease(pageId);
      // Start from the manifest each time: switching from release A to release B
      // must not retain A's version for a row that B marks unchanged.
      const result = applyConfluenceRelease(environment, current, release);
      setVersions(result.versions);
      setSelectedRelease({
        pageId,
        title: release.title,
        applied: result.applied,
        changed: result.changed,
        missing: result.missing,
      });
      setTitleOverride(null);
      setDescriptionOverride(null);
      upload.clear();
    });
  }

  // The current manifest version of each row is the "previous" version a change
  // replaces — used to word the description's `old → new` bullets.
  const described: FormatChange[] = environment.services
    .filter((s) => (versions[keyOf(s)] ?? "").trim() !== s.version)
    .map((s) => ({
      service: s.name,
      version: (versions[keyOf(s)] ?? "").trim(),
      section: s.section,
      previousVersion: s.version,
    }));
  const changes = described.map(({ service, version, section }) => ({ service, version, section }));
  const deploymentWarnings =
    confirmationOpenedAt && deploymentHistory.data
      ? sameDayDeploymentWarnings({
          environment: environment.name,
          changes: described.map((change) => ({
            service: change.service,
            section: change.section,
            previousVersion: change.previousVersion ?? "",
            version: change.version,
          })),
          entries: deploymentHistory.data.entries,
          now: confirmationOpenedAt,
          timeZone: fmt.timeZone,
        })
      : [];
  const deploymentWarningError =
    deploymentHistory.error ?? deploymentHistory.data?.error;

  const title = titleOverride ?? buildReleaseTitle(environment.name, changes);
  const description = descriptionOverride ?? buildReleaseDescription(environment.name, described);
  // The checkbox's own state is kept as the developer left it, but an
  // unconfigured Slack can never be notified — deriving the effective value here
  // means the box cannot look ticked while sending `false`, or vice versa.
  const notify = notifySlack && slackConfigured;

  function openConfirm() {
    if (changes.length === 0) {
      upload.fail("No version changes — edit a version before deploying.");
      return;
    }
    if (changes.some((c) => c.version === "")) {
      upload.fail("A version cannot be empty.");
      return;
    }
    upload.clear();
    setConfirmationOpenedAt(new Date());
    setConfirming(true);
  }

  async function handleSubmit() {
    await upload.run(async () => {
      onUploaded(
        await api.uploadRelease({
          environment: environment.name,
          changes,
          title,
          description,
          notifySlack: notify,
        }),
      );
    });
    // Whatever the outcome: on success the caller closes this, and on failure the
    // error belongs on the form behind the confirmation, not on the confirmation.
    setConfirming(false);
  }

  return (
    <>
      <Modal
        onClose={onClose}
        className="sm:max-w-4xl"
        title={
          <>
            Deploy to{" "}
            <span className="mono text-[1.2em] font-bold tracking-[-0.01em] text-primary">
              {environment.name}
            </span>
          </>
        }
        titleActions={
          <Select
            open={releaseSelectOpen}
            onOpenChange={(open) => {
              if (!open && keepReleaseSelectOpen.current) {
                keepReleaseSelectOpen.current = false;
                return;
              }
              setReleaseSelectOpen(open);
              if (!open && !production) setConfluenceReleasesExpanded(false);
            }}
            value={selectedSourceValue}
            onValueChange={(value) => {
              if (value === TOGGLE_CONFLUENCE_RELEASES_VALUE) {
                keepReleaseSelectOpen.current = true;
                setConfluenceReleasesExpanded((expanded) => !expanded);
                return;
              }
              if (value === SHOW_MORE_RELEASES_VALUE) {
                keepReleaseSelectOpen.current = true;
                setVisibleReleaseCount((count) =>
                  Math.min(count + CONFLUENCE_RELEASE_PAGE_SIZE, confluenceReleases.length),
                );
                return;
              }
              setSelectedSourceValue(value);
              if (value.startsWith(ENVIRONMENT_VALUE_PREFIX)) {
                const sourceName = value.slice(ENVIRONMENT_VALUE_PREFIX.length);
                setSelectedSourceLabel(sourceName);
                copyFrom(sourceName);
                return;
              }
              if (value.startsWith(CONFLUENCE_RELEASE_VALUE_PREFIX)) {
                const pageId = value.slice(CONFLUENCE_RELEASE_VALUE_PREFIX.length);
                const release = confluenceReleases.find(
                  (candidate) => candidate.pageId === pageId,
                );
                setSelectedSourceLabel(release?.title ?? "Confluence release");
                void applySuggestedVersions(pageId);
              }
            }}
            disabled={
              confluenceDetail.busy ||
              (production && (confluence.loading || confluenceReleases.length === 0))
            }
          >
              <SelectTrigger
                className="h-auto w-auto max-w-80 gap-1.5 border-transparent bg-transparent px-2 py-1 text-sm text-muted-foreground hover:bg-[var(--bg-hover)] hover:text-foreground"
                aria-label={
                  production
                    ? "Choose a production release from Confluence"
                    : "Copy versions from an environment or Confluence release"
                }
              >
                <Copy size={12} strokeWidth={2} />
                <SelectValue
                  placeholder={
                    !production
                      ? "Copy from…"
                      : confluence.loading
                      ? "Loading releases…"
                      : confluenceDetail.busy
                        ? "Loading release…"
                        : "Choose release…"
                  }
                >
                  {selectedSourceLabel || undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {!production && copySources.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>Environments</SelectLabel>
                    {copySources.map((env) => (
                      <SelectItem
                        key={env.name}
                        value={`${ENVIRONMENT_VALUE_PREFIX}${env.name}`}
                      >
                        {env.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
                <SelectGroup>
                  {!production ? <SelectLabel>Confluence releases</SelectLabel> : null}
                  {!production ? (
                    <SelectItem value={TOGGLE_CONFLUENCE_RELEASES_VALUE}>
                      {confluenceReleasesExpanded ? "Collapse releases" : "Show releases…"}
                    </SelectItem>
                  ) : null}
                  {confluenceReleasesExpanded && confluence.loading ? (
                    <SelectItem disabled value="__loading-confluence-releases__">
                      Loading releases…
                    </SelectItem>
                  ) : null}
                  {confluenceReleasesExpanded &&
                  !confluence.loading &&
                  confluence.data &&
                  confluenceReleases.length === 0 ? (
                    <SelectItem disabled value="__no-confluence-releases__">
                      No releases found
                    </SelectItem>
                  ) : null}
                  {production || confluenceReleasesExpanded
                    ? visibleConfluenceReleases.map((release) => (
                        <SelectItem
                          key={release.pageId}
                          value={`${CONFLUENCE_RELEASE_VALUE_PREFIX}${release.pageId}`}
                        >
                          {release.title}
                        </SelectItem>
                      ))
                    : null}
                  {(production || confluenceReleasesExpanded) &&
                  visibleReleaseCount < confluenceReleases.length ? (
                    <SelectItem value={SHOW_MORE_RELEASES_VALUE}>
                      Show {Math.min(
                        CONFLUENCE_RELEASE_PAGE_SIZE,
                        confluenceReleases.length - visibleReleaseCount,
                      )} more…
                    </SelectItem>
                  ) : null}
                </SelectGroup>
              </SelectContent>
          </Select>
        }
      >

        {production ? (
          <ProviderAccessNotice
            providers={["jira"]}
            purpose="Loading releases from Confluence"
          />
        ) : null}
        {production && confluence.data ? (
          <div className="mb-4 text-sm text-muted-foreground">
            Release choices come from{" "}
            <a
              className={OBSERVABILITY_LINK_CLASS}
              href={confluence.data.pageUrl}
              target="_blank"
              rel="noreferrer"
            >
              Confluence releases
              <ExternalLink size={12} strokeWidth={2} />
            </a>
            . Only concrete Suggested values are applied.
          </div>
        ) : null}
        {confluence.error ? <ErrorBox>{confluence.error}</ErrorBox> : null}
        {confluenceDetail.error ? <ErrorBox>{confluenceDetail.error}</ErrorBox> : null}
        {selectedRelease ? (
          <div className="mb-4 text-sm text-muted-foreground">
            Loaded {selectedRelease.applied} suggested version
            {selectedRelease.applied === 1 ? "" : "s"} from{" "}
            <span className="font-medium text-foreground">{selectedRelease.title}</span>.{" "}
            {selectedRelease.changed} differ
            {selectedRelease.changed === 1 ? "s" : ""} from current {environment.name}.
            {selectedRelease.missing.length > 0
              ? ` Not found in ${environment.name}: ${selectedRelease.missing.join(", ")}.`
              : null}
          </div>
        ) : null}

        {SECTIONS.map(({ section, label }) => {
          const rows = environment.services.filter((s) => s.section === section);
          if (rows.length === 0) return null;
          return (
            <div
              key={section}
              className={cn(RELEASE_SECTION_CLASS, "w-full")}
            >
              <h3 className={cn(RELEASE_SECTION_TITLE_CLASS, "text-center")}>{label}</h3>
              <div className="mt-1 grid grid-cols-1 gap-x-8 gap-y-2 lg:grid-cols-2">
                {rows.map((svc) => {
                  const key = keyOf(svc);
                  const changed = (versions[key] ?? "").trim() !== svc.version;
                  return (
                    <label
                      key={key}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,200px)_20px] items-center gap-x-3 sm:grid-cols-[max-content_200px_20px] sm:justify-center lg:grid-cols-[minmax(0,1fr)_200px_20px] lg:justify-stretch"
                    >
                      <span className="whitespace-nowrap text-right font-medium text-foreground">
                        {svc.name}
                      </span>
                      <Input
                        className={`mono min-w-0 w-full ${changed ? "border-primary" : ""}`}
                        value={versions[key] ?? ""}
                        onChange={(e) =>
                          setVersions((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                      />
                      {changed ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="size-5 text-primary hover:bg-primary/15"
                          title={`Revert to ${svc.version}`}
                          onClick={() =>
                            setVersions((prev) => ({ ...prev, [key]: svc.version }))
                          }
                        >
                          <RotateCcw size={12} strokeWidth={2} />
                        </Button>
                      ) : (
                        <span className="size-5" />
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}

        <Field className="mt-4" label="Merge request title">
          <Input
            value={title}
            onChange={(e) => setTitleOverride(e.target.value)}
          />
        </Field>
        <Field className="mt-3" label="Description">
          <Textarea
            className="font-mono"
            rows={5}
            value={description}
            onChange={(e) => setDescriptionOverride(e.target.value)}
          />
        </Field>

        <label className="mt-4 flex items-center gap-2 text-sm">
          <Checkbox
            checked={notify}
            disabled={!slackConfigured}
            onCheckedChange={(checked) => setNotifySlack(checked === true)}
          />
          Notify {slackChannel ?? "the team"} in Slack
        </label>
        {slackConfigured ? null : (
          <div className="mt-1.5 text-sm text-[var(--text-faint)]">
            Connect Slack under Settings → Integrations to announce releases.
          </div>
        )}

        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          {changes.length === 0
            ? "No changes yet."
            : `${changes.length} service${changes.length === 1 ? "" : "s"} changed. ` +
              `Title and description are prefilled from your changes — edit them if you like. ` +
              `The env:: label is added automatically.`}
        </div>

        {upload.error ? <ErrorBox>{upload.error}</ErrorBox> : null}

        <FormActions>
          <Button
            type="button"
            disabled={upload.busy || changes.length === 0}
            onClick={openConfirm}
          >
            Open and merge
          </Button>
          <Button type="button" variant="outline" disabled={upload.busy} onClick={onClose}>
            Cancel
          </Button>
        </FormActions>
      </Modal>

      {/* A sibling of the upload modal rather than a child of it: stacking it on
          top is what the z-index already does, and nesting meant a click on the
          confirmation's backdrop bubbled out and closed both. */}
      <AnimatePresence>
        {confirming ? (
          <ReleaseConfirmDialog
            environmentName={environment.name}
            projectId={projectId}
            targetBranch={targetBranch}
            changeCount={changes.length}
            notify={notify}
            slackChannel={slackChannel}
            deploymentWarnings={deploymentWarnings}
            checkingDeploymentHistory={deploymentHistory.fetching}
            deploymentHistoryUnavailable={Boolean(deploymentWarningError)}
            busy={upload.busy}
            onConfirm={() => void handleSubmit()}
            onCancel={() => setConfirming(false)}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}

/**
 * What "Open and merge" is about to do, before it does it — the same shape as
 * the graph page's "Fix this issue" confirm: the real steps, in order, rather
 * than a paraphrase, since it is easier to trust and to keep honest as the
 * upload flow changes.
 */
function ReleaseConfirmDialog({
  environmentName,
  projectId,
  targetBranch,
  changeCount,
  notify,
  slackChannel,
  deploymentWarnings,
  checkingDeploymentHistory,
  deploymentHistoryUnavailable,
  busy,
  onConfirm,
  onCancel,
}: {
  environmentName: string;
  projectId: string;
  targetBranch: string;
  changeCount: number;
  notify: boolean;
  slackChannel?: string;
  deploymentWarnings: SameDayDeploymentWarning[];
  checkingDeploymentHistory: boolean;
  deploymentHistoryUnavailable: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const fmt = useFormat();
  const steps: { title: string; detail: string }[] = [
    {
      title: "Open a merge request",
      detail: `Against ${targetBranch} in ${projectId}, with only the ${changeCount} service version edit${changeCount === 1 ? "" : "s"} you made to ${environmentName}.`,
    },
    {
      title: "Approve it",
      detail: "Approved for you automatically — no separate review step.",
    },
    {
      title: "Merge automatically",
      detail: "Set to merge on its own once the pipeline succeeds.",
    },
    ...(notify
      ? [
          {
            title: "Notify Slack",
            detail: `${slackChannel ?? "The team"} is told about the release once it merges.`,
          },
        ]
      : []),
  ];

  return (
    <Modal
      onClose={onCancel}
      className={CONFIRM_DIALOG_CLASS}
      title={
        <>
          <Rocket size={15} strokeWidth={2} />
          Deploy to {environmentName}
        </>
      }
    >

      <p className={CONFIRM_TARGET_CLASS}>
        <GitBranch size={13} strokeWidth={2} />
        <span>
          <span className="mono">{projectId}</span>, into <span className="mono">{targetBranch}</span>
        </span>
      </p>

      {checkingDeploymentHistory ? (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          Checking today’s deployment history…
        </p>
      ) : deploymentWarnings.length > 0 ? (
        <div
          className="mt-3 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--warn)_45%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_12%,transparent)] px-3 py-2.5 text-sm"
          role="alert"
        >
          <div className="flex items-center gap-2 font-medium text-foreground">
            <TriangleAlert size={15} strokeWidth={2} className="text-[var(--warn)]" />
            A recent version may still be needed
          </div>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
            {deploymentWarnings.map((warning) => (
              <li key={`${warning.section}:${warning.service}`}>
                <span
                  className="font-medium text-foreground"
                  title={warning.authorEmail ?? undefined}
                >
                  {warning.authorName}
                </span>{" "}
                deployed <span className="font-medium text-foreground">{warning.service}</span>{" "}
                <span className="mono">{warning.previousVersion}</span> at{" "}
                {fmt.time(warning.committedAt)} today. This changes it to{" "}
                <span className="mono">{warning.version}</span>.
              </li>
            ))}
          </ul>
        </div>
      ) : deploymentHistoryUnavailable ? (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          Today’s deployment history could not be checked. You can still continue.
        </p>
      ) : null}

      <ol className={CONFIRM_STEPS_CLASS}>
        {steps.map((step, index) => (
          <li className={CONFIRM_STEP_CLASS} key={step.title}>
            <span className={CONFIRM_STEP_NUMBER_CLASS}>{index + 1}</span>
            <span>
              <strong className={CONFIRM_STEP_TITLE_CLASS}>{step.title}</strong>
              <span className={CONFIRM_STEP_DETAIL_CLASS}>{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      <FormActions>
        <Button
          type="button"
          disabled={busy || checkingDeploymentHistory}
          onClick={onConfirm}
        >
          {busy
            ? "Opening MR…"
            : checkingDeploymentHistory
              ? "Checking history…"
              : "Open and merge"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </FormActions>
    </Modal>
  );
}
