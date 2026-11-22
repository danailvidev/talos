import { useState } from "react";
import { AnimatePresence } from "motion/react";
import {
  Activity,
  Bell,
  IdCard,
  KeyRound,
  LogOut,
  Palette,
  Plug,
  UserRound,
} from "lucide-react";

import { AgentConnectionsDialog } from "./AgentConnectionsDialog.tsx";
import { AgentUsageDialog } from "./AgentUsageDialog.tsx";
import { NotificationsDialog } from "./NotificationsDialog.tsx";
import { ProfileDialog } from "./ProfileDialog.tsx";
import { ThemeDialog } from "./ThemeDialog.tsx";
import type { AuthUser } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.tsx";
import { UserAvatar } from "./pr/Avatar.tsx";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { ICON_BUTTON_CLASS } from "./app-styles.ts";
import { cn } from "./lib/utils.ts";

const USER_MENU_ACTION_CLASS =
  "h-auto min-h-11 w-full cursor-pointer justify-start gap-2 rounded-none border-0 bg-transparent p-2 font-[inherit] text-[var(--text-dim)] hover:bg-[var(--bg-hover)] hover:text-foreground min-[901px]:min-h-0";

/**
 * Everything that is the signed-in developer's own, in one place.
 *
 * The dividing line against Settings: that page is the instance — one row in the
 * database, the same for everybody, and an operator's business. This menu is you.
 * Profile and notifications were tabs on that page first, which invited the
 * reading that muting a notification muted it for the team.
 */
type UserDialog =
  | "profile"
  | "notifications"
  | "theme"
  | "agent-connections"
  | "agent-usage";

export function UserMenu({
  user,
  onLogout,
  onRenamed,
  onOpenProviderAccess,
}: {
  user: AuthUser;
  onLogout: () => Promise<void>;
  onRenamed: (name: string) => void;
  onOpenProviderAccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<UserDialog>();
  const providerAccess = useApi(queries.providerAccess());
  const avatarUser = providerAccess.data?.gitlabUser ?? {
    username: user.email,
    name: user.name,
  };

  async function logout() {
    setBusy(true);
    try {
      await onLogout();
    } finally {
      setBusy(false);
    }
  }

  function openDialog(next: UserDialog) {
    setOpen(false);
    setDialog(next);
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              ICON_BUTTON_CLASS,
              "self-center rounded-full hover:translate-y-0 max-[900px]:size-11",
            )}
            aria-label="User settings"
          >
            <UserRound size={17} strokeWidth={2} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-55 gap-0 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] p-2 shadow-[var(--shadow-panel)]"
          align="end"
          sideOffset={7}
        >
          <div className="flex items-center gap-2.5 border-b border-border p-2">
            <UserAvatar
              user={avatarUser}
              size={34}
              className="inline-flex size-8.5 shrink-0 items-center justify-center overflow-hidden rounded-full !bg-action object-cover font-bold !text-[var(--bg-deep)]"
            />
            <span className="min-w-0">
              <strong className="block">{user.name}</strong>
              <small className="block overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-faint)]">
                {user.email}
              </small>
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            className={USER_MENU_ACTION_CLASS}
            onClick={() => openDialog("profile")}
          >
            <IdCard size={14} />
            My profile
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={USER_MENU_ACTION_CLASS}
            onClick={() => openDialog("notifications")}
          >
            <Bell size={14} />
            My notifications
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={USER_MENU_ACTION_CLASS}
            onClick={() => openDialog("theme")}
          >
            <Palette size={14} />
            Theme
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={cn(USER_MENU_ACTION_CLASS, "border-t border-border")}
            onClick={() => openDialog("agent-connections")}
          >
            <Plug size={14} />
            Agent connections
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={USER_MENU_ACTION_CLASS}
            onClick={() => openDialog("agent-usage")}
          >
            <Activity size={14} />
            Agent usage
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={USER_MENU_ACTION_CLASS}
            onClick={() => {
              setOpen(false);
              onOpenProviderAccess();
            }}
          >
            <KeyRound size={14} />
            My provider access
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={cn(
              USER_MENU_ACTION_CLASS,
              "border-t border-border text-[var(--brand)] hover:text-[var(--action-hover)]",
            )}
            disabled={busy}
            onClick={logout}
          >
            <LogOut size={14} />
            {busy ? "Signing out…" : "Sign out"}
          </Button>
        </PopoverContent>
      </Popover>
      <AnimatePresence>
        {dialog === "profile" ? (
          <ProfileDialog onClose={() => setDialog(undefined)} onRenamed={onRenamed} />
        ) : null}
        {dialog === "notifications" ? (
          <NotificationsDialog onClose={() => setDialog(undefined)} />
        ) : null}
        {dialog === "theme" ? <ThemeDialog onClose={() => setDialog(undefined)} /> : null}
        {dialog === "agent-connections" ? (
          <AgentConnectionsDialog onClose={() => setDialog(undefined)} />
        ) : null}
        {dialog === "agent-usage" ? (
          <AgentUsageDialog
            allowGlobal={user.role.id === "admin"}
            onClose={() => setDialog(undefined)}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}
