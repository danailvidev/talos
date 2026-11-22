import type { GitLabClient } from "../connectors/gitlab/client.ts";
import type { JiraClient } from "../connectors/jira/client.ts";
import type { FetchLike } from "../connectors/http.ts";
import type { TaskContext } from "../core/task.ts";

export type GitLabGateway = Pick<
  GitLabClient,
  | "listPipelines"
  | "listSchedulePipelines"
  | "listFailedPipelines"
  | "listFailedJobs"
  | "retryJob"
  | "pipeline"
  | "listJobs"
  | "schedule"
  | "pipelineTestReportSummary"
  | "pipelineTestReport"
  | "jobTrace"
  | "currentUser"
  | "project"
  | "getFileRaw"
  | "mergeRequest"
  | "mergeMergeRequest"
  | "listCommits"
  | "commitDiff"
  | "commitMergeRequests"
  | "listMergeRequests"
  | "listMergeRequestsForReview"
  | "listMergeRequestsAuthoredByMe"
  | "listMergeRequestDiscussions"
  | "mergeRequestDiffs"
  | "mergeRequestCommits"
  | "listBranches"
  | "createMergeRequest"
  | "createMergeRequestNote"
  | "createMergeRequestDiscussionNote"
  | "resolveMergeRequestDiscussion"
  | "updateMergeRequestNote"
  | "deleteMergeRequestNote"
>;

export type JiraGateway = Pick<
  JiraClient,
  | "issueTypeId"
  | "accountIdForEmail"
  | "searchAssignableUsers"
  | "userByAccountId"
  | "findSprintFieldId"
  | "resolveActiveSprint"
  | "issueUrl"
  | "issue"
  | "issueDetail"
  // The panel's fuller read and the ticket's thread, for the description review —
  // the one task whose subject is the ticket text rather than the code.
  | "ticketDetail"
  | "comments"
  | "addComment"
  | "createIssue"
  | "searchIssues"
  | "transitions"
  | "transitionIssue"
  | "transitionIssueTo"
  | "extraSelectFields"
>;

export interface TaskConnectorFactory {
  gitlab(ctx: TaskContext, fetch?: FetchLike): GitLabGateway;
  jira(ctx: TaskContext, fetch?: FetchLike): JiraGateway;
}
