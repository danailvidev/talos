# Competitor software-factory findings

Research notes from 2 November 2026. Each repository below was read from its
public README (and, where the README pointed at a concrete mechanism, from the
behavior it documents). The goal is ideas Talos can reimplement. Nothing here
is a plan to vendor their code.

Talos already runs the spine these products are selling: a Jira plan a person
approves, a fix that opens a draft merge request, review, follow-up, conflict
resolution, Playwright E2E, CI and Datadog intake, scheduled loops, Slack, and
a bounded agent budget. The useful ideas are the controls around that spine.

## What Talos already covers

Do not rebuild these. They are the baseline the recommendations sit on.

| Talos piece | What it already does |
| --- | --- |
| `plan-jira-issue` | Reads a Jira issue and the repository, writes an implementation plan, and stops. Writes no code and opens no merge request. |
| Plan approval | Approving the plan enqueues `fix-jira-issue-one` with the approved text in the job params, so a later re-read cannot hand the container text nobody approved. |
| Waiting without a slot | The plan job finishes and waits in SQLite. A run that held its container while a human decided would occupy an agent slot for hours. |
| `fix-jira-issue` / `fix-jira-issue-one` | One issue, one branch off the target, one draft merge request. The form and the queued graph click run the same pipeline. |
| `jira-ticket-to-mr` | The unattended loop that discovers tickets and opens merge requests. |
| `gitlab-code-review`, `gitlab-mr-follow-up`, `gitlab-mr-revision-one` | Scheduled review, comment follow-up, and revision. |
| `gitlab-resolve-conflicts-one` | Conflict resolution on an open merge request. |
| `review-ticket-description` | Ticket-description review, on demand rather than on a timer. |
| `e2e-test`, `write-e2e-test`, `write-regression-test` | Playwright evidence and test-writing jobs. Credentials stay out of the prompt. |
| `gitlab-ci-failure`, `triage-automation-failure`, `triage-datadog-error`, `datadog-scan` | Failure and error intake into tickets. |
| `deploy-watch`, `release-pipeline-watch`, `release-repo-poll` | Release and deploy observation. Kubernetes release status is read-only and independent of those jobs. |
| `custom-loop` | Prompt-driven scheduled loops without a new TypeScript handler. |
| Worker orchestration | Leases, heartbeats, actor-fair admission, an interactive reservation inside the total agent budget, and reconciliation. |
| Checkpoint suspension | Specified and capability-gated. No production provider. Cancelling and restarting is not suspension, and freezing a container does not free its slot. |
| Ask Talos | Can list, read, create, update, delete, and reschedule loops as the signed-in user. |

## Ranked ideas

### 1. A fresh reviewer with a hard stop

Sources: zeroshot, Finn-loop, factory.

`gitlab-code-review` and `gitlab-mr-follow-up` are separate polls. Close them
into one loop:

1. The fixer opens one merge request for one Jira issue.
2. A new session that never saw the implementer's transcript reviews that exact
   head against the approved plan and the required checks.
3. A "no" goes back only for the must-fix findings.
4. A new fresh reviewer checks the new head.
5. After two failed rounds, mark the merge request stuck and leave the queue.

The model must not be able to add another retry or widen the contract to make
a check pass. zeroshot's rule is the right one: the engine enforces order,
routing, and retry limits. Model output cannot add an edge or raise a bound.

### 2. Fail-to-pass proof, with a verdict the agent cannot paraphrase

Sources: factory's verifier, Loki.

The independent check reverts the fix and confirms the new test fails on the
old code, then passes after. The gate script prints one line (`PASS`, `FAIL`,
`MISSING`) and the merge-request comment quotes it. A missing test command is
a failure, not a green run. An agent paraphrase of "tests passed" is not a
verdict.

Loki's extra rule: a declared behavior change stays partial unless a test
fails on the old code and passes after. Factory's extra rule: the verifier
reads the diff cold and is told to ignore any account of what was done. It
rejects when uncertain.

This is the highest-signal check Talos does not have. A signed receipt can
wait. The proof cannot.

### 3. Stop starting work when review is backed up

Source: factory's `STOP_IF`.

If N draft merge requests are waiting on a person, `jira-ticket-to-mr` and
`fix-jira-issue` refuse to claim anything. Generation is cheaper than review
attention. The binding constraint is how many decisions are pending, not how
many agents can run. This is a scheduler rule on data Talos already stores.

### 4. A charter, and a backlog score before anything is planned

Sources: factory, Superplane, Finn-loop.

A repository file states:

- protected paths (auth, billing, migrations, permissions, deployment);
- what may be picked up unattended;
- what always needs a plan;
- what never opens a merge request on its own;
- the review-queue cap from idea 3.

Autonomy tracks consequence, not difficulty. A large change on an unlaunched
project can be safer than a small change to an auth path.

Superplane's extra piece: score Jira issues for agent fit and list the
decisions a human must answer before `plan-jira-issue` runs. Ambiguous tickets
stay out of the queue instead of becoming confident wrong merge requests.
Talos plans when asked. It does not classify the backlog.

### 5. The approved plan is the only contract

Source: Finn-loop.

Number acceptance criteria and non-goals. `gitlab-mr-follow-up` may fix a
review finding. It may not grow scope because someone asked in a thread. A new
behavior requires an edit to the Jira issue or the plan, then a new approval.

Finn-loop's wording is the rule to copy: if it is not in the issue, it does
not exist. Acceptance criteria are observable outcomes. Non-goals are binding.
One issue per merge request, sized so one agent run can finish it.

### 6. One blocked question, answered in Slack, resumed from SQLite

Sources: Finn-loop, Lemma, Loki's `loki answer`.

Talos already refuses to hold a container while a human decides. Keep that.
The missing state is:

- the job ends with exactly one question;
- Slack posts it to the people who can answer;
- the reply is written onto the Jira issue;
- the blocked label comes off and the same work resumes;
- at action time, re-read GitLab and Jira.

Do not trust the Slack message as proof the merge request is still
merge-ready, still at the reviewed SHA, or still blocked. Store event ids so
duplicate deliveries are harmless. Claim a post in durable storage before
calling Slack. Retry transient failures only after repeating the live checks.
Provide a kill switch for automated posting.

Lemma's "wait for days, then resume" is this pattern. It does not require
Lemma's pods, generated apps, or chat surfaces. Checkpoint suspension is the
wrong tool for a human wait.

Loki's matching outcome is `BLOCKED`: the run stops and asks one question
instead of guessing, and `loki answer` continues under the same run id.

### 7. A watchdog that alerts once

Source: Finn-loop.

A scheduled loop over existing runs, not a new agent that invents fixes.
Alert on:

- work stuck in building or review past a threshold;
- changes requested with no follow-up;
- the review queue over the cap;
- an empty ready queue or a growing blocked backlog;
- red required checks on the default branch.

Post when a condition opens, stay quiet while it persists, and post again
when it clears. A watchdog that repeats the same alert becomes noise.

Normalize Jira and GitLab events into one pipeline record per issue and merge
request, with stages such as awaiting approval, ready, building, review,
merge-ready, blocked, and done. The status digest and the watchdog should
read that same model.

## Next, once that loop is stable

### 8. A read-only morning status, separate from the builder

Sources: Finn-loop, CodeAF's "needs you" inbox.

One digest: merge these, approve these plans, answer these blocks. It never
enqueues a fix. Planning and building stay different jobs.

CodeAF's version of the same idea is one home across every project: what
needs you, what is unread, what is running, and what it cost. A digit answers
the question in that row. The useful slice for Talos is the inbox, not the
terminal UI.

### 9. A run dossier on the ticket and the merge request

Sources: Loki, Chainloop, factory's `gates.sh`.

Every fix, review, and E2E run should end with a structured record:

- outcome;
- head SHA;
- checks that ran;
- checks that were missing (fail closed);
- an explicit "not proven" list;
- cost and elapsed time, split by stage when known.

Factory's gate script ends with a line skills must quote verbatim. A missing
required gate is `MISCONFIGURED` and exits non-zero, so an absent test command
cannot quietly become a green run.

Loki's receipt is stricter: a local Ed25519 signature, a hash of the event
log, and a check that the checkout still matches the sealed code. Verdicts
include `VERIFIED`, `PARTIAL`, `ALREADY_SATISFIED`, `SPEC_CONFLICT`, and
`FAILED`. Run outcomes also include `BUDGET_STOP`, `BLOCKED`, `STALLED`, and
`CANCELLED`, which are not receipt verdicts. A partial run opens a draft
pull request titled as partial and leads with what is not proven. A verified
run opens a ready pull request. Anything else keeps the branch local.

Chainloop's full signed in-toto graph is a different product. The part worth
taking is that the gate runs outside the agent, the failure text is what the
agent reads, and a rule can start report-only before it blocks anything.
`chainloop trace` also attaches the ticket or approved plan next to the
session, so the record holds what was asked and what was produced.

Do not build an attestation registry. Attach the dossier to the Jira issue
and the GitLab merge request.

### 10. Lessons become a merge request, not a silent prompt edit

Sources: Finn-loop, SWE-AF `enable_learning`, zeroshot Active Memory.

Scan must-fix findings on merged merge requests, including earlier verdicts
that disappeared once the pull request was corrected. Distill one reusable
rule. Open a proposal merge request. A person decides whether it becomes
policy by merging it.

Store rules as version-controlled files with applicability tags and source
merge requests. Deduplicate against active rules. Reinforce an existing rule
when the same failure class recurs. Agents must not edit the instructions
that govern them.

SWE-AF's `enable_learning` injects conventions and failure patterns from early
issues into later ones inside the same build. zeroshot Active Memory recalls
lessons from costly mistakes and can backfill from local history. Both are
the right signal. Finn-loop's human merge is the right control. Do not inject
last week's failures straight into the next coder prompt.

### 11. A small risk graph, not a workflow engine

Source: zeroshot.

A fixed graph on top of existing jobs:

```text
worker
  ▼
risk check
  ├─ auth, payments, migration, permissions
  │    ▼
  │  critic / security review ── no ─┐
  ▼                                  │
acceptance + code review (parallel)  │
  └─ any no ─────────────────────────┘
       back to the same worker, with both reviews, bounded retries
  ▼
draft merge request
```

Per-step model choice is configuration on that graph: a strong worker, a
cheaper or different checker, a fresh reviewer session every pass. The same
worker can keep its session across repairs. Reviewers start clean.

Do not let a run add edges. Do not build a general graph product. zeroshot's
auto-research template (scouts, a researcher, a fresh reviewer, archived
candidates) is a different product and is not a Talos fit.

### 12. Typed debt instead of another retry

Source: SWE-AF's middle loop.

SWE-AF uses three nested loops:

| Loop | Scope | Trigger | Action |
| --- | --- | --- | --- |
| Inner | One issue | QA or review fails | Coder retries with feedback |
| Middle | One issue | Inner loop exhausted | Advisor retries with a new approach, splits the work, or accepts it with typed debt |
| Outer | Remaining DAG | Escalated failures | Replanner restructures remaining issues and dependencies |

Take the inner and middle loops. When the retry budget is spent, stop and
record what was dropped, how severe it is, and why. Propagate that debt onto
the Jira issue.

Skip the outer replanner and the fleet of hundreds of agents per build.
Talos's unit of work is one Jira issue, and that fleet fights the agent
budget Talos already enforces. SWE-AF also tracks compromises as typed,
severity-rated debt when scope is relaxed. That record is worth keeping even
if the replanner is not.

### 13. Split a large plan into a blocked-by chain

Source: Finn-loop.

`plan-jira-issue` can propose several one-day issues linked by blocked-by.
All parts may be approved up front. The queue hides a child until its blocker
is Done, and the claim operation enforces the same rule. A person approves
the packet. Builders stay single-issue jobs.

### 14. UI changes need preview evidence before review can pass

Sources: Finn-loop, the Playwright runs Talos already has.

For a merge request that changes rendered UI, require the builder to open the
deployment preview, sign in with a non-production account, run every
verification step from the issue, and record per-step pass or fail with
screenshots. The reviewer treats missing or failed evidence as a must-fix
finding.

Finn-loop also asks behavior-changing pull requests to update the matching
architecture document, or to state why no docs change is justified. A
lightweight check can require that statement in the merge-request body.

## Worth taking later

### Multi-repo, one ticket

Sources: Open-Inspect environments, SWE-AF `config.repos`, Loki composite
receipts.

One Jira issue can name several repositories. Each gets its own worktree and
its own merge request. The combined verdict equals the weakest child. Loki's
composite never reads higher than its weakest child receipt. SWE-AF marks one
repo `primary` (failures block) and the others `dependency` (failures are
recorded and do not block). Open-Inspect caps an ad-hoc set at 10 repositories
and can save the set as a named environment with its own secrets.

Build this only if cross-repo tickets are a real queue. It is not part of
the first seven.

### Sandbox warm start and repository hooks

Source: Open-Inspect. Talos already has `TALOS_AGENT_CACHE`.

Open-Inspect layers three startup speeds:

- filesystem snapshots after each prompt, so a follow-up restores instead of
  re-cloning;
- pre-built images per repository or environment, rebuilt on a schedule with
  current commits and dependencies;
- proactive warming that starts the sandbox while the user is still typing.

Repositories can ship `.openinspect/setup.sh` (provisioning, skipped on
snapshot restore) and `.openinspect/start.sh` (every non-build start, fatal
on failure). Both receive the boot mode. Port tunnels expose dev servers back
to the session. Browser automation is in the coding sandbox, not only in a
separate E2E job.

The Talos slice is per-repo setup and start scripts, plus a snapshot so the
second run does not reinstall. Port tunnels matter when an agent must boot
the app. Do not adopt a second sandbox platform.

### Standing orders confirmed in chat

Source: CodeAF.

"Never commit straight to the default branch." "Every Monday, draft the
weekly update." "Tell me when CI goes red." A card asks once. Confirming it
makes the order durable for one project or for every project, on the same
spend limit as other work.

Ask Talos can already create loops. The missing piece is the confirmation
card and a project-scoped rule that coding jobs must load. CodeAF's headless
`do` command is the other front door: the same factory with the conversation
removed, one JSON result, and recorded assumptions where a chat would have
asked. `custom-loop` is the closer Talos equivalent.

### Policy outside the agent

Source: Chainloop.

A small Talos contract, not an evidence product:

- which models may write code;
- which checks a run must hand in;
- no secrets in prompt logs;
- report-only first, then gate;
- any bypass recorded on the run.

Chainloop's contract is a YAML document in git. Policies are Rego or WASM.
`gate: false` reports and lets the run pass. `gate: true` blocks it. The same
contract applies to a person, a pipeline, and an agent. The job prints every
failing policy and its reason where the agent can read it, and the agent
pushes again until the gates pass. The verifier is outside the agent's
process, so the agent cannot turn it off from inside the session.

That loop shape matches idea 2 and idea 9. The in-toto attestations, OCI
registry, SBOM materials, and SLSA provenance do not.

### Risk-tiered merge, only after the evidence is reliable

Source: Finn-loop's mature factory, not its starter.

The public starter's rule is: agents never merge. A later, explicit policy
can add three lanes:

- human merge for application code and anything involving schema, auth,
  permissions, billing, deployment, or provisioning;
- a person's reaction authorizes one exact head, and the system re-reads
  labels, CI, conflicts, and SHA before merging;
- an opt-in allowlist (docs, tests) plus an explicit override label and a
  global kill switch.

Never infer safety from a small diff. A merge request that changes after
approval must earn approval again. factory is stricter: merge is never
automated on any tier, and branch protection is the enforcement boundary.
Talos should stay on that stricter rule until idea 2's evidence is boringly
reliable. Even then, protected paths stay human-only.

### Commit identity

Source: Open-Inspect.

Commits are attributed to the user who sent the prompt, by configuring git
identity per prompt. This matters for multiplayer sessions. Talos runs
unattended under one identity (`Talos` / `talos@talos.local` on the fix job).
Revisit only if several people prompt the same live session.

## What to leave

| Source | Leave it |
| --- | --- |
| Superplane | The hosted factory. The plan gate already exists as `plan-jira-issue`. |
| Open-Inspect | Multiplayer presence, per-prompt git identity, a second sandbox platform (Modal, Daytona, E2B, Boat), code-server, and a web terminal inside the run. |
| zeroshot | A general graph product, organization profile hosting, and the auto-research template. |
| SWE-AF | DAG replanning, fleet scale, and hundreds to thousands of agent invocations per build. |
| Loki | Ed25519 receipts until the dossier exists. Vendor nothing: the license is Business Source 1.1 until 19 March 2030. Also skip deploy-from-receipt and Sentry-webhook auto-fix until the dossier and the charter exist. |
| Lemma | Pods, generated apps, row-level table security, and WhatsApp, Telegram, email, or Teams teammates. |
| CodeAF | The terminal UI, Pareto model pooling, the anonymous model-pool relay, and the remote ssh chat split. |
| Chainloop | in-toto, Rego, Sigstore, an artifact store, and a provenance graph. |
| Finn-loop | Auto-merge, including the "safe" lane, until review evidence is reliable. Slack as a second source of truth. |
| factory | A GitHub-issue queue. Jira and GitLab are already the queue. Also skip copying Claude-routine scheduling; Talos already has a clock. |

## Suggested order

1. Run the existing plan, fix, review, and follow-up jobs as one bounded loop
   with a fresh reviewer and a stuck state.
2. Add fail-to-pass proof and a verbatim gate line on the merge request.
3. Add the charter and the review-queue cap.
4. Make the approved plan the only contract follow-up is allowed to satisfy.
5. Add the single blocked question, Slack delivery, and SQLite resume.
6. Add the watchdog and the read-only morning status on the same pipeline
   record.
7. Add the run dossier. Start every new policy report-only.
8. Add blocked-by issue chains and preview evidence for UI changes.
9. Add the learning merge request once reviews produce recurring findings.
10. Consider multi-repo tickets, sandbox snapshots, and standing orders only
    after the loop above is the normal way work ships.

The goal is not unattended merges. People keep product judgment, protected
paths, and every irreversible action. Agents keep repeatable execution.

## Per-repository notes

### Superplane

https://github.com/superplanehq/superplane

Open-source factory for one-shot engineering. Apache 2.0. It turns
high-confidence backlog issues into verified, review-ready pull requests.
The engine coordinates coding agents, source control, CI, review, approvals,
and feedback so an engineer does not project-manage every step.

Concrete behavior from the README:

- Continuously evaluates which backlog issues agents can handle with high
  confidence.
- Applies the same workflow-level guardrails to every run.
- Analyzes the issue, helps refine the plan, and identifies decisions that
  need a human before implementation begins.
- Checks the agent's work and sends failures back with actionable context.
- An agent review assesses merge confidence and highlights remaining concerns.
  A person makes the final decision with that evidence.
- Can wait for an event from external tools, call an agent, or ask a person
  for approval.
- The first recommended run is a small bug, a test fix, or a documentation
  update.
- Self-host is Docker Compose on one Linux VM, or Kubernetes on AWS, Azure,
  or Google Cloud. Models are bring-your-own. Cloud and on-prem are both
  supported.

The README is a product overview. It does not document the queue schema, the
confidence rubric, or the verification commands. Take the triage idea. Do not
treat the rest as a design.

Talos gap: nothing scores the Jira backlog for agent suitability or lists the
decisions a plan must not guess.

### Open-Inspect background-agents

https://github.com/open-inspect/background-agents

Open-source background coding agents, inspired by Ramp's Inspect. MIT.
Single-tenant by design: every user is a trusted member of one organization.
It is not a multi-tenant isolation story.

Concrete behavior:

- Clients are the web UI, Slack, GitHub pull requests, Linear issues, and
  authenticated webhooks.
- Sessions run in a full dev sandbox (Node, Python, git, browser automation,
  optional code-server and a web terminal). Harnesses are OpenCode or Claude.
- Models include Anthropic (API key or a connected Claude subscription),
  Codex via a ChatGPT subscription, xAI Grok via SuperGrok, and OpenCode Zen.
  Reasoning effort is per session.
- Filesystem snapshots, pre-built images, and proactive warming, as described
  above.
- One session can clone up to 10 repositories. A named environment saves that
  set with its own secrets scope and optional pre-built images.
- Managed skills: reusable instructions and files, assigned globally or to
  selected repositories and environments, with personal profiles and exact
  revisions pinned to a session.
- Multiplayer: presence, prompts attributed in git commits, live streaming to
  every connected client.
- Automations: cron with timezone, Sentry alerts, GitHub workflow-run
  completion with workflow-name and conclusion filters, inbound webhooks with
  JSONPath filters, and fan-out of one schedule across up to 10 repositories.
  Auto-pause after 3 consecutive failures. Manual trigger. Run history.
- Child sessions: `spawn-child` returns immediately, the parent keeps working,
  children run in their own sandboxes and branches. Follow-up, status, and
  cancel exist. Depth limits and per-repo guardrails are enforced.
- Repository lifecycle scripts `.openinspect/setup.sh` and `start.sh`, with
  boot mode exposed and credentials limited to the session's repository set.
- Secrets are AES-256-GCM, scoped globally, per repo, or per environment, and
  injected as environment variables. Bulk `.env` paste is supported.
- Security notes worth keeping: credentials are brokered on demand but cached
  on disk, so snapshots can retain them. Grant removal does not immediately
  revoke issued tokens. GitHub reach is the App installation, not the user's
  personal repository permissions. GitLab is a deployment-wide PAT. Private
  sessions are readable by the owner and explicit collaborators. Team-owned
  actions require current owning-team membership.

Talos gap: warm snapshots, per-repo boot scripts, and a first-class
multi-repo environment. The security notes about snapshot-cached credentials
apply if Talos adds snapshots. Child-session fan-out is a worse fit than
Finn-loop's blocked-by chain, because Talos capacity is a small semaphore.

### zeroshot

https://github.com/the-open-engine/zeroshot

Open-source meta-harness. MIT. You write the QA process as a graph. The
engine enforces it. A skill can ask for a review; zeroshot decides which
agents write, which independent agents review or test, what must pass, and
where rejected work goes. Each step can use its own harness and model. Graphs
are saved as profiles, locally or on their hosted platform.

Built-in `software-change` workflow:

1. A worker implements the task.
2. Acceptance and code reviewers check the result independently, in parallel.
3. Rejected work returns to the same worker with both reviews, then through
   both reviews again.
4. With delivery enabled, accepted work goes through the configured Git and
   CI steps.
5. Delivery conflicts return through repair and review.

Delivery modes: local only, push the managed branch, prepare a mergeable pull
request without merging, or proceed through pull request, CI, and merge.
Pull-request and ship runs address visible review feedback unless told not to.
GitHub (including Enterprise) and GitLab are both supported. Docker and
hosted runs require an exact Git source.

Other mechanisms:

- `pr-review` classifies whether reproduction is required, exercises the local
  stack when it is, and checks code and linked-issue coverage before posting
  a short report.
- Runs are bounded. Events go to a durable SQLite ledger. A passing run means
  the configured checks accepted the work, not that the change is correct in
  general.
- Active Memory recalls lessons from costly mistakes and can backfill from
  local history.
- A failed run with a recoverable workspace can be restarted or resumed.
- The `auto-research` template runs a fixed number of iterations: three scouts
  propose directions, one researcher runs an experiment, a fresh reviewer
  checks evidence. Scouts and the researcher keep their sessions across
  rounds. Candidates are archived under `.zeroshot/research`.
- They report a small model in a zeroshot loop matching a larger model's
  ProgramBench score at a median 58% of its cost. Treat that as their claim,
  not as a Talos benchmark.
- Self-host is a target container that serves the engine, a profile editor,
  and a run viewer. Harness CLIs are pinned in the image.
- Opcore, a sibling project, gives coding agents feedback on each edit while
  they write.

Talos gap: the enforced graph and the fresh-reviewer repair loop. Resume of a
crashed workspace is adjacent to checkpoint suspension, which Talos has
specified and not implemented. Do not block the review loop on that.

### SWE-AF

https://github.com/Agent-Field/SWE-AF

Autonomous engineering team runtime on AgentField. Apache 2.0. One API call
takes a goal and a repository and runs planners, coders, reviewers, testers,
and a merger. Python 3.12+. Runtimes include AForge, Claude Code, OpenCode,
Codex, and Command Code. Models are a flat map per role (`coder`, `qa`,
`architect`, and so on).

Modes:

- Single repository, by URL or local path.
- Several repositories in one build. `primary` failures block. `dependency`
  failures are captured and do not block. Aimed at an app plus a shared
  library, or a feature split across services.

What one build does:

- Architecture is generated and reviewed before coding starts.
- Issues are dependency-sorted and run in parallel in isolated git worktrees.
- Each issue gets coder, tester, and reviewer passes.
- The three control loops in idea 12.
- The end result is merged, integration-tested, and checked against
  acceptance criteria.
- `enable_learning` injects conventions and failure patterns discovered early
  into later issues.
- Explicit compromise tracking: relaxed scope becomes typed, severity-rated
  debt and is propagated.
- Checkpointed execution supports `resume_build` after a crash.
- Optional web search for coding and review agents, with a restraint note so
  the coder does not search what the repository already answers.

Their published example (a Go SDK change) finished 10 of 10 issues, 217 tests,
34 of 34 acceptance criteria, 79 agent invocations, about $19, mostly coder
and code reviewer. Their own benchmark write-up claims 95/100 on a small CLI
todo task with a cheap model, against lower scores for single-agent Claude
Code and Codex on the same prompt. Treat both as their measurements. The
structural claim that is usable without the numbers: isolated worktrees,
per-role models, and a middle loop that splits or records debt instead of
retrying the same prompt.

Talos gap: typed debt and "split or stop" after the inner budget. Not the
outer replanner, not the fleet, not merging the result themselves.

### Loki Mode

https://github.com/asklokesh/loki-mode

Autonomous coding agent. Business Source License 1.1, converting to Apache 2.0
on 19 March 2030. Free for personal, internal, academic, and non-commercial
use. Reimplement ideas. Do not copy the implementation.

A run starts from a delivery contract derived from the task, writes checks
from the task before touching code, implements, verifies, and ends in exactly
one outcome: `VERIFIED`, `ALREADY_SATISFIED`, `FAILED`, `BUDGET_STOP`,
`BLOCKED`, or `STALLED`. If the contract cannot be satisfied as written, it
stops and asks one question.

What a finished run produces:

- A pull request written for a quick review: what was asked, what changed, how
  it was tested, and what was not proven. Partial runs open a draft titled
  `[PARTIAL]`. Other non-verified outcomes keep the branch local.
- A signed receipt at `.loki/runs/<id>/receipt.json`. `loki verify` re-hashes
  it, checks the signature and the event log, and checks that the checkout
  still matches the sealed code. Exit codes distinguish verified, tampered,
  unchecked, unsigned, and "outcome was not verified".
- A specialist review council that picks reviewers by matching the diff to
  keyword-scoped reviewer profiles.
- A spend cap (`--max-cost`, default $100 when an API key is set, no dollar
  cap on a subscription login).
- `loki answer` continues a blocked run under the same id.
- Multi-repo: `loki start --workspace` seals one composite over every child
  receipt. The composite never reads higher than its weakest child.
- Autonomy file: `propose` opens nothing, `execute` opens a pull request,
  `operate` also allows deploy. Deploy still requires an explicit flag, a
  verified receipt anchored at HEAD, and the policy permission. A health URL
  and auto-rollback are optional. `loki trust` prints graduation advice and
  never writes the policy.
- A Sentry alert webhook can enqueue a receipt-gated fix.
- Providers: Claude Code by default, plus Codex, Cline, Aider, and OpenCode.
  Model routes cover OpenRouter, Ollama, LM Studio, llama.cpp, vLLM, and a
  custom endpoint. The engine enforces a wall-clock limit and a post-iteration
  guard scan on every provider.
- A local control plane lists outcomes, receipts, costs, and an answer box for
  blocked runs. It binds to localhost.
- An MCP server exposes starting a run, reading status, and verifying a
  receipt.
- A Claude Code stop hook (`loki-seal`) refuses "done" when tests newly fail
  or were weakened.
- Intake from GitHub, GitLab, or Jira issues, from a PRD file, or from a
  one-line task. Jira, Linear, and two-way Slack are documented.

Talos gap: the outcome vocabulary, the "not proven" list, fail-to-pass as a
hard partial, the one-question blocked resume, and the stop hook that refuses
a weakened test. The signature and the control-plane UI are later.

### Lemma

https://github.com/lemma-work/lemma-platform

A multiplayer harness that shapes itself around a team's work. Core is
AGPLv3. SDKs, CLI, and skills are Apache 2.0. It runs on a Claude Code or
Codex subscription, Lemma's hosted models, or any OpenAI- or
Anthropic-compatible key. Laptop, a VM via Docker Compose, or their cloud.

The unit is a teammate inside a pod: agents, apps, tables, files, and
workflows, with a permission boundary. Nothing crosses the pod unless you
connect it. A pod exports as files, so it can be versioned and imported.

Mechanisms that map to Talos:

- An agent is a role: a model, an instruction, and the tools, tables, and
  connectors it may use. It runs when asked, on a schedule, when a row
  changes, or when a webhook arrives. Each run is recorded step by step.
- Before anything consequential (send an email, issue a refund, delete a
  record) it pauses and asks the person who owns that decision. The run waits
  for days if needed and continues when they answer.
- Workflows are an ordered mix of agents, plain functions, decisions, loops,
  waits, and forms for a named person. A waiting step resumes where it
  stopped.
- Memory is Markdown notes the team can open and correct. Shared notes are
  team-visible. Personal notes are not. Correct it once and it writes the
  correction down. Tables and files sit beside the notes and are read at run
  time, so what the teammate knows is what the team can see and edit.
- One permission model covers people and agents. Every action lands in one
  history: who asked, which agent ran, and what changed.
- Surfaces (Slack, Teams, WhatsApp, Telegram, email) resolve the writer to an
  account and apply that account's permissions. Approvals travel to the chat
  the person already uses.

Talos gap: the durable human pause for a consequential action, and memory as
editable notes rather than a hidden prompt. The pod, the generated app, and
the extra chat networks are a different product. Talos's existing rule still
holds: AI proposes, the application performs the action.

### CodeAF

https://github.com/Agent-Field/CodeAF

A coding harness aimed at open models, shipped as one Go binary. Apache 2.0.
Early preview. One window lists every project and conversation on the machine.
Work handed off keeps running when you leave the tab.

Mechanisms:

- One message can become several tasks, each in its own copy of the
  repository and on its own branch. The conversation stays with the person.
  A rail shows every task and subtask.
- Work that passes its check lands on the user's branch by itself, never on
  `main`, `dev`, or a release branch. Work nothing could check waits under
  unread: accept, or send it back.
- A factory, in their words, sizes the work, splits it, runs the parts where
  they cannot collide, tests what came back, and merges what passed. It asks
  only when it must. Questions wait under "needs you" from every project.
- Subharnesses are specialists with their own plan, their own checks, and
  typed input and output. A run delivers what it promised or is marked
  incomplete. You can ask it to design a harness ("triage flaky tests"), save
  it, and run it. Their developer subharness is `/senior-dev`. A reviewer
  subharness is listed as coming soon.
- One session, several model seats: worker, planner, and checker, plus cheap
  seats for memory, titles, digests, and a safety gate. Seats are scored from
  catalog metadata and from how this install's own tasks ended. You can pin a
  seat, limit every seat to open-weight models, or rerun one task a step
  stronger. Each task reports its crew and its cost against the estimate.
  Per-task and daily spend caps exist.
- Installs can pool text-free measurements about models (role, model, a
  number, which model judged, size bucket, day). Prompts, paths, and identity
  are not sent. It is on by default and can be turned off. Do not copy the
  pool.
- Standing orders, described above.
- Headless `codeaf do` takes a brief, plans, runs, checks, and prints one JSON
  object and an exit code. Where a conversation would ask, it takes its best
  answer and records the assumption. `exec` is one worker with no plan. `run`
  executes a plan you edited.
- Remote use splits the screen (local) from the conversation (on the machine
  that owns the work). Closing the laptop does not stop the work. A question
  asked while you were away is still waiting. Files cross both ways.

They claim first place on a DeepSWE slice against other harnesses on the same
model, at the lowest cost per solved issue, and a large memory advantage over
Claude Code and OpenCode. Treat those as their benchmarks.

Talos gap: "needs you" as one inbox, standing orders with a confirmation
card, and per-role model choice. The binary, the TUI, the model pool, and
the remote terminal split are not Talos work. Merging onto the user's branch
conflicts with Talos's draft-merge-request rule. Keep the draft.

### Chainloop

https://github.com/chainloop-dev/chainloop

Collects what happens across software delivery, from the first prompt to the
release, into one graph. Apache 2.0. Self-hostable. In production since 2024.
The README is an evidence and governance product, not a coding-agent factory.

How it works:

1. A workflow contract in git says what every session and pipeline run must
   produce. Policies say what each record must satisfy: approved models only,
   no secrets in prompts, tests pass, every release has an SBOM.
2. `chainloop trace` records the agent session on the developer's machine and
   attests it on `git push`. `chainloop attestation` does the same in CI for
   SBOMs, scans, test reports, and SLSA provenance. Records are signed in-toto
   attestations in your own OCI registry, S3, or Azure Blob.
3. Every record is checked against the contract. A gated violation fails the
   pipeline, signs the violations into the record, and prints them where the
   agent can read them. The agent fixes and pushes again. Their hosted
   platform can also block the pull request.

Trust properties they emphasize:

- The policy is Rego or WASM, run by the CLI, not by a model. The same input
  gives the same answer.
- The gate runs in the pipeline. The agent cannot turn it off from inside the
  session. A bypass is recorded.
- The record is signed and stored outside the agent, so the agent cannot edit
  the evidence after the fact.
- The intent (ticket, doc, or approved plan) is attested next to the session.
- `gate: false` rolls a rule out as report-only. An organization-level switch
  can make policies block by default.

`chainloop trace init` installs git and agent hooks and writes
`.chainloop.yml`. Session data stays local until push. The CLI redacts
secrets before upload. `requireTrace: true` rejects a push with no recorded
session. Supported agents in the README: Claude Code, OpenCode, Codex, and
Cursor.

Contracts are directories applied with `chainloop apply`, so a pull request
is how a requirement changes. Policies can be linted and evaluated locally
against a sample material before they gate anything.

Talos gap: a small run contract with report-only then gate, and intent stored
next to the run. Not the attestation stack. Talos's E2E path already keeps
raw credentials out of the prompt, which is the same class of rule as "no
secrets in the transcript", enforced by the application rather than by Rego.

### Finn-loop

https://github.com/finna/Finn-loop

Three Claude Code skills that turn Linear and GitHub into a small, human-gated
factory:

**idea, then `/finn-spec` interviews you and files the issue, then you label
it `agent-ready`, then `/finn-build` claims it and opens a pull request, then
`/finn-review` posts a verdict, then you merge.**

Humans merge. Humans are the only ones who apply `agent-ready`.

The three skills:

- `finn-spec` researches the repository, interviews until the behavior is
  unambiguous, and files a Linear issue with acceptance criteria (`AC-N`) and
  non-goals (`NG-N`).
- `finn-build` claims the next safe unassigned `agent-ready` issue that is not
  `blocked`, implements only that contract, verifies it, and opens a pull
  request. It is meant to be run on a loop.
- `finn-review` reviews open pull requests against the linked issue and the
  required GitHub checks, then posts a three-group verdict. Without required
  CI it escalates for human review instead of approving.

`loop-approved` means: no must-fix issue against the Linear contract, all
required checks passed, and the pull request was not conflicting at the
reviewed commit. It is evidence for the human merge decision, not permission
for an agent to merge.

Rules they state as load-bearing:

- If it is not in the Linear issue, it does not exist. No side-channel
  instructions.
- One issue per pull request, sized to a day of agent work or less.
- A pull-request comment cannot expand scope. Only editing the issue can.
- Blocked issues and human-escalated pull requests leave the queue until a
  person resolves them.
- Spec quality is the bottleneck. Vague acceptance criteria produce confident
  wrong pull requests.
- Agents never merge and never enable auto-merge.
- Only one builder loop per Linear team. The assignee is a cooperative lock.
  Two sessions authenticated as the same person cannot lock each other.
  Concurrent repository tasks need separate clean worktrees.
- The target repository owns its build, test, security, and deployment
  checks. Finn-loop does not create CI.

The README then lists architecture patterns that are not in the starter.
They are the source of most of the ranked ideas above. In their suggested
order:

1. Run the three-skill starter on real pull requests and tune spec quality.
2. Fresh-reviewer convergence and a `loop-stuck` escape after two failed fix
   rounds.
3. Blocked-by issue chains and a read-only status skill.
4. A Slack lane for blocked issues. The reply is copied to Linear, `blocked`
   comes off, and the issue returns to the queue unassigned.
5. A Slack lane for merge-ready pull requests. A reaction is accepted only
   from configured people, and the system re-reads GitHub before merging.
   Old messages are marked superseded when the head changes.
6. Preview and documentation checks as merge gates.
7. Risk-tiered merging only after the earlier evidence is reliable.
8. A morning director (proposes a daily packet, files only what a person
   approves, never starts builders) and the watchdog, once volume justifies
   them.
9. Leased persistent workers when an open interactive session is the
   throughput bottleneck. Jobs have queued, leased, running, succeeded, and
   failed states. Workers renew short leases. Abandoned leases expire and
   requeue up to an attempt limit, then fail visibly. Each job gets a clean
   clone or worktree. Worker, dispatcher, and operator credentials stay
   separate. Heartbeats let the watchdog tell an empty queue from a dead
   scheduler.
10. The post-merge learning loop.
11. Versioned Slack approval of specs last, because it changes the most
    important human gate. Re-read the issue and confirm the version matches
    the Slack message before applying `agent-ready`.

Slack safety requirements they list: verify webhook signatures, allowlist
user ids, store event ids and reviewed SHAs, claim before calling out,
re-read the system of record at action time, and keep kill switches.

Their division of responsibility:

- Linear: what should be built, and whether it is ready or blocked.
- GitHub: the code, the reviewed commit, CI, conflicts, and merge state.
- Slack: questions, approvals, and alerts. Never shadow state.
- The repository: how the factory behaves.

Talos already has the closest equivalents of their systems of record (Jira,
GitLab) and of their leased workers. The gap is the contract, the closed
review loop, the stuck state, the single blocked question, and the watchdog.
Their worker-lease section is confirmation of `docs/worker-orchestration.md`,
not a new design. One difference: Talos does not resume a surviving execution
by reattaching to its output. It stops it and retries through the queue.

### factory

https://github.com/addyosmani/factory

A reference software factory. MIT. It installs an operating model into an
existing GitHub project using stock Claude Code, with a thin Codex adapter
over the same policy, queue, gates, and evidence files. There is no custom
orchestrator. GitHub issues are the queue. Scheduled agents triage, implement
bounded tasks, run the project's real tests, obtain an independent review,
and open draft pull requests. People remain responsible for ambiguous
requirements, system design, load-bearing changes, and every merge.

Mental model:

| Factory concept | Concrete mechanism |
| --- | --- |
| Intent and risk budget | A human-owned `docs/factory/CHARTER.md` |
| Work queue | GitHub issues with `factory:*` labels |
| Handoff between stages | A structured `factory-handoff:v1` issue comment |
| Procedures | Version-controlled skills |
| Clock | Claude routines, schedules, GitHub events, or an optional Action |
| Worker | A fresh Claude Code or Codex session |
| Quality control | The project's test commands, `gates.sh`, and an independent verifier |
| Control room | `/factory`, backed by live issues, pull requests, and run records |
| Release authority | A person merging the pull request |

Flow: triage routes an issue to implementation, specification, a named
question, or a known blocker. Small allowed work is claimed on a deterministic
branch (`claude/fq-<issue>`). The first non-forced push wins, so two sessions
cannot both own the issue. The implementation writes a failing test, makes
the scoped change, runs the gates, and delegates to a fresh verifier. It
opens a draft pull request only if those checks agree. A separate routine
verifies the pull request again. `/factory` shows the human review queue. No
routine merges.

If triage cannot infer product intent, the issue goes to spec and pauses at
four explicit human approval gates: product intent, observable behavior,
technical design, and implementation slices. If a fact is missing, the issue
is parked with the question rather than converted into speculative code.

What gets installed:

- Charter: tier, load-bearing paths, automatable work, definition of done,
  stop conditions.
- Contract: harness-neutral queue protocol and durable-evidence rules.
- `gates.sh`: types, lint, tests, build, audit, mutation, architecture. Three
  levels. A verbatim verdict line. Missing required gate is `MISCONFIGURED`
  with exit 2.
- Labels as the visible queue.
- Deterministic claim branch.
- Skills for triage, spec, implement, verify, and a weekly monitor that files
  new issues from default-branch and factory-health findings.
- A verifier agent that reads the diff cold, reverts the fix to prove the
  test fails, and rejects when uncertain.
- A critic agent as an adversarial second lens on load-bearing changes.
- `/factory` control room and `/factory-tune`, which proposes constraint
  changes and does not apply them.
- A hook that blocks common shell merge paths. Branch protection remains the
  real boundary.
- A doctor script for placeholders, missing labels, missing remotes, and
  setup gaps.

The four ideas they say are doing the work:

1. Everything lives in the repo, so a fresh cloud clone sees the same rules
   as a laptop. No home-directory config to keep in sync.
2. Autonomy tracks consequence, not difficulty. The charter's tier sets how
   much freedom every routine gets.
3. The gate script is the verdict.
4. The writer never grades the work.

The two constraints they say people delete:

- Back-pressure is a number. When the review queue is full, implement refuses
  to start.
- Merge is never automated, on any tier.

Honest limits they publish:

- Stock Claude routines have GitHub triggers for pull requests and releases,
  not for new issues. The reference polls on a schedule and ships an optional
  Action if triage must be immediate.
- Cloud environment config cannot be committed. Network, env vars, and setup
  scripts are account-level UI state.
- A green run status means the session exited without an infrastructure
  error. It does not mean the task succeeded.
- Environment variables are not secrets. Their GitHub proxy keeps the
  credential out of the VM.

Talos gap: the charter, the verbatim gate, the cold verifier, the claim
race via a deterministic branch, the review-queue cap, and a control room
that is "what needs you right now", review queue first. Talos's queue is
Jira and GitLab, and its clock already exists, so the GitHub-label and
Claude-routine machinery should not be ported. The handoff comment is a
good shape for the dossier in idea 9: expected files, completion condition,
gate level, and confidence, written by one stage and read by the next.

## Source list

- https://github.com/superplanehq/superplane
- https://github.com/open-inspect/background-agents
- https://github.com/the-open-engine/zeroshot
- https://github.com/Agent-Field/SWE-AF
- https://github.com/asklokesh/loki-mode
- https://github.com/lemma-work/lemma-platform
- https://github.com/Agent-Field/CodeAF
- https://github.com/chainloop-dev/chainloop
- https://github.com/finna/Finn-loop
- https://github.com/addyosmani/factory
