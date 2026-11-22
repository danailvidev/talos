import {
  bulletList,
  codeBlock,
  doc,
  heading,
  linkParagraph,
  paragraph,
  rule,
  type AdfDocument,
} from "../../connectors/jira/adf.ts";
import type { TraceAnalysis } from "../../connectors/gitlab/trace-format.ts";
import { describeAssessment, type FlakeAssessment } from "../../application/flake.ts";
import { basename, type FailureGroup, type SignatureDiff } from "./group.ts";

/**
 * Turning a failure group into a Jira description.
 *
 * The ticket has to answer three questions without anyone opening GitLab: what is
 * failing, what the runner said about it, and where the log is. Everything here
 * serves one of those; the pipeline metadata is last because it is the part a
 * reader needs least often.
 */

/** Per-test detail cap. Beyond this a ticket becomes a log dump. */
const MAX_DETAIL_LINES = 20;

/** Tests shown in full before the rest are listed by name only. */
const MAX_DETAILED_TESTS = 10;

export interface TicketContext {
  /** `group/project` on GitLab. */
  project: string | number;
  pipelineId: number;
  pipelineUrl: string;
  jobId: number;
  jobName: string;
  jobUrl: string;
  ref: string;
  /** The pipeline's commit, when known. */
  commitTitle?: string;
  commitAuthor?: string;
  /** Counts from the runner's own summary line. */
  summary?: TraceAnalysis["summary"];
  /** True when the trace was capped before parsing, so the reader knows. */
  traceTruncated?: boolean;
  /**
   * How this spec has behaved recently, when there is history to go on.
   *
   * On the ticket because it changes what the reader should do with it: "failed 8
   * of the last 8 runs" is a bug to fix, and "failed 3 of the last 10, last passed
   * yesterday" is a race to stabilise. Optional, so a first-ever run still files.
   */
  assessment?: FlakeAssessment;
}

export function buildDescription(
  group: FailureGroup,
  ctx: TicketContext,
): AdfDocument {
  const nodes = [];

  nodes.push(
    paragraph(
      group.suiteFailedToRun && group.tests.length === 0
        ? `The spec file ${group.file} failed to run — no tests in it executed.`
        : `${group.tests.length} test(s) are failing in ${group.file}.`,
    ),
  );

  nodes.push(paragraph(`File: ${group.file}`));

  if (group.suiteFailedToRun && group.suiteDetail) {
    nodes.push(heading("Suite failed to run"));
    // The cause of an import failure is the single most useful thing in the log,
    // so it goes above the individual tests rather than after them.
    nodes.push(codeBlock(capLines(group.suiteDetail, MAX_DETAIL_LINES)));
  }

  if (group.tests.length > 0) {
    nodes.push(heading("Failing tests"));
    nodes.push(bulletList(group.tests));

    nodes.push(heading("Details"));
    for (const detail of group.details.slice(0, MAX_DETAILED_TESTS)) {
      nodes.push(paragraph(detail.name));
      nodes.push(codeBlock(capLines(detail.detail, MAX_DETAIL_LINES)));
    }
    if (group.details.length > MAX_DETAILED_TESTS) {
      nodes.push(
        paragraph(
          `… ${group.details.length - MAX_DETAILED_TESTS} further failing test(s) ` +
            `in this file; see the job log.`,
        ),
      );
    }
  }

  if (ctx.assessment && ctx.assessment.observed > 0) {
    nodes.push(heading("Recent history"));
    nodes.push(paragraph(`This spec ${describeAssessment(ctx.assessment)}.`));
    if (ctx.assessment.quarantine) {
      nodes.push(
        paragraph(
          `Suggested: quarantine this spec. It fails intermittently ` +
            `(${Math.round(ctx.assessment.flakeRate * 100)}% of recent runs) rather ` +
            `than consistently, so it is currently costing every pipeline that runs ` +
            `it without reliably catching anything.`,
        ),
      );
    }
  }

  nodes.push(rule());
  nodes.push(heading("Pipeline"));
  nodes.push(bulletList(pipelineFacts(ctx)));
  nodes.push(linkParagraph(`Job log: ${ctx.jobName}`, ctx.jobUrl));
  nodes.push(linkParagraph(`Pipeline #${ctx.pipelineId}`, ctx.pipelineUrl));
  // Says plainly that this was machine-filed, so nobody wonders who typed it.
  nodes.push(paragraph("Filed automatically by talos."));

  return doc(...nodes);
}

/**
 * The comment posted when a file's failures change shape.
 *
 * Deliberately a diff and not a re-post of the description: the ticket already
 * carries the original, and a reader wants to know what moved since.
 */
export function buildChangeComment(
  group: FailureGroup,
  diff: SignatureDiff,
  ctx: TicketContext,
): AdfDocument {
  const nodes = [
    paragraph(
      `The failures in ${basename(group.file)} have changed — now ${
        group.tests.length
      } failing test(s).`,
    ),
  ];

  if (diff.suiteChanged) {
    nodes.push(
      paragraph(
        group.suiteFailedToRun
          ? "The suite now fails to run at all, rather than failing assertions."
          : "The suite now runs; the remaining failures are assertion failures.",
      ),
    );
  }

  if (diff.added.length > 0) {
    nodes.push(heading("Newly failing", 4));
    nodes.push(bulletList(diff.added));
  }
  if (diff.removed.length > 0) {
    nodes.push(heading("No longer failing", 4));
    nodes.push(bulletList(diff.removed));
  }

  if (diff.added.length > 0) {
    nodes.push(heading("Details for the new failures", 4));
    for (const detail of group.details
      .filter((d) => diff.added.includes(d.name))
      .slice(0, MAX_DETAILED_TESTS)) {
      nodes.push(paragraph(detail.name));
      nodes.push(codeBlock(capLines(detail.detail, MAX_DETAIL_LINES)));
    }
  }

  nodes.push(linkParagraph(`Job log: ${ctx.jobName}`, ctx.jobUrl));
  nodes.push(paragraph(`Pipeline #${ctx.pipelineId} on ${ctx.ref}.`));

  return doc(...nodes);
}

function pipelineFacts(ctx: TicketContext): string[] {
  const facts = [
    `Project: ${ctx.project}`,
    `Branch: ${ctx.ref}`,
    `Pipeline: #${ctx.pipelineId}`,
    `Job: ${ctx.jobName} (${ctx.jobId})`,
  ];

  if (ctx.summary) {
    facts.push(
      `Run totals: ${ctx.summary.failed} failed, ${ctx.summary.passed} passed, ` +
        `${ctx.summary.total} total`,
    );
  }
  if (ctx.commitTitle) {
    facts.push(
      `Commit: ${ctx.commitTitle}${ctx.commitAuthor ? ` — ${ctx.commitAuthor}` : ""}`,
    );
  }
  if (ctx.traceTruncated) {
    // Worth stating: a reader who cannot find a failure in the excerpt should
    // know the excerpt is partial rather than doubt the parser.
    facts.push("The job log was truncated before parsing; see the full log.");
  }

  return facts;
}

/** Caps a detail block, saying how much was dropped rather than trailing off. */
function capLines(text: string, maxLines: number): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length <= maxLines
    ? lines.join("\n")
    : `${lines.slice(0, maxLines).join("\n")}\n… ${lines.length - maxLines} more line(s)`;
}
