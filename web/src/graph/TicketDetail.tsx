import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  Bookmark,
  Bug,
  ChevronDown,
  CircleDot,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Link2,
  MessageSquare,
  MonitorSmartphone,
  Paperclip,
  Play,
  SquareCheck,
  UserRound,
  Zap,
} from "lucide-react";

import type {
  ConfluencePreviewView,
  GraphNode,
  SprintView,
  TicketAttachmentView,
  TicketCommentView,
  TicketDetailView,
  TicketFactsView,
  TicketPersonView,
  TicketRelationView,
} from "../api.ts";
import { Markdown } from "../components/Markdown.tsx";
import { ago } from "../format.ts";
import { queries } from "../queries.ts";
import { useApi } from "../useApi.ts";
import { useFormat, type Formatters } from "../FormatContext.tsx";
import { ErrorBox, Loading } from "../components/ui/query-state.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { cn } from "../lib/utils.ts";
import { StatusBadge } from "../StatusBadge.tsx";
import { PriorityMark } from "./PriorityMark.tsx";

/**
 * Everything about a ticket that is not on its node — the reason this page can
 * replace the Jira tab.
 *
 * Fetched here rather than carried on the graph payload, and it has to be: the
 * graph is one bulk search over up to sixty tickets refreshed every three seconds,
 * while this is two Jira calls about the one ticket somebody clicked. See
 * `TicketDetailView` in the contract for the whole argument.
 *
 * The drawer it lives in already shows the facts the search hit carried — status,
 * type, priority, sprint, labels — so this deliberately does not repeat them. It
 * adds the parts you previously had to leave the page for: who is on it, what it
 * says, what has been said about it, and what it is attached to.
 *
 * Three regions, which is what the drawer's width bought: what the ticket says,
 * everything you look up about it in a rail to its right, and the conversation
 * underneath the description. Metadata is a column of short rows and reads fine
 * narrow, so it is the part that gives up the width. Keeping the thread in the
 * prose column also leaves the sticky rail in its own column instead of letting it
 * cover long comments as the drawer scrolls.
 */
export function TicketDetail({
  issueKey,
  /**
   * The facts the graph payload already carried, which this fetch also returns.
   *
   * They are here so the Details card is populated on the first frame instead of
   * appearing a Jira round-trip later: every row it fills is one the fetch will
   * fill again with the same value. `TicketDetailView` is the richer of the two —
   * people rather than names, sprint dates, components — so it wins wherever both
   * have an answer.
   */
  facts,
  /** GitLab merge requests related to this ticket by key, kept separate from job activity. */
  pullRequests = [],
}: {
  issueKey: string;
  facts?: TicketFactsView;
  pullRequests?: GraphNode[];
}) {
  const query = useApi(queries.ticket(issueKey));
  // `null` is what the server sends for a ticket it could not read; the components
  // below only care that there is nothing to draw, so both absences are one.
  const ticket = query.data?.ticket ?? undefined;
  const [selectedAttachment, setSelectedAttachment] = useState<TicketAttachmentView>();
  const renderAttachment = (filename: string, compact = false): ReactNode => {
    const attachment = ticket?.attachments.find(
      (candidate) => candidate.inline && candidate.filename === filename,
    );
    return attachment ? (
      <InlineAttachment
        issueKey={issueKey}
        attachment={attachment}
        compact={compact}
        onPreview={() => setSelectedAttachment(attachment)}
      />
    ) : undefined;
  };
  const renderInlineAttachment = (filename: string) => renderAttachment(filename);
  const renderCommentAttachment = (filename: string) => renderAttachment(filename, true);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_280px] items-start gap-x-7 gap-y-4 max-[900px]:grid-cols-1">
      {/* The description first in the markup as well as on screen, so tabbing and a
          screen reader take the ticket in the order the eye does. The grid areas
          only place these; they do not reorder them. */}
      <div className="flex min-w-0 flex-col gap-3 [grid-column:1] [grid-row:1] [&>section:first-child]:border-t-0 [&>section:first-child]:pt-0 max-[900px]:[grid-column:1] max-[900px]:[grid-row:auto]">
        {/* In the description's column, because that is what is missing while it
            loads and what is wrong when it fails — the rail has the node's own
            facts and stays readable either way. */}
        {query.error ? (
          <ErrorBox>{query.error}</ErrorBox>
        ) : !query.data ? (
          <Loading>Reading {issueKey} from Jira…</Loading>
        ) : null}
        {query.data?.warning ? (
          <p className="m-0 rounded-r-[var(--radius)] border-l-2 border-l-[var(--warn)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-2.5 py-2 text-[0.7812rem] leading-normal text-[var(--text-dim)]">
            {query.data.warning}
          </p>
        ) : null}
        {ticket ? (
          <>
            {ticket.description ? (
              <Prose
                title="Description"
                icon={<FileText size={12} strokeWidth={2} />}
                text={ticket.description}
                smartLinkPreviews={ticket.confluencePreviews}
                renderAttachment={renderInlineAttachment}
              />
            ) : ticket.parentDescription && ticket.parent ? (
              <Prose
                title={`Parent requirements · ${ticket.parent.key}`}
                icon={<FileText size={12} strokeWidth={2} />}
                text={ticket.parentDescription}
                smartLinkPreviews={ticket.confluencePreviews}
                renderAttachment={renderInlineAttachment}
              />
            ) : (
              <Prose
                title="Description"
                icon={<FileText size={12} strokeWidth={2} />}
                empty="No description."
              />
            )}
            {/* Its own section rather than folded into the description: several teams
                use Jira's Environment field as the repro steps, and a bug's repro
                steps are not a footnote to its description. */}
            {ticket.environment ? (
              <Prose
                title="Environment"
                icon={<MonitorSmartphone size={12} strokeWidth={2} />}
                text={ticket.environment}
              />
            ) : null}
            <Attachments
              issueKey={ticket.key}
              attachments={ticket.attachments}
              onPreview={setSelectedAttachment}
            />
          </>
        ) : null}
      </div>

      <div className="sticky top-0 flex h-[calc(100dvh-8.5rem)] min-h-0 flex-col gap-3 overflow-hidden [grid-column:2] [grid-row:1] max-[900px]:static max-[900px]:h-auto max-[900px]:overflow-visible max-[900px]:[grid-column:1] max-[900px]:[grid-row:auto]">
        <Details ticket={ticket} facts={facts} />
        <RelatedPullRequests nodes={pullRequests} />
        {ticket ? <Related ticket={ticket} /> : null}
      </div>

      {ticket ? (
        <div className="[grid-column:1] [grid-row:2] max-[900px]:[grid-row:auto]">
          <Comments
            comments={ticket.comments}
            total={ticket.commentCount}
            url={ticket.url}
            renderAttachment={renderCommentAttachment}
          />
        </div>
      ) : null}
      <AttachmentPreviewDialog
        issueKey={issueKey}
        attachment={selectedAttachment}
        onClose={() => setSelectedAttachment(undefined)}
      />
    </div>
  );
}

/**
 * Everything you look up about a ticket, in one card.
 *
 * Modelled on Jira's own Details panel, deliberately: this is the panel a
 * developer has read a thousand times, and a rail that puts the same rows in the
 * same order with the same priority arrow and the same avatars is one they do not
 * have to learn. Collapsible for the same reason it is there — once you know a
 * ticket, the fields are the part you stop needing.
 *
 * Colour is the one place it does not follow Jira. `design.md` spends colour on
 * operational meaning, so the tinted things here are the ones that carry state —
 * status, priority, issue type — and labels, components and versions are neutral
 * chips rather than Jira's orange ones.
 *
 * Rows are drawn from the fetch where it has an answer and from the node's facts
 * until it does, so the card fills in on the first frame and only deepens. Absent
 * fields are dropped rather than shown as Jira's "Add option" placeholders: this
 * is a reading surface, and a row you cannot fill in is noise.
 */
function Details({ ticket, facts }: { ticket?: TicketDetailView; facts?: TicketFactsView }) {
  const fmt = useFormat();
  const [open, setOpen] = useState(true);

  const status = ticket?.status ?? facts?.status;
  const statusCategory = ticket?.statusCategory ?? facts?.statusCategory;
  const type = ticket?.type ?? facts?.type;
  const priority = ticket?.priority ?? facts?.priority;
  const labels = ticket?.labels ?? facts?.labels ?? [];
  const createdAt = ticket?.createdAt ?? facts?.createdAt;
  const updatedAt = ticket?.updatedAt ?? facts?.updatedAt;
  // The fetch gives a person with a face; the node gives a name. Either is worth a
  // row, so the name is wrapped into the same shape rather than handled twice.
  const reporter = ticket?.reporter ?? (facts?.reporter ? { name: facts.reporter } : undefined);

  const fields: Field[] = [];
  if (status) {
    fields.push({
      label: "Status",
      value: (
        <span
          className={cn(
            "rounded-sm bg-[color-mix(in_srgb,var(--text-faint)_20%,transparent)] px-[7px] py-0.5 text-xs font-semibold tracking-[0.05em] text-[var(--text-dim)] uppercase",
            statusCategory === "indeterminate" && "bg-[var(--live-wash)] text-live",
            statusCategory === "done" && "bg-success/20 text-success",
          )}
        >
          {status}
        </span>
      ),
    });
  }
  if (type) fields.push({ label: "Type", value: <TypeMark name={type} /> });
  if (priority) fields.push({ label: "Priority", value: <PriorityMark name={priority} /> });
  if (ticket?.assignee) {
    fields.push({ label: "Assignee", value: <PersonValue person={ticket.assignee} /> });
  } else if (ticket) {
    // The one absent field worth stating, because this space normally shows the
    // current user's assigned tickets and an unassigned one is worth noticing.
    fields.push({
      label: "Assignee",
      value: <span className="text-[var(--text-faint)] italic">Unassigned</span>,
    });
  }
  if (reporter) fields.push({ label: "Reporter", value: <PersonValue person={reporter} /> });
  if (ticket?.sprint) {
    const sprint = ticket.sprint;
    fields.push({
      label: "Sprint",
      // The state alongside the name, because "Sprint 41 (closed)" says the ticket
      // was left behind while "Sprint 41" says it is being worked on.
      value: sprint.state === "active" ? sprint.name : `${sprint.name} (${sprint.state})`,
      title: sprintRange(sprint, fmt),
    });
    // Only for the sprint that is running: a closed sprint's end date is history,
    // and a future one's is answered by the sprint's own name on the filter bar.
    if (sprint.endDate && sprint.state === "active") {
      fields.push({
        label: "Sprint ends",
        value: ago(sprint.endDate),
        title: fmt.stamp(sprint.endDate),
      });
    }
  }
  if (ticket?.dueAt) {
    fields.push({ label: "Due date", value: ago(ticket.dueAt), title: fmt.stamp(ticket.dueAt) });
  }
  if (labels.length > 0) fields.push({ label: "Labels", value: <Chips values={labels} /> });
  if (ticket && ticket.components.length > 0) {
    fields.push({ label: "Components", value: <Chips values={ticket.components} /> });
  }
  if (ticket && ticket.fixVersions.length > 0) {
    fields.push({ label: "Fix versions", value: <Chips values={ticket.fixVersions} /> });
  }
  if (ticket?.resolution) fields.push({ label: "Resolution", value: ticket.resolution });
  if (createdAt) {
    fields.push({ label: "Created", value: ago(createdAt), title: fmt.stamp(createdAt) });
  }
  if (updatedAt) {
    fields.push({ label: "Updated", value: ago(updatedAt), title: fmt.stamp(updatedAt) });
  }

  if (fields.length === 0) return null;

  return (
    <RailCard title="Details" open={open} onToggle={() => setOpen(!open)}>
      <dl className="m-0 flex flex-col gap-2.5">
        {fields.map((field) => (
          <div
            className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-2.5"
            key={field.label}
          >
            <dt className="text-sm leading-[1.45] text-muted-foreground">{field.label}</dt>
            <dd
              className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-[1.45] text-foreground [overflow-wrap:anywhere]"
              {...(field.title ? { title: field.title } : {})}
            >
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </RailCard>
  );
}

/**
 * The rail's card chrome: a border, a heading you can shut, and padding.
 *
 * Shared by all three rail cards so they read as a stack of the same thing rather
 * than three lists that happen to be near each other — which is the difference
 * between Jira's panel and the flat `dl` this replaced. Each card owns its own
 * open state, because collapsing the fields to get at the attachments is exactly
 * what a rail this long is collapsed for.
 */
function RailCard({
  title,
  icon,
  open,
  onToggle,
  children,
  className,
  contentClassName,
}: {
  title: string;
  icon?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius)] border border-border bg-[var(--bg-deep)]",
        className,
      )}
    >
      <button
        type="button"
        className="group flex w-full shrink-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent px-3 py-[9px] text-left font-[inherit] text-[var(--text-faint)] hover:text-[var(--text-dim)]"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronDown
          className="-rotate-90 shrink-0 transition-transform group-aria-expanded:rotate-0"
          size={14}
          strokeWidth={2.5}
        />
        <h4 className="m-0 flex items-center gap-1.5 font-display text-[0.9375rem] font-semibold text-foreground">
          {icon}
          {title}
        </h4>
      </button>
      {open ? (
        <div className={cn("px-3 pt-0.5 pb-3", contentClassName)}>{children}</div>
      ) : null}
    </section>
  );
}

/**
 * GitLab work associated by the Jira key in the source branch or title.
 *
 * These are ticket development facts, not TALOS job activity. The graph
 * already carries the related MR identities; the detail query deepens each one
 * with its branches, commits and pipelines while retaining the graph row as an
 * immediate fallback.
 */
function RelatedPullRequests({ nodes }: { nodes: GraphNode[] }) {
  const [open, setOpen] = useState(true);
  if (nodes.length === 0) return null;

  return (
    <RailCard
      title="Development"
      icon={<GitPullRequest size={12} strokeWidth={2} />}
      open={open}
      onToggle={() => setOpen(!open)}
      className={open
        ? "flex min-h-0 flex-1 flex-col overflow-hidden max-[900px]:flex-none"
        : "shrink-0"}
      contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden max-[900px]:overflow-visible"
    >
      <div className="min-h-0 flex-1 overflow-y-scroll overscroll-contain pr-1 max-[900px]:overflow-visible">
        <div className="flex flex-col gap-3">
        <span className="text-xs font-semibold tracking-[0.05em] text-[var(--text-faint)] uppercase">
          Pull requests · {nodes.length}
        </span>
        {nodes.map((node) =>
          node.pullRequest ? (
            <RelatedPullRequest key={node.id} node={node} />
          ) : (
            <PullRequestFallback key={node.id} node={node} />
          ),
        )}
        </div>
      </div>
    </RailCard>
  );
}

function RelatedPullRequest({ node }: { node: GraphNode }) {
  const ref = node.pullRequest!;
  const id = `gitlab:${ref.projectId}!${ref.mrIid}`;
  const query = useApi(queries.pr(id));
  const pullRequest = query.data;
  const url = pullRequest?.webUrl ?? node.url;
  const pipelines = pullRequest?.pipelines ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-center gap-2">
        {url ? (
          <a
            className="min-w-0 shrink-0 font-mono text-sm text-success no-underline hover:underline"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {pullRequest ? `!${pullRequest.number}` : node.label}
          </a>
        ) : (
          <span className="shrink-0 font-mono text-sm text-foreground">{node.label}</span>
        )}
        <StatusBadge status={pullRequestStatusTone(pullRequest?.state ?? node.status)}>
          {pullRequest?.state ?? node.status}
        </StatusBadge>
        {url ? <ExternalLink className="ml-auto shrink-0 text-[var(--text-faint)]" size={11} /> : null}
      </div>

      {pullRequest ? (
        <>
          <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
            <span className="text-[var(--text-faint)]">Source</span>
            <span className="min-w-0 font-mono text-[var(--text-dim)] [overflow-wrap:anywhere]">
              {pullRequest.sourceBranch}
            </span>
            <span className="text-[var(--text-faint)]">Target</span>
            <span className="min-w-0 font-mono text-[var(--text-dim)] [overflow-wrap:anywhere]">
              {pullRequest.targetBranch}
            </span>
          </div>

          <DevelopmentListTitle label="Commits" count={pullRequest.commits.length} />
          {pullRequest.commits.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {pullRequest.commits.slice(0, 5).map((commit) => (
                <li
                  className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-dim)]"
                  key={commit.sha}
                >
                  <GitCommitHorizontal
                    className="shrink-0 text-[var(--text-faint)]"
                    size={12}
                    strokeWidth={2}
                  />
                  {commit.url ? (
                    <a
                      className="shrink-0 font-mono text-success"
                      href={commit.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {commit.sha.slice(0, 8)}
                    </a>
                  ) : (
                    <span className="shrink-0 font-mono text-success">
                      {commit.sha.slice(0, 8)}
                    </span>
                  )}
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {commit.title}
                  </span>
                </li>
              ))}
              {pullRequest.commits.length > 5 ? (
                <li className="text-xs text-[var(--text-faint)]">
                  +{pullRequest.commits.length - 5} more commits
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="m-0 text-xs text-[var(--text-faint)] italic">No commits.</p>
          )}

          <DevelopmentListTitle label="Pipelines" count={pipelines.length} />
          {pipelines.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {pipelines.slice(0, 5).map((pipeline) => (
                <li
                  className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-dim)]"
                  key={pipeline.id}
                >
                  <a
                    className="shrink-0 font-mono text-success"
                    href={pipeline.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    #{pipeline.id}
                  </a>
                  <StatusBadge status={pipelineStatusTone(pipeline.status)}>
                    {pipeline.status}
                  </StatusBadge>
                  <span
                    className="ml-auto shrink-0 text-[var(--text-faint)]"
                    title={pipeline.updatedAt}
                  >
                    {ago(pipeline.updatedAt)}
                  </span>
                </li>
              ))}
              {pipelines.length > 5 ? (
                <li className="text-xs text-[var(--text-faint)]">
                  +{pipelines.length - 5} more pipelines
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="m-0 text-xs text-[var(--text-faint)] italic">No pipelines.</p>
          )}
        </>
      ) : query.error ? (
        <p className="m-0 text-xs text-[var(--text-faint)]" title={query.error}>
          GitLab details unavailable.
        </p>
      ) : (
        <p className="m-0 text-xs text-[var(--text-faint)]">Loading GitLab details…</p>
      )}
    </div>
  );
}

function DevelopmentListTitle({ label, count }: { label: string; count: number }) {
  return (
    <span className="mt-1 text-xs font-semibold text-[var(--text-faint)]">
      {label} · {count}
    </span>
  );
}

function pullRequestStatusTone(status: string): string {
  if (status === "merged" || status === "success") return "success";
  if (status === "closed" || status === "failure") return "failure";
  if (status === "draft" || status === "waiting") return "warn";
  if (status === "open") return "enabled";
  return "running";
}

function pipelineStatusTone(status: string): string {
  if (status === "success") return "success";
  if (status === "failed") return "failure";
  if (status === "canceled" || status === "canceling") return "cancelled";
  if (status === "skipped" || status === "manual") return "disabled";
  if (status === "scheduled" || status === "created") return "warn";
  return "running";
}

function PullRequestFallback({ node }: { node: GraphNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {node.url ? (
        <a
          className="font-mono text-sm text-success"
          href={node.url}
          target="_blank"
          rel="noreferrer"
        >
          {node.label}
        </a>
      ) : (
        <span className="font-mono text-sm text-foreground">{node.label}</span>
      )}
      {node.sublabel ? <span className="text-sm text-[var(--text-dim)]">{node.sublabel}</span> : null}
    </div>
  );
}

/** One row of the Details card. `title` is the tooltip on the value. */
type Field = { label: string; value: ReactNode; title?: string };

const MARK_TONE_CLASS: Record<string, string> = {
  bug: "[&_svg]:text-[var(--status-danger)]",
  story: "[&_svg]:text-success",
  task: "[&_svg]:text-[var(--status-success-strong)]",
  epic: "[&_svg]:text-warning",
  subtask: "[&_svg]:text-[var(--text-faint)]",
  other: "[&_svg]:text-[var(--text-faint)]",
};

const SECTION_CLASS = "flex flex-col gap-2 border-t border-border pt-3";
const SECTION_HEAD_CLASS = "flex items-center justify-between gap-2";
const SECTION_TITLE_CLASS =
  "m-0 flex items-center gap-1.5 font-display text-[0.9375rem] font-semibold text-foreground [&_svg]:shrink-0 [&_svg]:text-[var(--text-faint)]";
const MORE_CLASS =
  "inline-flex cursor-pointer items-center self-start border-0 bg-transparent p-0 font-[inherit] text-[0.7812rem] text-success hover:underline";
const EMPTY_CLASS = "m-0 text-[0.7812rem] text-[var(--text-faint)] italic";
const PROSE_CLASS = "text-[var(--text-dim)] [overflow-wrap:anywhere]";
/** Stable across graph-driven remounts; each entry is a small, scaled JPEG data URL. */
const videoPosterCache = new Map<string, string>();

/**
 * The issue type, with Jira's own shorthand: a bug is not a story is not an epic,
 * and in a rail of grey rows the icon is what tells you which kind of work this is
 * before you read anything.
 */
const TYPES: [RegExp, ComponentType<{ size?: number; strokeWidth?: number }>, string][] = [
  [/bug|defect|incident/i, Bug, "bug"],
  [/epic/i, Zap, "epic"],
  [/sub-?task/i, GitBranch, "subtask"],
  [/story/i, Bookmark, "story"],
  [/task|chore/i, SquareCheck, "task"],
];

function TypeMark({ name }: { name: string }) {
  const match = TYPES.find(([pattern]) => pattern.test(name));
  const [, Icon, tone] = match ?? [undefined, CircleDot, "other"];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] [&_svg]:shrink-0",
        MARK_TONE_CLASS[tone],
      )}
    >
      <Icon size={13} strokeWidth={2.25} />
      {name}
    </span>
  );
}

/** Labels, components and fix versions — a list of short strings, as chips. */
function Chips({ values }: { values: string[] }) {
  return (
    <>
      {values.map((value) => (
        <span
          className="rounded-sm border border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--bg-hover)_60%,transparent)] px-1.5 py-px font-mono text-xs leading-[1.6] text-[var(--text-dim)]"
          key={value}
        >
          {value}
        </span>
      ))}
    </>
  );
}

/**
 * A face and a name, as the value of a field.
 *
 * With a face on it because this space normally shows the current user's work;
 * a ticket reassigned in Jira an hour ago is exactly the one you want to notice.
 */
function PersonValue({ person }: { person: TicketPersonView }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-[7px]" title={person.email ?? person.name}>
      {person.avatarUrl ? (
        <img
          className="shrink-0 rounded-full bg-[var(--bg-hover)] object-cover"
          src={person.avatarUrl}
          alt=""
          width={20}
          height={20}
        />
      ) : (
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--bg-hover)] text-[var(--text-faint)]">
          <UserRound size={11} strokeWidth={2} />
        </span>
      )}
      {person.name}
    </span>
  );
}

/** Above this many characters a body can be folded away with a "Show less". */
const CLIP_CHARS = 700;

/**
 * A block of Jira prose, as Markdown.
 *
 * The server turns the ADF into Markdown (`adfToMarkdown`) and this renders it, so
 * the headings, numbered repro steps, tables and fenced stack traces that make up a
 * real bug report arrive looking like themselves. No ADF renderer ships to the
 * browser and no HTML is trusted from Jira — see `Markdown`.
 */
function Prose({
  title,
  icon,
  text,
  empty,
  smartLinkPreviews,
  renderAttachment,
}: {
  title: string;
  icon?: ReactNode;
  text?: string;
  empty?: string;
  smartLinkPreviews?: readonly ConfluencePreviewView[];
  renderAttachment?: (filename: string) => ReactNode;
}) {
  /*
   * Open, and the clip is now something you opt into rather than out of.
   *
   * It was shut by default because this lived in a 420px column where a long
   * description pushed the comment thread off the bottom of the screen. In the
   * drawer the description has its own column with the thread underneath it, so
   * the reason to read a ticket here — reading it — should not start with a click.
   * The fold stays for the occasional 8000-character bug report.
   */
  const [open, setOpen] = useState(true);
  const body = text?.trim() ?? "";
  const clipped = body.length > CLIP_CHARS && !open;

  return (
    <section className={SECTION_CLASS}>
      <header className={SECTION_HEAD_CLASS}>
        <h4 className={SECTION_TITLE_CLASS}>
          {icon}
          {title}
        </h4>
      </header>
      {body ? (
        <>
          <div className={cn(PROSE_CLASS, clipped && "ticket-prose-clipped")}>
            <Markdown
              text={clipped ? clip(body, CLIP_CHARS) : body}
              smartLinkPreviews={smartLinkPreviews}
              renderAttachment={renderAttachment}
            />
          </div>
          {body.length > CLIP_CHARS ? (
            <button type="button" className={MORE_CLASS} onClick={() => setOpen(!open)}>
              {open ? "Show less" : "Show more"}
            </button>
          ) : null}
        </>
      ) : empty ? (
        <p className={EMPTY_CLASS}>{empty}</p>
      ) : null}
    </section>
  );
}

/**
 * Markdown cut to length without leaving syntax hanging open.
 *
 * A blind `slice` can end inside a code fence or a table, and the parser then reads
 * the rest of the block as its contents — which is how a clipped description turns
 * into one grey box. So the cut is taken at the last blank line before the limit
 * where possible, and an odd number of fences is closed behind it.
 */
function clip(text: string, maxChars: number): string {
  const hard = text.slice(0, maxChars);
  const paragraph = hard.lastIndexOf("\n\n");
  const cut = paragraph > maxChars / 2 ? hard.slice(0, paragraph) : hard;
  const fences = cut.match(/^ {0,3}`{3,}/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${cut}\n\`\`\`` : cut;
}

/**
 * The parent, the subtasks and the links, in one list grouped by relationship.
 *
 * One section rather than three, because "what else is this ticket tangled up in"
 * is a single question and Jira's own distinction between a subtask and a
 * `relates to` link is bookkeeping. `is blocked by` is the row that earns the
 * section: it is the reason a ticket you are answerable for has not moved, and it
 * was previously invisible from this page.
 */
function Related({ ticket }: { ticket: TicketDetailView }) {
  const groups = useMemo(() => {
    const all = [
      ...(ticket.parent ? [ticket.parent] : []),
      ...ticket.subtasks,
      ...ticket.links,
    ];
    const byRelation = new Map<string, TicketRelationView[]>();
    for (const relation of all) {
      const bucket = byRelation.get(relation.relation);
      if (bucket) bucket.push(relation);
      else byRelation.set(relation.relation, [relation]);
    }
    return [...byRelation];
  }, [ticket]);

  const [open, setOpen] = useState(true);

  if (groups.length === 0) return null;

  return (
    <RailCard
      title="Related"
      icon={<Link2 size={11} strokeWidth={2} />}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      {groups.map(([relation, tickets]) => (
        <div className="mb-1.5 flex flex-col gap-1" key={relation}>
          <span className="text-xs text-[var(--text-faint)]">{relation}</span>
          {tickets.map((related) => (
            <a
              className="flex items-baseline gap-2 rounded-[var(--radius)] border border-border px-2 py-[5px] text-[0.7812rem] text-[var(--text-dim)] no-underline hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
              key={related.key}
              href={related.url}
              target="_blank"
              rel="noreferrer"
              title={related.assignee ? `Assigned to ${related.assignee}` : undefined}
            >
              <span
                className={cn(
                  "shrink-0 font-mono text-foreground",
                  related.statusCategory === "done" &&
                    "text-[var(--text-faint)] line-through",
                )}
              >
                {related.key}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap",
                  related.statusCategory === "done" &&
                    "text-[var(--text-faint)] line-through",
                )}
              >
                {related.summary ?? ""}
              </span>
              {related.status ? (
                <span className="shrink-0 text-xs text-[var(--text-faint)]">
                  {related.status}
                </span>
              ) : null}
            </a>
          ))}
        </div>
      ))}
    </RailCard>
  );
}

function Attachments({
  issueKey,
  attachments,
  onPreview,
}: {
  issueKey: string;
  attachments: TicketAttachmentView[];
  onPreview: (attachment: TicketAttachmentView) => void;
}) {
  const remaining = attachments.filter((attachment) => !attachment.inline);
  if (attachments.length === 0) return null;
  const inlineCount = attachments.length - remaining.length;

  const media = remaining.filter(
    (attachment) => canPreviewAttachment(issueKey, attachment),
  );
  const files = remaining.filter(
    (attachment) => !canPreviewAttachment(issueKey, attachment),
  );

  return (
    <section className={SECTION_CLASS}>
      <header className={SECTION_HEAD_CLASS}>
        <h4 className={SECTION_TITLE_CLASS}>
          <Paperclip size={11} strokeWidth={2} />
          {attachments.length} attachment{attachments.length === 1 ? "" : "s"}
        </h4>
      </header>

      {inlineCount > 0 ? (
        <p className="m-0 text-xs text-[var(--text-faint)]">
          {inlineCount} shown inline in the description or comments.
        </p>
      ) : null}

      {media.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
          {media.map((attachment, index) => {
            return (
              <AttachmentThumbnail
                attachment={attachment}
                issueKey={issueKey}
                key={attachment.id ?? index}
                onPreview={() => onPreview(attachment)}
              />
            );
          })}
        </div>
      ) : null}

      {files.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[0.7812rem]">
          {files.map((attachment, index) => (
            <li key={attachment.id ?? index}>
              <a
                className="text-success [overflow-wrap:anywhere]"
                href={attachmentMediaUrl(issueKey, attachment)}
                target="_blank"
                rel="noreferrer"
              >
                {attachment.filename}
              </a>
              {attachment.size != null ? (
                <span className="ml-1.5 text-xs text-[var(--text-faint)]">
                  {bytes(attachment.size)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function InlineAttachment({
  issueKey,
  attachment,
  compact = false,
  onPreview,
}: {
  issueKey: string;
  attachment: TicketAttachmentView;
  compact?: boolean;
  onPreview: () => void;
}) {
  const mediaUrl = attachmentMediaUrl(issueKey, attachment);
  const kind = attachmentKind(attachment);
  if (!mediaUrl || !kind || (kind === "text" && !attachment.id)) {
    return (
      <p>
        <a href={mediaUrl} target="_blank" rel="noreferrer">
          📎 {attachment.filename}
        </a>
      </p>
    );
  }

  return (
    <div className={cn("my-2", compact && "max-w-80")}>
      <Button
        className={cn(
          "group relative h-auto w-full overflow-hidden border-border bg-[var(--bg-deep)] p-0 hover:border-[var(--border-strong)] hover:bg-[var(--bg-deep)]",
          compact ? "max-h-48 max-w-80" : "max-h-[520px]",
        )}
        type="button"
        variant="outline"
        onClick={onPreview}
        aria-label={`Preview ${attachment.filename}`}
      >
        {kind === "image" ? (
          <img
            className={cn(
              "w-full object-contain",
              compact ? "max-h-48 max-w-80" : "max-h-[520px]",
            )}
            src={mediaUrl}
            alt={attachment.filename}
            loading="lazy"
          />
        ) : kind === "video" ? (
          <>
            <VideoPoster
              src={mediaUrl}
              className={cn(
                "w-full bg-black object-contain",
                compact ? "max-h-48 max-w-80" : "max-h-[520px]",
              )}
            />
            <PlayOverlay />
          </>
        ) : (
          <TextAttachmentContent
            issueKey={issueKey}
            attachment={attachment}
            compact
          />
        )}
      </Button>
      <span className="mt-1 block text-xs text-[var(--text-faint)]">
        {attachment.filename}
        {attachment.size != null ? ` · ${bytes(attachment.size)}` : ""}
      </span>
    </div>
  );
}

function AttachmentThumbnail({
  issueKey,
  attachment,
  onPreview,
}: {
  issueKey: string;
  attachment: TicketAttachmentView;
  onPreview: () => void;
}) {
  const mediaUrl = attachmentMediaUrl(issueKey, attachment)!;
  const kind = attachmentKind(attachment)!;
  return (
    <Button
      className="group relative h-36 min-w-0 overflow-hidden border-border bg-[var(--bg-deep)] p-0 hover:border-[var(--border-strong)] hover:bg-[var(--bg-deep)]"
      type="button"
      variant="outline"
      onClick={onPreview}
      aria-label={`Preview ${attachment.filename}`}
    >
      {kind === "image" ? (
        <img
          className="size-full object-cover transition-transform group-hover:scale-[1.02]"
          src={mediaUrl}
          alt=""
          loading="lazy"
        />
      ) : kind === "video" ? (
        <>
          <VideoPoster
            className="size-full object-cover"
            src={mediaUrl}
          />
          <PlayOverlay />
        </>
      ) : (
        <TextAttachmentContent
          issueKey={issueKey}
          attachment={attachment}
          compact
        />
      )}
      <span className="absolute inset-x-0 bottom-0 overflow-hidden bg-linear-to-t from-black/85 to-transparent px-2 pt-6 pb-1.5 text-left text-xs font-medium text-ellipsis whitespace-nowrap text-white">
        {attachment.filename}
        {attachment.size != null ? ` · ${bytes(attachment.size)}` : ""}
      </span>
    </Button>
  );
}

function PlayOverlay() {
  return (
    <span className="absolute inset-0 flex items-center justify-center bg-black/20">
      <span className="flex size-10 items-center justify-center rounded-full bg-black/65 text-white">
        <Play className="ml-0.5" size={18} fill="currentColor" />
      </span>
    </span>
  );
}

/**
 * A video element is not a stable thumbnail: Chromium may discard and repaint
 * its decoded first frame while idle. Decode once into a small canvas image, then
 * remove the video element entirely. The cache survives ticket-panel remounts.
 */
function VideoPoster({ src, className }: { src: string; className: string }) {
  const [poster, setPoster] = useState(() => videoPosterCache.get(src));
  if (poster) {
    return <img className={className} src={poster} alt="" aria-hidden="true" />;
  }
  return (
    <>
      <span className={cn("block aspect-video", className)} aria-hidden="true" />
      <video
        className="pointer-events-none absolute size-px opacity-0"
        src={src}
        crossOrigin="anonymous"
        muted
        preload="auto"
        aria-hidden="true"
        onLoadedData={(event) => {
          const video = event.currentTarget;
          if (!video.videoWidth || !video.videoHeight) return;
          try {
            const scale = Math.min(1, 640 / video.videoWidth, 360 / video.videoHeight);
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
            videoPosterCache.set(src, dataUrl);
            setPoster(dataUrl);
          } catch {
            // A browser that refuses a redirected CORS canvas keeps the stable
            // black video tile and play icon rather than reviving the flicker.
          }
        }}
      />
    </>
  );
}

function AttachmentPreviewDialog({
  issueKey,
  attachment,
  onClose,
}: {
  issueKey: string;
  attachment?: TicketAttachmentView;
  onClose: () => void;
}) {
  const mediaUrl = attachment ? attachmentMediaUrl(issueKey, attachment) : undefined;
  const kind = attachment ? attachmentKind(attachment) : undefined;
  return (
    <Dialog
      open={attachment != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-3 overflow-hidden rounded-none bg-black/95 p-3 text-white sm:max-w-none"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          // Radix and the underlying Base UI drawer otherwise both react to the
          // same document-level Escape event. Consume it here and close only the
          // topmost media preview.
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <DialogHeader className="min-w-0 pr-10">
          <DialogTitle className="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-white">
            {attachment?.filename ?? "Attachment preview"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
          {kind === "image" && mediaUrl ? (
            <img
              className="max-h-full max-w-full object-contain"
              src={mediaUrl}
              alt={attachment?.filename ?? ""}
            />
          ) : kind === "video" && mediaUrl ? (
            <video
              className="max-h-full max-w-full"
              src={mediaUrl}
              controls
              autoPlay
              preload="metadata"
            />
          ) : kind === "text" && attachment?.id ? (
            <TextAttachmentContent
              issueKey={issueKey}
              attachment={attachment}
              fullscreen
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TextAttachmentContent({
  issueKey,
  attachment,
  compact = false,
  fullscreen = false,
}: {
  issueKey: string;
  attachment: TicketAttachmentView & { id?: string };
  compact?: boolean;
  fullscreen?: boolean;
}) {
  const query = useApi(queries.ticketAttachmentText(issueKey, attachment.id ?? ""));
  if (query.error) {
    return (
      <span className="p-3 text-xs text-[var(--failure)]">
        Text preview unavailable.
      </span>
    );
  }
  if (!query.data) {
    return <span className="p-3 text-xs text-[var(--text-faint)]">Loading text…</span>;
  }
  return (
    <pre
      className={cn(
        "m-0 w-full overflow-auto whitespace-pre-wrap p-3 text-left font-mono text-xs leading-relaxed font-normal text-[var(--text-dim)]",
        compact && "max-h-48",
        fullscreen && "h-full max-h-none bg-black text-white",
      )}
    >
      {query.data.text}
    </pre>
  );
}

function canPreviewAttachment(
  issueKey: string,
  attachment: TicketAttachmentView,
): boolean {
  const kind = attachmentKind(attachment);
  if (!kind) return false;
  if (kind === "text") return attachment.id != null;
  return attachmentMediaUrl(issueKey, attachment) != null;
}

function attachmentMediaUrl(
  issueKey: string,
  attachment: TicketAttachmentView,
): string | undefined {
  return attachment.id
    ? `/api/tickets/${encodeURIComponent(issueKey)}/attachments/${encodeURIComponent(attachment.id)}`
    : attachment.url;
}

function attachmentKind(
  attachment: TicketAttachmentView,
): "image" | "video" | "text" | undefined {
  if (attachment.mimeType?.startsWith("image/")) return "image";
  if (attachment.mimeType?.startsWith("video/")) return "video";
  if (attachment.mimeType?.startsWith("text/")) return "text";
  if (/\.(?:avif|gif|jpe?g|png|webp)$/i.test(attachment.filename)) return "image";
  if (/\.(?:m4v|mov|mp4|webm)$/i.test(attachment.filename)) return "video";
  if (/\.txt$/i.test(attachment.filename)) return "text";
  return undefined;
}

/**
 * The conversation, newest first.
 *
 * Newest first because the reason to read a ticket's comments on a dashboard is to
 * find out what changed since you last looked, which is the opposite of the order
 * Jira shows them in when you open one to read it from the top. The count says when
 * there are older ones, so a truncated thread never passes for a whole one.
 */
function Comments({
  comments,
  total,
  url,
  renderAttachment,
}: {
  comments: TicketCommentView[];
  total?: number;
  url: string;
  renderAttachment?: (filename: string) => ReactNode;
}) {
  const fmt = useFormat();
  const hidden = total != null && total > comments.length ? total - comments.length : 0;

  return (
    <section className={SECTION_CLASS}>
      <header className={SECTION_HEAD_CLASS}>
        <h4 className={SECTION_TITLE_CLASS}>
          <MessageSquare size={11} strokeWidth={2} />
          {total ?? comments.length} comment{(total ?? comments.length) === 1 ? "" : "s"}
        </h4>
      </header>
      {comments.length === 0 ? (
        <p className={EMPTY_CLASS}>Nothing said yet.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
          {comments.map((comment) => (
            <li
              className="flex flex-col gap-1 rounded-[var(--radius)] bg-[var(--bg-hover)] px-2.5 py-2"
              key={comment.id}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                {comment.author?.avatarUrl ? (
                  <img
                    className="shrink-0 rounded-full bg-[var(--bg-hover)] object-cover"
                    src={comment.author.avatarUrl}
                    alt=""
                    width={18}
                    height={18}
                  />
                ) : null}
                <span className="text-[0.7812rem] text-foreground">
                  {comment.author?.name ?? "Someone"}
                </span>
                {comment.createdAt ? (
                  <span
                    className="text-xs text-[var(--text-faint)]"
                    title={fmt.stamp(comment.createdAt)}
                  >
                    {ago(comment.createdAt)}
                  </span>
                ) : null}
                {comment.updatedAt ? (
                  <span
                    className="text-xs text-[var(--text-faint)]"
                    title={fmt.stamp(comment.updatedAt)}
                  >
                    (edited)
                  </span>
                ) : null}
                {comment.restrictedTo ? (
                  <span
                    className="rounded-[3px] bg-warning/20 px-[5px] py-px text-xs tracking-[0.06em] text-warning uppercase"
                    title={`Only visible to ${comment.restrictedTo}`}
                  >
                    {comment.restrictedTo}
                  </span>
                ) : null}
              </div>
              <div className={PROSE_CLASS}>
                <Markdown text={comment.body} renderAttachment={renderAttachment} />
              </div>
            </li>
          ))}
        </ol>
      )}
      {hidden > 0 ? (
        <a className={MORE_CLASS} href={url} target="_blank" rel="noreferrer">
          <ExternalLink size={11} strokeWidth={2} />
          {hidden} older comment{hidden === 1 ? "" : "s"} in Jira
        </a>
      ) : null}
    </section>
  );
}

/** The sprint's dates, for the row's tooltip. Absent when Jira reports neither. */
function sprintRange(sprint: SprintView, fmt: Formatters): string | undefined {
  if (!sprint.startDate && !sprint.endDate) return undefined;
  const from = sprint.startDate ? fmt.stamp(sprint.startDate) : "?";
  const to = sprint.endDate ? fmt.stamp(sprint.endDate) : "?";
  return `${from} → ${to}`;
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
