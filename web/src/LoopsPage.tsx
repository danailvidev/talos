import { Infinity as InfinityIcon, LayoutGrid, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import type { TaskSummary } from "./api.ts";
import { CreateTaskPanel } from "./CreateTaskPanel.tsx";
import { TaskDetail } from "./TaskDetail.tsx";
import { TaskList } from "./TaskList.tsx";
import { Tip } from "./Tip.tsx";
import { MasterDetail } from "./MasterDetail.tsx";
import { useMobileDetail } from "./useMobileDetail.ts";
import { useNarrowLayout } from "./useNarrowLayout.ts";
import { useResizableWidth } from "./useResizableWidth.ts";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs.tsx";
import { Button } from "./components/ui/button.tsx";
import { ICON_BUTTON_CLASS } from "./app-styles.ts";
import { EMPTY_STATE_CLASS } from "./state-styles.ts";

/**
 * The Loops list view — the two-pane alternative to `LoopsDashboard`'s cards,
 * still reachable at `/loops?view=list` and `/loops/:id`.
 *
 * Was generic over `kind` while an ad-hoc Tasks page existed beside this one;
 * that page is retired (its run history now lives on the pull request it was
 * about), so this is loops-only and the `kind` prop is gone.
 *
 * Title, Add button and the My/Team tabs live at the top of the list panel (not
 * spanning the whole page) so the layout matches the rest of the app's fixed
 * two-pane split. Public instances appear under Team; private instances returned
 * by the API belong to the signed-in user and appear under My. (Other users'
 * private rows never reach the browser.)
 */
export function LoopsPage({
  title,
  rows,
  definitions,
  loading,
  error,
  selectedId,
  onSelect,
  onDashboard,
  tab,
  onSetTab,
  addOpen,
  onSetAdd,
  onCreated,
  onChanged,
  onDeleted,
  hasMore,
  onLoadMore,
  onToast,
}: {
  title: string;
  rows: TaskSummary[];
  /** Instantiable loop definitions, offered by the Add dialog. */
  definitions: TaskSummary[];
  loading: boolean;
  error?: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  /** Loops list view only: jump back to the card dashboard. */
  onDashboard?: () => void;
  tab: "team" | "mine";
  onSetTab: (tab: "team" | "mine") => void;
  addOpen: boolean;
  onSetAdd: (open: boolean) => void;
  onCreated: (id: string) => void;
  /** Refreshes the shared loop list after a schedule or run changes. */
  onChanged?: () => void;
  /** The selected loop was deleted — clear the selection. */
  onDeleted?: () => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onToast?: (text: string) => void;
}) {
  const visibleRows = rows.filter((row) =>
    tab === "mine" ? row.visibility === "private" : row.visibility !== "private",
  );
  // Keyed by name rather than by page: the pull request split reads the same
  // stored width, so dragging the divider once holds everywhere.
  const { width, onPointerDown, onPointerMove, onPointerUp } = useResizableWidth(
    "talos-list-width",
    340,
    220,
    640,
  );
  const narrow = useNarrowLayout();
  const mobileDetail = useMobileDetail(selectedId);
  const list = () =>
    error ? (
      <ErrorBox>{error}</ErrorBox>
    ) : loading && visibleRows.length === 0 ? (
      <Loading>Loading {title.toLowerCase()}…</Loading>
    ) : (
      <TaskList
        tasks={visibleRows}
        selectedId={selectedId}
        onSelect={(id) => {
          onSelect(id);
          mobileDetail.showDetail();
        }}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
      />
    );

  return (
    <MasterDetail
      narrow={narrow}
      detailOpen={mobileDetail.open || addOpen}
      onBack={() => {
        onSetAdd(false);
        mobileDetail.showList();
      }}
      backLabel={title}
      width={width}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      list={
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-sm font-semibold tracking-[0.06em] text-[var(--text-dim)]">
            <InfinityIcon size={14} strokeWidth={2} />
            {title.toUpperCase()}
          </span>
          <div className="flex items-center gap-0.5">
            {onDashboard ? (
              <Tip label="Dashboard">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={ICON_BUTTON_CLASS}
                  aria-label="Loops dashboard"
                  onClick={onDashboard}
                >
                  <LayoutGrid size={16} strokeWidth={2} />
                </Button>
              </Tip>
            ) : null}
            {definitions.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={ICON_BUTTON_CLASS}
                aria-label="Add loop"
                onClick={() => {
                  mobileDetail.showDetail();
                  onSetAdd(true);
                }}
              >
                <Plus size={16} strokeWidth={2} />
              </Button>
            ) : (
              <Tip label="No creatable loop templates yet">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={ICON_BUTTON_CLASS}
                  disabled
                  aria-label="Add loop"
                >
                  <Plus size={16} strokeWidth={2} />
                </Button>
              </Tip>
            )}
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(value) => onSetTab(value as "team" | "mine")}
          className="min-h-0 flex-1"
        >
          <TabsList variant="line">
            <TabsTrigger value="team">
              Team {title}
            </TabsTrigger>
            <TabsTrigger value="mine">
              My {title}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="team" className="min-h-0 flex-1 overflow-y-auto text-inherit">
            {list()}
          </TabsContent>
          <TabsContent value="mine" className="min-h-0 flex-1 overflow-y-auto text-inherit">
            {list()}
          </TabsContent>
        </Tabs>
      </div>

      }
      detail={
      <div className="h-full min-h-0 overflow-y-auto p-4 min-[901px]:p-8">
        <AnimatePresence mode="wait" initial={false}>
          {addOpen ? (
            <motion.div
              key="add"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
            >
              <CreateTaskPanel
                definitions={definitions}
                onCancel={() => {
                  onSetAdd(false);
                  mobileDetail.showList();
                }}
                onCreated={onCreated}
              />
            </motion.div>
          ) : selectedId ? (
            <motion.div
              key={selectedId}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
            >
              <TaskDetail
                id={selectedId}
                onChanged={onChanged}
                onDeleted={onDeleted}
                onToast={onToast}
              />
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className={EMPTY_STATE_CLASS}
            >
              Select a loop to see its details.
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      }
    />
  );
}
