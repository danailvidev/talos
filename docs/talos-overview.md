# Talos

Talos is a self-hosted web app for the delivery work that today is split across Jira, GitLab, Slack, Datadog, LogRocket, and Kubernetes. People use it in the browser. There is also a JSON API.

The short description is **Automate, orchestrate, deliver**: GitLab, Jira, and AI in one place, with a person still responsible for what ships.

## The problem

A ticket, a failing pipeline, a production error, a review comment, and a deploy each live in a different tool. Connecting them is repetitive, and it falls on engineering and QA.

- A GitLab pipeline fails. Someone has to notice, read the log, and file a Jira ticket. The same spec can fail again the next day and be filed a second time, or never be filed at all.
- A production error shows up in Datadog, or a frontend issue shows up in LogRocket. It stays in that tool until someone turns it into a ticket or a test.
- Once a ticket is clear, opening a branch and a draft merge request is still a switch between Jira and GitLab.
- Review comments, conflicts, and a failed check pull the author back into GitLab for the same follow-up on every merge request.
- Shipping a version means editing an environment manifest by hand, then watching the rollout and hoping a new error is noticed.
- Scheduled test suites fail for the same reason across several days. The reports sit in GitLab until someone groups them and decides whether the product, the data, the test, or the infrastructure broke.

The decisions stay with a person: write the ticket, approve a plan, review the diff, merge, and deploy. The time goes into moving information between tools and repeating the same checks.

## What Talos does

Talos sits on the team's existing Jira and GitLab and carries that connecting work. A person starts the step. Talos prepares the artifact: a plan, a draft merge request, a review comment, a test report, or a release merge request. Ask Talos, the in-app assistant, can read and change the same things the signed-in user can.

From one signed-in session, a person can:

- Open the Jira board and, from an issue, ask for a plan, a fix, or a QA run.
- Open GitLab merge requests and ask for a review, a revision, or a conflict resolution.
- Change versions for one environment and deploy, then see whether the rollout landed.
- Read scheduled test results grouped by the broken test, and ask for a read-only triage.
- Read production errors and frontend issues next to the work they belong to.
- Read and reply to Slack in the same app.
- Build a dashboard from the Jira, GitLab, and Talos data they are already allowed to see.

Custom dashboards are built and not yet committed.

Scheduled loops pick up work on a timer. They are experimental and described in [Scheduled loops](#scheduled-loops-experimental). The path above runs when a person starts it.

## Who it is for

Engineering and QA. An administrator creates named accounts and assigns modules (tickets, pull requests, loops, releases, automation, Datadog, LogRocket, Slack). Each person acts with their own GitLab and Jira access. A private loop stays with its owner.

## How a ticket moves

A Jira issue is the unit of work. People still write the ticket, approve the plan, review the diff, and merge.

1. **Intake.** Failures and production errors become tickets. A GitLab pipeline failure is filed once per spec file, into the active sprint, and is not filed again while that ticket is open. A Datadog scan clusters production errors and can file a confirmed regression. LogRocket alerts are recorded so a person can turn a frontend issue into a test. Filing from pipelines and from the Datadog scan runs on a schedule; that schedule is experimental.
2. **Plan, when someone asks for one.** An agent reads the ticket and the repository and writes an implementation plan. It writes no code and opens no merge request. The plan waits until a person approves it. Approving it is what starts the fix, and the approved text is what the agent is given.
3. **Fix.** One issue becomes one branch and one draft merge request. The same path runs from a ticket action or from an approved plan. A scheduled loop can also pick up tickets that carry an opt-in label (`talos` by default). That loop is experimental.
4. **Review.** A person can ask Talos to review a merge request, revise a branch, or rebase and resolve conflicts. Open merge requests can also be reviewed on a schedule, once per new commit, and a separate loop can answer unresolved review comments on merge requests Talos authored. Those schedules are experimental.
5. **Check.** From a ticket, QA can run an AI Playwright pass against the linked merge request. The run follows the team's exploratory-test instructions, records screenshots, and posts pass, fail, or inconclusive on the ticket. A completed run can be turned into a Playwright test and a merge request. A production error can be turned into a regression test the same way, and only when someone asks.

## Deploy

Releases is where a person deploys and then watches what happened. It reads each environment's manifest (`cluster.yaml`) from the releases repository, as the person who is signed in.

**Deploy.** On an environment, the person edits application and service versions and clicks Deploy. Talos updates that environment's manifest, opens a merge request, approves it, and sets it to merge when its pipeline succeeds. The same action can announce the release in Slack. Revert last deploy opens the reverse change the same way. This replaces editing the manifest by hand in an IDE.

**Observe.** The Environments tab shows the versions in the manifest and the live Kubernetes state of each service: pending, deploying, released, or degraded. History lists past version changes. Every upload gets a short pipeline watch.

**After production.** A production deploy can start a watch that keeps running on its own. It waits until the release merge request merges, takes the Datadog errors from the day before the merge as a baseline, then for six hours compares new Datadog errors and newly seen LogRocket issues with that baseline. A new error is recorded on the release and announced, so a regression shows up before someone else reports it. A production change that landed outside Talos is found by a poll and watched the same way. This watch is an experimental loop.

## Automation

Automation is where scheduled test suites are checked for regressions. Reports show, day by day, whether a suite passed, failed its tests, or failed because the pipeline or the report itself broke. A day that passed only after an earlier failure is marked unstable.

Failures are grouped into clusters of the same broken test. From a cluster, a person can ask for a read-only triage. The agent reads the test repository and classifies the failure as a product change, bad data, a test bug, or an infrastructure problem, and recommends a next step. It does not edit code. A cluster can be filed as one Jira ticket, so the same break is not ticketed twice.

Pulling GitLab schedules, jobs, and test reports onto a timer is an experimental loop. Triage and filing a ticket start when a person asks.

## Dashboards

Overview is a custom dashboard, computed at runtime. Talos stores the layout. Each widget's numbers are calculated when the page opens, as the person viewing it, from the data that person is already allowed to see. A refresh reads the sources again. There is no stored history of "how many were open on a past day." A trend uses a date already on the record, such as created, updated, or started.

A built-in TALOS dashboard shows open merge requests, the person's open Jira issues, pipelines, loop runs, and their own agent usage. Anyone can keep their own dashboards. A dashboard is private to its owner. Widgets are a number, a table, or a line, area, bar, pie, or heatmap chart, arranged on a grid the person can drag and resize.

The sources are live Jira issues and GitLab merge requests, plus records Talos already keeps: pipelines, loop runs, the viewer's agent usage, automation results, flaky specs, Datadog issues, and LogRocket issues. A widget can filter, group, and bucket by day, week, or month. Ask Talos can create a dashboard from a description and add or change widgets in place.

## Scheduled loops (experimental)

Loops are experimental. The product works without them: a person starts a plan, a fix, a review, a QA run, a triage, or a deploy from the page for that work.

A loop is a named handler with a cron schedule and a memory of what it already handled. On each tick it looks for new work and enqueues one job per item. A job runs once: one ticket, one merge request, one error. Loop and job are product labels for the same runner.

What a loop can pick up today:

- CI failures filed as Jira tickets.
- Jira tickets that carry the opt-in label, turned into a draft merge request.
- Open merge requests, reviewed once per new commit.
- Unresolved review comments on merge requests Talos authored.
- The Datadog error scan.
- The Automation report sync.
- The six-hour watch after a production deploy.

A custom loop is a prompt plus the repositories it may touch, on a cron schedule. A private loop stays with its owner.

A person can also start the same kinds of jobs directly. Planning a ticket, approving that plan, running Playwright, resolving conflicts, and writing a regression test stay off the timer until someone asks. Ask Talos, Slack, dashboards, and Releases sit beside the runner.

## What the product covers

| Area | What it is for |
| --- | --- |
| Tickets | The Jira board inside Talos: plan, fix, review the description, or start a QA run from the issue. |
| Pull requests | Open GitLab merge requests, with review, revision, and conflict resolution. |
| Releases | Deploy and observe. Change versions for one environment, open and auto-merge the manifest merge request, then watch the pipeline and the Kubernetes rollout. The six-hour production-error watch is an experimental loop. |
| Automation | Scheduled test suites, checked for regressions. Clusters repeated failures, and triages whether a failure is a product change, bad data, a test bug, or infrastructure. Report sync on a timer is an experimental loop. |
| Datadog | Production error issues, owners, and trends. The scheduled scan that files tickets is an experimental loop. It does not open branches. |
| LogRocket | Frontend issues from LogRocket alerts, with a link back to the session. |
| Slack | The workspace inbox in Talos, for reading and replying in the same app. |
| Overview | Custom dashboards. The layout is saved; the numbers are computed when the page opens from Jira, GitLab, and Talos records the viewer can already see. Ask Talos can build and edit them. Built, not yet committed. |
| Ask Talos | A chat assistant that uses the signed-in user's permissions. It can run the same ticket, merge request, dashboard, and loop actions as the UI. |
| Loops | **Experimental.** Scheduled jobs. Built-in loops cover CI failures, labeled tickets, code review, review requests, merge-request follow-up, the Datadog scan, the Automation report sync, and the post-production deploy watch. A custom loop is a prompt plus the repositories it may touch, on a cron schedule. |

## What stays with a person

- **A person decides.** The model proposes a plan, a review, or a code change. Talos queues the work, skips a repeat, and writes only what that action allows. A repeat of a scheduled loop does not file the same ticket or review the same commit again.
- **A person merges product code.** Fixes, follow-ups, regression tests, and generated end-to-end tests open a draft merge request.
- **Unattended coding is opt-in and experimental.** The ticket-to-merge-request loop ignores issues that do not carry the configured label. Description review, conflict resolution, regression tests, and end-to-end runs start from a person's action.
- **A small agent budget.** Background work and Ask Talos share a fixed number of container slots. A plan or a human decision waits in the database and does not hold a slot. Interactive chat is reserved a slot so background jobs leave room for it.
- **Credentials stay out of prompts.** Agents run with the acting user's tokens. QA logins are passed to the browser as secrets, and the prompt and the stored run keep only placeholder names.
- **One installation, one database.** Talos keeps its own history in SQLite: runs, tickets it has already handled, reviews, plans, and agent usage. Settings in the UI override the values used at startup.

## Security

Access, credentials, and agent runs are kept apart. This is the control model, not a procedure for handling secrets.

**Accounts.** Public registration is off. An administrator creates named accounts and assigns a role. A role grants modules, and separately the right to manage users, settings, or other people's loops. A signed-in person can open only the modules that role includes. Ask Talos and dashboards are checked against that same role on every call. A private loop and a private dashboard stay with their owner.

**Whose credentials.** Interactive work uses the signed-in person's own GitLab, Jira, and Slack access. A missing personal token is a missing connection. Talos does not fall back to a shared instance account for that view. Agent spend is tied to an agent account that person connected.

**Secrets.** Integration credentials and personal tokens are encrypted before they are stored. The encryption key lives with the deployment, outside the database rows. The interface reports that a secret is set and does not return its value. Logs, run output, and text coming back from an agent are scrubbed of known secret values. QA logins are handed to the browser as secrets and appear in the prompt only as placeholder names. Losing the encryption key makes stored credentials unreadable.

**Agent boundary.** Coding and QA agents run in isolated containers with a fixed memory, CPU, and process limit. In production the worker has no Kubernetes API access. Only the Talos control plane can create a job and the short-lived input that job needs. A loop can be limited to read-only tools, so it cannot edit files or run a shell. A loop that is allowed to write still stops at the action it was given, such as a draft merge request. Ask Talos calls back into Talos with a short-lived grant for that conversation, as the signed-in user, and the grant ends when the conversation does. The Kubernetes release check can only read workload status in the namespaces it is granted.

## Where it runs

Talos is hosted by the team. Locally, agent and QA jobs run in Docker. A reverse proxy terminates HTTPS when it is exposed beyond the host. Integration credentials are stored encrypted with the database; losing that key makes them unreadable.

Setup and environment variables are in [README.md](../README.md).
