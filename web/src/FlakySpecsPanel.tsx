import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Bug,
  EyeOff,
  ExternalLink,
  FileQuestion,
  FileWarning,
  Info,
  RefreshCw,
  Repeat,
  ShieldAlert,
} from "lucide-react";

import { api, type FlakySpecView } from "./api.ts";
import { ago } from "./format.ts";
import { Button } from "./components/ui/button.tsx";
import { invalidate, queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { toMessage } from "./errors.ts";
import { PAGE_META_CLASS } from "./typography-styles.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.tsx";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./components/ui/popover.tsx";

/**
 * The Spec failures tab on a `gitlab-ci-failure` loop's own detail page: what
 * that loop saw fail and chose not to file, for the project it is pointed at.
 *
 * Lives on the loop's detail page rather than as its own top-level page or a
 * Loops-wide tab, because the loop is instantiable — several of them can each
 * watch a different project — and "flaky specs" only means something scoped to
 * one project's history. `TestRunHistoryRepository` behind it is already
 * source-generic (see `application/flake.ts`), so a future test-reporting loop
 * would get the same tab on its own detail page, reading the same table under
 * its own `source`.
 *
 * It exists because of what the loop used to do. It filed a Jira ticket the first
 * time a spec file went red, which on a nightly suite means the board fills with
 * flakes and stops being read — and the one real regression goes down with it. The
 * loop now waits for a spec to fail twice in a row before filing, and everything it
 * withholds ends up here rather than nowhere.
 *
 * ## What the numbers mean
 *
 * A pass is never recorded anywhere: a job log names the specs that FAILED and says
 * nothing about the rest. So "failed 3 of the last 10" counts pipelines the loop
 * observed and in which this spec has no failure row. Pipelines that died for
 * non-test reasons — no runner, a timeout — are excluded entirely rather than
 * counted as passes, because treating one as a pass would break a real regression's
 * streak and mislabel it as flaky right here.
 *
 * ## The two actions
 *
 * "Dismiss" is about this page only. History keeps being recorded and a spec that
 * turns into a genuine regression still files its ticket; the row just stops asking
 * for attention. "File a ticket" overrides the verdict for one spec — recorded here,
 * honoured by the loop's next run, because the ticket worth having is the one the
 * loop builds with the trace excerpt and the duplicate-check label in it.
 */
export function FlakySpecsPanel({
  project,
  onToast,
}: {
  /** The loop instance's configured GitLab project. Empty means unconfigured. */
  project: string;
  onToast?: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const [showDismissed, setShowDismissed] = useState(false);
  const [busyKey, setBusyKey] = useState<string>();

  // One filter object for the read, for the dismissal POST and for the cache key
  // its answer is written into — the panel is mounted once per loop, so "this
  // project" is a real distinction between entries and not a formality.
  const filter = { project, includeDismissed: showDismissed };
  const specs = useApi(queries.flakySpecs(filter));
  const refresh = () => invalidate.flakySpecs(queryClient);
  const data = specs.data;

  const act = async (spec: FlakySpecView, action: () => Promise<unknown>) => {
    setBusyKey(keyOf(spec));
    try {
      await action();
    } catch (err) {
      onToast?.(toMessage(err));
    } finally {
      setBusyKey(undefined);
    }
  };

  const dismiss = (spec: FlakySpecView) =>
    act(spec, async () => {
      // The response is this filter's list — the POST carries the same query
      // string as the GET — so it goes straight into the cache and a dismissal
      // costs no follow-up read. Other projects' entries are marked stale without
      // refetching: they belong to panels that are not mounted.
      const view = await api.setFlakySpecState(
        spec.project,
        spec.specFile,
        spec.state === "dismissed" ? "open" : "dismissed",
        filter,
      );
      invalidate.flakySpecs(queryClient, "none");
      queryClient.setQueryData(keys.flakySpecs(filter), view);
    });

  const file = (spec: FlakySpecView) =>
    act(spec, async () => {
      const result = await api.fileFlakySpec(spec.project, spec.specFile);
      onToast?.(result.message);
      // The list only — filing records an override, and the loop builds the ticket
      // on its next run, so nothing is queued now. See `FlakySpecFileResult`.
      refresh();
    });

  if (!project.trim()) {
    return (
      <div className="mt-1.5 max-w-180 text-sm text-[var(--text-faint)]">
        Set a GitLab project in the Settings tab first — flaky history is kept per
        project, and this loop is not pointed at one yet.
      </div>
    );
  }

  if (specs.loading && !data) return <Loading>Loading spec failures…</Loading>;
  if (specs.error) return <ErrorBox>{specs.error}</ErrorBox>;
  if (!data) return null;

  const rows = data.specs;
  const flaky = rows.filter((spec) => spec.verdict === "flaky").length;

  return (
    <section className="mb-5.5">
      <div className="flex items-center justify-between" style={{ marginTop: 12, marginBottom: 8 }}>
        <p className={PAGE_META_CLASS}>
          Spec files that have failed recently, judged over the last {data.window}{" "}
          conclusive pipelines. {rows.length}{" "}
          {rows.length === 1 ? "spec" : "specs"}
          {flaky > 0 ? `, ${flaky} intermittent` : ""} · a ticket is filed after{" "}
          {data.failuresBeforeFiling} consecutive{" "}
          {data.failuresBeforeFiling === 1 ? "failure" : "failures"}
        </p>
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
            disabled={specs.fetching}
          >
            <RefreshCw
              size={14}
              strokeWidth={2}
              className={specs.fetching ? "animate-spin" : ""}
            />{" "}
            Refresh
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="mt-1.5 max-w-180 text-sm text-[var(--text-faint)]">
          No spec has failed in the recorded window. Nothing to look at, which is
          the intended state.
        </div>
      ) : (
        <table className="w-full border-collapse text-[0.9062rem] [&_th]:border-b [&_th]:border-border [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[0.7812rem] [&_th]:font-medium [&_th]:tracking-[0.4px] [&_th]:text-[var(--text-faint)] [&_th]:uppercase [&_td]:border-b [&_td]:border-border [&_td]:px-2.5 [&_td]:py-[7px] [&_td]:align-top [&_tbody_tr:hover]:bg-[var(--bg-raised)]">
          <thead>
            <tr>
              <th>Spec</th>
              <th>
                <div className="flex items-center gap-1">
                  Verdict
                  <VerdictInfo
                    historyWindow={data.window}
                    failuresBeforeFiling={data.failuresBeforeFiling}
                  />
                </div>
              </th>
              <th>Failure rate</th>
              <th>Last failed</th>
              <th>Last passed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((spec) => (
              <SpecRow
                key={keyOf(spec)}
                spec={spec}
                busy={busyKey === keyOf(spec)}
                fileDisabled={data.fileRefusal != null}
                fileTitle={data.fileRefusal ?? "File a Jira ticket for this spec anyway"}
                onDismiss={() => void dismiss(spec)}
                onFile={() => void file(spec)}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function VerdictInfo({
  historyWindow,
  failuresBeforeFiling,
}: {
  historyWindow: number;
  failuresBeforeFiling: number;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-5 rounded-full text-[var(--text-faint)] hover:bg-[var(--bg-raised)] hover:text-foreground"
          aria-label="How flaky spec verdicts are determined"
        >
          <Info className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={7} className="w-96 max-w-[calc(100vw-2rem)] gap-3 p-4">
        <PopoverHeader>
          <PopoverTitle>How verdicts are determined</PopoverTitle>
          <PopoverDescription className="leading-relaxed">
            We compare each spec across its last {historyWindow} conclusive pipelines.
          </PopoverDescription>
        </PopoverHeader>

        <div className="grid gap-2">
          <div className="rounded-md border border-border bg-[var(--bg-raised)] p-3">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
              <Repeat className="size-4 text-action" aria-hidden="true" />
              Flaky
            </div>
            <p className="m-0 leading-relaxed text-muted-foreground">
              Failures are separated by a successful run. The same code has both passed
              and failed, so the failure is intermittent and no ticket is filed automatically.
            </p>
          </div>

          <div className="rounded-md border border-border bg-[var(--bg-raised)] p-3">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
              <FileWarning className="size-4 text-action" aria-hidden="true" />
              Regression
            </div>
            <p className="m-0 leading-relaxed text-muted-foreground">
              The spec has failed {failuresBeforeFiling} consecutive{" "}
              {failuresBeforeFiling === 1 ? "pipeline" : "pipelines"}, or its suite could
              not run because of an import or syntax error. A ticket is filed.
            </p>
          </div>
        </div>

        <p className="m-0 text-xs leading-relaxed text-[var(--text-faint)]">
          Runner failures, timeouts, and other inconclusive pipelines do not count as
          passes or failures. A first isolated failure stays undecided until another
          conclusive run supplies enough evidence.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** Project plus path: the same identity the server keys a row on. */
function keyOf(spec: FlakySpecView): string {
  return `${spec.project}::${spec.specFile}`;
}

function SpecRow({
  spec,
  busy,
  fileDisabled,
  fileTitle,
  onDismiss,
  onFile,
}: {
  spec: FlakySpecView;
  busy: boolean;
  fileDisabled: boolean;
  fileTitle: string;
  onDismiss: () => void;
  onFile: () => void;
}) {
  const unattributed = spec.specFile === "(unattributed)";
  const recordedFailures = failureNameCount(spec.lastSignature);

  return (
    <tr className={spec.state === "dismissed" ? "opacity-55" : undefined}>
      <td>
        <div className="flex items-center gap-2">
          <span title={spec.specFile}>
            {unattributed
              ? `${recordedFailures || "Multiple"} test failures without file paths`
              : spec.name}
          </span>
          {spec.lastSuiteFailedToRun ? (
            <span
              className="inline-flex items-center gap-[3px] rounded-[10px] border border-transparent px-[7px] py-px text-xs leading-[1.6] font-semibold tracking-[0.4px] uppercase"
              title="The whole suite failed to run — an import or syntax error, not a race"
            >
              <FileWarning size={12} strokeWidth={2} /> Suite
            </span>
          ) : null}
          {spec.quarantine && !unattributed ? (
            <span
              className="inline-flex items-center gap-[3px] rounded-[10px] border border-transparent px-[7px] py-px text-xs leading-[1.6] font-semibold tracking-[0.4px] uppercase"
              title={
                `Failing intermittently since ${
                  spec.quarantineSuggestedAt
                    ? ago(spec.quarantineSuggestedAt)
                    : ago(spec.firstFailedAt)
                }. ` +
                "Consider quarantining it: as it stands it costs every pipeline that " +
                "runs it without reliably catching anything."
              }
            >
              <ShieldAlert size={12} strokeWidth={2} /> Quarantine?
            </span>
          ) : null}
        </div>
        {unattributed ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Jest parser could not associate these failures with spec files.</span>
            <UnattributedDataDialog spec={spec} />
          </div>
        ) : (
          <div className="text-xs text-muted-foreground" title={spec.lastSignature ?? ""}>
            {spec.specFile}
          </div>
        )}
      </td>
      <td>
        <VerdictBadge spec={spec} />
      </td>
      <td title={`${spec.failed} of ${spec.observed} recorded pipelines`}>
        {Math.round(spec.flakeRate * 100)}%{" "}
        <span className="text-xs text-muted-foreground">
          ({spec.failed}/{spec.observed})
        </span>
      </td>
      <td>
        {spec.lastFailedPipelineUrl ? (
          <a href={spec.lastFailedPipelineUrl} target="_blank" rel="noreferrer">
            {ago(spec.lastFailedAt)} <ExternalLink size={12} strokeWidth={2} />
          </a>
        ) : (
          ago(spec.lastFailedAt)
        )}
        {spec.consecutiveFailures > 1 ? (
          <span className="text-xs text-muted-foreground">
            {" "}
            · {spec.consecutiveFailures} in a row
          </span>
        ) : null}
      </td>
      <td className="text-muted-foreground">
        {spec.lastPassedPipelineId != null
          ? `#${spec.lastPassedPipelineId}`
          : "not in this window"}
      </td>
      <td>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || fileDisabled}
            title={fileTitle}
            onClick={onFile}
          >
            <Bug size={14} strokeWidth={2} /> File a ticket
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            title={
              spec.state === "dismissed"
                ? "Show this spec again"
                : "Stop showing this spec. History keeps being recorded either way."
            }
            onClick={onDismiss}
          >
            <EyeOff size={14} strokeWidth={2} />{" "}
            {spec.state === "dismissed" ? "Undo" : "Dismiss"}
          </Button>
        </div>
      </td>
    </tr>
  );
}

/**
 * The verdict, with the reasoning in its tooltip.
 *
 * `regression` rows appear here too: the loop filed those, and seeing them next to
 * the ones it held is how anybody checks the rule is behaving.
 */
function VerdictBadge({ spec }: { spec: FlakySpecView }) {
  if (spec.specFile === "(unattributed)") {
    return (
      <span
        className="inline-flex items-center gap-[3px] rounded-[10px] border border-transparent px-[7px] py-px text-xs leading-[1.6] font-semibold tracking-[0.4px] uppercase"
        title="The log parser found failing tests but no matching spec-file headers. This is a parser diagnostic, not one flaky spec."
      >
        <FileQuestion size={12} strokeWidth={2} /> Attribution failed
      </span>
    );
  }

  const label =
    spec.verdict === "regression"
      ? "Regression"
      : spec.verdict === "flaky"
        ? "Flaky"
        : spec.verdict === "new"
          ? "First failure"
          : "Watching";

  const title =
    spec.verdict === "regression"
      ? spec.lastSuiteFailedToRun
        ? "The suite fails to run at all, which is deterministic — filed immediately."
        : `Failed ${spec.consecutiveFailures} runs in a row. A ticket has been filed.`
      : spec.verdict === "flaky"
        ? "It has passed on code it also failed on, so the failure is not the code."
        : spec.verdict === "new"
          ? "Seen failing once, with no earlier history. Waiting for the next run."
          : "One failure with clean runs behind it. The next run decides which it is.";

  return (
    <span
      className="inline-flex items-center gap-[3px] rounded-[10px] border border-transparent px-[7px] py-px text-xs leading-[1.6] font-semibold tracking-[0.4px] uppercase"
      title={title}
    >
      {spec.verdict === "flaky" ? <Repeat size={12} strokeWidth={2} /> : null}
      {label}
    </span>
  );
}

function UnattributedDataDialog({ spec }: { spec: FlakySpecView }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="link" size="xs" className="h-auto p-0">
          View recorded data
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Unattributed failures from pipeline #{spec.lastFailedPipelineId}</DialogTitle>
          <DialogDescription>
            These are the exact failure names retained from the Jest output. The full
            job trace is not stored in Talos.
            {spec.lastFailedPipelineUrl ? (
              <>
                {" "}
                <a href={spec.lastFailedPipelineUrl} target="_blank" rel="noreferrer">
                  Open the GitLab pipeline
                </a>
                .
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <pre className="m-0 max-h-[65vh] overflow-auto rounded-md border border-border bg-[var(--bg-raised)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {spec.lastSignature ?? "No failure names were retained for this occurrence."}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function failureNameCount(signature: string | null): number {
  if (!signature) return 0;

  let count = 0;
  for (const line of signature.split("\n")) {
    const overflow = /^ and-more:(\d+)$/.exec(line);
    if (overflow?.[1]) count += Number(overflow[1]);
    else if (line && !line.startsWith(" ")) count++;
  }
  return count;
}
