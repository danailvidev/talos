import { useEffect, useMemo, useRef, useState } from "react";
import { Ellipsis, LayoutDashboard, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";

import {
  DEFAULT_DASHBOARD_ID,
  DEFAULT_TALOS_DASHBOARD,
  type DashboardSpec,
  type DatasetCatalogEntry,
  type Widget,
} from "../../shared/dashboard.ts";
import { api, type DashboardListView } from "./api.ts";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { queryClient } from "./query-client.ts";
import { keys } from "./query-keys.ts";
import { ICON_BUTTON_CLASS } from "./app-styles.ts";
import { Button } from "./components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import { Input } from "./components/ui/input.tsx";
import { cn } from "./lib/utils.ts";
import { Tip } from "./Tip.tsx";
import { Card, CardDescription, CardHeader, CardTitle } from "./components/ui/card.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import type { RouteState } from "./route-state.ts";
import { dashboardAccessPurpose, providersForWidgets } from "./dashboard/access.ts";
import {
  dashboardToReopen,
  LAST_DASHBOARD_PREFERENCE,
  parseLastDashboard,
} from "./dashboard/last-dashboard.ts";
import { DashboardGrid } from "./dashboard/DashboardGrid.tsx";
import { ProviderAccessNotice } from "./ProviderAccessNotice.tsx";
import { usePreference } from "./PreferencesContext.tsx";

const CUSTOMIZE_PROMPT =
  "Help me build a TALOS dashboard. List the datasets I can use, ask what I want to see, then create the dashboard. Use dates the records already have, such as created or updated. Do not assume historical open-count snapshots exist.";

function addWidgetPrompt(dashboardId: string, name: string): string {
  return [
    `Add a widget to dashboard "${name}" (${dashboardId}).`,
    "The widgets are already saved. Call talos_dashboard_get now, then talos_dashboard_update.",
    "Keep every widget that is already there. Do not stop after saying you will look at the configuration.",
    "",
    "Example: add a table titled \"My open bugs\" using jira.issues,",
    "JQL assignee = currentUser() AND resolution = Unresolved,",
    "columns key, summary, status and url, sorted by updated descending.",
    "Place it on the next free row.",
    "",
    "Use this example unless I describe a different widget, then update the dashboard.",
  ].join("\n");
}

export function DashboardsPage({
  route,
  onNavigate,
  onAskTalos,
}: {
  route: RouteState;
  onNavigate: (next: RouteState, opts?: { replace?: boolean }) => void;
  onAskTalos: (prompt: string) => void;
}) {
  const list = useApi(queries.dashboards());
  const datasets = useApi(queries.dashboardDatasets());
  const saved = useApi({ ...queries.dashboard(route.id ?? ""), enabled: Boolean(route.id && route.id !== DEFAULT_DASHBOARD_ID) });
  const [lastDashboard, storeLastDashboard, { loaded: lastDashboardLoaded }] = usePreference(
    LAST_DASHBOARD_PREFERENCE,
    parseLastDashboard,
  );

  useEffect(() => {
    // Wait until the stored id has arrived. Saving earlier would replace it
    // with whichever overview the empty route opened first.
    if (!lastDashboardLoaded || !route.id || route.id === lastDashboard) return;
    if (route.id !== DEFAULT_DASHBOARD_ID && saved.error === "Dashboard not found.") return;
    storeLastDashboard(route.id);
  }, [lastDashboard, lastDashboardLoaded, route.id, saved.error, storeLastDashboard]);

  useEffect(() => {
    if (route.id || !lastDashboardLoaded || !list.data) return;
    const next = dashboardToReopen(lastDashboard, list.data.dashboards);
    if (next) onNavigate({ page: "dashboard", id: next }, { replace: true });
  }, [lastDashboard, lastDashboardLoaded, list.data, onNavigate, route.id]);

  // A deleted id 404s. That error used to replace the page, so closing the last
  // copy also hid the built-in dashboard — it is not a stored row.
  useEffect(() => {
    if (route.id && route.id !== DEFAULT_DASHBOARD_ID && saved.error === "Dashboard not found.") {
      onNavigate({ page: "dashboard", id: DEFAULT_DASHBOARD_ID }, { replace: true });
    }
  }, [onNavigate, route.id, saved.error]);

  if (
    list.loading
    || datasets.loading
    || (route.id && route.id !== DEFAULT_DASHBOARD_ID && saved.loading)
  ) {
    return <p className="p-6 text-sm text-muted-foreground">Loading dashboard…</p>;
  }
  if (list.error) return <p className="p-6 text-sm text-destructive">{list.error}</p>;
  if (datasets.error) return <p className="p-6 text-sm text-destructive">{datasets.error}</p>;
  if (!route.id) {
    const reopen = list.data && lastDashboardLoaded
      ? dashboardToReopen(lastDashboard, list.data.dashboards)
      : lastDashboard;
    if (!lastDashboardLoaded || list.loading || reopen) {
      return <p className="p-6 text-sm text-muted-foreground">Loading dashboard…</p>;
    }
    return (
      <Chooser
        onShowDefault={() => onNavigate({ page: "dashboard", id: DEFAULT_DASHBOARD_ID })}
        onCustomize={() => onAskTalos(CUSTOMIZE_PROMPT)}
      />
    );
  }

  const spec: DashboardSpec = route.id === DEFAULT_DASHBOARD_ID
    ? DEFAULT_TALOS_DASHBOARD
    : saved.data
      ? { version: 1, name: saved.data.name, ...(saved.data.description ? { description: saved.data.description } : {}), widgets: saved.data.widgets }
      : DEFAULT_TALOS_DASHBOARD;
  if (route.id !== DEFAULT_DASHBOARD_ID && saved.error) {
    if (saved.error === "Dashboard not found.") {
      return <p className="p-6 text-sm text-muted-foreground">Loading dashboard…</p>;
    }
    return <p className="p-6 text-sm text-destructive">{saved.error}</p>;
  }

  return (
    <DashboardView
      dashboardId={route.id}
      spec={spec}
      owned={route.id !== DEFAULT_DASHBOARD_ID}
      dashboards={list.data?.dashboards ?? []}
      datasets={datasets.data?.datasets ?? []}
      onNavigate={onNavigate}
      onAskTalos={onAskTalos}
      onSaved={() => {
        void queryClient.invalidateQueries({ queryKey: keys.dashboards() });
        if (route.id && route.id !== DEFAULT_DASHBOARD_ID) {
          void queryClient.invalidateQueries({ queryKey: keys.dashboard(route.id) });
        }
      }}
    />
  );
}

function Chooser({
  onShowDefault,
  onCustomize,
}: {
  onShowDefault: () => void;
  onCustomize: () => void;
}) {
  const needed = providersForWidgets(DEFAULT_TALOS_DASHBOARD.widgets);

  return (
    <div className="grid h-full place-items-center overflow-auto p-6">
      <div className="w-full max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Nothing here yet. Open the TALOS dashboard, or describe your own and the assistant will build it.
        </p>
        {/* The built-in dashboard reads merge requests and tickets as this
            person. Say so here, before they open a page of widgets that cannot load.
            Kept mounted even after the tokens are stored: the dialog lives inside
            the notice, and unmounting it on the first save would close it
            before the second token can be entered. */}
        {needed.length > 0 ? (
          <ProviderAccessNotice providers={needed} purpose="Opening the TALOS dashboard" />
        ) : null}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button type="button" className="text-left" onClick={onShowDefault}>
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardHeader>
                <LayoutDashboard className="size-5 text-action" />
                <CardTitle>Show the TALOS dashboard</CardTitle>
                <CardDescription>
                  Merge requests, tickets, pipelines, loop runs and your agent usage.
                </CardDescription>
              </CardHeader>
            </Card>
          </button>
          <button type="button" className="text-left" onClick={onCustomize}>
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardHeader>
                <Sparkles className="size-5 text-action" />
                <CardTitle>Customize with Talos</CardTitle>
                <CardDescription>
                  Tell the assistant what you want to see and it will create the dashboard.
                </CardDescription>
              </CardHeader>
            </Card>
          </button>
        </div>
      </div>
    </div>
  );
}

function DashboardView({
  dashboardId,
  spec,
  owned,
  dashboards,
  datasets,
  onNavigate,
  onAskTalos,
  onSaved,
}: {
  dashboardId: string;
  spec: DashboardSpec;
  owned: boolean;
  dashboards: Array<{ id: string; name: string }>;
  datasets: DatasetCatalogEntry[];
  onNavigate: (next: RouteState, opts?: { replace?: boolean }) => void;
  onAskTalos: (prompt: string) => void;
  onSaved: () => void;
}) {
  const visible = useMemo(() => widgetsFor(spec.widgets, datasets), [datasets, spec.widgets]);
  const serverWidgets = JSON.stringify(visible);
  const appliedServerWidgets = useRef(serverWidgets);
  const [widgets, setWidgets] = useState(visible);
  const [name, setName] = useState(spec.name);
  const [renaming, setRenaming] = useState(false);
  const renamingRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const needed = useMemo(() => providersForWidgets(widgets), [widgets]);

  useEffect(() => {
    if (appliedServerWidgets.current === serverWidgets) return;
    appliedServerWidgets.current = serverWidgets;
    setWidgets(visible);
    setRefreshToken((token) => token + 1);
  }, [serverWidgets, visible]);

  useEffect(() => {
    setName(spec.name);
    renamingRef.current = false;
    setRenaming(false);
  }, [dashboardId, spec.name]);

  const forgetMissingDashboard = (message: string): boolean => {
    if (message !== "Dashboard not found.") return false;
    queryClient.setQueryData<DashboardListView>(keys.dashboards(), (current) =>
      current
        ? { dashboards: current.dashboards.filter((item) => item.id !== dashboardId) }
        : current,
    );
    queryClient.removeQueries({ queryKey: keys.dashboard(dashboardId) });
    onNavigate({ page: "dashboard", id: DEFAULT_DASHBOARD_ID }, { replace: true });
    setError("This dashboard is no longer saved, so the change was not kept.");
    return true;
  };

  const persist = async (next: Widget[], name = spec.name) => {
    setSaving(true);
    setError(undefined);
    try {
      await api.updateDashboard(dashboardId, {
        name,
        ...(spec.description ? { description: spec.description } : {}),
        widgets: next,
      });
      setWidgets(next);
      onSaved();
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!forgetMissingDashboard(message)) setError(message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const rename = async (nextName: string) => {
    if (!renamingRef.current) return;
    // Closing the field blurs it, and blur is what calls this. Drop the flag
    // first so that blur cannot save the same name a second time.
    renamingRef.current = false;
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === spec.name) {
      setName(spec.name);
      setRenaming(false);
      return;
    }
    if (!owned) {
      const saved = await saveCopy(trimmed);
      if (saved) setRenaming(false);
      else renamingRef.current = true;
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const updated = await api.updateDashboard(dashboardId, { name: trimmed });
      queryClient.setQueryData<DashboardListView>(keys.dashboards(), (current) =>
        current
          ? {
              dashboards: current.dashboards.map((dashboard) =>
                dashboard.id === updated.id ? { ...dashboard, name: updated.name } : dashboard,
              ),
            }
          : current,
      );
      onSaved();
      setRenaming(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (forgetMissingDashboard(message)) return;
      renamingRef.current = true;
      setName(spec.name);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const saveCopy = async (explicitName?: string): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    try {
      const existing = dashboards.map((dashboard) => dashboard.name);
      const chosen = explicitName?.trim();
      const name = chosen && chosen.toLowerCase() !== spec.name.trim().toLowerCase()
        ? availableName(chosen, existing)
        : uniqueCopyName(spec.name, existing);
      const created = await api.createDashboard({
        version: 1,
        name,
        ...(spec.description ? { description: spec.description } : {}),
        widgets: visible,
      });
      queryClient.setQueryData<DashboardListView>(keys.dashboards(), (current) => {
        const summary = {
          id: created.id,
          name: created.name,
          ...(created.description ? { description: created.description } : {}),
          updatedAt: created.updatedAt,
        };
        const rest = (current?.dashboards ?? []).filter((dashboard) => dashboard.id !== created.id);
        return { dashboards: [summary, ...rest] };
      });
      onSaved();
      onNavigate({ page: "dashboard", id: created.id });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const removeDashboard = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.deleteDashboard(dashboardId);
      const remaining = dashboards.filter((item) => item.id !== dashboardId);
      queryClient.setQueryData<DashboardListView>(keys.dashboards(), (current) =>
        current
          ? { dashboards: current.dashboards.filter((item) => item.id !== dashboardId) }
          : current,
      );
      // Drop the deleted read before invalidating. A refetch of this
      // id 404s, and that error replaced the whole page — including
      // the built-in dashboard, which is not a stored row and cannot
      // be deleted.
      queryClient.removeQueries({ queryKey: keys.dashboard(dashboardId) });
      void queryClient.invalidateQueries({ queryKey: keys.dashboards() });
      onNavigate(
        {
          page: "dashboard",
          id: remaining[0]?.id ?? DEFAULT_DASHBOARD_ID,
        },
        { replace: true },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        {renaming ? (
          <Input
            aria-label="Dashboard name"
            value={name}
            maxLength={80}
            autoFocus
            disabled={saving}
            className="mr-auto h-9 max-w-md min-w-48 bg-[var(--bg-deep)] text-lg font-semibold"
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void rename(name)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void rename(name);
              if (event.key === "Escape") {
                renamingRef.current = false;
                setName(spec.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h1 className="mr-auto inline-flex min-w-0 items-center gap-1 text-lg font-semibold tracking-tight">
            <span className="truncate">{spec.name}</span>
            <Tip label="Rename">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(ICON_BUTTON_CLASS, "size-7 opacity-60 hover:!opacity-100")}
                aria-label="Rename"
                disabled={saving}
                onClick={() => {
                  setName(spec.name);
                  renamingRef.current = true;
                  setRenaming(true);
                }}
              >
                <Pencil size={14} strokeWidth={2} />
              </Button>
            </Tip>
          </h1>
        )}
        {dashboards.length > 0 ? (
          <Select value={dashboardId} onValueChange={(id) => onNavigate({ page: "dashboard", id })}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_DASHBOARD_ID}>TALOS</SelectItem>
              {dashboards.map((dashboard) => (
                <SelectItem key={dashboard.id} value={dashboard.id}>{dashboard.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button type="button" variant="outline" onClick={() => setRefreshToken((token) => token + 1)}>
          <RefreshCw />
          Refresh
        </Button>
        {owned && editing ? (
          <Button
            type="button"
            disabled={saving}
            onClick={() => {
              void persist(widgets).then((saved) => {
                if (saved) setEditing(false);
              });
            }}
          >
            Done
          </Button>
        ) : null}
        {owned ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Dashboard actions"
                disabled={saving}
              >
                <Ellipsis className="rotate-90" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem onSelect={() => onAskTalos(addWidgetPrompt(dashboardId, spec.name))}>
                <Plus />
                Add widget
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={saving}
                onSelect={() => {
                  if (!editing) {
                    setEditing(true);
                    return;
                  }
                  void persist(widgets).then((saved) => {
                    if (saved) setEditing(false);
                  });
                }}
              >
                <Pencil />
                {editing ? "Done" : "Edit layout"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={saving}
                onSelect={() => void removeDashboard()}
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button type="button" disabled={saving} onClick={() => void saveCopy()}>Save a copy</Button>
        )}
      </header>
      {error ? <p className="px-4 pt-3 text-sm text-destructive">{error}</p> : null}
      {/* Same notice as Tickets and merge requests: a widget that calls GitLab
          or Jira as this person cannot load until their own token is stored.
          An instance token would answer as someone else. */}
      {needed.length > 0 ? (
        <div className="px-4">
          <ProviderAccessNotice
            providers={needed}
            purpose={(missing) => dashboardAccessPurpose(missing)}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <DashboardGrid
          widgets={widgets}
          editing={editing && owned}
          refreshToken={refreshToken}
          onRemove={(id) => setWidgets((current) => current.filter((widget) => widget.id !== id))}
          onLayout={(layout, ids) => {
            setWidgets((current) => {
              const byId = new Map(current.map((widget) => [widget.id, widget]));
              const next = ids.flatMap((id, index) => {
                const widget = byId.get(id);
                const item = layout[index];
                return widget && item ? [{ ...widget, layout: item }] : [];
              });
              const unchanged = next.length === current.length && next.every((widget, index) => {
                const previous = current[index];
                return previous?.id === widget.id
                  && previous.layout.x === widget.layout.x
                  && previous.layout.y === widget.layout.y
                  && previous.layout.w === widget.layout.w
                  && previous.layout.h === widget.layout.h;
              });
              return unchanged ? current : next;
            });
          }}
        />
      </div>
    </div>
  );
}

function availableName(wanted: string, existing: readonly string[]): string {
  const used = new Set(existing.map((name) => name.trim().toLowerCase()));
  const root = wanted.trim().slice(0, 80);
  if (root && !used.has(root.toLowerCase())) return root;
  return uniqueCopyName(root || "Dashboard", existing);
}

/** "TALOS" is the built-in dashboard, so the first saved copy is "TALOS 2". */
function uniqueCopyName(base: string, existing: readonly string[]): string {
  const used = new Set(existing.map((name) => name.trim().toLowerCase()));
  const root = (base.trim() || "Dashboard").slice(0, 70);
  used.add(root.toLowerCase());
  for (let number = 2; number < 1000; number += 1) {
    const candidate = `${root} ${number}`;
    if (candidate.length <= 80 && !used.has(candidate.toLowerCase())) return candidate;
  }
  return `${root} ${Date.now()}`.slice(0, 80);
}

function widgetsFor(widgets: Widget[], datasets: DatasetCatalogEntry[]): Widget[] {
  if (datasets.length === 0) return widgets;
  const allowed = new Set(datasets.map((dataset) => dataset.id));
  return widgets.filter((widget) => allowed.has(widget.query.dataset));
}
