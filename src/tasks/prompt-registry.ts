import {
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  REVIEW_PROMPT_ID,
} from "./code-review/prompt.ts";
import {
  DEFAULT_FOLLOW_UP_PROMPT_TEMPLATE,
  FOLLOW_UP_PROMPT_ID,
} from "./mr-follow-up/agent.ts";
import {
  DEFAULT_MR_REVISION_PROMPT_TEMPLATE,
  MR_REVISION_PROMPT_ID,
} from "./mr-revision/agent.ts";
import {
  DEFAULT_RESOLVE_CONFLICTS_PROMPT_TEMPLATE,
  RESOLVE_CONFLICTS_PROMPT_ID,
} from "./resolve-conflicts/agent.ts";
import {
  DEFAULT_TICKET_PROMPT_TEMPLATE,
  TICKET_PROMPT_ID,
} from "./jira-ticket-to-mr/agent.ts";
import {
  DEFAULT_FIX_ISSUE_PLANNED_PROMPT_TEMPLATE,
  DEFAULT_FIX_ISSUE_PROMPT_TEMPLATE,
  FIX_JIRA_ISSUE_PLANNED_PROMPT_ID,
  FIX_JIRA_ISSUE_PROMPT_ID,
} from "./fix-jira-issue/agent.ts";
import {
  DEFAULT_PLAN_ISSUE_PROMPT_TEMPLATE,
  PLAN_JIRA_ISSUE_PROMPT_ID,
} from "./plan-jira-issue/agent.ts";
import {
  DEFAULT_REVIEW_TICKET_PROMPT_TEMPLATE,
  REVIEW_TICKET_PROMPT_ID,
} from "./review-ticket/agent.ts";
import {
  DEFAULT_WRITE_REGRESSION_TEST_PROMPT_TEMPLATE,
  WRITE_REGRESSION_TEST_PROMPT_ID,
} from "./write-regression-test/agent.ts";

export interface PromptTemplateDef {
  id: string;
  label: string;
  description: string;
  /** `{{name}}` placeholders the template may use. */
  variables: string[];
  defaultTemplate: string;
  /** Task definition IDs that use this prompt (e.g., ["gitlab-code-review"]). */
  definitionIds?: string[];
}

/** Every overridable prompt in the system. The web UI's Prompts page lists exactly these. */
export const PROMPT_TEMPLATES: PromptTemplateDef[] = [
  {
    id: REVIEW_PROMPT_ID,
    label: "GitLab code review",
    description:
      "Sent to Claude inside the review container for each merge request or branch reviewed.",
    variables: ["scope", "context"],
    defaultTemplate: DEFAULT_REVIEW_PROMPT_TEMPLATE,
    definitionIds: ["gitlab-code-review"],
  },
  {
    id: FOLLOW_UP_PROMPT_ID,
    label: "MR follow-up",
    description:
      "Sent to Claude when addressing reviewer feedback on an authored merge request.",
    variables: ["mrIid", "project", "branch"],
    defaultTemplate: DEFAULT_FOLLOW_UP_PROMPT_TEMPLATE,
    definitionIds: ["gitlab-mr-follow-up"],
  },
  {
    id: MR_REVISION_PROMPT_ID,
    label: "MR revision",
    description:
      "Sent to Claude for each free-form revision a human requests on an existing merge request.",
    variables: ["mrIid", "project", "branch"],
    defaultTemplate: DEFAULT_MR_REVISION_PROMPT_TEMPLATE,
    // Queue handler only: there is no loop instance for a per-loop override.
  },
  {
    id: RESOLVE_CONFLICTS_PROMPT_ID,
    label: "MR conflict resolution",
    description:
      "Sent to Claude after the container has started a rebase onto the target branch and stopped on a conflict.",
    variables: ["mrIid", "project", "branch", "targetBranch"],
    defaultTemplate: DEFAULT_RESOLVE_CONFLICTS_PROMPT_TEMPLATE,
    // No definitionIds: this prompt belongs to a queue handler with no loop in
    // front of it, so there is no instance for a per-loop override to hang off.
  },
  {
    id: TICKET_PROMPT_ID,
    label: "Jira ticket to MR",
    description:
      "Sent to Claude when attempting a Jira ticket in an isolated branch workspace.",
    variables: ["ticketKey", "project", "baseBranch"],
    defaultTemplate: DEFAULT_TICKET_PROMPT_TEMPLATE,
    definitionIds: ["jira-ticket-to-mr"],
  },
  {
    id: FIX_JIRA_ISSUE_PROMPT_ID,
    label: "Fix Jira issue",
    description:
      "Sent to Claude inside the container when resolving a single Jira issue.",
    variables: ["issueKey", "project", "baseBranch"],
    defaultTemplate: DEFAULT_FIX_ISSUE_PROMPT_TEMPLATE,
    definitionIds: ["fix-jira-issue"],
  },
  {
    id: FIX_JIRA_ISSUE_PLANNED_PROMPT_ID,
    label: "Fix Jira issue (from an approved plan)",
    description:
      "Sent to Claude instead of the prompt above when the fix is carrying out a plan a human approved. The clause that matters is the instruction to report rather than improvise when the plan turns out to be wrong about the code — an agent that quietly builds something else makes the approval meaningless.",
    variables: ["issueKey", "project", "baseBranch"],
    defaultTemplate: DEFAULT_FIX_ISSUE_PLANNED_PROMPT_TEMPLATE,
    // No definitionIds deliberately: `fix-jira-issue` already claims that mapping
    // for the ungated prompt, and a per-loop override must not silently apply to
    // both. The gated path resolves this id directly.
  },
  {
    id: PLAN_JIRA_ISSUE_PROMPT_ID,
    label: "Plan a Jira issue",
    description:
      "Sent to Claude inside a read-only container when writing the implementation plan a human approves before any code is written. The clause that matters is the instruction to name real files and call sites — a plan that only restates the ticket reads plausibly and tells the reviewer nothing they could disagree with.",
    variables: ["issueKey", "project", "baseBranch"],
    defaultTemplate: DEFAULT_PLAN_ISSUE_PROMPT_TEMPLATE,
    // No definitionIds: a queue handler with no loop in front of it, so there is
    // no instance for a per-loop override to hang off.
  },
  {
    id: REVIEW_TICKET_PROMPT_ID,
    label: "Review a Jira description",
    description:
      "Sent to Claude when reviewing one ticket's requirements. The clause that matters is the permission to answer \"ready\" — without it every review invents questions to look useful, and a reporter who gets three of those stops reading the fourth.",
    variables: ["issueKey"],
    defaultTemplate: DEFAULT_REVIEW_TICKET_PROMPT_TEMPLATE,
    // No definitionIds: a queue handler with no loop in front of it, so there is
    // no instance for a per-loop override to hang off.
  },
  {
    id: WRITE_REGRESSION_TEST_PROMPT_ID,
    label: "Write a regression test",
    description:
      "Sent to Claude inside the container when turning one production error into a test. The clause that matters is the permission to answer \"not-reachable\" — without it an agent invents a test that passes and covers nothing.",
    variables: ["source", "project", "baseBranch"],
    defaultTemplate: DEFAULT_WRITE_REGRESSION_TEST_PROMPT_TEMPLATE,
    // No definitionIds: a queue handler with no loop in front of it, so there is
    // no instance for a per-loop override to hang off.
  },
];

/**
 * Maps a task definition ID to the prompt template ID it uses, if any.
 * Used to resolve per-loop prompt overrides.
 */
export function promptIdForDefinition(definitionId: string): string | undefined {
  for (const template of PROMPT_TEMPLATES) {
    if (template.definitionIds?.includes(definitionId)) {
      return template.id;
    }
  }
  return undefined;
}
