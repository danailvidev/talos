import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, GitBranch, RefreshCw, Tag, TriangleAlert } from "lucide-react";

import { type PullRequestDetailView, type PullRequestView } from "../api.ts";
import { ago } from "../format.ts";
import { JiraIcon } from "../JiraIcon.tsx";
import { queries, refresh } from "../queries.ts";
import { useApi } from "../useApi.ts";
import { useFormat } from "../FormatContext.tsx";
import { Tip } from "../Tip.tsx";
import { UserAvatar, UserChip } from "./Avatar.tsx";
import { Markdown } from "./Markdown.tsx";
import { PullRequestActions } from "./PullRequestActions.tsx";
import { PullRequestActivity } from "./PullRequestActivity.tsx";
import { PullRequestChanges } from "./PullRequestChanges.tsx";
import { PullRequestConversation } from "./PullRequestConversation.tsx";
import { PullRequestRevisionChat } from "./PullRequestRevisionChat.tsx";
import { stateMeta } from "./state.ts";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs.tsx";
import { ErrorBox, Loading } from "../components/ui/query-state.tsx";
import { Button } from "../components/ui/button.tsx";
import { ICON_BUTTON_CLASS } from "../app-styles.ts";
import { cn } from "../lib/utils.ts";
import { PR_STATE_CLASS, PR_STATE_TONE } from "./styles.ts";
import { PAGE_TITLE_CLASS, SECTION_TITLE_CLASS } from "../typography-styles.ts";

type Tab = "overview" | "changes" | "revise" | "activity";

/**
 * One merge request, in enough detail that opening the forge is a choice rather
 * than a necessity: who wrote it, where it is going, what ticket it belongs to,
 * what it says, who has to approve it, and every word anyone has said about it.
 *
 * Laid out the way the forge's own page is — a main column for the substance
 * (description, commits, discussion) and a narrow sidebar for the facts about
 * the request itself (people, labels, mergeability) — because that split is
 * already how a developer reads one of these.
 *
 * The list row is rendered first and the full detail fills in over it, so
 * selecting a row is instant — the title and author are already known, and
 * waiting on a forge round trip to draw them would make the pane feel slower than
 * the list it came from.
 */
export function PullRequestDetail({ pr }: { pr: PullRequestView }) {
  const fmt = useFormat();
  const [tab, setTab] = useState<Tab>("overview");
  // Never polled; the refresh button means "the forge changed, go look again"
  // rather than something to infer from a timer. It goes through
  // `refresh.pullRequest` so it also bypasses the server's 30s entry, which a
  // plain `refetch` would be served from.
  const queryClient = useQueryClient();
  const detail = useApi(queries.pr(pr.id));

  // No id check any more — the merge request's id *is* the cache key, so
  // selecting another row reads another entry instead of holding this one's
  // value while the next request is in flight. That is what the check here used
  // to guard against.
  const full = detail.data;
  const head: PullRequestView | PullRequestDetailView = full ?? pr;
  const revisionAction = full?.actions.find((action) => action.action === "revise");
  const { label } = stateMeta(head.state);
  const opened = head.createdAt ?? head.updatedAt;

  return (
    <div>
      <div>
        <div className="flex flex-wrap items-start gap-3">
          <h1 className={cn(PAGE_TITLE_CLASS, "min-w-0 shrink")}>
            {head.title}
            <span className={cn(PR_STATE_CLASS, PR_STATE_TONE[head.state])}>{label}</span>
            <Tip label="Fetch the latest from the forge">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={ICON_BUTTON_CLASS}
                aria-label="Refresh merge request"
                disabled={detail.fetching}
                onClick={() => refresh.pullRequest(queryClient, pr.id)}
              >
                <RefreshCw
                  size={14}
                  strokeWidth={2}
                  className={detail.fetching ? "animate-spin" : ""}
                />
              </Button>
            </Tip>
          </h1>

          {/* Pinned to the corner rather than sharing a row with the branches or
              the sub line below: every other line here can run long (a title
              wraps, a branch name runs on), and the one control that starts an
              agent should not drift depending on how much text is above it.
              Waits for the detail — every button's availability depends on facts
              only the detail carries (are there conflicts? open threads?), and a
              menu that guesses would be worse than one that arrives. */}
          {full ? (
            <div className="mt-px shrink-0">
              <PullRequestActions
                prId={full.id}
                actions={full.actions}
                onAction={() => setTab("activity")}
              />
            </div>
          ) : null}
        </div>

        <div className="mb-2 flex flex-wrap items-center gap-2.5 text-[0.9375rem] text-[var(--text-dim)]">
          {/* The id doubles as the link to the forge — there is no separate
              "Open on GitLab" link because this is that link. */}
          <a
            className="mono text-muted-foreground hover:text-action"
            href={head.webUrl}
            target="_blank"
            rel="noreferrer"
          >
            {head.repository ? `${head.repository}!${head.number}` : `!${head.number}`}
          </a>
          {head.author ? (
            <span className="inline-flex items-center gap-[5px]">
              <UserAvatar user={head.author} size={18} />
              {head.author.name ?? head.author.username}
            </span>
          ) : null}
          <Tip label={fmt.stamp(opened)}>
            <span className="text-[var(--text-faint)]">opened {ago(opened)}</span>
          </Tip>
        </div>

        <div className="mono mb-3 flex items-center gap-[7px] text-sm text-[var(--text-dim)] [&_svg]:shrink-0 [&_svg]:text-[var(--text-faint)] [&_span]:max-w-[40%] [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap">
          <GitBranch size={13} strokeWidth={2} />
          <span title={head.sourceBranch}>{head.sourceBranch}</span>
          <ArrowRight size={13} strokeWidth={2} />
          <span title={head.targetBranch}>{head.targetBranch}</span>
        </div>
      </div>

      {detail.error ? <ErrorBox>{detail.error}</ErrorBox> : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList variant="line">
          <TabsTrigger value="overview">
            Overview
          </TabsTrigger>
          <TabsTrigger value="changes">
            Changes
          </TabsTrigger>
          {revisionAction ? (
            <TabsTrigger value="revise">
              Revise
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="activity">
            Runs
          </TabsTrigger>
        </TabsList>

        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_240px] items-start gap-7 max-[900px]:grid-cols-1",
            (tab === "changes" || tab === "revise") && "grid-cols-1",
          )}
        >
          <div className="min-w-0">
            <TabsContent value="overview" className="tab-panel flex-none text-inherit">
              <Overview detail={full} loading={detail.loading} />
            </TabsContent>
            <TabsContent value="changes" className="tab-panel flex-none text-inherit">
              {/* The commits come from the detail rather than being fetched by the
                  tab, so the picker is empty for as long as the header is — which
                  is the same wait, not an extra one. */}
              <PullRequestChanges
                prId={pr.id}
                commits={full?.commits ?? []}
                threads={full?.threads ?? []}
                baseUrl={full?.webUrl}
              />
            </TabsContent>
            <TabsContent value="revise" className="tab-panel flex-none text-inherit">
              <PullRequestRevisionChat prId={pr.id} action={revisionAction} />
            </TabsContent>
            <TabsContent value="activity" className="tab-panel flex-none text-inherit">
              <PullRequestActivity prId={pr.id} />
            </TabsContent>
          </div>

          {tab !== "changes" && tab !== "revise" ? (
            <aside className="flex flex-col gap-3.5 border-l border-border pl-5 max-[900px]:border-t max-[900px]:border-l-0 max-[900px]:pt-3.5 max-[900px]:pl-0">
              <Sidebar detail={full} loading={detail.loading} />
            </aside>
          ) : null}
        </div>
      </Tabs>
    </div>
  );
}

function Overview({
  detail,
  loading,
}: {
  detail?: PullRequestDetailView;
  loading: boolean;
}) {
  if (!detail) {
    return <Loading>{loading ? "Loading the merge request…" : ""}</Loading>;
  }

  return (
    <>
      {detail.mergeability === "conflicts" ? (
        <div className="mb-4.5 flex items-start gap-2.5 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)] px-[13px] py-[11px] text-[0.9062rem] leading-normal text-[var(--text-dim)] [&_svg]:mt-px [&_svg]:shrink-0 [&_svg]:text-[var(--warn)] [&_strong]:text-foreground">
          <TriangleAlert size={15} strokeWidth={2} />
          <span>
            This branch conflicts with {detail.targetBranch}
            {detail.mergeBlockedReason ? ` (${detail.mergeBlockedReason})` : ""}. Use the
            <strong> Resolve conflicts</strong> action above to rebase it.
          </span>
        </div>
      ) : null}

      {detail.description ? (
        <section className="mb-5.5">
          <h2 className={SECTION_TITLE_CLASS}>Description</h2>
          <Markdown
            text={detail.description}
            baseUrl={detail.webUrl}
            prId={detail.id}
            className="rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] px-3.5 py-3"
          />
        </section>
      ) : null}

      <section className="mb-5.5">
        <h2 className={SECTION_TITLE_CLASS}>
          Conversation
          {detail.openThreadCount > 0 ? (
            <span className="ml-1.5 rounded-full bg-[color-mix(in_srgb,var(--warn)_18%,var(--bg-deep))] px-[7px] py-px text-xs tracking-normal text-[var(--warn)] normal-case">
              {detail.openThreadCount} open
            </span>
          ) : null}
        </h2>
        <PullRequestConversation
          threads={detail.threads}
          baseUrl={detail.webUrl}
          prId={detail.id}
        />
      </section>
    </>
  );
}

/**
 * The facts a GitLab merge request keeps down its right rail: who is on it, what
 * it is tagged with, whether it can merge, and what ticket it answers. Grouped
 * apart from the substance in the main column because these are attributes of
 * the request, not things anyone wrote.
 */
function Sidebar({
  detail,
  loading,
}: {
  detail?: PullRequestDetailView;
  loading: boolean;
}) {
  const fmt = useFormat();

  if (!detail) {
    return <Loading>{loading ? "…" : ""}</Loading>;
  }

  return (
    <div className="flex flex-col gap-4">
      <SidebarFact label="Reviewers">
        {detail.reviewers.length === 0 ? (
          <span className="text-[var(--text-faint)] italic">None requested</span>
        ) : (
          detail.reviewers.map((user) => <UserChip key={user.username} user={user} size={16} />)
        )}
      </SidebarFact>

      <SidebarFact label="Assignees">
        {detail.assignees.length === 0 ? (
          <span className="text-[var(--text-faint)] italic">None</span>
        ) : (
          detail.assignees.map((user) => <UserChip key={user.username} user={user} size={16} />)
        )}
      </SidebarFact>

      {/* Absent rather than zero when the forge will not say: approvals are a
          paid feature, and "0 of 0 approved" would be an invention. */}
      {detail.approvals ? (
        <SidebarFact label="Approvals">
          <span className="font-medium text-foreground">
            {detail.approvals.approvedBy.length}
            {detail.approvals.required != null ? ` of ${detail.approvals.required}` : ""} approved
          </span>
          {detail.approvals.approvedBy.map((user) => (
            <UserChip key={user.username} user={user} size={16} />
          ))}
        </SidebarFact>
      ) : null}

      <SidebarFact label="Labels">
        {detail.labels.length === 0 ? (
          <span className="text-[var(--text-faint)] italic">None</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {detail.labels.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-muted)] px-2 py-0.5 text-[0.7812rem] text-[var(--text-dim)] [&_svg]:text-[var(--text-faint)]"
              >
                <Tag size={10} strokeWidth={2} />
                {name}
              </span>
            ))}
          </div>
        )}
      </SidebarFact>

      <SidebarFact label="Mergeable">
        <span
          className={cn(
            detail.mergeability === "clean" && "text-[var(--success)]",
            detail.mergeability === "conflicts" && "text-[var(--warn)]",
            detail.mergeability === "unknown" && "text-[var(--text-faint)]",
          )}
        >
          {detail.mergeability === "clean"
            ? "No conflicts"
            : detail.mergeability === "conflicts"
              ? "Has conflicts"
              : "Not checked yet"}
        </span>
      </SidebarFact>

      {detail.issue ? (
        <SidebarFact label="Jira issue">
          {detail.issue.url ? (
            <a
              className="inline-flex items-center gap-1.5 text-[0.9062rem] text-[var(--text-dim)] hover:text-action"
              href={detail.issue.url}
              target="_blank"
              rel="noreferrer"
            >
              <JiraIcon size={13} />
              {detail.issue.key}
            </a>
          ) : (
            // The key was recovered from the branch name but no Jira site is
            // configured for this developer, so there is nothing to link to.
            <Tip label="Connect Jira to link this ticket.">
              <span className="inline-flex cursor-default items-center gap-1.5 text-[0.9062rem] text-[var(--text-dim)] opacity-55">
                <JiraIcon size={13} />
                {detail.issue.key}
              </span>
            </Tip>
          )}
        </SidebarFact>
      ) : null}

      <SidebarFact label="Last updated">
        <span title={fmt.stamp(detail.updatedAt)}>{ago(detail.updatedAt)}</span>
      </SidebarFact>
    </div>
  );
}

function SidebarFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[0.7812rem] tracking-[0.4px] text-[var(--text-faint)] uppercase">
        {label}
      </div>
      <div className="flex flex-col items-start gap-1.5 text-[0.9062rem]">{children}</div>
    </div>
  );
}
