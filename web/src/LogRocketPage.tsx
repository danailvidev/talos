import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Camera,
  Copy,
  ExternalLink,
  EyeOff,
  RefreshCw,
  Settings,
  Wand2,
  X,
} from "lucide-react";

import { api, type LogRocketIssueView } from "./api.ts";
import { ago } from "./format.ts";
import { Button } from "./components/ui/button.tsx";
import { LogRocketIcon } from "./LogRocketIcon.tsx";
import {
  RegressionTestBadge,
  RegressionTestButton,
  RegressionTestLink,
} from "./RegressionTest.tsx";
import { invalidate, queries } from "./queries.ts";
import { TitleInfo } from "./TitleInfo.tsx";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { toMessage } from "./errors.ts";
import { cn } from "./lib/utils.ts";
import {
  ISSUE_ACTIONS_CLASS,
  ISSUE_DETAIL_CLASS,
  ISSUE_LIST_CLASS,
  ISSUE_META_CLASS,
  ISSUE_ROW_CLASS,
  ISSUE_ROW_HEAD_CLASS,
  ISSUE_ROW_MAIN_CLASS,
  ISSUE_SUMMARY_CLASS,
  ISSUE_TITLE_CLASS,
  OBSERVABILITY_LINK_CLASS,
  SETUP_NOTICE_CLASS,
  SETUP_STEPS_CLASS,
  SETUP_TITLE_CLASS,
} from "./observability-styles.ts";
import { PAGE_META_CLASS, PAGE_TITLE_CLASS } from "./typography-styles.ts";

/**
 * The LogRocket page: frontend issues LogRocket alerted us about, and one button
 * that turns one into a Jira ticket, an agent run and a merge request.
 *
 * Read-only about LogRocket itself, and not by choice — LogRocket has no API for
 * listing issues or sessions, only alerts pushed to a webhook. So this page shows
 * what has been delivered to `/webhooks/logrocket`, which is why "no issues" is
 * rendered next to the URL to paste rather than as an empty table: on a fresh
 * install the two states are indistinguishable to anyone but the server.
 */
export function LogRocketPage({
  onToast,
  onOpenSettings,
}: {
  onToast: (text: string) => void;
  onOpenSettings: () => void;
}) {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string>();
  const [showDismissed, setShowDismissed] = useState(false);
  // One filter object for the read, for the dismissal POST and for the cache key
  // the response is written into — they have to agree, or a dismissal answers
  // about a list this page is not showing.
  const filter = { includeDismissed: showDismissed };
  const issues = useApi(queries.logRocketIssues(filter));
  const refresh = () => invalidate.logRocketIssues(queryClient);

  const data = issues.data;

  const fix = async (issue: LogRocketIssueView) => {
    setBusyId(issue.id);
    try {
      const result = await api.fixLogRocketIssue(issue.id);
      onToast(result.message);
      // The list, because the row now shows a ticket and a run in flight, and the
      // job queue, because filing one queued an agent.
      refresh();
      invalidate.jobQueue(queryClient);
    } catch (err) {
      onToast(toMessage(err));
    } finally {
      setBusyId(undefined);
    }
  };

  const writeTest = async (issue: LogRocketIssueView) => {
    setBusyId(issue.id);
    try {
      const result = await api.writeLogRocketRegressionTest(issue.id);
      onToast(result.message);
      refresh();
      invalidate.jobQueue(queryClient);
    } catch (err) {
      onToast(toMessage(err));
    } finally {
      setBusyId(undefined);
    }
  };

  const setState = async (issue: LogRocketIssueView, state: "open" | "dismissed") => {
    setBusyId(issue.id);
    try {
      // The response *is* the new list for this filter — the server was told which
      // one to answer with — so it goes straight into the cache and this dismissal
      // costs no GET at all. The other filter is marked stale without refetching:
      // it is off screen, and it should not be refetched just because this one
      // changed.
      const view = await api.setLogRocketIssueState(issue.id, state, filter);
      invalidate.logRocketIssues(queryClient, "none");
      queryClient.setQueryData(keys.logRocketIssues(filter), view);
    } catch (err) {
      onToast(toMessage(err));
    } finally {
      setBusyId(undefined);
    }
  };

  if (issues.loading && !data) {
    return <Loading>Loading LogRocket issues…</Loading>;
  }
  if (issues.error) {
    return <ErrorBox>{issues.error}</ErrorBox>;
  }
  if (!data) return null;

  return (
    <div className="flex min-h-0 w-full flex-col gap-5 overflow-y-auto px-4 pt-5 pb-8 min-[901px]:px-[34px] min-[901px]:pt-8 min-[901px]:pb-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className={PAGE_TITLE_CLASS}>
            <LogRocketIcon size={18} />
            LogRocket
            <TitleInfo>Frontend issues LogRocket sent us.</TitleInfo>
          </h1>
          {/* The count stays on the page — it moves with every sync, so it is
              status rather than description. */}
          <p className={PAGE_META_CLASS}>
            {data.issues.length}{" "}
            {data.issues.length === 1 ? "issue" : "issues"}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={showDismissed ? "secondary" : "outline"}
            size="sm"
            aria-pressed={showDismissed}
            onClick={() => setShowDismissed((v) => !v)}
          >
            <EyeOff size={14} strokeWidth={2} /> Dismissed
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={issues.fetching}
          >
            <RefreshCw
              size={14}
              strokeWidth={2}
              className={issues.fetching ? "animate-spin" : ""}
            />{" "}
            Refresh
          </Button>
        </div>
      </header>

      <SetupNotice data={data} onToast={onToast} onOpenSettings={onOpenSettings} />

      {data.fixRefusal && data.issues.length > 0 ? (
        <div className="mt-1.5 max-w-180 text-sm text-[var(--text-faint)]">
          {data.fixRefusal}
        </div>
      ) : null}

      {/* Only when it adds something the fix refusal did not: both usually end in
          "set a default project", and saying that twice reads as a bug. */}
      {data.regressionTestRefusal &&
      data.regressionTestRefusal !== data.fixRefusal &&
      data.issues.length > 0 ? (
        <div className="mt-1.5 max-w-180 text-sm text-[var(--text-faint)]">
          {data.regressionTestRefusal}
        </div>
      ) : null}

      {data.issues.length === 0 ? (
        <div className="mt-1.5 max-w-180 text-sm text-[var(--text-faint)]">
          {showDismissed
            ? "No issues, dismissed ones included."
            : "No issues yet. They appear here as LogRocket alerts fire — nothing is polled, so this list is exactly what has been delivered."}
        </div>
      ) : (
        <div className={ISSUE_LIST_CLASS}>
          {data.issues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              busy={busyId === issue.id}
              fixDisabled={data.fixRefusal != null}
              testRefusal={data.regressionTestRefusal}
              onFix={() => void fix(issue)}
              onWriteTest={() => void writeTest(issue)}
              onSetState={(state) => void setState(issue, state)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Everything standing between this page and its first row.
 *
 * Shown only while something is actually missing: an install that is set up sees
 * its issues and no scaffolding.
 */
function SetupNotice({
  data,
  onToast,
  onOpenSettings,
}: {
  data: { enabled: boolean; webhookConfigured: boolean; webhookPath: string | null };
  onToast: (text: string) => void;
  onOpenSettings: () => void;
}) {
  if (data.enabled && data.webhookConfigured) return null;

  const url = data.webhookPath ? `${window.location.origin}${data.webhookPath}` : null;

  return (
    <div className={SETUP_NOTICE_CLASS}>
      <p className={SETUP_TITLE_CLASS}>
        {!data.webhookConfigured
          ? "LogRocket alerts are not being accepted yet."
          : "LogRocket is not fully configured."}
      </p>
      <ol className={SETUP_STEPS_CLASS}>
        {!data.enabled ? (
          <li>Add the LogRocket API key under Settings → Integrations.</li>
        ) : null}
        {!data.webhookConfigured ? (
          <li>
            Set a webhook secret under Settings → Integrations → LogRocket. Until then
            every delivery is refused, because the secret is what stops a stranger
            filing issues here.
          </li>
        ) : null}
        <li>
          Paste the URL into LogRocket → Issues → Alerts as a webhook destination.
        </li>
      </ol>
      {url ? (
        <div className="flex max-w-full items-center gap-1.5">
          <code className="mono rounded-[var(--radius)] border border-border bg-[var(--bg-deep)] px-2 py-1 text-[0.8125rem] text-foreground [overflow-wrap:anywhere]">
            {url}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Copy webhook URL"
            onClick={() => {
              void navigator.clipboard
                .writeText(url)
                .then(() => onToast("Webhook URL copied."))
                .catch(() => onToast("Could not copy — select the URL instead."));
            }}
          >
            <Copy size={14} strokeWidth={2} />
          </Button>
        </div>
      ) : null}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onOpenSettings}>
          <Settings size={14} strokeWidth={2} /> Open Integrations settings
        </Button>
      </div>
    </div>
  );
}

function IssueRow({
  issue,
  busy,
  fixDisabled,
  testRefusal,
  onFix,
  onWriteTest,
  onSetState,
}: {
  issue: LogRocketIssueView;
  busy: boolean;
  fixDisabled: boolean;
  testRefusal: string | null;
  onFix: () => void;
  onWriteTest: () => void;
  onSetState: (state: "open" | "dismissed") => void;
}) {
  // The label is the error text and the title is usually the same string; showing
  // both would read as a stutter, so the label only appears when it adds something.
  const detail =
    issue.label && issue.label !== issue.title ? issue.label : issue.description;

  const facts = [
    issue.sessionCount != null
      ? `${issue.sessionCount} ${issue.sessionCount === 1 ? "session" : "sessions"}`
      : null,
    issue.sessionRate != null ? `${issue.sessionRate}/min` : null,
    issue.firstSeenAt ? `first seen ${ago(issue.firstSeenAt)}` : null,
    `last alert ${ago(issue.lastAlertAt)}`,
    issue.alertCount > 1 ? `${issue.alertCount} alerts` : null,
  ].filter(Boolean);

  return (
    <div className={cn(ISSUE_ROW_CLASS, issue.state === "dismissed" && "opacity-55")}>
      <div className={ISSUE_ROW_MAIN_CLASS}>
        <div className={ISSUE_ROW_HEAD_CLASS}>
          {issue.issueType ? (
            <span className="whitespace-nowrap rounded-full border border-[color-mix(in_srgb,var(--primary)_35%,transparent)] bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] px-1.5 py-px text-xs font-semibold tracking-[0.04em] text-primary uppercase">
              {issue.issueType}
            </span>
          ) : null}
          <span className={ISSUE_TITLE_CLASS}>{issue.title}</span>
        </div>
        {detail ? <div className={cn(ISSUE_DETAIL_CLASS, "mono")}>{detail}</div> : null}
        {issue.summary ? <div className={ISSUE_SUMMARY_CLASS}>{issue.summary}</div> : null}
        {issue.userImpact ? (
          <div className={ISSUE_SUMMARY_CLASS}>
            <strong>Impact: </strong>
            {issue.userImpact}
          </div>
        ) : null}
        <div className={ISSUE_META_CLASS}>
          {facts.join(" · ")}
          {issue.regressionTest ? (
            <>
              {" · "}
              <RegressionTestBadge test={issue.regressionTest} />
            </>
          ) : null}
        </div>
      </div>

      <div className={ISSUE_ACTIONS_CLASS}>
        {issue.jiraIssueKey ? (
          <a
            className={cn(OBSERVABILITY_LINK_CLASS, "mono")}
            href={issue.jiraIssueUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
          >
            {issue.jiraIssueKey}
            <ExternalLink size={12} strokeWidth={2} />
          </a>
        ) : null}
        {issue.regressionTest ? <RegressionTestLink test={issue.regressionTest} /> : null}
        {issue.url ? (
          <a className={OBSERVABILITY_LINK_CLASS} href={issue.url} target="_blank" rel="noreferrer">
            LogRocket
            <ExternalLink size={12} strokeWidth={2} />
          </a>
        ) : null}
        {issue.screenshotUrl ? (
          <a
            className={OBSERVABILITY_LINK_CLASS}
            href={issue.screenshotUrl}
            target="_blank"
            rel="noreferrer"
            title="Screenshot at the time of the error"
          >
            <Camera size={13} strokeWidth={2} />
          </a>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          // In-flight rather than "already filed": an issue that alerts again
          // after its fix merged is worth another attempt on the same ticket.
          disabled={busy || fixDisabled || issue.fixInFlight}
          title={issue.fixInFlight ? "A fix is already running for this ticket" : undefined}
          onClick={onFix}
        >
          <Wand2 size={13} strokeWidth={2} />
          {issue.fixInFlight
            ? "Fixing…"
            : issue.jiraIssueKey
              ? "Fix again"
              : "Create ticket & fix"}
        </Button>
        <RegressionTestButton
          test={issue.regressionTest}
          inFlight={issue.regressionTestInFlight}
          disabled={testRefusal != null}
          disabledReason={testRefusal}
          busy={busy}
          onClick={onWriteTest}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          title={issue.state === "dismissed" ? "Bring back" : "Dismiss"}
          onClick={() => onSetState(issue.state === "dismissed" ? "open" : "dismissed")}
        >
          <X size={14} strokeWidth={2} />
        </Button>
      </div>
    </div>
  );
}
