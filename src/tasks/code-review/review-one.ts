import type { GitLabGateway } from "../../application/gateways.ts";
import type { ReviewRepository } from "../../application/ports.ts";
import type { MergeRequest } from "../../connectors/gitlab/types.ts";
import { ConfigError } from "../../core/errors.ts";
import { describeError } from "../../core/executor.ts";
import { mutate } from "../../core/step.ts";
import type { TaskContext } from "../../core/task.ts";
import { runAgentJob } from "../../infrastructure/agent/index.ts";
import { reviewContextFiles } from "./context.ts";
import {
  formatFailedNote,
  formatProgressNote,
  formatReviewNote,
  isReviewNoteFor,
} from "./notes.ts";
import { buildReviewPrompt, REVIEW_PROMPT_ID } from "./prompt.ts";
import { ReviewOutputSchema, unstructuredReview } from "./review-result.ts";

export interface ReviewOneArgs {
  ctx: TaskContext;
  gitlab: GitLabGateway;
  ledger: ReviewRepository;
  projectId: string;
  mr: MergeRequest;
}

/**
 * Why no review comment was posted, when none was. Distinct cases rather than a
 * bare `null`: "we already reviewed this sha" and "this was a dry run" look
 * identical from the outside but mean opposite things to whoever clicked the
 * button, and a caller that collapses them reports a dry run on a live run.
 */
export type ReviewOutcome =
  | { action: "reviewed"; noteUrl: string }
  | { action: "already-reviewed"; sha: string }
  | { action: "dry-run" };

/**
 * Reviews and comments on one merge request. The clone happens inside the
 * container — see `infrastructure/agent` — but GitLab's Changes-tab diffs are
 * fetched on the host and mounted in, so the reviewer sees the same files the
 * MR UI shows rather than `git show HEAD`.
 *
 * A non-`reviewed` outcome means nothing was posted, so nothing is recorded —
 * the same "record only what actually happened" rule `mutate` enforces
 * everywhere else.
 */
export async function reviewOne(args: ReviewOneArgs): Promise<ReviewOutcome> {
  const { ctx, gitlab, ledger, projectId, mr } = args;

  // Belt-and-suspenders against a local ledger that missed this sha (a fresh
  // deploy, a wiped table): ask GitLab itself whether we already left a review
  // note for this exact commit before spinning up a container to write another
  // one. Failure here is not fatal — an unreachable API just means we fall
  // through to reviewing, same as before this check existed.
  //
  // Gated on `force` for the same reason the ledger check in `index.ts` is: an
  // explicit run — the PR page's Code review button, a rerun, `task run` — means
  // "review this now", and a second opinion on an unchanged sha is a legitimate
  // thing to ask for. Every queued job is forced (see `worker-pool`, which
  // documents that a handler must not skip work a discoverer asked for), so in
  // practice this guard only holds back the `gitlab-code-review` loop's own
  // cron ticks.
  if (mr.sha && !ctx.force) {
    try {
      const [currentUser, discussions] = await Promise.all([
        gitlab.currentUser(ctx.signal),
        gitlab.listMergeRequestDiscussions(projectId, mr.iid, { signal: ctx.signal }),
      ]);
      const already = discussions.some((discussion) =>
        discussion.notes.some(
          (note) => note.author.id === currentUser.id && isReviewNoteFor(note.body, mr.sha!),
        ),
      );
      if (already) {
        ctx.logger.info(
          { mrIid: mr.iid, sha: mr.sha },
          `skipping !${mr.iid}: already have a review comment at ${mr.sha.slice(0, 8)}`,
        );
        return { action: "already-reviewed", sha: mr.sha };
      }
    } catch (err) {
      ctx.logger.warn(
        { mrIid: mr.iid, err: describeError(err) },
        `could not check for an existing review comment on !${mr.iid}; reviewing anyway`,
      );
    }
  }

  // Absent diffs are not fatal: the entrypoint falls back to a git three-dot
  // against the target branch, which is close enough to review from.
  let contextFiles: Record<string, string> | undefined;
  try {
    const [diffs, commits] = await Promise.all([
      gitlab.mergeRequestDiffs(projectId, mr.iid, ctx.signal),
      gitlab.mergeRequestCommits(projectId, mr.iid, ctx.signal),
    ]);
    contextFiles = reviewContextFiles({ diffs, commits });
    ctx.logger.info(
      { mrIid: mr.iid, files: diffs.length, commits: commits.length },
      `fetched GitLab MR !${mr.iid} diffs (${diffs.length} file(s), ${commits.length} commit(s))`,
    );
  } catch (err) {
    ctx.logger.warn(
      { mrIid: mr.iid, err: describeError(err) },
      `could not fetch GitLab diffs for !${mr.iid}; the container will build a git three-dot diff instead`,
    );
  }

  let progress: { id: number } | null = null;
  try {
    progress = await mutate(
      ctx,
      `post a review-started note on MR !${mr.iid}`,
      () =>
        gitlab.createMergeRequestNote(
          projectId,
          mr.iid,
          formatProgressNote(ctx.executionId),
          ctx.signal,
        ),
      { mrIid: mr.iid, executionId: ctx.executionId },
    );
    if (progress) {
      ctx.logger.info(
        { mrIid: mr.iid, noteId: progress.id },
        `posted review-started note on MR !${mr.iid}`,
      );
    }
  } catch (err) {
    ctx.logger.warn(
      { mrIid: mr.iid, err: describeError(err) },
      `could not post a review-started note on MR !${mr.iid}; continuing with the review`,
    );
  }

  try {
    const { output: review } = await runAgentJob({
      executionId: ctx.executionId,
      label: mr.iid,
      workspace: {
        project: projectPathOrThrow(projectId),
        branch: mr.source_branch,
        targetBranch: mr.target_branch,
        token: ctx.secrets.require("GITLAB_TOKEN"),
      },
      contextFiles,
      prompt: buildReviewPrompt(
        `This is merge request !${mr.iid}, "${mr.title}", branch ${mr.source_branch} ` +
          `targeting ${mr.target_branch}. Review the GitLab Changes-tab diff ` +
          `(every commit on the MR versus ${mr.target_branch}), following the ` +
          `repo's CLAUDE.md / AGENTS.md / docs/guidelines.`,
        mr.target_branch,
        ctx.prompts[REVIEW_PROMPT_ID],
      ),
      appendRepositoryGuidelines: true,
      output: ReviewOutputSchema,
      // A malformed review is still worth posting; see `unstructuredReview`.
      onUnstructured: unstructuredReview,
      writePolicy: "none",
      model: ctx.llm.model,
      effort: ctx.llm.effort,
      signal: ctx.signal,
      logger: ctx.logger,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    });

    const body = formatReviewNote(mr, review.summary, review.findings);
    ctx.logger.info(
      { mrIid: mr.iid, findings: review.findings.length },
      `posting review comment on MR !${mr.iid}`,
    );

    const posted = await mutate(
      ctx,
      progress
        ? `update the review comment on MR !${mr.iid}`
        : `post a review comment on MR !${mr.iid}`,
      () =>
        progress
          ? gitlab.updateMergeRequestNote(projectId, mr.iid, progress.id, body, ctx.signal)
          : gitlab.createMergeRequestNote(projectId, mr.iid, body, ctx.signal),
      { mrIid: mr.iid, findings: review.findings.length },
    );

    if (posted == null) return { action: "dry-run" };

    const noteUrl = `${mr.web_url}#note_${posted.id}`;
    ledger.record({ taskId: ctx.taskId, projectId, mrIid: mr.iid, sha: mr.sha!, noteUrl });
    return { action: "reviewed", noteUrl };
  } catch (err) {
    const started = progress;
    if (started) {
      try {
        // Do not pass ctx.signal: on cancel it is already aborted, and the
        // GitLab write would never leave the host.
        if (ctx.signal.aborted) {
          await mutate(
            ctx,
            `remove the review-started note on MR !${mr.iid}`,
            () => gitlab.deleteMergeRequestNote(projectId, mr.iid, started.id),
            { mrIid: mr.iid, executionId: ctx.executionId },
          );
        } else {
          await mutate(
            ctx,
            `update the review-started note on MR !${mr.iid} with the failure`,
            () =>
              gitlab.updateMergeRequestNote(
                projectId,
                mr.iid,
                started.id,
                formatFailedNote(ctx.executionId, describeError(err)),
              ),
            { mrIid: mr.iid },
          );
        }
      } catch (updateErr) {
        ctx.logger.warn(
          { mrIid: mr.iid, err: describeError(updateErr) },
          ctx.signal.aborted
            ? `could not remove the review-started note on MR !${mr.iid} after cancel`
            : `could not update the review-started note on MR !${mr.iid} after failure`,
        );
      }
    }
    throw err;
  }
}

/**
 * The container clones with `git`, which needs a `group/project` path — not
 * a numeric id, which only the REST API accepts. Surfacing that here, rather
 * than in `infrastructure/agent`, keeps the error naming the caller's config field.
 */
export function projectPathOrThrow(projectId: string): string {
  if (/^\d+$/.test(projectId)) {
    throw new ConfigError(
      `code review needs a 'group/project' path to check branches out inside ` +
        `the review container; '${projectId}' is a numeric id, which only the REST API accepts.`,
    );
  }
  return projectId;
}
