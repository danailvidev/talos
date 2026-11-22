import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AbilityProvider, useAbility } from "@casl/react";
import {
  Bell,
  ChevronsLeft,
  ChevronsRight,
  Cog,
  FlaskConical,
  GitPullRequest,
  Infinity as InfinityIcon,
  LayoutDashboard,
  Menu,
  MessagesSquare,
  MonitorPlay,
  Radar,
  Rocket,
  Search,
  Shield,
  Workflow,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import {
  api,
  onUnauthorized,
  type AuthUser,
  type NotificationView,
  type SlackActivityView,
} from "./api.ts";
import { AcceptInvitation } from "./AcceptInvitation.tsx";
import { AssistantIcon } from "./AssistantIcon.tsx";
import { AssistantSidebar } from "./AssistantDrawer.tsx";
import { ago } from "./format.ts";
import { FeedbackDialog } from "./FeedbackDialog.tsx";
import { ProviderAccessDialog } from "./ProviderAccessDialog.tsx";
import { ForgotPassword } from "./ForgotPassword.tsx";
import { GlobalSearch } from "./GlobalSearch.tsx";
import { LandingPage } from "./LandingPage.tsx";
import { Logo } from "./Logo.tsx";
import { Login } from "./Login.tsx";
import { ResetPassword } from "./ResetPassword.tsx";
import { SetupReminderDialog } from "./SetupReminderDialog.tsx";
import { queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { queryClient } from "./query-client.ts";
import { canAccessPage, defaultRouteForAbility } from "./module-access.ts";
import { useRoute } from "./router.ts";
import { JobQueueProvider, useJobQueue } from "./JobQueueContext.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { loopRowsFrom } from "./task-rows.ts";
import { Tip } from "./Tip.tsx";
import { PreferencesProvider } from "./PreferencesContext.tsx";
import { FormatProvider } from "./FormatContext.tsx";
import { ThemeProvider } from "./ThemeContext.tsx";
import { TimezoneProvider } from "./TimezoneContext.tsx";
import { ToastViewport, useToasts } from "./Toast.tsx";
import { useApi } from "./useApi.ts";
import { UserMenu } from "./UserMenu.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Drawer,
  DrawerContent,
} from "./components/ui/drawer.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.tsx";
import { useNarrowLayout } from "./useNarrowLayout.ts";
import { cn } from "./lib/utils.ts";
import {
  BRAND_MARK_CLASS,
  ICON_BUTTON_CLASS,
  SEARCH_ROW_CLASS,
} from "./app-styles.ts";
import { LOADING_STATE_CLASS } from "./state-styles.ts";
import {
  createAppAbility,
  type AppAbility,
} from "../../shared/authorization.ts";
import type { SlackInboxPanels } from "./SlackInboxPage.tsx";

// Route-level chunks keep graph layout, charts, settings forms, and provider
// detail code out of the initial authenticated shell. Each module uses named
// exports, hence the small adapters React.lazy expects.
const DashboardsPage = lazy(() =>
  import("./DashboardsPage.tsx").then((m) => ({ default: m.DashboardsPage })),
);
const JiraSpacePage = lazy(() =>
  import("./JiraSpacePage.tsx").then((m) => ({ default: m.JiraSpacePage })),
);
const LogRocketPage = lazy(() => import("./LogRocketPage.tsx").then((m) => ({ default: m.LogRocketPage })));
const DatadogPage = lazy(() => import("./DatadogPage.tsx").then((m) => ({ default: m.DatadogPage })));
const LoopsDashboard = lazy(() => import("./LoopsDashboard.tsx").then((m) => ({ default: m.LoopsDashboard })));
const PullRequestsPage = lazy(() => import("./PullRequestsPage.tsx").then((m) => ({ default: m.PullRequestsPage })));
const ReleasesPage = lazy(() => import("./ReleasesPage.tsx").then((m) => ({ default: m.ReleasesPage })));
const AutomationPage = lazy(() => import("./AutomationPage.tsx").then((m) => ({ default: m.AutomationPage })));
const SlackInboxPage = lazy(() => import("./SlackInboxPage.tsx").then((m) => ({ default: m.SlackInboxPage })));
const SettingsPage = lazy(() => import("./SettingsPage.tsx").then((m) => ({ default: m.SettingsPage })));
const LoopsPage = lazy(() => import("./LoopsPage.tsx").then((m) => ({ default: m.LoopsPage })));
const AdminPage = lazy(() => import("./AdminPage.tsx").then((m) => ({ default: m.AdminPage })));

type AuthPage = "landing" | "login" | "forgot" | "reset";

function authPageFromPath(pathname: string): AuthPage {
  if (pathname === "/") return "landing";
  if (pathname === "/forgot-password") return "forgot";
  if (pathname === "/reset-password") return "reset";
  return "login";
}

function pathForAuthPage(page: AuthPage): string {
  if (page === "landing") return "/";
  if (page === "forgot") return "/forgot-password";
  if (page === "reset") return "/reset-password";
  return "/login";
}

/**
 * Console over the TALOS API, sharing one top bar/search/footer across
 * its pages. The dashboard is the home page: a signed-in user lands on an empty
 * dashboard and can open the built-in TALOS dashboard or ask the assistant to
 * build one. Pull request detail still owns everything that happened to a merge
 * request — actions, queued jobs and run history alike.
 *
 * There is no ad-hoc Tasks page any more. Every task it listed had a better-placed
 * trigger elsewhere (PR actions, the graph's "Fix this issue"), and its one piece
 * of unique value — run history — now lives on the pull request the run was about.
 * Tasks remain the execution substrate (`core/task.ts`), but the console does not
 * draw a page for them. Loops keep theirs, since a schedule, a watermark and tracked issues
 * are inherently task-scoped: a card dashboard at `/loops`, the older split list
 * at `/loops?view=list` and `/loops/:id`.
 */
export function App() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [showSetupReminder, setShowSetupReminder] = useState(false);
  const [authPage, setAuthPage] = useState<AuthPage>(() =>
    authPageFromPath(window.location.pathname),
  );
  const urlToken = new URLSearchParams(window.location.search).get("token") ?? "";
  const resetToken = urlToken;
  const [invitationToken, setInvitationToken] = useState(() => {
    if (window.location.pathname !== "/accept-invite") return "";
    return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
  });
  /**
   * Every identity change goes through here, because every one of them has to
   * empty the cache. Signing out, a session expiring and signing back in all
   * leave the app mounted, so without the `clear()` the next person to use this
   * browser would paint the previous user's merge requests — repositories they
   * may have no access to — before the first refetch replaced them.
   */
  const changeIdentity = (next: AuthUser | null) => {
    queryClient.clear();
    if (next === null) setShowSetupReminder(false);
    setUser(next);
  };

  const completeLogin = (next: AuthUser) => {
    setShowSetupReminder(true);
    changeIdentity(next);
  };

  const showAuthPage = (next: AuthPage, options?: { replace?: boolean }) => {
    let path = pathForAuthPage(next);
    const returnTo = new URLSearchParams(window.location.search).get("returnTo");
    if (next !== "landing" && returnTo) {
      path += `?returnTo=${encodeURIComponent(returnTo)}`;
    }
    if (options?.replace) {
      window.history.replaceState(null, "", path);
    } else {
      window.history.pushState(null, "", path);
    }
    setAuthPage(next);
  };

  useEffect(() => {
    if (invitationToken) return;
    api
      .session()
      .then((session) => setUser(session.user))
      .catch(() => setUser(null));
  }, [invitationToken]);

  useEffect(() => {
    if (invitationToken && window.location.hash) {
      // Keep the bearer token out of screenshots, copied addresses and later
      // browser history while retaining it in component state for submission.
      window.history.replaceState(null, "", "/accept-invite");
    }
  }, [invitationToken]);

  useEffect(() => {
    onUnauthorized(() => {
      // A session expiring mid-use (not the initial session check, which is
      // excluded in api.ts) drops the user here — carry the page they were
      // on so login/register can send them back after they sign in again.
      if (!window.location.pathname.startsWith("/login")) {
        const returnTo = window.location.pathname + window.location.search;
        window.history.pushState(null, "", `/login?returnTo=${encodeURIComponent(returnTo)}`);
      }
      setAuthPage("login");
      changeIdentity(null);
    });
  }, []);

  useEffect(() => {
    const onPopState = () => setAuthPage(authPageFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  if (invitationToken) {
    return (
      <AcceptInvitation
        token={invitationToken}
        onAccepted={(acceptedUser) => {
          window.history.replaceState(null, "", "/");
          setInvitationToken("");
          completeLogin(acceptedUser);
        }}
      />
    );
  }

  if (user === undefined) {
    return (
      <div className="grid min-h-screen place-items-center text-muted-foreground">
        Loading TALOS…
      </div>
    );
  }
  if (user === null) {
    if (authPage === "landing") {
      return (
        <LandingPage
          onSignIn={() => showAuthPage("login")}
        />
      );
    }
    if (authPage === "forgot") {
      return <ForgotPassword onShowLogin={() => showAuthPage("login")} />;
    }
    if (authPage === "reset" && resetToken) {
      return (
        <ResetPassword
          token={resetToken}
          onReset={() => showAuthPage("login", { replace: true })}
          onShowLogin={() => showAuthPage("login")}
        />
      );
    }
    return (
      <Login
        onLogin={completeLogin}
        onShowForgotPassword={() => showAuthPage("forgot")}
      />
    );
  }

  return (
    // Inside the auth gate, because preferences are the signed-in user's: mounting
    // this above it would read one account's settings and hand them to the next.
    <TimezoneProvider>
      <PreferencesProvider>
        <ThemeProvider>
          {/* A formatted date needs the instance's timezone (above) and this
              developer's chosen notation (a preference, also above). */}
          <FormatProvider>
            <JobQueueProvider tasksEnabled={user.permissions.includes("loops:access")}>
              <AuthorizedConsole
                user={user}
                // A rename in My profile, folded into the session held here. Not an
                // identity change: the cache still describes the same account, so
                // this deliberately does not go through `changeIdentity`.
                onRenamed={(name) => setUser((prev) => (prev ? { ...prev, name } : prev))}
                showSetupReminder={showSetupReminder}
                onDismissSetupReminder={() => setShowSetupReminder(false)}
                onLogout={async () => {
                  try {
                    await api.logout();
                  } finally {
                    changeIdentity(null);
                  }
                }}
              />
            </JobQueueProvider>
          </FormatProvider>
        </ThemeProvider>
      </PreferencesProvider>
    </TimezoneProvider>
  );
}

function AuthorizedConsole(props: {
  user: AuthUser;
  onLogout: () => Promise<void>;
  onRenamed: (name: string) => void;
  showSetupReminder: boolean;
  onDismissSetupReminder: () => void;
}) {
  return (
    <AbilityProvider value={createAppAbility(props.user.permissions)}>
      <ConsoleApp {...props} />
    </AbilityProvider>
  );
}

// Collapsed, the sidebar is icon-only and relies on the hover tooltip to say
// what each icon means; expanded, the label is right there so the tooltip
// would just be noise.
function NavItem({
  label,
  icon,
  active,
  expanded,
  badge,
  showCollapsedBadge = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  expanded: boolean;
  badge?: number;
  showCollapsedBadge?: boolean;
  onClick: () => void;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      className={cn(
        "relative mb-0.5 h-auto min-h-11 w-full cursor-pointer justify-center gap-2 rounded-[var(--radius)] border-0 border-l-2 border-transparent bg-transparent px-0 py-2 text-left font-[inherit] text-[0.9375rem] text-[var(--text-dim)] transition-[transform,background,color] duration-120 hover:translate-x-0.5 hover:bg-[var(--bg-hover)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-x-0 disabled:hover:bg-transparent min-[901px]:min-h-0 [&_svg]:shrink-0",
        expanded && "justify-start px-2.5",
        active && "border-l-action bg-[var(--bg-hover)] font-medium text-foreground",
      )}
      onClick={onClick}
    >
      <span className="relative flex shrink-0">
        {icon}
        {!expanded && showCollapsedBadge && badge !== undefined ? (
          <span className="absolute -top-2 -right-2 h-[15px] min-w-[15px] rounded-full bg-action px-[3px] text-center text-xs leading-[15px] font-bold text-[var(--bg-deep)]">
            {badge}
          </span>
        ) : null}
      </span>
      {expanded ? <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span> : null}
      {expanded && badge !== undefined ? (
        <span className={cn("ml-auto text-[0.7812rem] text-[var(--text-dim)]", active && "text-foreground")}>
          {badge}
        </span>
      ) : null}
    </Button>
  );
  if (expanded) return button;
  return (
    <Tip label={badge !== undefined ? `${label} (${badge})` : label} side="right">
      {button}
    </Tip>
  );
}

function SlackNavItem({
  active,
  expanded,
  onClick,
}: {
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  const activity = useApi(queries.slackActivity());
  const unread = activity.data?.unreadCount ?? 0;
  return (
    <NavItem
      label="Team chat"
      badge={unread > 0 ? unread : undefined}
      showCollapsedBadge
      expanded={expanded}
      active={active}
      onClick={onClick}
      icon={<MessagesSquare size={14} strokeWidth={2} />}
    />
  );
}

function useSlackActivityStream(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const events = new EventSource("/api/me/slack/activity/stream");
    events.onmessage = (event) => {
      try {
        const activity = JSON.parse(event.data) as SlackActivityView;
        if (
          typeof activity.revision === "number" &&
          typeof activity.unreadCount === "number"
        ) {
          queryClient.setQueryData(keys.slackActivity(), activity);
        }
      } catch {
        // Ignore one malformed event; EventSource remains connected.
      }
    };
    return () => events.close();
  }, [enabled]);
}

function ConsoleApp({
  user,
  onLogout,
  onRenamed,
  showSetupReminder,
  onDismissSetupReminder,
}: {
  user: AuthUser;
  onLogout: () => Promise<void>;
  onRenamed: (name: string) => void;
  showSetupReminder: boolean;
  onDismissSetupReminder: () => void;
}) {
  const [requestedRoute, navigate] = useRoute();
  const { push } = useToasts();
  const ability = useAbility<AppAbility>();
  const defaultRoute = defaultRouteForAbility(ability);
  const requestedRouteAllowed = canAccessPage(ability, requestedRoute.page);
  const route = requestedRouteAllowed ? requestedRoute : defaultRoute ?? requestedRoute;
  const noAccessiblePage = !canAccessPage(ability, route.page);
  const canAccessLoops = ability.can("read", "Loop");
  const canAccessPullRequests = ability.can("read", "PullRequest");
  const canAccessReleases = ability.can("read", "Release");
  const canAccessAutomation = ability.can("read", "Automation");
  const canAccessLogRocket = ability.can("read", "LogRocket");
  const canAccessDatadog = ability.can("read", "Datadog");
  const canAccessTickets = ability.can("read", "Ticket");
  const canAccessSlack = ability.can("read", "Slack");
  const canSearch = canAccessPullRequests || canAccessTickets;
  useSlackActivityStream(canAccessSlack);
  const [slackNavigation, setSlackNavigation] = useState<
    SlackInboxPanels & { selectedId?: string }
  >(() => ({
    selectedId: requestedRoute.page === "slack" ? requestedRoute.id : undefined,
    channelsOpen: true,
    directMessagesOpen: true,
    appsOpen: true,
  }));

  useEffect(() => {
    if (requestedRouteAllowed || !defaultRoute) return;
    navigate(defaultRoute, { replace: true });
  }, [requestedRouteAllowed, defaultRoute?.page, navigate]);

  useEffect(() => {
    if (route.page !== "dashboard") return;
    if (!window.location.pathname.startsWith("/dashboards")) return;
    navigate(route, { replace: true });
  }, [route, navigate]);

  useEffect(() => {
    if (route.page !== "slack" || !route.id) return;
    setSlackNavigation((current) =>
      current.selectedId === route.id
        ? current
        : { ...current, selectedId: route.id },
    );
  }, [route.page, route.id]);

  // Persisted so the sidebar doesn't snap back to icon-only on every reload.
  const [sidebarExpanded, setSidebarExpanded] = useState(
    () => localStorage.getItem("sidebarExpanded") === "true",
  );
  useEffect(() => {
    localStorage.setItem("sidebarExpanded", String(sidebarExpanded));
  }, [sidebarExpanded]);

  const narrow = useNarrowLayout();
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const [notifOpen, setNotifOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantSeed, setAssistantSeed] = useState<{ id: number; text: string } | null>(null);

  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [providerAccessOpen, setProviderAccessOpen] = useState(false);

  // Shared with the footer badge, task rows and anything else that shows a
  // running-jobs indicator, so they all read the same numbers.
  const {
    system,
    tasks: all,
    hasMoreTasks,
    loadMoreTasks,
    refresh: refreshTasks,
  } = useJobQueue();
  // Polled unconditionally rather than only while a run is in flight, which is
  // what the job queue's own entries do: that would miss a Fix Jira Issue run
  // finishing while nothing else was running.
  const notifications = useApi(queries.notifications());
  const agentUsage = useApi(queries.agentUsage({
    days: 30,
    ...(user.role.id === "admin" ? { scope: "all" as const } : {}),
    limit: 1,
    offset: 0,
  }));
  const seenNotificationIds = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    const rows = notifications.data?.notifications;
    if (!rows) return;

    const currentIds = new Set(rows.map((notification) => notification.id));
    const previousIds = seenNotificationIds.current;
    if (previousIds) {
      for (const notification of [...rows].reverse()) {
        if (
          notification.kind === "release-pipeline-watch" &&
          !previousIds.has(notification.id)
        ) {
          push(
            notification.body
              ? `${notification.title}. ${notification.body}`
              : notification.title,
            {
              severity: "error",
              duration: 8_000,
              ...(notification.link
                ? {
                    action: {
                      label: "Open GitLab",
                      onClick: () =>
                        window.open(notification.link, "_blank", "noopener,noreferrer"),
                    },
                  }
                : {}),
            },
          );
        }
      }
    }
    seenNotificationIds.current = currentIds;
  }, [notifications.data, push]);

  // The LogRocket page appears only once the integration is configured: with no
  // API key there is nothing behind it but setup instructions, and an install
  // that does not use LogRocket should not carry a nav icon for it. Read off the
  // system view, which already reports which known secrets are set.
  const logRocketEnabled =
    system.data?.secrets.some((s) => s.name === "LOGROCKET_API_KEY" && s.present) ?? false;

  // Same rule for Datadog, and the same reason: without a token the page is setup
  // instructions, and an install that does not use Datadog should not carry the icon.
  const datadogEnabled =
    system.data?.secrets.some((s) => s.name === "DATADOG_TOKEN" && s.present) ?? false;

  const rows = all.data?.tasks ?? [];
  const loops = loopRowsFrom(rows);
  const loopDefinitions = loops.definitions;
  const loopRows = loops.work;

  const loopsDashboard = route.page === "loops" && !route.id && route.view !== "list";
  // Opening the loops *list* view with no id picks the first row, so its detail
  // pane is never an empty "select something". The only page that needs this:
  // pull requests are a two-pane split too but their rows come from
  // `/api/pull-requests`, so that page picks its own first row, and the dashboard
  // and the ticket board open on everything — the board's `?ticket=` is a
  // selection somebody made, never one to invent.
  //
  // Only fill a missing id — do not treat "not in this payload yet" as stale,
  // because creating an instance selects it and then refetches, and the previous
  // list does not include it.
  useEffect(() => {
    if (route.page !== "loops" || loopsDashboard) return;
    if (route.id || loopRows.length === 0) return;
    navigate({ ...route, id: loopRows[0]!.id }, { replace: true });
  }, [route.page, route.id, route.view, loopRows.length]);

  // Opening the loop behind a ticket's activity, from the board's detail panel.
  // Every task-shaped id opens on Loops, `kind` regardless: with the Tasks page
  // gone there is nowhere else for one to land, and `TaskDetail` renders any
  // instance by id whether or not the loops list contains it — so a `kind: "task"`
  // instance still opens rather than dead-ending on a "no matches" pane.
  function selectAndNavigate(id: string) {
    if (!canAccessLoops) {
      push("Your role does not include access to Loops.", { severity: "error" });
      return;
    }
    const hit = rows.find((row) => row.id === id);
    navigate({
      page: "loops",
      id,
      tab: hit?.visibility === "private" ? "mine" : undefined,
    });
  }

  function activate(action: () => void) {
    return () => {
      setNavOpen(false);
      setSearchOpen(false);
      action();
    };
  }

  const askTalos = (text: string) => {
    setAssistantSeed({ id: Date.now(), text });
    setAssistantOpen(true);
  };

  const navigation = (
    <>
      <div>
        <NavItem
          label="Overview"
          expanded={narrow || sidebarExpanded}
          active={route.page === "dashboard"}
          onClick={activate(() => navigate({ page: "dashboard" }))}
          icon={<LayoutDashboard size={14} strokeWidth={2} />}
        />
        {canAccessLoops ? (
          <NavItem
            label="Loops"
            badge={loopRows.length}
            expanded={narrow || sidebarExpanded}
            active={route.page === "loops"}
            onClick={activate(() => navigate({ page: "loops" }))}
            icon={<InfinityIcon size={14} strokeWidth={2} />}
          />
        ) : null}
        {canAccessPullRequests ? (
          <NavItem
            label="Pull requests"
            expanded={narrow || sidebarExpanded}
            active={route.page === "pull-requests"}
            onClick={activate(() => navigate({ page: "pull-requests" }))}
            icon={<GitPullRequest size={14} strokeWidth={2} />}
          />
        ) : null}
        {canAccessReleases ? (
          <NavItem
            label="Releases"
            expanded={narrow || sidebarExpanded}
            active={route.page === "releases"}
            onClick={activate(() => navigate({ page: "releases" }))}
            icon={<Rocket size={14} strokeWidth={2} />}
          />
        ) : null}
        {canAccessAutomation ? (
          <NavItem
            label="Automation"
            expanded={narrow || sidebarExpanded}
            active={route.page === "automation"}
            onClick={activate(() => navigate({ page: "automation" }))}
            icon={<FlaskConical size={14} strokeWidth={2} />}
          />
        ) : null}
        {canAccessLogRocket && logRocketEnabled ? (
          <NavItem
            label="LogRocket"
            expanded={narrow || sidebarExpanded}
            active={route.page === "logrocket"}
            onClick={activate(() => navigate({ page: "logrocket" }))}
            icon={<MonitorPlay size={14} strokeWidth={2} />}
          />
        ) : null}
        {canAccessDatadog && datadogEnabled ? (
          <NavItem
            label="Datadog"
            expanded={narrow || sidebarExpanded}
            active={route.page === "datadog"}
            onClick={activate(() => navigate({ page: "datadog" }))}
            icon={<Radar size={14} strokeWidth={2} />}
          />
        ) : null}
        {canAccessTickets ? (
          <NavItem
            label="Tickets"
            expanded={narrow || sidebarExpanded}
            active={route.page === "space"}
            onClick={activate(() =>
              navigate({
                page: "space",
                ...(route.page === "space" && route.spaceKey
                  ? { spaceKey: route.spaceKey }
                  : {}),
              }),
            )}
            icon={<Workflow size={14} strokeWidth={2} />}
          />
        ) : null}
      </div>
      <div className="mt-auto">
        {canAccessSlack ? (
          <SlackNavItem
            expanded={narrow || sidebarExpanded}
            active={route.page === "slack"}
            onClick={activate(() =>
              navigate({ page: "slack", id: slackNavigation.selectedId }),
            )}
          />
        ) : null}
        <div className="-mx-2 my-2 border-t border-border" />
        {ability.can("manage", "User") ||
        ability.can("read", "ApplicationLog") ||
        ability.can("manage", "InstanceSettings") ? (
          <NavItem
            label="Admin"
            expanded={narrow || sidebarExpanded}
            active={route.page === "admin"}
            onClick={activate(() => navigate({
              page: "admin",
              adminTab: ability.can("manage", "User") ? "users" : "orchestration",
            }))}
            icon={<Shield size={14} strokeWidth={2} />}
          />
        ) : null}
        {ability.can("manage", "InstanceSettings") ? (
          <NavItem
            label="Settings"
            expanded={narrow || sidebarExpanded}
            active={route.page === "settings"}
            onClick={activate(() => navigate({ page: "settings" }))}
            icon={<Cog size={14} strokeWidth={2} />}
          />
        ) : null}
        {narrow ? null : (
          <Tip label={sidebarExpanded ? "Collapse" : "Expand"} side="right">
            <Button
              type="button"
              variant="ghost"
              className={cn(
                "relative mb-0.5 h-auto w-full cursor-pointer justify-center gap-2 rounded-[var(--radius)] border-0 border-l-2 border-transparent bg-transparent px-0 py-2 text-left font-[inherit] text-[0.9375rem] text-[var(--text-dim)] transition-[transform,background,color] duration-120 hover:translate-x-0.5 hover:bg-[var(--bg-hover)] hover:text-foreground",
                sidebarExpanded && "justify-start px-2.5",
              )}
              aria-label={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
              onClick={() => setSidebarExpanded((expanded) => !expanded)}
            >
              {sidebarExpanded ? (
                <ChevronsLeft size={14} strokeWidth={2} />
              ) : (
                <ChevronsRight size={14} strokeWidth={2} />
              )}
              {sidebarExpanded ? (
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">Collapse</span>
              ) : null}
            </Button>
          </Tip>
        )}
      </div>
    </>
  );

  const openTicket = (key: string) => {
    setSearchOpen(false);
    navigate({
      page: "space",
      spaceKey: key.split("-")[0],
      ticket: key,
      ...(route.page === "space" ? { tab: route.tab } : {}),
    });
  };
  const openPullRequest = (id: string) => {
    setSearchOpen(false);
    navigate({ page: "pull-requests", id });
  };

  return (
    <div className="fixed inset-0 grid h-dvh w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <header className="relative flex flex-col border-b border-border bg-background">
        <div className="flex h-12 items-center gap-2 px-3 min-[901px]:gap-4 min-[901px]:px-6">
        {narrow ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(ICON_BUTTON_CLASS, "size-11")}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <Menu size={18} strokeWidth={2} />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="h-auto cursor-pointer border-0 bg-transparent p-0 transition-opacity hover:bg-transparent hover:opacity-80"
          onClick={() => defaultRoute && navigate(defaultRoute)}
          aria-label="TALOS home"
        >
          <Logo
            size={28}
            variant={narrow ? "mark" : "horizontal"}
            className={BRAND_MARK_CLASS}
          />
        </Button>
        {canSearch && !narrow ? (
          <div className="absolute top-1/2 left-1/2 w-full max-w-115 -translate-x-1/2 -translate-y-1/2">
            <GlobalSearch
              // The space's own scope is kept only when the space is what is on
              // screen: `tab` means a different thing on the page being left, and
              // arriving from Pull requests should not switch which scope opens.
              onOpenTicket={openTicket}
              onOpenPullRequest={openPullRequest}
            />
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-1 text-sm text-[var(--text-dim)] min-[901px]:gap-2">
          {!narrow && system.data?.dryRun ? <StatusBadge status="warn">dry-run</StatusBadge> : null}
          {!narrow && system.data?.orphanedRuns ? (
            <StatusBadge status="failure">
              <Tip label="Runs claimed but never finished">
                <span>{system.data.orphanedRuns} orphaned</span>
              </Tip>
            </StatusBadge>
          ) : null}
          <Popover
            open={notifOpen}
            onOpenChange={(open) => {
              setNotifOpen(open);
              if (open && (notifications.data?.unreadCount ?? 0) > 0) {
                void api
                  .markNotificationsRead()
                  .then(() => queryClient.invalidateQueries({ queryKey: keys.notifications() }));
              }
            }}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  ICON_BUTTON_CLASS,
                  "self-center hover:translate-y-0 max-[900px]:size-11",
                )}
                aria-label="Notifications"
              >
                <Bell size={16} strokeWidth={2} />
                {(notifications.data?.unreadCount ?? 0) > 0 ? (
                  <span className="absolute top-[3px] right-[3px] inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-action px-[3px] text-xs leading-none font-bold text-[var(--bg-deep)]">
                    {notifications.data!.unreadCount}
                  </span>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="max-h-90 w-[min(320px,calc(100vw-24px))] gap-0 overflow-y-auto rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] p-1.5 shadow-[var(--shadow-panel)]"
              align="end"
              sideOffset={6}
            >
              <NotificationPopover notifications={notifications.data?.notifications ?? []} />
            </PopoverContent>
          </Popover>
          {canSearch && narrow ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(ICON_BUTTON_CLASS, "size-11")}
              aria-label={searchOpen ? "Close search" : "Search"}
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen((open) => !open)}
            >
              <Search size={18} strokeWidth={2} />
            </Button>
          ) : null}
          <Tip label={assistantOpen ? "Close Talos assistant" : "Open Talos assistant"}>
            <Button
              type="button"
              variant="ghost"
              className="h-8.5 self-center gap-1.5 rounded-full border-border px-3 text-muted-foreground hover:border-[var(--border-strong)] hover:bg-[var(--bg-raised)] hover:text-foreground max-[900px]:size-11 max-[900px]:px-0"
              aria-label={assistantOpen ? "Close assistant" : "Open assistant"}
              aria-expanded={assistantOpen}
              onClick={() => setAssistantOpen((open) => !open)}
            >
              <AssistantIcon size={17} />
              <span className="max-[900px]:sr-only">Ask Talos</span>
            </Button>
          </Tip>
          <UserMenu
            user={user}
            onLogout={onLogout}
            onRenamed={onRenamed}
            onOpenProviderAccess={() => setProviderAccessOpen(true)}
          />
        </div>
        </div>
        {canSearch && narrow && searchOpen ? (
          <div className="px-3 pb-2">
            <GlobalSearch onOpenTicket={openTicket} onOpenPullRequest={openPullRequest} />
          </div>
        ) : null}
      </header>

      {narrow ? (
        <Drawer open={navOpen} onOpenChange={setNavOpen} swipeDirection="left">
          <DrawerContent
            className="bg-[var(--bg-raised)]"
            style={
              { "--drawer-content-width": "min(20rem, 88vw)" } as React.CSSProperties
            }
          >
            <nav
              aria-label="Primary"
              className="flex h-full flex-col overflow-y-auto overscroll-contain px-2 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            >
              {navigation}
            </nav>
          </DrawerContent>
        </Drawer>
      ) : null}

      <div
        className={cn(
          "grid min-h-0",
          narrow ? "grid-cols-1 grid-rows-1" : "grid-cols-[auto_minmax(0,1fr)_auto_auto]",
        )}
      >
        {narrow ? null : (
          <nav
            aria-label="Primary"
            className={cn(
              "flex w-12 flex-col overflow-hidden border-r border-border bg-[var(--bg-raised)] px-2 py-3 transition-[width] duration-150",
              sidebarExpanded && "w-44",
            )}
          >
            {navigation}
          </nav>
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={route.page === "loops" ? (loopsDashboard ? "loops-dashboard" : "loops-list") : route.page}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className="grid h-full min-h-0 min-w-0 overflow-hidden"
          >
            <Suspense fallback={<div className={LOADING_STATE_CLASS}>Loading page…</div>}>
            {noAccessiblePage ? (
              <div className="grid place-items-center p-8 text-center text-muted-foreground">
                No application modules are assigned to your role. Contact an administrator.
              </div>
            ) : route.page === "dashboard" ? (
              <DashboardsPage
                route={route}
                onNavigate={navigate}
                onAskTalos={askTalos}
              />
            ) : route.page === "admin" ? (
              ability.can("manage", "User") ||
              ability.can("read", "ApplicationLog") ||
              ability.can("manage", "InstanceSettings") ? (
                <AdminPage
                  tab={route.adminTab ?? "users"}
                  currentUserId={user.id}
                  onSetTab={(adminTab) => navigate({ page: "admin", adminTab })}
                />
              ) : (
                <div className="grid place-items-center p-8 text-muted-foreground">
                  User-management or application-log permission is required.
                </div>
              )
            ) : route.page === "settings" ? (
              ability.can("manage", "InstanceSettings") ? (
                <SettingsPage
                  settingsTab={route.settingsTab}
                  onSetSettingsTab={(tab) => navigate({ page: "settings", settingsTab: tab })}
                />
              ) : (
                <div className="grid place-items-center p-8 text-muted-foreground">
                  Instance-settings permission is required.
                </div>
              )
            ) : route.page === "pull-requests" ? (
              <PullRequestsPage
                tab={route.tab ?? "mine"}
                // Dropping the id: the other tab lists different merge
                // requests, so the selected one is not in it.
                onSetTab={(tab) => navigate({ page: "pull-requests", tab })}
                selectedId={route.id}
                onSelect={(id, opts) =>
                  navigate({ page: "pull-requests", id, tab: route.tab }, opts)
                }
              />
            ) : route.page === "releases" ? (
              <ReleasesPage
                initialTab={route.releasesTab}
                onToast={push}
                onOpenSettings={
                  ability.can("manage", "InstanceSettings")
                    ? () => navigate({ page: "settings", settingsTab: "releases" })
                    : undefined
                }
              />
            ) : route.page === "automation" ? (
              <AutomationPage
                pipelineId={route.id}
                tab={route.automationTab}
                failureRoute={route.automationFailures}
                onSelectPipeline={(pipelineId) =>
                  navigate({ page: "automation", id: String(pipelineId) })
                }
                onBack={() => navigate({ page: "automation" })}
                onSetTab={(automationTab) =>
                  navigate({
                    page: "automation",
                    automationTab,
                    ...(automationTab === "failures" &&
                    route.automationFailures
                      ? { automationFailures: route.automationFailures }
                      : {}),
                  })
                }
                onFailureRouteChange={(automationFailures) =>
                  navigate({
                    page: "automation",
                    automationTab: "failures",
                    automationFailures,
                  })
                }
                canManageSettings={ability.can("manage", "InstanceSettings")}
              />
            ) : route.page === "slack" ? (
              <SlackInboxPage
                selectedId={route.id}
                onSelect={(id, options) => {
                  setSlackNavigation((current) => ({ ...current, selectedId: id }));
                  navigate({ page: "slack", id }, options);
                }}
                panels={slackNavigation}
                onPanelsChange={(next) =>
                  setSlackNavigation((current) => ({ ...current, ...next }))
                }
              />
            ) : route.page === "logrocket" ? (
              <LogRocketPage
                onToast={push}
                onOpenSettings={() =>
                  navigate({ page: "settings", settingsTab: "integrations" })
                }
              />
            ) : route.page === "datadog" ? (
              <DatadogPage
                onToast={push}
                onOpenSettings={() =>
                  navigate({ page: "settings", settingsTab: "integrations" })
                }
              />
            ) : route.page === "space" ? (
              <JiraSpacePage
                spaceKey={route.spaceKey}
                onSpaceResolved={(spaceKey) =>
                  navigate({ ...route, page: "space", spaceKey }, { replace: true })
                }
                scope={route.tab ?? "mine"}
                // Dropping the ticket: the panel belongs to the board you were
                // looking at, and the other scope's clusters are different rows.
                onScope={(tab) =>
                  navigate({ page: "space", spaceKey: route.spaceKey, tab })
                }
                selectedTicket={route.ticket}
                onSelectTicket={(ticket) =>
                  navigate({
                    page: "space",
                    spaceKey: route.spaceKey,
                    tab: route.tab,
                    ticket,
                  })
                }
                onOpenTask={selectAndNavigate}
                onOpenSettings={() =>
                  navigate({ page: "settings", settingsTab: "pull-requests" })
                }
              />
            ) : loopsDashboard ? (
              <LoopsDashboard
                rows={loopRows}
                definitions={loopDefinitions}
                loading={all.loading}
                error={all.error}
                addOpen={!!route.add}
                onSetAdd={(add) => navigate({ page: "loops", add: add || undefined })}
                onOpenLoop={(id) => {
                  const hit = loopRows.find((row) => row.id === id);
                  navigate({ page: "loops", id, tab: hit?.visibility === "private" ? "mine" : undefined });
                }}
                onListView={() => navigate({ page: "loops", view: "list" })}
                onCreated={(id) => {
                  refreshTasks();
                  navigate({ page: "loops", id });
                }}
                onChanged={() => refreshTasks()}
                hasMore={hasMoreTasks}
                onLoadMore={loadMoreTasks}
                onToast={push}
              />
            ) : (
              <LoopsPage
                title="Loops"
                rows={loopRows}
                definitions={loopDefinitions}
                loading={all.loading}
                error={all.error}
                selectedId={route.id}
                onSelect={(id) => navigate({ page: "loops", id, tab: route.tab })}
                onDashboard={() => navigate({ page: "loops" })}
                tab={route.tab ?? "team"}
                onSetTab={(tab) => navigate({ ...route, tab: tab === "team" ? undefined : tab })}
                addOpen={!!route.add}
                onSetAdd={(add) => navigate({ ...route, add: add || undefined })}
                onCreated={(id) => {
                  refreshTasks();
                  navigate({ page: "loops", id, tab: route.tab });
                }}
                onChanged={() => refreshTasks()}
                hasMore={hasMoreTasks}
                onLoadMore={loadMoreTasks}
                // Drops the id but keeps `view: "list"`, so the effect above
                // selects the next remaining loop rather than bouncing to the
                // card dashboard.
                onDeleted={() => {
                  refreshTasks();
                  navigate({ ...route, id: undefined });
                }}
                onToast={push}
              />
            )}
            </Suspense>
          </motion.div>
        </AnimatePresence>

        <AssistantSidebar
          key={user.id}
          open={assistantOpen}
          onOpenChange={setAssistantOpen}
          seed={assistantSeed}
          userId={user.id}
        />
      </div>

      <footer className="flex h-11 items-center gap-3 overflow-x-auto border-t border-border bg-[var(--bg-raised)] px-3 text-xs whitespace-nowrap text-[var(--text-faint)] min-[901px]:h-5.5 min-[901px]:gap-4 min-[901px]:px-4 min-[901px]:text-[0.7812rem]">
        <span>TALOS v{system.data?.version ?? "…"}</span>
        {narrow && system.data?.dryRun ? <span>dry-run</span> : null}
        {narrow && system.data?.orphanedRuns ? (
          <span>
            {system.data.orphanedRuns} orphaned
          </span>
        ) : null}
        <span className="text-[var(--border-strong)] max-[900px]:hidden">|</span>
        <span className="max-[900px]:hidden">schema v{system.data?.schemaVersion ?? "—"}</span>
        <span className="text-[var(--border-strong)] max-[900px]:hidden">|</span>
        <span className="max-[900px]:hidden">
          {footerUsage(agentUsage.data?.totals)}
        </span>
        {system.data && system.data.runningJobs > 0 && (
          <>
            <span className="text-[var(--border-strong)]">|</span>
            <span className="inline-flex items-center gap-1.5 text-[var(--running)]">
              <span className="size-1.5 rounded-full bg-[var(--running)]" aria-hidden="true" />
              {system.data.runningJobs} job{system.data.runningJobs === 1 ? "" : "s"} running
            </span>
          </>
        )}
        <Button
          type="button"
          variant="link"
          className="ml-auto h-11 border-0 px-2 font-mono [font-size:inherit] [font-weight:inherit] [line-height:inherit] text-inherit hover:text-foreground min-[901px]:h-auto min-[901px]:p-0"
          onClick={() => setFeedbackOpen(true)}
        >
          Feedback
        </Button>
      </footer>

      <AnimatePresence>
        {feedbackOpen && (
          <FeedbackDialog
            onClose={() => setFeedbackOpen(false)}
            onOpenProviderAccess={() => setProviderAccessOpen(true)}
          />
        )}
        {providerAccessOpen ? (
          <ProviderAccessDialog onClose={() => setProviderAccessOpen(false)} />
        ) : null}
      </AnimatePresence>

      {showSetupReminder ? (
        <SetupReminderDialog onClose={onDismissSetupReminder} />
      ) : null}

      <ToastViewport />
    </div>
  );
}

function footerUsage(
  totals: {
    invocations: number;
    knownUsageInvocations: number;
    tokens: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    };
  } | undefined,
): string {
  if (!totals) return "30d agent usage …";
  if (totals.invocations > 0 && totals.knownUsageInvocations === 0) {
    return `30d agent usage unknown · ${totals.invocations} invocation${totals.invocations === 1 ? "" : "s"}`;
  }
  const newContext = totals.tokens.inputTokens + totals.tokens.cacheCreationInputTokens;
  const output = totals.tokens.outputTokens;
  const compact = (value: number) => new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
  return `30d agent usage ${compact(newContext)} new · ${compact(output)} output`;
}

function NotificationPopover({ notifications }: { notifications: NotificationView[] }) {
  if (notifications.length === 0) {
    return (
      <div className="px-2.5 py-3.5 text-center text-[0.9375rem] text-[var(--text-faint)]">
        You are all caught up
      </div>
    );
  }

  return (
    <div>
      {notifications.map((n) => (
        <a
          key={n.id}
          className={SEARCH_ROW_CLASS}
          href={n.link ?? undefined}
          target={n.link ? "_blank" : undefined}
          rel={n.link ? "noreferrer" : undefined}
        >
          <span className="flex items-baseline gap-1.5">{n.title}</span>
          {n.body ? <span className="mt-0.5 text-sm text-muted-foreground">{n.body}</span> : null}
          <span className="mt-0.5 text-sm text-muted-foreground">{ago(n.createdAt)}</span>
        </a>
      ))}
    </div>
  );
}
