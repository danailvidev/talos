import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpDown, AtSign, Bot, Check, ChevronLeft, ChevronRight, Clock3, Copy, Ellipsis, Filter, Hash, Image, Link, MessageCircle, Paperclip, Pencil, Plus, RefreshCw, Search, Send, Settings2, SmilePlus, Trash2, UserRound, Users, X } from "lucide-react";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";

import {
  api,
  type SlackChannelView,
  type SlackConversationMembersView,
  type SlackConversationView,
  type SlackConversationSearchFilters,
  type SlackConversationSearchResultView,
  type SlackMessageSendResult,
  type SlackMessageAttachmentView,
  type SlackMessageBlockView,
  type SlackMessageView,
  type SlackReactionView,
  type SlackUserProfileView,
  type SlackWorkspaceUserView,
} from "./api.ts";
import { ICON_BUTTON_CLASS } from "./app-styles.ts";
import { Button } from "./components/ui/button.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
} from "./components/ui/drawer.tsx";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./components/ui/input-group.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { Switch } from "./components/ui/switch.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ago } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { ProviderAccessButton, useProviderAccessDialog } from "./ProviderAccessNotice.tsx";
import { keys } from "./query-keys.ts";
import { queries } from "./queries.ts";
import { EMPTY_STATE_CLASS } from "./state-styles.ts";
import { Tip } from "./Tip.tsx";
import { useToasts } from "./Toast.tsx";
import { useApi, type AsyncQuery } from "./useApi.ts";
import { useDebounced } from "./useDebounced.ts";
import { MasterDetail } from "./MasterDetail.tsx";
import { useMobileDetail } from "./useMobileDetail.ts";
import { useNarrowLayout } from "./useNarrowLayout.ts";
import { useResizableWidth } from "./useResizableWidth.ts";
import { SlackIcon } from "./SlackIcon.tsx";
import { replaceSlackEmojiShortcodes } from "./slack-emoji.ts";
import { usePreference } from "./PreferencesContext.tsx";

/** Must stay identical to `SLACK_READ_SYNC_PREFERENCE` in shared/api-contract.ts. */
const SLACK_READ_SYNC_PREFERENCE = "slack.markReadInSlack";

type ConversationSectionFilter = "all" | "unread";
type ConversationSectionSort = "recent" | "alphabetical";

function filterAndSortConversations(
  conversations: SlackConversationView[],
  filter: ConversationSectionFilter,
  sort: ConversationSectionSort,
): SlackConversationView[] {
  const filtered =
    filter === "unread"
      ? conversations.filter((conversation) => conversation.unread)
      : conversations;
  return [...filtered].sort((a, b) =>
    sort === "alphabetical"
      ? a.name.localeCompare(b.name)
      : (b.latestTs ?? "").localeCompare(a.latestTs ?? ""),
  );
}

const SLACK_REACTIONS = [
  { name: "+1", emoji: "👍", label: "Thumbs up" },
  { name: "heart", emoji: "❤️", label: "Heart" },
  { name: "joy", emoji: "😂", label: "Joy" },
  { name: "tada", emoji: "🎉", label: "Celebrate" },
  { name: "eyes", emoji: "👀", label: "Eyes" },
  { name: "white_check_mark", emoji: "✅", label: "Done" },
  { name: "clap", emoji: "👏", label: "Clap" },
  { name: "pray", emoji: "🙏", label: "Thanks" },
  { name: "fire", emoji: "🔥", label: "Fire" },
  { name: "rocket", emoji: "🚀", label: "Rocket" },
  { name: "thinking_face", emoji: "🤔", label: "Thinking" },
  { name: "wave", emoji: "👋", label: "Wave" },
] as const;

const SLACK_MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1_000;

function messagesShareSlackGroup(
  message: SlackMessageView,
  previousMessage: SlackMessageView | undefined,
): boolean {
  if (!previousMessage) return false;

  const sameSender =
    message.userId && previousMessage.userId
      ? message.userId === previousMessage.userId
      : message.userName === previousMessage.userName &&
        message.avatarUrl === previousMessage.avatarUrl;
  if (!sameSender) return false;

  const messageTime = new Date(message.at).getTime();
  const previousTime = new Date(previousMessage.at).getTime();
  return (
    !Number.isNaN(messageTime) &&
    !Number.isNaN(previousTime) &&
    Math.abs(messageTime - previousTime) <= SLACK_MESSAGE_GROUP_WINDOW_MS
  );
}

function slackMessageTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
    .format(date)
    .replace(/\s?[ap]\.?m\.?$/i, "");
}

export function SlackInboxPage({
  selectedId,
  onSelect,
  panels,
  onPanelsChange,
}: {
  selectedId?: string;
  onSelect: (id: string, options?: { replace?: boolean }) => void;
  panels: SlackInboxPanels;
  onPanelsChange: (next: Partial<SlackInboxPanels>) => void;
}) {
  const connection = useApi(queries.slackConnection());
  const providerAccess = useProviderAccessDialog();
  // Captured once before the cleanup below. The connection query renders a
  // loading state first; recomputing from location after replaceState used to
  // erase the OAuth failure before the page had a chance to show it.
  const [callbackError] = useState(
    () => new URLSearchParams(window.location.search).get("message"),
  );

  useEffect(() => {
    if (!window.location.search.includes("slack=")) return;
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  if (connection.loading) return <Loading>Loading Slack connection…</Loading>;
  if (connection.error) return <div className="p-8"><ErrorBox>{connection.error}</ErrorBox></div>;

  if (!connection.data?.configured) {
    return (
      <div className="grid min-h-0 place-items-center p-8">
        <div className="flex max-w-lg flex-col items-center gap-4 text-center">
          <SlackIcon size={34} />
          <div>
            <h1 className="text-xl font-semibold">Connect your Slack inbox</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              TALOS reads your direct and group messages plus the channels you select. It
              can send as your connected Slack user, optionally synchronize read state,
              and never retains message bodies.
            </p>
          </div>
          {callbackError ? <ErrorBox>{callbackError}</ErrorBox> : null}
          <ProviderAccessButton onOpen={providerAccess.open}>Connect Slack</ProviderAccessButton>
          {providerAccess.dialog}
        </div>
      </div>
    );
  }

  return (
    <>
      <ConnectedInbox
        selectedId={selectedId}
        onSelect={onSelect}
        panels={panels}
        onPanelsChange={onPanelsChange}
        groupDmsEnabled={connection.data.groupDmsEnabled === true}
        liveUpdatesConfigured={connection.data.liveUpdatesConfigured === true}
        reliableUnreadEnabled={connection.data.reliableUnreadEnabled === true}
        userGroupMentionsEnabled={connection.data.userGroupMentionsEnabled === true}
        postingEnabled={connection.data.postingEnabled === true}
        reactionsEnabled={connection.data.reactionsEnabled === true}
        imageUploadsEnabled={connection.data.imageUploadsEnabled === true}
        readSyncAvailable={connection.data.readSyncAvailable === true}
      />
      {providerAccess.dialog}
    </>
  );
}

export interface SlackInboxPanels {
  channelsOpen: boolean;
  directMessagesOpen: boolean;
  appsOpen: boolean;
}

function ConnectedInbox({
  selectedId,
  onSelect,
  panels,
  onPanelsChange,
  groupDmsEnabled,
  liveUpdatesConfigured,
  reliableUnreadEnabled,
  userGroupMentionsEnabled,
  postingEnabled,
  reactionsEnabled,
  imageUploadsEnabled,
  readSyncAvailable,
}: {
  selectedId?: string;
  onSelect: (id: string, options?: { replace?: boolean }) => void;
  panels: SlackInboxPanels;
  onPanelsChange: (next: Partial<SlackInboxPanels>) => void;
  groupDmsEnabled: boolean;
  liveUpdatesConfigured: boolean;
  reliableUnreadEnabled: boolean;
  userGroupMentionsEnabled: boolean;
  postingEnabled: boolean;
  reactionsEnabled: boolean;
  imageUploadsEnabled: boolean;
  readSyncAvailable: boolean;
}) {
  const queryClient = useQueryClient();
  const { push: pushToast } = useToasts();
  const listing = useApi(queries.slackInbox());
  const activity = useApi(queries.slackActivity());
  const activityRevision = useRef<number | undefined>(undefined);
  const [visibleDmCount, setVisibleDmCount] = useState(10);
  const [channelFilter, setChannelFilter] = useState<ConversationSectionFilter>("all");
  const [channelSort, setChannelSort] = useState<ConversationSectionSort>("recent");
  const [directMessageFilter, setDirectMessageFilter] =
    useState<ConversationSectionFilter>("all");
  const [directMessageSort, setDirectMessageSort] =
    useState<ConversationSectionSort>("recent");
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const [markingChannelsRead, setMarkingChannelsRead] = useState(false);
  const [hidingConversationId, setHidingConversationId] = useState<string | null>(null);
  const [localRead, setLocalRead] = useState<Map<string, string>>(() => new Map());
  const [markReadInSlack, setMarkReadInSlack] = usePreference(
    SLACK_READ_SYNC_PREFERENCE,
    (raw) => raw === true,
  );
  const { width, onPointerDown, onPointerMove, onPointerUp } = useResizableWidth(
    "talos-slack-list-width",
    340,
    240,
    600,
  );
  const narrow = useNarrowLayout();
  const mobileDetail = useMobileDetail(selectedId);

  useEffect(() => {
    setVisibleDmCount(10);
  }, [listing.data, directMessageFilter, directMessageSort]);

  useEffect(() => {
    const revision = activity.data?.revision;
    if (revision == null) return;
    if (activityRevision.current != null && revision !== activityRevision.current) {
      const changed = activity.data?.changedConversationIds ?? [];
      const refreshSelected = selectedId != null && changed.includes(selectedId);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.slackInbox() }),
        ...(refreshSelected
          ? [
              queryClient.invalidateQueries({
                queryKey: keys.slackMessages(selectedId),
              }),
              queryClient.invalidateQueries({
                queryKey: ["slack", "thread", selectedId],
              }),
            ]
          : []),
      ]);
    }
    activityRevision.current = revision;
  }, [activity.data, queryClient, selectedId]);

  const rows = useMemo(() => {
    const byId = new Map<string, SlackConversationView>();
    for (const row of listing.data?.conversations ?? []) {
      const localReadTs = localRead.get(row.id);
      const locallyRead =
        localReadTs != null &&
        (row.latestTs == null || localReadTs.localeCompare(row.latestTs) >= 0);
      byId.set(row.id, locallyRead ? { ...row, unread: false } : row);
    }
    return [...byId.values()].sort((a, b) => {
      const kindOrder = Number(a.kind === "channel") - Number(b.kind === "channel");
      if (kindOrder !== 0) return kindOrder;
      return (b.latestTs ?? "").localeCompare(a.latestTs ?? "");
    });
  }, [listing.data, localRead]);
  const allPrivateConversations = rows.filter(
    (row) => row.kind !== "channel" && !row.app,
  );
  const apps = rows.filter((row) => row.app);
  const allChannels = rows.filter((row) => row.kind === "channel");
  const privateConversations = filterAndSortConversations(
    allPrivateConversations,
    directMessageFilter,
    directMessageSort,
  );
  const channels = filterAndSortConversations(allChannels, channelFilter, channelSort);
  useEffect(() => {
    if (selectedId || rows.length === 0) return;
    onSelect(rows[0]!.id, { replace: true });
  }, [rows.length, selectedId]);

  async function refresh() {
    setVisibleDmCount(10);
    setLocalRead(new Map());
    await api.resyncSlack();
    await queryClient.invalidateQueries({ queryKey: keys.allSlack() });
  }

  async function selectConversation(row: SlackConversationView) {
    mobileDetail.showDetail();
    if (row.id === selectedId && row.unread && row.latestTs) {
      await api.markSlackRead({
        conversationId: row.id,
        timestamp: row.latestTs,
      });
      setLocalRead((current) => new Map(current).set(row.id, row.latestTs!));
      return;
    }
    onSelect(row.id);
  }

  async function markAllChannelsRead() {
    const unread = allChannels.filter((row) => row.unread && row.latestTs);
    if (unread.length === 0 || markingChannelsRead) return;

    setMarkingChannelsRead(true);
    const results = await Promise.allSettled(
      unread.map(async (row) => {
        await api.markSlackRead({
          conversationId: row.id,
          timestamp: row.latestTs!,
        });
        return row;
      }),
    );
    const marked = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (marked.length > 0) {
      setLocalRead((current) => {
        const next = new Map(current);
        for (const row of marked) next.set(row.id, row.latestTs!);
        return next;
      });
    }
    const failed = results.length - marked.length;
    if (failed > 0) {
      pushToast(
        failed === results.length
          ? "Could not mark channels as read."
          : `Marked ${marked.length} channels as read; ${failed} failed.`,
        { severity: "error" },
      );
    }
    setMarkingChannelsRead(false);
  }

  async function hideDirectMessage(row: SlackConversationView) {
    if (hidingConversationId) return;
    setHidingConversationId(row.id);
    try {
      await api.hideSlackDirectMessage(row.id);
      if (row.id === selectedId) {
        const next = rows.find((candidate) => candidate.id !== row.id);
        if (next) onSelect(next.id, { replace: true });
      }
      await queryClient.invalidateQueries({ queryKey: keys.slackInbox() });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), { severity: "error" });
    } finally {
      setHidingConversationId(null);
    }
  }

  async function openDirectMessage(userId: string) {
    const conversation = await api.openSlackDirectMessage({ userId });
    onPanelsChange({ directMessagesOpen: true });
    await queryClient.invalidateQueries({ queryKey: keys.slackInbox() });
    mobileDetail.showDetail();
    onSelect(conversation.id);
  }

  return (
    <MasterDetail
      narrow={narrow}
      detailOpen={mobileDetail.open}
      onBack={mobileDetail.showList}
      backLabel="Inbox"
      width={width}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      list={
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-md leading-none font-semibold tracking-[0.06em] text-[var(--text-dim)]">
            <SlackIcon size={14} />
            <span>SLACK</span>
            {liveUpdatesConfigured ? (
              <span className="size-1.5 rounded-full bg-[var(--success)]" title="Live updates configured" />
            ) : null}
          </span>
          <div className="flex items-center gap-0.5">
            <ChannelPicker
              open={channelPickerOpen}
              onOpenChange={setChannelPickerOpen}
              onChanged={async () => {
                await queryClient.invalidateQueries({ queryKey: keys.allSlack() });
              }}
              markReadInSlack={markReadInSlack}
              readSyncAvailable={readSyncAvailable}
              onMarkReadInSlack={setMarkReadInSlack}
            />
            <Tip label="Refresh from Slack">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={ICON_BUTTON_CLASS}
                aria-label="Refresh Slack inbox"
                disabled={listing.fetching}
                onClick={refresh}
              >
                <RefreshCw
                  size={16}
                  className={listing.fetching ? "animate-spin" : ""}
                />
              </Button>
            </Tip>
          </div>
        </div>
        {!groupDmsEnabled ? (
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            1:1 DMs remain available. Add <span className="mono">mpim:read</span> and{" "}
            <span className="mono">mpim:history</span> to the Slack app and reconnect
            to include group DMs.
          </div>
        ) : null}
        {!reliableUnreadEnabled ? (
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            Inactive-DM unread detection needs <span className="mono">search:read</span>.
            Add it to the Slack app and reconnect; Socket Mode remains active meanwhile.
          </div>
        ) : null}
        {!userGroupMentionsEnabled ? (
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            User-group aliases need <span className="mono">usergroups:read</span>.
            Add it to the Slack app and reconnect under My provider access.
          </div>
        ) : null}
        {!postingEnabled ? (
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            Sending needs the <span className="mono">chat:write</span> user scope.
            Add it to the Slack app and reconnect under My provider access.
          </div>
        ) : null}
        {!reactionsEnabled ? (
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            Reactions need the <span className="mono">reactions:write</span> user scope.
            Add it and reconnect under My provider access.
          </div>
        ) : null}
        {!imageUploadsEnabled ? (
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            Image attachments need <span className="mono">files:read</span> and{" "}
            <span className="mono">files:write</span>. Add them and reconnect.
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listing.loading ? (
            <Loading>Reading Slack…</Loading>
          ) : listing.error ? (
            <div className="p-3"><ErrorBox>{listing.error}</ErrorBox></div>
          ) : (
            <div className="py-1.5">
              <ConversationSection
                title="Channels"
                open={panels.channelsOpen}
                onToggle={() =>
                  onPanelsChange({ channelsOpen: !panels.channelsOpen })
                }
                action={
                  <ConversationSectionMenu
                    section="channels"
                    canMarkAllRead={channels.some((row) => row.unread && row.latestTs)}
                    markingAllRead={markingChannelsRead}
                    onMarkAllRead={markAllChannelsRead}
                    onBrowseChannels={() => setChannelPickerOpen(true)}
                    filter={channelFilter}
                    onFilterChange={setChannelFilter}
                    sort={channelSort}
                    onSortChange={setChannelSort}
                  />
                }
              >
                {channels.length === 0 ? (
                  <p className="px-5 py-2 text-sm text-muted-foreground">
                    {channelFilter === "unread" && allChannels.length > 0
                      ? "No unread channels."
                      : "No channels selected."}
                  </p>
                ) : (
                  channels.map((row) => (
                    <ConversationRow
                      key={row.id}
                      row={row}
                      selected={row.id === selectedId}
                      onSelect={() => void selectConversation(row)}
                    />
                  ))
                )}
              </ConversationSection>
              <ConversationSection
                title="Direct messages"
                icon={<MessageCircle size={16} />}
                open={panels.directMessagesOpen}
                onToggle={() =>
                  onPanelsChange({
                    directMessagesOpen: !panels.directMessagesOpen,
                  })
                }
                action={
                  <>
                    <NewDirectMessageButton
                      onOpened={async (conversation) => {
                        onPanelsChange({ directMessagesOpen: true });
                        await queryClient.invalidateQueries({ queryKey: keys.slackInbox() });
                        onSelect(conversation.id);
                      }}
                    />
                    <ConversationSectionMenu
                      section="direct-messages"
                      filter={directMessageFilter}
                      onFilterChange={setDirectMessageFilter}
                      sort={directMessageSort}
                      onSortChange={setDirectMessageSort}
                    />
                  </>
                }
              >
                {privateConversations.length === 0 ? (
                  <p className="px-5 py-2 text-sm text-muted-foreground">
                    {directMessageFilter === "unread" && allPrivateConversations.length > 0
                      ? "No unread direct messages."
                      : "No direct messages yet."}
                  </p>
                ) : (
                  privateConversations.slice(0, visibleDmCount).map((row) => (
                    <ConversationRow
                      key={row.id}
                      row={row}
                      selected={row.id === selectedId}
                      onSelect={() => void selectConversation(row)}
                      hiding={hidingConversationId === row.id}
                      onHide={() => void hideDirectMessage(row)}
                    />
                  ))
                )}
                {privateConversations.length > visibleDmCount ? (
                  <div className="px-3 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full"
                      onClick={() => setVisibleDmCount((count) => count + 10)}
                    >
                      Show more
                    </Button>
                  </div>
                ) : null}
              </ConversationSection>
              <ConversationSection
                title="Apps"
                icon={<Bot size={16} />}
                open={panels.appsOpen}
                onToggle={() => onPanelsChange({ appsOpen: !panels.appsOpen })}
              >
                {apps.length === 0 ? (
                  <p className="px-5 py-2 text-sm text-muted-foreground">
                    No app conversations.
                  </p>
                ) : (
                  apps.map((row) => (
                    <ConversationRow
                      key={row.id}
                      row={row}
                      selected={row.id === selectedId}
                      onSelect={() => void selectConversation(row)}
                      hiding={hidingConversationId === row.id}
                      onHide={() => void hideDirectMessage(row)}
                    />
                  ))
                )}
              </ConversationSection>
            </div>
          )}
        </div>
      </div>

      }
      detail={
      <div className="h-full min-h-0 overflow-hidden">
        {selectedId ? (
          <ConversationDetail
            key={selectedId}
            conversationId={selectedId}
            readOnOpen={
              !listing.fetching &&
              rows.some((row) => row.id === selectedId && row.unread)
            }
            onRead={(timestamp) =>
              setLocalRead((current) => new Map(current).set(selectedId, timestamp))
            }
            postingEnabled={postingEnabled}
            reactionsEnabled={reactionsEnabled}
            imageUploadsEnabled={imageUploadsEnabled}
            searchEnabled={reliableUnreadEnabled}
            onOpenDirectMessage={openDirectMessage}
          />
        ) : (
          <div className={EMPTY_STATE_CLASS}>Select a Slack conversation.</div>
        )}
      </div>
      }
    />
  );
}

function ConversationSection({
  title,
  icon,
  open,
  onToggle,
  action,
  children,
}: {
  title: string;
  icon?: ReactNode;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="group/header relative">
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-base font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          onClick={onToggle}
        >
          <ChevronRight
            size={13}
            className={cn("transition-transform", open && "rotate-90")}
          />
          {icon}
          <span>{title}</span>
        </Button>
        {action ? (
          <div className="absolute top-1/2 right-2 z-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/header:opacity-100 group-hover/header:opacity-100 has-[[data-state=open]]:opacity-100">
            {action}
          </div>
        ) : null}
      </div>
      {open ? children : null}
    </section>
  );
}

function ConversationSectionMenu({
  section,
  canMarkAllRead = false,
  markingAllRead = false,
  onMarkAllRead,
  onBrowseChannels,
  filter,
  onFilterChange,
  sort,
  onSortChange,
}: {
  section: "channels" | "direct-messages";
  canMarkAllRead?: boolean;
  markingAllRead?: boolean;
  onMarkAllRead?: () => Promise<void>;
  onBrowseChannels?: () => void;
  filter: ConversationSectionFilter;
  onFilterChange: (filter: ConversationSectionFilter) => void;
  sort: ConversationSectionSort;
  onSortChange: (sort: ConversationSectionSort) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          aria-label={`${section === "channels" ? "Channel" : "Direct message"} section actions`}
        >
          <Ellipsis size={18} className="rotate-90" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {section === "channels" ? (
          <>
            <DropdownMenuItem
              disabled={!canMarkAllRead || markingAllRead}
              onSelect={() => void onMarkAllRead?.()}
            >
              <Check />
              {markingAllRead ? "Marking as read…" : "Mark all as read"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              <Plus />
              Create a channel
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onBrowseChannels}>
              <Hash />
              Browse channels
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Filter />
            Filter
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(value) =>
                onFilterChange(value as ConversationSectionFilter)
              }
            >
              <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="unread">Unread only</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ArrowUpDown />
            Sort
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) =>
                onSortChange(value as ConversationSectionSort)
              }
            >
              <DropdownMenuRadioItem value="recent">Recent activity</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="alphabetical">Alphabetical</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NewDirectMessageButton({
  onOpened,
}: {
  onOpened: (conversation: SlackConversationView) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debouncedSearch = useDebounced(search.trim(), 250);
  const users = useApi(queries.slackUsers(debouncedSearch, open));

  async function startConversation(user: SlackWorkspaceUserView) {
    if (openingId) return;
    setOpeningId(user.id);
    setError(null);
    try {
      const conversation = await api.openSlackDirectMessage({ userId: user.id });
      setOpen(false);
      setSearch("");
      await onOpened(conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setSearch("");
          setError(null);
        }
      }}
    >
      <Tip label="New direct message" side="top">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Start a new direct message"
            onClick={(event) => event.stopPropagation()}
          >
            <Plus size={16} />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="start" sideOffset={4} className="w-72 gap-0 overflow-hidden p-0">
        <Command shouldFilter={false} className="rounded-none p-0">
          <CommandInput
            autoFocus
            placeholder="Search people…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-64 p-1">
            {users.loading ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">Loading people…</div>
            ) : users.error ? (
              <div className="px-2 py-3 text-sm text-destructive">{users.error}</div>
            ) : (users.data?.users.length ?? 0) === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                No matching people.
              </div>
            ) : (
              (users.data?.users ?? []).map((user) => (
                <CommandItem
                  key={user.id}
                  value={`${user.name} ${user.id}`}
                  disabled={openingId != null}
                  onSelect={() => void startConversation(user)}
                >
                  {user.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt=""
                      className="size-5 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-muted text-[10px] font-semibold">
                      {user.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {openingId === user.id ? "Opening…" : user.name}
                  </span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
        {error ? <div className="border-t border-border p-2"><ErrorBox>{error}</ErrorBox></div> : null}
      </PopoverContent>
    </Popover>
  );
}

function ConversationRow({
  row,
  selected,
  onSelect,
  hiding = false,
  onHide,
}: {
  row: SlackConversationView;
  selected: boolean;
  onSelect: () => void;
  hiding?: boolean;
  onHide?: () => void;
}) {
  return (
    <div className="group/conversation relative">
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "h-auto w-full justify-start rounded-none border-0 border-l-2 border-l-transparent px-5 py-2 text-left text-base font-normal hover:bg-[var(--bg-hover)]",
          onHide && "pr-11",
          selected && "border-l-action bg-[var(--bg-hover)]",
          row.unread && "font-semibold",
        )}
        onClick={onSelect}
      >
        <span className="flex min-w-0 flex-1">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {row.kind === "channel" ? (
              <span className="flex min-w-0 items-center gap-1">
                <span className="text-muted-foreground">#</span>
                <span className="truncate">{row.name.replace(/^#/, "")}</span>
              </span>
            ) : row.kind === "group-dm" ? (
              <span className="grid size-5 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
                <Users size={14} aria-hidden="true" />
              </span>
            ) : (
              <span className="relative shrink-0">
                {row.avatarUrl ? (
                  <img
                    src={row.avatarUrl}
                    alt=""
                    className="size-5 rounded-sm object-cover"
                  />
                ) : (
                  <span className="grid size-5 place-items-center">
                    <MessageCircle size={13} />
                  </span>
                )}
                {row.kind === "dm" && row.online ? (
                  <span
                    className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-[var(--status-success)] ring-1 ring-background"
                    aria-label="Online"
                    title="Online"
                  />
                ) : null}
              </span>
            )}
            {row.kind !== "channel" ? <span className="truncate">{row.name}</span> : null}
            {row.unread ? (
              <span
                className="ml-auto size-2 rounded-full bg-action"
                aria-label="Unread"
                title="New message"
              />
            ) : null}
          </span>
        </span>
      </Button>
      {onHide ? (
        <Tip label="Hide direct message" side="left">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute top-1/2 right-3 -translate-y-1/2 opacity-0 transition-opacity group-focus-within/conversation:opacity-100 group-hover/conversation:opacity-100"
            aria-label={`Hide direct message with ${row.name}`}
            disabled={hiding}
            onClick={onHide}
          >
            <X size={13} />
          </Button>
        </Tip>
      ) : null}
    </div>
  );
}

function ChannelPicker({
  open,
  onOpenChange,
  onChanged,
  markReadInSlack,
  readSyncAvailable,
  onMarkReadInSlack,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
  markReadInSlack: boolean;
  readSyncAvailable: boolean;
  onMarkReadInSlack: (enabled: boolean) => void;
}) {
  const channels = useApi(queries.slackChannels());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (channels.data) setSelected(new Set(channels.data.selectedIds));
  }, [channels.data]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.setSlackChannels({ channelIds: [...selected] });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={ICON_BUTTON_CLASS}
          aria-label="Choose Slack channels"
        >
          <Settings2 size={16} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div>
          <h2 className="font-medium">Slack inbox settings</h2>
        </div>
        <div className="flex items-start justify-between gap-4 rounded-md border border-border p-2.5">
          <div>
            <div className="text-sm font-medium">Mark read in Slack</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Opening a conversation in TALOS also clears its unread state in Slack.
              {!readSyncAvailable
                ? " Add channels:write, groups:write, im:write and mpim:write, then reconnect."
                : ""}
            </p>
          </div>
          <Switch
            checked={markReadInSlack && readSyncAvailable}
            disabled={!readSyncAvailable}
            aria-label="Mark conversations read in Slack"
            onCheckedChange={onMarkReadInSlack}
          />
        </div>
        <div>
          <h3 className="text-sm font-medium">Channels in your inbox</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Direct messages are always included. Select up to 20 channels.
          </p>
        </div>
        {channels.loading ? (
          <Loading>Loading channels…</Loading>
        ) : channels.error ? (
          <ErrorBox>{channels.error}</ErrorBox>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            {(channels.data?.channels ?? []).map((channel) => (
              <ChannelOption
                key={channel.id}
                channel={channel}
                checked={selected.has(channel.id)}
                onChecked={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(channel.id);
                    else next.delete(channel.id);
                    return next;
                  })
                }
              />
            ))}
          </div>
        )}
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <div className="flex justify-end">
          <Button type="button" disabled={saving || selected.size > 20} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChannelOption({
  channel,
  checked,
  onChecked,
}: {
  channel: SlackChannelView;
  checked: boolean;
  onChecked: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 border-b border-border px-2.5 py-2 text-base last:border-b-0">
      <Checkbox checked={checked} onCheckedChange={(value) => onChecked(value === true)} />
      <Hash size={13} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{channel.name}</span>
      {channel.private ? <span className="text-xs text-muted-foreground">private</span> : null}
    </label>
  );
}

function ConversationDetail({
  conversationId,
  readOnOpen,
  onRead,
  postingEnabled,
  reactionsEnabled,
  imageUploadsEnabled,
  searchEnabled,
  onOpenDirectMessage,
}: {
  conversationId: string;
  readOnOpen: boolean;
  onRead: (timestamp: string) => void;
  postingEnabled: boolean;
  reactionsEnabled: boolean;
  imageUploadsEnabled: boolean;
  searchEnabled: boolean;
  onOpenDirectMessage: (userId: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [focus, setFocus] = useState<{ ts: string; threadTs?: string }>();
  const messages = useApi(queries.slackMessages(conversationId));
  const groupMembers = useApi(
    queries.slackConversationMembers(
      conversationId,
      messages.data?.conversation.kind === "group-dm",
    ),
  );
  const [membersOpen, setMembersOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [profileUserId, setProfileUserId] = useState<string>();
  const initialReadDone = useRef(false);
  const scrollArea = useRef<HTMLDivElement>(null);
  const [older, setOlder] = useState<SlackMessageView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setOlder([]);
    setNextCursor(messages.data?.nextCursor);
  }, [messages.data]);

  const allMessages = [...(messages.data?.messages ?? []), ...older];

  useEffect(() => {
    if (!messages.data) return;
    const frame = requestAnimationFrame(() => {
      const element = scrollArea.current;
      if (!element) return;
      if (focus) {
        const target = [...element.querySelectorAll<HTMLElement>("[data-slack-ts]")]
          .find((candidate) => candidate.dataset.slackTs === (focus.threadTs ?? focus.ts));
        target?.scrollIntoView({ block: "center" });
      } else {
        element.scrollTop = element.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationId, messages.data, older, focus]);

  useEffect(() => {
    if (focus || !readOnOpen) return;
    const observed = newestTimestamp(allMessages);
    if (!observed || initialReadDone.current) return;
    initialReadDone.current = true;
    void api
      .markSlackRead({ conversationId, timestamp: observed })
      .then(() => onRead(observed))
      .catch(() => {
        initialReadDone.current = false;
      });
  }, [conversationId, messages.data, focus, readOnOpen]);

  async function loadOlder() {
    if (!nextCursor) return;
    setLoadingOlder(true);
    setLoadError(null);
    try {
      const page = await api.slackMessages(
        conversationId,
        nextCursor,
      );
      setOlder((current) => [...current, ...page.messages]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function refreshAfterSend(timestamp: string, threadTs?: string) {
    onRead(timestamp);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.slackInbox() }),
      queryClient.invalidateQueries({ queryKey: keys.slackMessages(conversationId) }),
      ...(threadTs
        ? [
            queryClient.invalidateQueries({
              queryKey: keys.slackThread(conversationId, threadTs),
            }),
          ]
        : []),
    ]);
  }

  async function refreshAfterReaction(threadTs?: string) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.slackInbox() }),
      queryClient.invalidateQueries({ queryKey: keys.slackMessages(conversationId) }),
      ...(threadTs
        ? [
            queryClient.invalidateQueries({
              queryKey: keys.slackThread(conversationId, threadTs),
            }),
          ]
        : []),
    ]);
  }

  async function focusSearchResult(result: SlackConversationSearchResultView) {
    const rootTs = result.threadTs ?? result.ts;
    if (!allMessages.some((message) => message.ts === rootTs)) {
      setLoadError(null);
      try {
        const context = await api.slackMessages(
          conversationId,
          undefined,
          undefined,
          rootTs,
        );
        const currentPageIds = new Set(
          (messages.data?.messages ?? []).map((message) => message.ts),
        );
        setOlder((current) => {
          const byTimestamp = new Map(
            current.map((message) => [message.ts, message] as const),
          );
          for (const message of context.messages) {
            if (!currentPageIds.has(message.ts)) byTimestamp.set(message.ts, message);
          }
          return [...byTimestamp.values()].sort((left, right) =>
            right.ts.localeCompare(left.ts),
          );
        });
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setFocus({
      ts: result.ts,
      ...(result.threadTs && result.threadTs !== result.ts
        ? { threadTs: result.threadTs }
        : {}),
    });
  }

  if (messages.loading) return <Loading>Loading messages…</Loading>;
  if (messages.error) return <div className="p-8"><ErrorBox>{messages.error}</ErrorBox></div>;
  if (!messages.data) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative flex h-full min-h-0 min-w-0"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-6">
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{messages.data.conversation.name}</h1>
          <p className="text-xs text-muted-foreground">
            Messages stay in Slack · opening here does not mark them read in Slack
          </p>
        </div>
        {messages.data.conversation.kind === "group-dm" ? (
          <div className="flex shrink-0 items-center gap-1">
            <Tip label="Group members" side="bottom">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
                aria-label="Show group members"
                onClick={() => setMembersOpen(true)}
              >
                <Users size={16} />
                <span>{groupMembers.data?.total ?? "…"}</span>
              </Button>
            </Tip>
            <Tip
              label={searchEnabled ? "Search group history" : "Reconnect Slack to enable search"}
              side="bottom"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label="Search group history"
                disabled={!searchEnabled}
                onClick={() => setSearchOpen(true)}
              >
                <Search size={16} />
              </Button>
            </Tip>
          </div>
        ) : null}
        </header>
        <div ref={scrollArea} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="w-full">
          {focus ? (
            <div className="mb-3 flex justify-center">
              <Button type="button" variant="outline" size="sm" onClick={() => setFocus(undefined)}>
                <ChevronLeft size={14} />
                Back to latest messages
              </Button>
            </div>
          ) : null}
          {nextCursor ? (
            <div className="mb-3 flex justify-center">
              <Button type="button" variant="outline" disabled={loadingOlder} onClick={loadOlder}>
                {loadingOlder ? "Loading…" : "Load older messages"}
              </Button>
            </div>
          ) : null}
          {loadError ? <ErrorBox>{loadError}</ErrorBox> : null}
          <div className="flex flex-col-reverse">
            {allMessages.map((message, index) => (
              <MessageRow
                key={message.ts}
                conversationId={conversationId}
                message={message}
                grouped={messagesShareSlackGroup(message, allMessages[index + 1])}
                postingEnabled={postingEnabled}
                reactionsEnabled={reactionsEnabled}
                imageUploadsEnabled={imageUploadsEnabled}
                highlighted={focus?.ts === message.ts}
                focusedReplyTs={
                  focus?.threadTs === message.ts && focus.ts !== message.ts
                    ? focus.ts
                    : undefined
                }
                onUserSelect={setProfileUserId}
                onSent={refreshAfterSend}
                onChanged={refreshAfterReaction}
              />
            ))}
          </div>
        </div>
        </div>
        {postingEnabled ? (
          <div className="border-t border-border px-6 py-3">
            <MessageComposer
              conversationId={conversationId}
              placeholder={`Message ${messages.data.conversation.name}`}
              imageUploadsEnabled={imageUploadsEnabled}
              onSent={(result) => refreshAfterSend(result.timestamp)}
            />
          </div>
        ) : null}
      </div>
      <SlackGroupMembersDialog
        open={membersOpen}
        onOpenChange={setMembersOpen}
        conversationId={conversationId}
        conversationName={messages.data.conversation.name}
        members={groupMembers}
        onUserSelect={(userId) => {
          setMembersOpen(false);
          setProfileUserId(userId);
        }}
      />
      {searchOpen ? (
        <SlackConversationSearchDialog
          open
          onOpenChange={setSearchOpen}
          conversationId={conversationId}
          conversationName={messages.data.conversation.name}
          onSelect={(result) => void focusSearchResult(result)}
        />
      ) : null}
      <SlackProfileDrawer
        userId={profileUserId}
        onOpenChange={(open) => {
          if (!open) setProfileUserId(undefined);
        }}
        onMessage={onOpenDirectMessage}
      />
    </motion.div>
  );
}

function SlackGroupMembersDialog({
  open,
  onOpenChange,
  conversationId,
  conversationName,
  members,
  onUserSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  conversationName: string;
  members: AsyncQuery<SlackConversationMembersView>;
  onUserSelect: (userId: string) => void;
}) {
  const queryClient = useQueryClient();
  const details = useApi(queries.slackConversationDetails(conversationId, open));
  const [memberSearch, setMemberSearch] = useState("");
  const [editing, setEditing] = useState<"name" | "topic">();
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"names" | "emails">();
  const visibleMembers = (members.data?.members ?? []).filter((member) =>
    [member.name, member.username ?? "", member.email ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(memberSearch.trim().toLowerCase()),
  );

  function beginEdit(field: "name" | "topic") {
    setEditing(field);
    setEditValue(
      field === "name"
        ? (details.data?.name ?? conversationName)
        : (details.data?.topic ?? ""),
    );
    setActionError(null);
  }

  async function saveDetail() {
    if (!editing || saving) return;
    setSaving(true);
    setActionError(null);
    try {
      await api.updateSlackConversationDetails(conversationId, {
        [editing]: editValue,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.slackConversationDetails(conversationId) }),
        queryClient.invalidateQueries({ queryKey: keys.slackInbox() }),
        queryClient.invalidateQueries({ queryKey: keys.slackMessages(conversationId) }),
      ]);
      setEditing(undefined);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function copyMembers(kind: "names" | "emails") {
    const values = (members.data?.members ?? []).flatMap((member) =>
      kind === "names"
        ? [member.name]
        : member.email
          ? [member.email]
          : [],
    );
    if (values.length === 0) return;
    await navigator.clipboard.writeText(values.join("\n"));
    setCopied(kind);
    window.setTimeout(() => setCopied(undefined), 1_500);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setMemberSearch("");
          setEditing(undefined);
          setActionError(null);
        }
      }}
    >
      <DialogContent
        className="flex h-[min(46rem,90vh)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle className="flex items-center gap-3 text-2xl">
            <span className="relative grid size-10 place-items-center rounded-lg bg-action/15 text-action">
              <Users size={22} />
              {members.data ? (
                <span className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full bg-muted text-[10px] text-foreground">
                  {members.data.total}
                </span>
              ) : null}
            </span>
            <span className="truncate">{details.data?.name ?? conversationName}</span>
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="members" className="min-h-0 flex-1 gap-0">
          <TabsList variant="line" className="shrink-0 px-6">
            <TabsTrigger value="about">About</TabsTrigger>
            <TabsTrigger value="members">
              Members {members.data?.total ?? ""}
            </TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <TabsContent value="about" className="min-h-0 overflow-y-auto p-6">
            {details.loading ? (
              <Loading>Loading conversation details…</Loading>
            ) : details.error ? (
              <ErrorBox>{details.error}</ErrorBox>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {(["name", "topic"] as const).map((field) => {
                  const label = field === "name" ? "Conversation name" : "Topic";
                  const value =
                    field === "name"
                      ? (details.data?.name ?? conversationName)
                      : (details.data?.topic ?? "");
                  const allowed =
                    field === "name"
                      ? details.data?.canRename
                      : details.data?.canSetTopic;
                  return (
                    <div key={field} className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="font-semibold">{label}</p>
                          {editing !== field ? (
                            <p className="mt-1 break-words text-muted-foreground">
                              {value || "No topic set"}
                            </p>
                          ) : null}
                        </div>
                        {editing !== field ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={!allowed}
                            onClick={() => beginEdit(field)}
                          >
                            Edit
                          </Button>
                        ) : null}
                      </div>
                      {editing === field ? (
                        <div className="mt-3 space-y-2">
                          <Input
                            autoFocus
                            value={editValue}
                            maxLength={field === "name" ? 80 : 250}
                            onChange={(event) => setEditValue(event.target.value)}
                          />
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setEditing(undefined)}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={saving || (field === "name" && !editValue.trim())}
                              onClick={() => void saveDetail()}
                            >
                              {saving ? "Saving…" : "Save"}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {!allowed ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Reconnect Slack with the required group-message write scope to edit.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            {actionError ? <div className="mt-3"><ErrorBox>{actionError}</ErrorBox></div> : null}
          </TabsContent>
          <TabsContent value="members" className="flex min-h-0 flex-col">
            <div className="shrink-0 border-b border-border p-5">
              <div className="relative">
                <Search
                  size={18}
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  placeholder="Find people"
                  className="pl-10"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {members.loading ? (
                <Loading>Loading group members…</Loading>
              ) : members.error ? (
                <ErrorBox>{members.error}</ErrorBox>
              ) : visibleMembers.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No matching members.
                </p>
              ) : (
                <div className="space-y-1">
                  {visibleMembers.map((member) => (
                    <Button
                      key={member.id}
                      type="button"
                      variant="ghost"
                      className="h-auto min-h-16 w-full justify-start px-0 py-0"
                      onClick={() => onUserSelect(member.id)}
                    >
                      <span className="grid w-full grid-cols-[3rem_minmax(0,1fr)] items-center gap-4 px-2 py-2">
                        <span className="relative block size-11">
                          {member.avatarUrl ? (
                            <img
                              src={member.avatarUrl}
                              alt=""
                              className="size-11 rounded-lg object-cover"
                            />
                          ) : (
                            <span className="grid size-11 place-items-center rounded-lg bg-muted font-semibold">
                              {member.name.slice(0, 1).toUpperCase()}
                            </span>
                          )}
                          <span
                            className={cn(
                              "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background",
                              member.online ? "bg-[var(--status-success)]" : "bg-muted-foreground",
                            )}
                          />
                        </span>
                        <span className="flex min-w-0 flex-col items-start gap-0.5 text-left leading-tight">
                          <span className="flex min-w-0 max-w-full items-center gap-1.5">
                            <span className="truncate font-semibold">{member.name}</span>
                            {member.self ? (
                              <span className="shrink-0 font-normal text-muted-foreground">(you)</span>
                            ) : null}
                          </span>
                          {member.username && member.username !== member.name ? (
                            <span className="block max-w-full truncate text-sm font-normal text-muted-foreground">
                              @{member.username}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
          <TabsContent value="settings" className="min-h-0 overflow-y-auto p-6">
            <div className="divide-y divide-border rounded-lg border border-border">
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start rounded-none px-4 py-4"
                disabled={!members.data?.members.length}
                onClick={() => void copyMembers("names")}
              >
                <Copy size={16} />
                {copied === "names" ? "Copied member names" : "Copy member names"}
              </Button>
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start rounded-none px-4 py-4"
                  disabled={!members.data?.members.some((member) => member.email)}
                  onClick={() => void copyMembers("emails")}
                >
                  <Copy size={16} />
                  {copied === "emails"
                    ? "Copied member email addresses"
                    : "Copy member email addresses"}
                </Button>
                {!members.data?.members.some((member) => member.email) ? (
                  <p className="px-4 pb-4 text-xs text-muted-foreground">
                    Reconnect Slack with users:read.email to make email addresses available.
                  </p>
                ) : null}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SlackProfileDrawer({
  userId,
  onOpenChange,
  onMessage,
}: {
  userId?: string;
  onOpenChange: (open: boolean) => void;
  onMessage: (userId: string) => Promise<void>;
}) {
  const profile = useApi(queries.slackUserProfile(userId ?? "", userId != null));
  const [openingMessage, setOpeningMessage] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);

  useEffect(() => {
    setMessageError(null);
    setOpeningMessage(false);
  }, [userId]);

  async function messageUser() {
    if (!userId || openingMessage) return;
    setOpeningMessage(true);
    setMessageError(null);
    try {
      await onMessage(userId);
      onOpenChange(false);
    } catch (err) {
      setMessageError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningMessage(false);
    }
  }

  return (
    <Drawer
      open={userId != null}
      onOpenChange={onOpenChange}
      swipeDirection="right"
    >
      <DrawerContent
        className="bg-[var(--bg-raised)]"
        style={
          { "--drawer-content-width": "min(30rem, 92vw)" } as React.CSSProperties
        }
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <DrawerTitle className="text-lg font-semibold">Profile</DrawerTitle>
          <DrawerClose className={ICON_BUTTON_CLASS} aria-label="Close profile">
            <X size={18} />
          </DrawerClose>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {profile.loading ? (
            <Loading>Loading Slack profile…</Loading>
          ) : profile.error ? (
            <div className="p-5"><ErrorBox>{profile.error}</ErrorBox></div>
          ) : profile.data ? (
            <div>
              <div className="p-5">
                {profile.data.avatarUrl ? (
                  <img
                    src={profile.data.avatarUrl}
                    alt=""
                    className="mx-auto aspect-square w-full max-w-72 rounded-lg object-cover"
                  />
                ) : (
                  <div className="mx-auto grid aspect-square w-full max-w-72 place-items-center rounded-lg bg-muted text-7xl font-semibold text-muted-foreground">
                    {profile.data.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <h2 className="mt-5 text-2xl font-semibold">{profile.data.name}</h2>
                {profile.data.title ? (
                  <p className="mt-1 text-sm text-muted-foreground">{profile.data.title}</p>
                ) : null}
                <div className="mt-4 space-y-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-2.5 rounded-full border",
                        profile.data.presence === "active"
                          ? "border-[var(--status-success)] bg-[var(--status-success)]"
                          : "border-muted-foreground",
                      )}
                    />
                    <span>{profile.data.presence === "active" ? "Active" : "Away"}</span>
                  </div>
                  {formatSlackLocalTime(profile.data) ? (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Clock3 size={16} />
                      <span>{formatSlackLocalTime(profile.data)}</span>
                    </div>
                  ) : null}
                  {profile.data.statusText ? (
                    <div className="flex items-start gap-2">
                      <span aria-hidden="true">
                        {profile.data.statusEmoji
                          ? replaceSlackEmojiShortcodes(profile.data.statusEmoji)
                          : "💬"}
                      </span>
                      <span>{profile.data.statusText}</span>
                    </div>
                  ) : null}
                </div>
                {!profile.data.self ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-5 w-full"
                    disabled={openingMessage}
                    onClick={() => void messageUser()}
                  >
                    <MessageCircle size={16} />
                    {openingMessage ? "Opening…" : "Message"}
                  </Button>
                ) : null}
                {messageError ? <div className="mt-3"><ErrorBox>{messageError}</ErrorBox></div> : null}
              </div>
              {profile.data.username ? (
                <div className="border-t border-border px-5 py-4">
                  <h3 className="text-sm font-semibold">Slack information</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    @{profile.data.username}
                    {profile.data.timezoneLabel ? ` · ${profile.data.timezoneLabel}` : ""}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function SlackConversationSearchDialog({
  open,
  onOpenChange,
  conversationId,
  conversationName,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  conversationName: string;
  onSelect: (result: SlackConversationSearchResultView) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<SlackConversationSearchFilters>({});
  const debouncedSearch = useDebounced(search.trim(), 500);
  const results = useApi(
    queries.slackConversationSearch(
      conversationId,
      debouncedSearch,
      page,
      filters,
      open && debouncedSearch.length > 0,
    ),
  );

  useEffect(() => setPage(1), [debouncedSearch, filters]);

  function toggleFilter(filter: keyof SlackConversationSearchFilters) {
    setFilters((current) => ({ ...current, [filter]: !current[filter] }));
  }

  if (!open) return null;

  function closeSearch() {
    setSearch("");
    setPage(1);
    setFilters({});
    onOpenChange(false);
  }

  return (
      <aside
        className="flex h-full min-h-0 w-[min(44rem,58%)] min-w-96 shrink-0 flex-col border-l border-border bg-[var(--bg-raised)] shadow-2xl max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-20 max-[1100px]:w-full max-[1100px]:max-w-[44rem]"
        aria-label={`Search ${conversationName}`}
      >
        <h2 className="sr-only">Search {conversationName}</h2>
        <div className="flex h-16 shrink-0 items-center gap-2 border-b border-border px-4">
          <Search
            size={22}
            className="shrink-0 text-muted-foreground"
          />
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search ${conversationName}`}
            className="h-9 flex-1 border-0 bg-transparent px-1 text-base shadow-none focus-visible:ring-0"
          />
          {search ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setSearch("")}
            >
              Clear
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={ICON_BUTTON_CLASS}
            aria-label="Close search"
            onClick={closeSearch}
          >
            <X size={18} />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 px-4 py-3">
          <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-action px-3 text-sm font-medium text-action-foreground">
            <MessageCircle size={14} />
            In this DM
          </span>
          <SearchFilterButton
            active={filters.fromMe === true}
            icon={<UserRound size={14} />}
            onClick={() => toggleFilter("fromMe")}
          >
            From me
          </SearchFilterButton>
          <SearchFilterButton
            active={filters.includesMe === true}
            icon={<AtSign size={14} />}
            onClick={() => toggleFilter("includesMe")}
          >
            Includes me
          </SearchFilterButton>
          <SearchFilterButton
            active={filters.hasLink === true}
            icon={<Link size={14} />}
            onClick={() => toggleFilter("hasLink")}
          >
            Has a link
          </SearchFilterButton>
          <SearchFilterButton
            active={filters.threadsOnly === true}
            icon={<MessageCircle size={14} />}
            onClick={() => toggleFilter("threadsOnly")}
          >
            Threads only
          </SearchFilterButton>
        </div>
        {debouncedSearch ? (
          <div className="flex items-center gap-3 border-t border-border px-5 py-3 text-sm">
            <Search size={18} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">
              Show results for <span className="font-medium text-action">“{debouncedSearch}”</span>
              {" "}in {conversationName}
            </span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border p-4">
          {!debouncedSearch ? (
            <p className="grid min-h-48 place-items-center text-sm text-muted-foreground">
              Enter words to search this DM’s history.
            </p>
          ) : results.loading ? (
            <Loading>Searching Slack…</Loading>
          ) : results.error ? (
            <ErrorBox>{results.error}</ErrorBox>
          ) : (results.data?.results.length ?? 0) === 0 ? (
            <p className="grid min-h-48 place-items-center text-sm text-muted-foreground">
              No matching messages in this group.
            </p>
          ) : (
            <div className="space-y-2">
              {results.data?.results.map((result) => (
                <Button
                  key={`${result.ts}-${result.threadTs ?? ""}`}
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-20 w-full items-start justify-start gap-3 whitespace-normal rounded-lg border border-border bg-[var(--bg-raised)] px-3 py-3 text-left shadow-sm hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
                  onClick={() => onSelect(result)}
                >
                  {result.avatarUrl ? (
                    <img
                      src={result.avatarUrl}
                      alt=""
                      className="mt-0.5 size-8 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold">
                      {result.userName.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 truncate font-semibold text-foreground">
                        {result.userName}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {ago(result.at)}
                      </span>
                    </span>
                    <span className="line-clamp-3 block text-sm leading-relaxed font-normal text-muted-foreground">
                      <SlackSearchHighlight
                        text={formatSlackSearchResultText(result.text, result.mentions)}
                        query={debouncedSearch}
                      />
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          )}
        </div>
        {results.data && results.data.pageCount > 1 ? (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {results.data.page} of {results.data.pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= results.data.pageCount}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </aside>
  );
}

function SearchFilterButton({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      size="sm"
      className={cn("gap-1.5", active && "border-action/40 bg-action/10 text-action")}
      aria-pressed={active}
      onClick={onClick}
    >
      {icon}
      {children}
    </Button>
  );
}

function SlackSearchHighlight({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const terms = [...query.matchAll(/"([^"]+)"|(\S+)/g)]
    .map((match) => (match[1] ?? match[2] ?? "").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (terms.length === 0) return <>{text}</>;
  const pattern = new RegExp(
    `(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return (
    <>
      {text.split(pattern).map((part, index) =>
        terms.some((term) => term.toLowerCase() === part.toLowerCase()) ? (
          <mark
            key={index}
            className="rounded-[var(--radius-compact)] bg-[var(--status-warning)] px-px text-[var(--bg)]"
          >
            {part}
          </mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function formatSlackSearchResultText(
  text: string,
  mentions: Record<string, string> = {},
): string {
  return replaceSlackEmojiShortcodes(
    decodeSlackEntities(text)
      .replace(/<@([A-Z0-9]+)>/g, (_token, id: string) => `@${mentions[id] ?? id}`)
      .replace(
        /<!subteam\^([A-Z0-9]+)(?:\|@?([^>]+))?>/g,
        (_token, id: string, alias?: string) => `@${mentions[id] ?? alias ?? id}`,
      )
      .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_token, id: string, name?: string) =>
        `#${name ?? id}`,
      )
      .replace(/<(https?:\/\/[^>|]+)(?:\|([^>]+))?>/g, (_token, url: string, label?: string) =>
        label ?? url,
      ),
  );
}

function SlackUserAvatar({
  name,
  avatarUrl,
}: {
  name: string;
  avatarUrl?: string;
}) {
  return avatarUrl ? (
    <img src={avatarUrl} alt="" className="size-8 shrink-0 rounded-md object-cover" />
  ) : (
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function MessageRow({
  conversationId,
  message,
  grouped = false,
  postingEnabled,
  reactionsEnabled,
  imageUploadsEnabled,
  highlighted = false,
  focusedReplyTs,
  onUserSelect,
  onSent,
  onChanged,
}: {
  conversationId: string;
  message: SlackMessageView;
  grouped?: boolean;
  postingEnabled: boolean;
  reactionsEnabled: boolean;
  imageUploadsEnabled: boolean;
  highlighted?: boolean;
  focusedReplyTs?: string;
  onUserSelect: (userId: string) => void;
  onSent: (timestamp: string, threadTs?: string) => Promise<void>;
  onChanged: (threadTs?: string) => Promise<void>;
}) {
  const [threadOpen, setThreadOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reactionError, setReactionError] = useState<string | null>(null);
  const ownMessage = message.mine && postingEnabled;
  const actionsVisible = menuOpen || confirmDelete;

  useEffect(() => {
    if (focusedReplyTs) setThreadOpen(true);
  }, [focusedReplyTs]);

  function copyMessage() {
    void navigator.clipboard
      .writeText(message.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => {});
  }

  async function setReaction(name: string, active: boolean) {
    setReactionError(null);
    try {
      await api.setSlackReaction(conversationId, message.ts, { name, active });
      await onChanged(message.threadTs);
    } catch (err) {
      setReactionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <article
      data-slack-ts={message.ts}
      className={cn(
        "group relative -mx-2 rounded-md px-2 transition-colors hover:bg-[var(--bg-hover)]",
        grouped ? "py-0.5" : "py-2.5",
        highlighted && "bg-action/10 ring-1 ring-action/30",
      )}
    >
      {!editing ? (
        <div
          className={cn(
            "pointer-events-none absolute -top-2 right-2 z-10 flex translate-y-1 items-center gap-0.5 rounded-md border border-border bg-[var(--bg-raised)] p-0.5 opacity-0 shadow-sm transition-[opacity,transform] group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100",
            actionsVisible && "pointer-events-auto translate-y-0 opacity-100",
          )}
        >
          {reactionsEnabled ? (
            <>
              {SLACK_REACTIONS.slice(0, 3).map((reaction) => {
                const active =
                  message.reactions?.some(
                    (existing) => existing.name === reaction.name && existing.reacted,
                  ) === true;
                return (
                  <Button
                    key={reaction.name}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${active ? "Remove" : "Add"} ${reaction.label} reaction`}
                    aria-pressed={active}
                    title={reaction.label}
                    onClick={() => void setReaction(reaction.name, !active)}
                  >
                    <span aria-hidden="true">{reaction.emoji}</span>
                  </Button>
                );
              })}
              <ReactionPicker
                reactions={message.reactions ?? []}
                onSelect={(name, active) => void setReaction(name, active)}
              />
            </>
          ) : null}
          {postingEnabled || message.replyCount > 0 ? (
            <Tip
              label={
                message.replyCount > 0
                  ? `Open thread · ${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`
                  : "Reply in thread"
              }
              side="top"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={
                  message.replyCount > 0
                    ? `Open thread with ${message.replyCount} replies`
                    : "Reply in thread"
                }
                aria-expanded={threadOpen}
                onClick={() => setThreadOpen((open) => !open)}
              >
                <MessageCircle size={15} />
              </Button>
            </Tip>
          ) : null}
          {ownMessage ? (
            <MessageOverflowMenu
              copied={copied}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              onCopy={copyMessage}
              onEdit={() => setEditing(true)}
              onDelete={() => setConfirmDelete(true)}
            />
          ) : (
            <Tip label={copied ? "Copied" : "Copy message"} side="top">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Copy message text"
                onClick={copyMessage}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </Button>
            </Tip>
          )}
        </div>
      ) : null}
      <div className="flex gap-3">
        {grouped ? (
          <time
            dateTime={message.at}
            className="w-8 shrink-0 pt-1 text-right text-[10px] leading-5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          >
            {slackMessageTime(message.at)}
          </time>
        ) : message.userId ? (
          <Button
            type="button"
            variant="ghost"
            className="h-fit shrink-0 rounded-md p-0 hover:bg-transparent"
            aria-label={`Open ${message.userName}'s profile`}
            onClick={() => onUserSelect(message.userId!)}
          >
            <SlackUserAvatar name={message.userName} avatarUrl={message.avatarUrl} />
          </Button>
        ) : (
          <SlackUserAvatar name={message.userName} avatarUrl={message.avatarUrl} />
        )}
        <div className="min-w-0 flex-1">
          {!grouped ? (
            <div className="flex items-baseline gap-2">
              {message.userId ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto p-0 font-semibold hover:bg-transparent hover:text-action hover:underline"
                  onClick={() => onUserSelect(message.userId!)}
                >
                  {message.userName}
                </Button>
              ) : (
                <span className="font-semibold">{message.userName}</span>
              )}
              <span className="text-xs text-muted-foreground">{ago(message.at)}</span>
            </div>
          ) : null}
          {editing ? (
            <MessageEditor
              conversationId={conversationId}
              timestamp={message.ts}
              initialText={message.text}
              onCancel={() => setEditing(false)}
              onSaved={async () => {
                setEditing(false);
                await onChanged(message.threadTs);
              }}
            />
          ) : (
            <div className={cn("break-words text-base leading-relaxed", !grouped && "mt-0.5")}>
              {message.blocks?.length ? (
                <SlackMessageBlocks
                  blocks={message.blocks}
                  mentions={message.mentions}
                  onUserSelect={onUserSelect}
                />
              ) : (
                <SlackMrkdwn
                  text={message.text}
                  mentions={message.mentions}
                  onUserSelect={onUserSelect}
                />
              )}
            </div>
          )}
          {message.attachments?.length ? (
            <SlackMessageAttachments
              conversationId={conversationId}
              attachments={message.attachments}
            />
          ) : null}
          {message.reactions?.length ? (
            <ReactionChips
              reactions={message.reactions}
              enabled={reactionsEnabled}
              onToggle={(name, active) => void setReaction(name, active)}
            />
          ) : null}
          {reactionError ? (
            <p className="mt-1 text-xs text-destructive">{reactionError}</p>
          ) : null}
          {threadOpen ? (
            <ThreadReplies
              conversationId={conversationId}
              threadTs={message.ts}
              postingEnabled={postingEnabled}
              reactionsEnabled={reactionsEnabled}
              imageUploadsEnabled={imageUploadsEnabled}
              focusedTs={focusedReplyTs}
              onUserSelect={onUserSelect}
              onSent={onSent}
              onChanged={onChanged}
              onClose={() => setThreadOpen(false)}
            />
          ) : null}
        </div>
      </div>
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete message"
          body="This removes the message from Slack for everyone. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={async () => {
            await api.deleteSlackMessage(conversationId, message.ts);
            await onChanged(message.threadTs);
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </article>
  );
}

const SLACK_PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function SlackMessageAttachments({
  conversationId,
  attachments,
  compact = false,
}: {
  conversationId: string;
  attachments: readonly SlackMessageAttachmentView[];
  compact?: boolean;
}) {
  const [selected, setSelected] = useState<SlackMessageAttachmentView>();
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {attachments.map((attachment) => {
          const image =
            attachment.mimeType != null &&
            SLACK_PREVIEWABLE_IMAGE_TYPES.has(attachment.mimeType.toLowerCase()) &&
            !failed.has(attachment.id);
          if (!image) {
            return (
              <span
                key={attachment.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-[var(--bg-raised)] px-2 py-1 text-xs text-muted-foreground"
              >
                <Image size={13} />
                {attachment.name}
              </span>
            );
          }
          return (
            <Button
              key={attachment.id}
              type="button"
              variant="outline"
              className={cn(
                "group relative h-auto overflow-hidden border-border bg-[var(--bg-deep)] p-0 hover:border-[var(--border-strong)] hover:bg-[var(--bg-deep)]",
                compact ? "max-h-36 max-w-64" : "max-h-64 max-w-md",
              )}
              aria-label={`Preview ${attachment.name}`}
              onClick={() => setSelected(attachment)}
            >
              <img
                src={api.slackImageUrl(conversationId, attachment.id, "thumbnail")}
                alt={attachment.name}
                loading="lazy"
                className={cn(
                  "max-w-full object-contain transition-transform group-hover:scale-[1.01]",
                  compact ? "max-h-36" : "max-h-64",
                )}
                onError={() =>
                  setFailed((current) => new Set(current).add(attachment.id))
                }
              />
              <span className="absolute inset-x-0 bottom-0 overflow-hidden bg-linear-to-t from-black/85 to-transparent px-2 pt-6 pb-1.5 text-left text-xs font-medium text-ellipsis whitespace-nowrap text-white">
                {attachment.name}
              </span>
            </Button>
          );
        })}
      </div>
      <Dialog
        open={selected != null}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent
          className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-3 overflow-hidden rounded-none bg-black/95 p-3 text-white sm:max-w-none"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setSelected(undefined);
          }}
        >
          <DialogHeader className="min-w-0 pr-10">
            <DialogTitle className="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-white">
              {selected?.name ?? "Slack image"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
            {selected ? (
              <img
                src={api.slackImageUrl(conversationId, selected.id, "original")}
                alt={selected.name}
                className="max-h-full max-w-full object-contain"
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReactionPicker({
  reactions,
  onSelect,
}: {
  reactions: readonly SlackReactionView[];
  onSelect: (name: string, active: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Choose an emoji reaction"
          title="Add reaction"
        >
          <SmilePlus size={15} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="grid grid-cols-6 gap-1" aria-label="Emoji reactions">
          {SLACK_REACTIONS.map((reaction) => {
            const active = reactions.some(
              (existing) => existing.name === reaction.name && existing.reacted,
            );
            return (
              <Button
                key={reaction.name}
                type="button"
                variant={active ? "secondary" : "ghost"}
                size="icon"
                aria-label={`${active ? "Remove" : "Add"} ${reaction.label} reaction`}
                aria-pressed={active}
                title={reaction.label}
                onClick={() => {
                  onSelect(reaction.name, !active);
                  setOpen(false);
                }}
              >
                <span className="text-lg" aria-hidden="true">{reaction.emoji}</span>
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ReactionChips({
  reactions,
  enabled,
  onToggle,
}: {
  reactions: readonly SlackReactionView[];
  enabled: boolean;
  onToggle: (name: string, active: boolean) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {reactions.map((reaction) => (
        <Button
          key={reaction.name}
          type="button"
          variant={reaction.reacted ? "secondary" : "outline"}
          size="xs"
          disabled={!enabled}
          aria-label={`${reaction.reacted ? "Remove" : "Add"} ${reaction.name} reaction`}
          aria-pressed={reaction.reacted}
          onClick={() => onToggle(reaction.name, !reaction.reacted)}
        >
          <span aria-hidden="true">
            {replaceSlackEmojiShortcodes(`:${reaction.name}:`)}
          </span>
          {reaction.count}
        </Button>
      ))}
    </div>
  );
}

function ThreadReplyRow({
  conversationId,
  reply,
  postingEnabled,
  reactionsEnabled,
  highlighted = false,
  onUserSelect,
  onChanged,
}: {
  conversationId: string;
  reply: SlackMessageView;
  postingEnabled: boolean;
  reactionsEnabled: boolean;
  highlighted?: boolean;
  onUserSelect: (userId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const ownMessage = reply.mine && postingEnabled;
  const actionsVisible = menuOpen || confirmDelete;

  async function setReaction(name: string, active: boolean) {
    setError(null);
    try {
      await api.setSlackReaction(conversationId, reply.ts, { name, active });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function copyMessage() {
    void navigator.clipboard
      .writeText(reply.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => {});
  }

  return (
    <div
      data-slack-ts={reply.ts}
      className={cn(
        "group/reply relative rounded-md py-2 pr-1 text-base transition-colors hover:bg-[var(--bg-hover)]",
        highlighted && "bg-action/10 ring-1 ring-action/30",
      )}
    >
      {!editing ? (
        <div
          className={cn(
            "pointer-events-none absolute right-1 top-0 z-10 flex items-center gap-0.5 rounded-md border border-border bg-[var(--bg-raised)] p-0.5 opacity-0 shadow-sm group-focus-within/reply:pointer-events-auto group-focus-within/reply:opacity-100 group-hover/reply:pointer-events-auto group-hover/reply:opacity-100",
            actionsVisible && "pointer-events-auto opacity-100",
          )}
        >
          {reactionsEnabled ? (
            <ReactionPicker
              reactions={reply.reactions ?? []}
              onSelect={(name, active) => void setReaction(name, active)}
            />
          ) : null}
          {ownMessage ? (
            <MessageOverflowMenu
              copied={copied}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              onCopy={copyMessage}
              onEdit={() => setEditing(true)}
              onDelete={() => setConfirmDelete(true)}
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Copy reply text"
              title="Copy reply"
              onClick={copyMessage}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
          )}
        </div>
      ) : null}
      {reply.userId ? (
        <Button
          type="button"
          variant="ghost"
          className="h-auto p-0 font-semibold hover:bg-transparent hover:text-action hover:underline"
          onClick={() => onUserSelect(reply.userId!)}
        >
          {reply.userName}
        </Button>
      ) : (
        <span className="font-semibold">{reply.userName}</span>
      )}{" "}
      <span className="text-xs text-muted-foreground">{ago(reply.at)}</span>
      {editing ? (
        <MessageEditor
          conversationId={conversationId}
          timestamp={reply.ts}
          initialText={reply.text}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onChanged();
          }}
        />
      ) : (
        <div className="mt-0.5 break-words">
          <SlackMrkdwn
            text={reply.text}
            mentions={reply.mentions}
            onUserSelect={onUserSelect}
          />
        </div>
      )}
      {reply.attachments?.length ? (
        <SlackMessageAttachments
          conversationId={conversationId}
          attachments={reply.attachments}
          compact
        />
      ) : null}
      {reply.reactions?.length ? (
        <ReactionChips
          reactions={reply.reactions}
          enabled={reactionsEnabled}
          onToggle={(name, active) => void setReaction(name, active)}
        />
      ) : null}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete message"
          body="This removes the reply from Slack for everyone. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={async () => {
            await api.deleteSlackMessage(conversationId, reply.ts);
            await onChanged();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </div>
  );
}

function ThreadReplies({
  conversationId,
  threadTs,
  postingEnabled,
  reactionsEnabled,
  imageUploadsEnabled,
  focusedTs,
  onUserSelect,
  onSent,
  onChanged,
  onClose,
}: {
  conversationId: string;
  threadTs: string;
  postingEnabled: boolean;
  reactionsEnabled: boolean;
  imageUploadsEnabled: boolean;
  focusedTs?: string;
  onUserSelect: (userId: string) => void;
  onSent: (timestamp: string, threadTs?: string) => Promise<void>;
  onChanged: (threadTs?: string) => Promise<void>;
  onClose: () => void;
}) {
  const thread = useApi(
    queries.slackThread(conversationId, threadTs, "", focusedTs ?? ""),
  );
  const [older, setOlder] = useState<SlackMessageView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setOlder([]);
    setNextCursor(thread.data?.nextCursor);
  }, [thread.data]);

  const replies = [...(thread.data?.messages ?? []), ...older].filter(
    (message) => message.ts !== threadTs,
  );

  useEffect(() => {
    if (!focusedTs || !thread.data) return;
    const frame = requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLElement>("[data-slack-ts]")]
        .find((candidate) => candidate.dataset.slackTs === focusedTs);
      target?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedTs, thread.data]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.slackThread(
        conversationId,
        threadTs,
        nextCursor,
        undefined,
        focusedTs,
      );
      setOlder((current) => [...current, ...page.messages]);
      setNextCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="mt-2 border-l-2 border-border pl-3">
      <div className="flex items-center justify-between pb-1">
        <span className="text-xs font-medium text-muted-foreground">Thread</span>
        <Tip label="Close thread" side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Close thread"
            onClick={onClose}
          >
            <X size={13} />
          </Button>
        </Tip>
      </div>
      {thread.loading ? (
        <Loading>Loading replies…</Loading>
      ) : thread.error ? (
        <ErrorBox>{thread.error}</ErrorBox>
      ) : (
        <>
          {replies.map((reply) => (
            <ThreadReplyRow
              key={reply.ts}
              conversationId={conversationId}
              reply={reply}
              postingEnabled={postingEnabled}
              reactionsEnabled={reactionsEnabled}
              highlighted={reply.ts === focusedTs}
              onUserSelect={onUserSelect}
              onChanged={() => onChanged(threadTs)}
            />
          ))}
          {nextCursor ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? "Loading…" : "Load more replies"}
            </Button>
          ) : null}
          {postingEnabled ? (
            <div className="mt-2">
              <MessageComposer
                conversationId={conversationId}
                threadTs={threadTs}
                placeholder="Reply in thread"
                imageUploadsEnabled={imageUploadsEnabled}
                onSent={(result) => onSent(result.timestamp, threadTs)}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function MessageComposer({
  conversationId,
  threadTs,
  placeholder,
  imageUploadsEnabled,
  onSent,
}: {
  conversationId: string;
  threadTs?: string;
  placeholder: string;
  imageUploadsEnabled: boolean;
  onSent: (result: SlackMessageSendResult) => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<{ file: File; previewUrl: string }>>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    },
    [],
  );

  function addImages(files: readonly File[]) {
    if (!imageUploadsEnabled) {
      setError("Add files:read and files:write to the Slack app, then reconnect.");
      return;
    }
    const accepted = files.filter((file) =>
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type),
    );
    if (accepted.length !== files.length) {
      setError("Slack image attachments must be PNG, JPEG, GIF, or WebP.");
      return;
    }
    if (accepted.some((file) => file.size > 10 * 1024 * 1024)) {
      setError("Each Slack image attachment must be 10 MB or smaller.");
      return;
    }
    if (images.length + accepted.length > 4) {
      setError("Attach at most 4 images.");
      return;
    }
    setError(null);
    setImages((current) => [
      ...current,
      ...accepted.map((file) => ({ file, previewUrl: URL.createObjectURL(file) })),
    ]);
  }

  function clearImages() {
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setImages([]);
  }

  async function submit() {
    const message = text.trim();
    if ((!message && images.length === 0) || sending) return;
    setSending(true);
    setError(null);
    try {
      const result =
        images.length > 0
          ? await api.uploadSlackImages(conversationId, {
              images: images.map((image) => image.file),
              ...(message ? { text: message } : {}),
              ...(threadTs ? { threadTs } : {}),
            })
          : await api.sendSlackMessage(conversationId, {
              text: message,
              ...(threadTs ? { threadTs } : {}),
            });
      setText("");
      clearImages();
      void Promise.resolve(onSent(result)).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        tabIndex={-1}
        onChange={(event) => {
          addImages([...event.target.files ?? []]);
          event.target.value = "";
        }}
      />
      <InputGroup className="h-auto min-h-0 w-full bg-background">
        {images.length > 0 ? (
          <InputGroupAddon align="block-start" className="flex-wrap gap-2">
            {images.map((image, index) => (
              <div
                key={image.previewUrl}
                className="relative size-14 overflow-hidden rounded-md border border-border bg-muted"
              >
                <img
                  src={image.previewUrl}
                  alt={image.file.name || `Attachment ${index + 1}`}
                  className="size-full object-cover"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-xs"
                  className="absolute right-0.5 top-0.5"
                  aria-label={`Remove ${image.file.name || `attachment ${index + 1}`}`}
                  onClick={() => {
                    URL.revokeObjectURL(image.previewUrl);
                    setImages((current) =>
                      current.filter((candidate) => candidate !== image),
                    );
                  }}
                >
                  <X size={12} />
                </Button>
              </div>
            ))}
          </InputGroupAddon>
        ) : null}
        <InputGroupTextarea
          rows={1}
          value={text}
          maxLength={40_000}
          disabled={sending}
          placeholder={placeholder}
          aria-label={threadTs ? "Thread reply" : "Message"}
          className="min-h-8 px-3 text-base"
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const pasted = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (pasted.length === 0) return;
            event.preventDefault();
            addImages(pasted);
          }}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing
            ) {
              return;
            }
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <InputGroupAddon
          align="block-end"
          className="justify-between"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            event.currentTarget.parentElement?.querySelector("textarea")?.focus();
          }}
        >
          <Tip
            label={
              imageUploadsEnabled
                ? "Attach images"
                : "Reconnect Slack with files:read and files:write"
            }
            side="top"
          >
            <InputGroupButton
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={sending || !imageUploadsEnabled || images.length >= 4}
              aria-label="Attach images"
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip />
            </InputGroupButton>
          </Tip>
          <InputGroupButton
            type="submit"
            variant="default"
            size="icon-sm"
            disabled={sending || (!text.trim() && images.length === 0)}
            aria-label={threadTs ? "Send thread reply" : "Send Slack message"}
            title="Send (Enter)"
          >
            <Send />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
    </form>
  );
}

function MessageOverflowMenu({
  copied,
  open,
  onOpenChange,
  onCopy,
  onEdit,
  onDelete,
}: {
  copied: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Message actions"
          aria-expanded={open}
        >
          <Ellipsis size={15} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          Edit message
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCopy}>
          {copied ? <Check /> : <Copy />}
          Copy message
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          Delete message
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MessageEditor({
  conversationId,
  timestamp,
  initialText,
  onCancel,
  onSaved,
}: {
  conversationId: string;
  timestamp: string;
  initialText: string;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [text, setText] = useState(initialText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = text.trim();
    if (!next || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateSlackMessage(conversationId, timestamp, { text: next });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="mt-2 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <InputGroup className="h-auto min-h-0 w-full bg-background">
        <InputGroupTextarea
          rows={3}
          value={text}
          maxLength={40_000}
          disabled={saving}
          aria-label="Edit message"
          className="min-h-16 px-3 text-base"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
              return;
            }
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing
            ) {
              return;
            }
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <InputGroupAddon align="block-end" className="justify-end gap-2">
          <InputGroupButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </InputGroupButton>
          <InputGroupButton
            type="submit"
            variant="default"
            size="sm"
            disabled={saving || !text.trim() || text.trim() === initialText.trim()}
          >
            {saving ? "Saving…" : "Save"}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <p className="text-xs text-muted-foreground">Enter to save · Escape to cancel</p>
    </form>
  );
}

function SlackMessageBlocks({
  blocks,
  mentions,
  onUserSelect,
}: {
  blocks: SlackMessageBlockView[];
  mentions?: Record<string, string>;
  onUserSelect: (userId: string) => void;
}) {
  return (
    <div className="mt-1 flex max-w-2xl flex-col gap-2 rounded-md border border-border bg-[var(--bg-raised)] p-3">
      {blocks.map((block, index) => {
        if (block.type === "divider") {
          return <div key={index} className="border-t border-border" />;
        }
        if (block.type === "actions") {
          return (
            <div key={index} className="flex flex-wrap gap-2 pt-0.5">
              {(block.actions ?? []).map((action) => (
                <Button
                  key={`${action.text}-${action.url}`}
                  asChild
                  size="sm"
                  variant={
                    action.style === "primary"
                      ? "default"
                      : action.style === "danger"
                        ? "destructive"
                        : "outline"
                  }
                >
                  <a href={action.url} target="_blank" rel="noreferrer">
                    {action.text}
                  </a>
                </Button>
              ))}
            </div>
          );
        }
        return (
          <div
            key={index}
            className={cn(
              block.type === "header" && "font-semibold",
              block.type === "context" && "text-xs text-muted-foreground",
            )}
          >
            {block.text ? (
              <SlackMrkdwn
                text={block.text}
                mentions={mentions}
                onUserSelect={onUserSelect}
              />
            ) : null}
            {block.fields?.length ? (
              <div className="mt-1 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {block.fields.map((field, fieldIndex) => (
                  <SlackMrkdwn
                    key={fieldIndex}
                    text={field}
                    mentions={mentions}
                    onUserSelect={onUserSelect}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SlackMrkdwn({
  text,
  mentions = {},
  onUserSelect,
}: {
  text: string;
  mentions?: Record<string, string>;
  onUserSelect: (userId: string) => void;
}) {
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return (
    <div className="whitespace-pre-wrap">
      {blocks.map((block, index) =>
        block.startsWith("```") && block.endsWith("```") ? (
          <pre
            key={index}
            className="my-1.5 overflow-x-auto rounded-md bg-[var(--bg-deep)] px-3 py-2 font-mono text-xs"
          >
            <code>{decodeSlackEntities(block.slice(3, -3).replace(/^\n|\n$/g, ""))}</code>
          </pre>
        ) : (
          <Fragment key={index}>
            {renderSlackInline(block, mentions, `b${index}`, onUserSelect)}
          </Fragment>
        ),
      )}
    </div>
  );
}

function renderSlackInline(
  text: string,
  mentions: Record<string, string>,
  keyPrefix: string,
  onUserSelect: (userId: string) => void,
): ReactNode[] {
  const pattern = /(`[^`\n]+`|<[^>\n]+>|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;
  const out: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      out.push(
        replaceSlackEmojiShortcodes(
          decodeSlackEntities(text.slice(cursor, start)),
        ),
      );
    }
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("`")) {
      out.push(
        <code key={key} className="rounded bg-[var(--bg-deep)] px-1 py-0.5 font-mono text-xs">
          {decodeSlackEntities(token.slice(1, -1))}
        </code>,
      );
    } else if (token.startsWith("<")) {
      out.push(renderSlackReference(token, mentions, key, onUserSelect));
    } else {
      const content = replaceSlackEmojiShortcodes(
        decodeSlackEntities(token.slice(1, -1)),
      );
      if (token.startsWith("*")) out.push(<strong key={key}>{content}</strong>);
      else if (token.startsWith("_")) out.push(<em key={key}>{content}</em>);
      else out.push(<s key={key}>{content}</s>);
    }
    cursor = start + token.length;
  }
  if (cursor < text.length) {
    out.push(
      replaceSlackEmojiShortcodes(decodeSlackEntities(text.slice(cursor))),
    );
  }
  return out;
}

function renderSlackReference(
  token: string,
  mentions: Record<string, string>,
  key: string,
  onUserSelect: (userId: string) => void,
): ReactNode {
  const inner = token.slice(1, -1);
  const user = inner.match(/^@([A-Z0-9]+)$/);
  if (user) {
    const id = user[1]!;
    return (
      <Button
        key={key}
        type="button"
        variant="ghost"
        className="inline-flex h-auto p-0 align-baseline font-medium text-action hover:bg-transparent hover:underline"
        onClick={() => onUserSelect(id)}
      >
        @{mentions[id] ?? id}
      </Button>
    );
  }
  const userGroup = inner.match(/^!subteam\^([A-Z0-9]+)(?:\|@?(.+))?$/);
  if (userGroup) {
    const id = userGroup[1]!;
    const alias = mentions[id] ?? userGroup[2] ?? id;
    return <span key={key} className="font-medium text-action">@{alias}</span>;
  }
  const channel = inner.match(/^#([A-Z0-9]+)(?:\|(.+))?$/);
  if (channel) {
    return <span key={key} className="font-medium text-action">#{channel[2] ?? channel[1]}</span>;
  }
  const special = inner.match(/^!([^|]+)(?:\|(.+))?$/);
  if (special) {
    return <span key={key} className="font-medium text-action">@{special[2] ?? special[1]}</span>;
  }
  const separator = inner.indexOf("|");
  const href = separator >= 0 ? inner.slice(0, separator) : inner;
  const label = replaceSlackEmojiShortcodes(
    decodeSlackEntities(separator >= 0 ? inner.slice(separator + 1) : href),
  );
  if (/^(https?:\/\/|mailto:)/i.test(href)) {
    return (
      <a
        key={key}
        href={href}
        target={href.startsWith("mailto:") ? undefined : "_blank"}
        rel={href.startsWith("mailto:") ? undefined : "noreferrer"}
        className="text-action underline decoration-current/40 underline-offset-2 hover:decoration-current"
      >
        {label}
      </a>
    );
  }
  return decodeSlackEntities(token);
}

function decodeSlackEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function formatSlackLocalTime(profile: SlackUserProfileView): string | undefined {
  try {
    if (profile.timezone) {
      return `${new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: profile.timezone,
      }).format(new Date())} local time`;
    }
  } catch {
    // Slack can retain obsolete IANA zone names; fall back to its UTC offset.
  }
  if (profile.timezoneOffset == null) return undefined;
  const local = new Date(Date.now() + profile.timezoneOffset * 1_000);
  return `${new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(local)} local time`;
}

function newestTimestamp(messages: readonly SlackMessageView[]): string | undefined {
  let newest: string | undefined;
  for (const message of messages) {
    for (const timestamp of [message.ts, message.latestReplyTs]) {
      if (timestamp && (!newest || timestamp.localeCompare(newest) > 0)) newest = timestamp;
    }
  }
  return newest;
}
