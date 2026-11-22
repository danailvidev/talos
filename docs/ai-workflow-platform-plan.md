# Talos — Implementation Plan

> Historical design record. Talos is now web-only; CLI sections below
> describe the original implementation and are not current usage documentation.

Project name: **talos**.

Target deployments for v1: **Jira Cloud** and **GitLab.com**. Jira Server/DC and
self-hosted GitLab are explicitly out of scope for v1 — their auth and API
versions differ enough that supporting both from the start would leak
conditionals through every connector.

**Progress: Phases 1–6 complete** (§16). The deterministic GitLab → Jira workflow
runs end to end; Phase 7 adds the LLM layer. Sections below carry implementation
notes recording what live systems turned out to require, which is often not what
this plan first assumed.

## 1. Goal

Build a self-hosted automation platform that can:

- Run scheduled workflows.
- Connect to external systems such as GitLab, Azure DevOps, Jira, and Slack.
- Use different LLM providers through a common abstraction.
- Start as a CLI application.
- Evolve later into a persistent server with a web UI.
- Keep deterministic automation logic separate from optional AI reasoning.

The initial implementation will use **Bun + TypeScript**.

---

## 2. Initial Use Cases

### Workflow 1 — GitLab Pipeline Failure → Jira Ticket

Periodically inspect GitLab pipelines.

When a new pipeline failure is detected:

1. Identify failed jobs.
2. Fetch useful job/build/unit-test logs.
3. Optionally send the logs to an LLM for analysis.
4. Produce a structured summary:
   - Failure title
   - Summary
   - Probable cause
   - Failed tests/jobs
   - Relevant log excerpts
   - Confidence
5. Group the failures **by spec file** and create one Jira ticket per file, in
   the board's active sprint.
6. Assign it to a configured Jira user.
7. Store the file → ticket mapping so the ticket is not created twice — not even
   by the next night's pipeline, which is a new pipeline with the same broken
   file. Recording pipeline ids alone is not enough for this; see §7
   `filed_issues`.

### Workflow 2 — Azure DevOps Backlog → Slack DM

Periodically query Azure DevOps work items assigned to the configured user.

When a newly assigned ticket is detected:

1. Read the work item.
2. Compare it with previously processed work items.
3. If it is new, send a Slack private message.
4. Mark the work item as processed.

---

## 3. Core Architecture

```text
                       ┌──────────────────┐
                       │       CLI        │
                       │  talos ...    │
                       └────────┬─────────┘
                                │
                       ┌────────▼─────────┐
                       │ Workflow Engine  │
                       │                  │
                       │ Trigger          │
                       │ Conditions       │
                       │ Steps            │
                       │ State            │
                       │ Retry            │
                       │ Execution log    │
                       └────────┬─────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
  ┌───────▼────────┐   ┌────────▼───────┐   ┌────────▼────────┐
  │   Connectors   │   │  LLM Providers │   │   Persistence   │
  │                │   │                │   │                 │
  │ GitLab         │   │ Anthropic      │   │ SQLite          │
  │ Azure DevOps   │   │ OpenAI         │   │ later Postgres  │
  │ Jira           │   │ Gemini         │   │                 │
  │ Slack          │   │ Ollama/local   │   │                 │
  └────────────────┘   └────────────────┘   └─────────────────┘
```

The LLM is a workflow step, not the controller of the whole system.

Principle:

```text
AI proposes information.
Application performs actions.
```

This makes external actions predictable and testable.

---

## 4. Technology Stack

### Runtime

- Bun
- TypeScript

### CLI

- Commander.js

### Validation

- Zod

### HTTP

- Native `fetch`

### Persistence

Initial:

- `bun:sqlite` with raw SQL and numbered migration files

No ORM in v1. There are four small tables and `bun:sqlite` is synchronous;
introducing Drizzle later is cheaper than fighting it now.

Future:

- PostgreSQL

### Scheduling

- `croner` — cron parsing with timezone support. Do not hand-roll cron parsing.

### HTTP testability

Every connector client takes an injectable `fetch` so `bun:test` can serve
recorded fixtures instead of calling live APIs.

### Logging

- Pino

### Tests

- `bun:test`

### Configuration

- YAML
- Zod schema validation

### Packaging

- Docker
- Optional Bun standalone executable

### LLM Integration

Start with a small internal abstraction rather than coupling workflows directly to one SDK.

Possible providers later:

- Anthropic
- OpenAI
- Gemini
- Ollama/local models

---

## 5. Repository Structure

As built through Phase 6. Entries marked *(planned)* do not exist yet.

```text
talos/
│
├── src/
│   ├── app.ts                  composition root; CLI and future REST API
│   │                           both build an App from it
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── workflow.ts      run, list, enable, disable, logs, reset
│   │   │   ├── connector.ts     list, test, pipelines, failures, trace
│   │   │   ├── doctor.ts        stranded claims after a crash
│   │   │   └── status.ts        effective config plus each field's origin
│   │   ├── format.ts
│   │   └── index.ts             the entrypoint; note: not src/index.ts
│   │
│   ├── config/
│   │   ├── schema.ts            Zod schema for workflows.yaml
│   │   └── load.ts              loader plus precedence resolution
│   │
│   ├── core/
│   │   ├── workflow.ts          Workflow, WorkflowContext, mutate()
│   │   ├── executor.ts
│   │   ├── registry.ts
│   │   ├── retry.ts
│   │   ├── watermark.ts
│   │   └── errors.ts
│   │
│   ├── connectors/
│   │   ├── http.ts              shared client; status → error taxonomy
│   │   ├── connector.ts         health-check contract
│   │   ├── registry.ts
│   │   ├── gitlab/
│   │   │   ├── client.ts
│   │   │   ├── types.ts
│   │   │   └── trace-format.ts  runner-aware trace parsing
│   │   ├── jira/
│   │   │   ├── client.ts
│   │   │   ├── types.ts
│   │   │   └── adf.ts           Atlassian Document Format builder
│   │   ├── azure-devops/        (planned)
│   │   └── slack/               (planned)
│   │
│   ├── llm/                     (planned, Phase 7)
│   │
│   ├── persistence/
│   │   ├── migrations.ts        versioned; never edit an applied one
│   │   ├── database.ts
│   │   ├── state-store.ts       the claim contract
│   │   ├── sqlite-state-store.ts
│   │   ├── sqlite-execution-sink.ts
│   │   ├── config-store.ts      runtime overrides
│   │   └── issue-ledger.ts      one open ticket per subject
│   │
│   ├── scheduling/              (planned, Phase 12)
│   │
│   ├── secrets/
│   │   ├── secret-store.ts
│   │   └── env-file.ts
│   │
│   └── workflows/
│       ├── example.ts           fake workflow; exercises the executor
│       └── ci-failure/
│           ├── index.ts         the workflow itself
│           ├── group.ts         grouping, signatures, subject keys
│           └── ticket.ts        description and comment bodies
│
├── config/
│   ├── workflows.example.yaml   tracked
│   ├── workflows.yaml           gitignored
│   └── example.env              tracked; real values go in .env
│
├── data/                        SQLite database, gitignored
├── tests/
│   └── fixtures/                recorded HTTP responses + FakeHttp
├── tsconfig.json
├── package.json
├── Dockerfile                   (planned, Phase 13)
└── README.md
```

Two conventions worth stating, both learned the hard way:

- A connector's `client.ts` owns its own truncation and its own name → id
  resolution. Anything a workflow would otherwise have to know about the remote
  system's quirks belongs here.
- Migrations are append-only. Editing an applied migration silently gives two
  databases different schemas at the same version number.

---

## 6. Core Domain Interfaces

### Workflow

A workflow is a function, not an array of steps.

```ts
export interface Workflow<C = unknown> {
  id: string;
  name: string;
  configSchema: z.ZodType<C>;
  run(ctx: WorkflowContext, config: C): Promise<WorkflowResult>;
}

export interface WorkflowResult {
  itemsSeen: number;
  itemsProcessed: number;
  itemsSkipped: number;
}
```

Rationale: both v1 workflows are shaped
`poll → filter → for each new item → fan out`, which a linear `Step<I, O>[]`
pipeline models awkwardly. `ctx.step()` supplies the same per-step logging,
timing, and retry that a step array would, without committing to a DAG schema
before real workflows exist. §19's warning against premature schemas applies to
the engine, not just the serialization format.

The declarative `steps:` representation arrives at M14+, once several workflows
show what the schema actually needs to express.

### Trigger

Triggers live in configuration, not in the workflow definition — the same
workflow can be cron-driven, run manually, or later webhook-driven without
changing its code.

```ts
export type Trigger =
  | { type: "cron"; expression: string; timezone?: string }
  | { type: "manual" };
```

Future trigger types: webhook, GitLab webhook, Azure DevOps service hook, queue
event.

### Workflow Context

```ts
export interface WorkflowContext {
  workflowId: string;
  executionId: string;
  logger: Logger;
  state: StateStore;
  secrets: SecretStore;
  llm: LlmRegistry;

  /** Whether external writes are suppressed. */
  dryRun: boolean;

  /**
   * Wraps a unit of work: logs start/finish, records duration, persists a
   * step record, and applies the retry policy to transient failures.
   */
  step<T>(
    id: string,
    fn: () => Promise<T>,
    opts?: { retry?: RetryPolicy }
  ): Promise<T>;
}
```

### Dry run

`ctx.dryRun` is threaded from a global `--dry-run` CLI flag and is honoured from
Phase 2 onward, not retrofitted. Every connector write goes through one guard:

```ts
export async function mutate<T>(
  ctx: WorkflowContext,
  description: string,
  fn: () => Promise<T>
): Promise<T | null> {
  if (ctx.dryRun) {
    ctx.logger.info({ dryRun: true, action: description }, "suppressed write");
    return null;
  }
  return fn();
}
```

Without this, workflow 1 cannot be tested against a real Jira project.

### LLM Provider

```ts
export interface LlmResult<T> {
  data: T;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface LlmProvider {
  readonly name: string;

  generate<T>(request: {
    system?: string;
    prompt: string;
    schema: z.ZodType<T>;
    model?: string;
    maxTokens?: number;
  }): Promise<LlmResult<T>>;
}
```

The schema is a `z.ZodType<T>` rather than `unknown`, so the returned `T` is
actually tied to what was validated. Returning `usage` is what makes §15's token
and cost logging possible at all.

### State Store — claim, do not check

The check-then-act pattern (`hasProcessed` → work → `markProcessed`) has a
crash window: if the process dies after creating the Jira ticket but before
marking, the next poll creates a second ticket. That violates §23.7.

The store therefore hands out **claims**, backed by a unique index on
`(workflow_id, external_id)` and an `INSERT OR IGNORE`, so the claim is atomic:

```ts
export type ClaimStatus = "claimed" | "completed" | "failed";

export interface StateStore {
  /**
   * Atomically claims an event. Returns false if another run already holds
   * or has completed this claim. Never blocks.
   */
  claimEvent(
    workflowId: string,
    externalId: string,
    eventType: string
  ): Promise<boolean>;

  completeEvent(
    workflowId: string,
    externalId: string,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /** Releases a claim so a later run may retry it. */
  failEvent(
    workflowId: string,
    externalId: string,
    error: string
  ): Promise<void>;

  /** Claims stuck in `claimed` past the timeout, for reconciliation. */
  findStaleClaims(
    workflowId: string,
    olderThan: Date
  ): Promise<ProcessedEvent[]>;

  getWatermark(workflowId: string): Promise<Date | null>;
  setWatermark(workflowId: string, at: Date): Promise<void>;
}
```

Usage:

```ts
if (!(await ctx.state.claimEvent(id, key, "pipeline-failure"))) continue;
try {
  await doWork();
  await ctx.state.completeEvent(id, key, meta);
} catch (err) {
  await ctx.state.failEvent(id, key, String(err));
  throw err;
}
```

A claim left in `claimed` past the timeout is **not** blindly retried — it is
reconciled by searching the target system for the pipeline URL (Jira) before
deciding whether the side effect happened. Blind retry is how duplicates get
created.

### Watermarks — first-run flood protection

On the first poll, GitLab reports every failed pipeline within its retention
window and Azure DevOps reports every already-assigned work item. Without
protection that is dozens of Jira tickets and Slack DMs on install.

Two mechanisms, both required:

- **Watermark.** Seeded to "now" on a workflow's first run. Nothing created
  before the watermark is ever processed. Advanced only after a fully successful
  run.
- **Per-run cap.** `maxItemsPerRun` (default 10) bounds the blast radius even if
  the watermark logic is wrong.

A `--since` override on `workflow run` allows deliberate backfill.

---

## 7. Persistence Model

The most important requirement is idempotency.

The scheduler must not create the same Jira issue or Slack notification repeatedly.

### Suggested tables

#### workflow_runs

```text
id
workflow_id
started_at
finished_at
status
error
```

#### workflow_steps

```text
id
run_id
step_id
started_at
duration_ms
status
attempts
error
```

#### processed_events

```text
id
workflow_id
external_id
event_type
status          -- claimed | completed | failed
claimed_at
completed_at
attempts
error
metadata

UNIQUE (workflow_id, external_id)   -- this index is what makes claims atomic
```

#### workflow_state

Holds watermarks and any other per-workflow scalar.

```text
workflow_id
key             -- e.g. 'watermark'
value
updated_at

PRIMARY KEY (workflow_id, key)
```

#### workflow_config

Runtime **overrides only**. See §10 for precedence.

```text
workflow_id
enabled         -- nullable; null means "defer to YAML"
schedule        -- nullable; null means "defer to YAML"
updated_at
```

#### filed_issues

Added in Phase 6. `processed_events` answers "did I handle pipeline 93821?",
which is the wrong question for a nightly job: tomorrow brings pipeline 93999
with the same broken file, and a fresh event key would file a second ticket.
This table answers "is there already an open ticket about *this file*?"

```text
id
workflow_id
subject_key     -- 'project:path/to/file.spec.ts'; deliberately no pipeline id
issue_key       -- 'TP-4242'
issue_url
signature       -- the failure set, for change detection
state           -- open | closed
seen_count
filed_at
updated_at
last_seen_at
closed_at
metadata

UNIQUE (workflow_id, subject_key) WHERE state = 'open'
```

The index is **partial**. That single clause is the whole dedup rule: at most one
open ticket per subject — enforced in the schema, so two concurrent runs cannot
both pass a check-then-insert — while any number of closed rows may coexist, so a
file that breaks again after its ticket was resolved is filed afresh and keeps
its history. `record()` uses `ON CONFLICT DO NOTHING` and returns `null` when it
lost the race, because the caller's job is then to comment, not to fail the run.

Example event key:

```text
gitlab-ci-failure:
project:42:pipeline:93821
```

Example Azure event key:

```text
azure-assigned-ticket:
work-item:82917
```

---

## 8. Workflow 1 — Detailed Design

### GitLab polling

Every 2–5 minutes:

```text
Scheduler
   ↓
Load watermark (seed to now on first run)
   ↓
GitLab: list pipelines updated since watermark
   ↓
Filter failed pipelines, apply maxItemsPerRun cap
   ↓
For each pipeline:
   ↓
StateStore.claimEvent()  ← atomic INSERT OR IGNORE
   │
   ├── false → skip (already claimed or completed)
   │
   └── true
        ↓
GitLab: retrieve failed jobs
        ↓
GitLab: retrieve traces, truncated at maxTraceBytes
        ↓
Optional LLM analysis (fallback to deterministic on failure)
        ↓
Validate structured result using Zod
        ↓
Create Jira ticket   ← through mutate(), suppressed on --dry-run
        ↓
Assign Jira user
        ↓
completeEvent()    ─ on error ─→ failEvent()
   ↓
Advance watermark only if the whole run succeeded
```

### Log truncation happens at fetch

GitLab job traces reach tens of megabytes. Truncation to `maxTraceBytes`
(head + tail, middle elided) happens in the **connector**, not in the LLM step,
so it protects the SQLite rows and the Jira description as well as the token
budget. `llm.maxLogBytes` then caps the aggregate across jobs.

### Structured AI response

```ts
const FailureAnalysisSchema = z.object({
  title: z.string(),
  summary: z.string(),
  probableCause: z.string(),
  failedJobs: z.array(z.string()),
  failedTests: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
```

The AI must not independently call Jira.

The workflow engine passes validated output to the Jira connector.

### Jira ticket

Suggested content:

```text
Title:
<AI-generated concise title>

Pipeline:
<URL>

Failed jobs:
...

Summary:
...

Probable cause:
...

Failed tests:
...

Relevant logs:
...

AI confidence:
...
```

### One ticket per spec file — as shipped in Phase 6

The pre-LLM version replaces the AI title and summary with parsed facts, and
changes the unit of a ticket. A pipeline is not a useful unit: one broken import
fails 400 tests in one file, and a ticket per test is 400 tickets. A test is not
one either. **The file is the unit** — one problem, one owner, one ticket.

```text
Title        Unit test failure: checkout.component.spec.ts
             — Checkout › applies a discount (+2 more)

What failed  the failing test names, with the first ten details in full
Runner       'jest' + '1 failed, 20 passed, 21 total'
Where        job log link, pipeline link, commit title + author
Sprint       the board's active sprint
Assignee     the accountId behind JIRA_EMAIL
Labels       talos, ci-failure, spec:checkout.component.spec.ts
```

A file whose suite never ran leads with the suite error instead ("Cannot find
module 'x'") and says no tests in it executed — otherwise a ticket listing zero
failing tests looks like a parser bug.

### Not refiling tomorrow

```text
group failures by file
   ↓
subject_key = project:file
   ↓
IssueLedger.findOpen(workflow, subject)
   │
   ├── open ticket, same signature      → touch(); no Jira call at all
   │
   ├── open ticket, changed signature   → one comment describing the diff,
   │                                      then updateSignature()
   │
   └── none
        ↓
   search Jira for an open ticket we filed but never recorded
        │
        ├── found  → adopt() it
        │
        └── none   → create issue, then record()
```

The signature is **test names only** — never assertion text, never line numbers.
`Received: 100` becomes `Received: 103` tomorrow, and a signature built on it
would earn a pointless comment every night. It is sorted, so a reordered parallel
run is not a change, and a wholesale failure is summarised by count
(`and-more:70`) rather than storing 400 names. A suite that stopped compiling is
recorded as a marker line alongside the names, not instead of them, so both kinds
of change are visible.

The reconciliation search exists for one crash window: die between Jira's create
call and our insert, and the ticket exists with no record of it. Adopting beats
filing a duplicate. If that search fails the run files anyway — a possible
duplicate is better than silence about a broken build. A recorded ticket that has
since been deleted in Jira releases its subject.

A ledger row is closed only when **Jira** says the issue is done
(`statusCategory.key === 'done'`), never because the tests changed. Tests
changing is what a comment is for.

---

## 9. Workflow 2 — Detailed Design

```text
Scheduler
   ↓
Load watermark (seed to now on first run)
   ↓
Azure DevOps WIQL, ChangedDate > watermark
   ↓
Work items assigned to configured identity
   ↓
Apply maxItemsPerRun cap
   ↓
Load item details
   ↓
For each item:
   ↓
StateStore.claimEvent()
   │
   ├── false → skip
   │
   └── true
        ↓
Slack DM   ← through mutate()
        ↓
completeEvent()  ─ on error ─→ failEvent()
   ↓
Advance watermark
```

Suggested Slack message:

```text
New Azure DevOps ticket assigned to you

#82917 — Fix authentication timeout

Priority: High
State: Active

https://dev.azure.com/...
```

No LLM is necessary for the first version of this workflow.

---

## 10. Configuration Strategy

Start with YAML.

### Precedence — one source of truth per field

YAML is the declarative baseline. The `workflow_config` table holds runtime
overrides written by `workflow enable` / `workflow disable`. **A non-null DB
override wins over YAML.**

```text
effective(enabled)  = db.enabled  ?? yaml.enabled  ?? false
effective(schedule) = db.schedule ?? yaml.schedule
```

Everything else (connector settings, LLM settings, caps) lives in YAML only —
the CLI does not mutate it. `talos status` prints the effective value plus
its origin, so a DB override is never invisible.

Example:

```yaml
workflows:

  gitlab-ci-failure:
    enabled: true
    schedule: "0 7 * * *"    # nightly job, so read it once in the morning

    maxItemsPerRun: 10

    gitlab:
      projectId: 42
      ref: main              # optional branch filter
      maxTraceBytes: 65536   # per-job trace cap, head+tail

    # Which pipelines to read. Top-level, not under `gitlab:`, because they are
    # this workflow's selection policy rather than connector settings.
    pipelineSchedule: "Nightly tests"   # optional; the schedule's *description*
    anyStatus: true                     # see allow_failure, Phase 4 notes
    includeAllowedFailures: true
    titlePrefix: "Unit test failure"

    jira:
      project: DEV
      issueType: Bug         # resolved to a per-project id at runtime, see below
      boardId: 21            # optional; required when the project has >1 board
      useActiveSprint: true  # put the issue in the board's active sprint
      assignee: user-account-id   # optional; defaults to JIRA_EMAIL's account
      labels: []             # added to talos, ci-failure and spec:<file>

    llm:
      enabled: true
      provider: anthropic
      model: configured-model
      maxLogBytes: 32768     # total log volume sent to the LLM

  azure-assigned-ticket:
    enabled: true
    schedule: "*/3 * * * *"

    maxItemsPerRun: 10

    azure:
      organization: my-org
      project: my-project

    slack:
      recipient: configured-user
```

### Connector identifier resolution

Jira issue types and assignees are per-project **ids**, not the names written
above. `talos connector test jira` prints the valid issue types and the
resolved `accountId` for a given email, so config can be filled in with real
values. The connector resolves and caches names → ids at startup and fails loudly
on an unknown name rather than at ticket-creation time.

Three things about a Jira site are per-site or per-project, and none may be
hardcoded:

- **Issue type ids come from the project's createmeta, not `/issuetype`.** The
  site-wide list includes types the project does not offer; choosing from it
  produces a 400 at create time, i.e. after the run has already decided to file.
- **The sprint field id differs per site.** It is a Greenhopper custom field —
  `customfield_10020` on one site, `customfield_10104` on another — so it is
  discovered by scanning `/field` for `schema.custom` ending `gh-sprint`. It also
  takes a bare id, not `{id: …}` like every other reference field.
- **A board must be named when there is more than one.** Discovery only fires
  with exactly one scrum board; otherwise the run stops and names `jira.boardId`,
  because putting a sprint's worth of tickets on the wrong team's board is worse
  than filing none. Kanban boards are excluded — they have no sprints.

### Required connector scopes

Documented in the README, verified by `connector test`:

```text
GitLab PAT      read_api
Jira Cloud      email + API token (basic auth); Browse projects, Create issues,
                Add comments, Assign issues, and Agile board read for sprints
Azure DevOps    PAT with Work Items (read)
Slack bot       chat:write, im:write, users:read, users:read.email
```

Jira has no project-scoped way to resolve an email to a user: `/user/search`
needs the site-wide **Browse users and groups** permission. Without it the token
can only assign to itself, so `jira.assignee` must be given as an accountId. The
connector refuses to guess between several matches rather than assigning a ticket
to the wrong person.

Azure DevOps WIQL `@Me` resolves to the PAT owner, so the PAT must belong to the
person being notified. Otherwise the query must name the identity explicitly.

Secrets must not be stored directly in this file.

Use environment variables initially:

```env
GITLAB_TOKEN=
AZURE_DEVOPS_TOKEN=
JIRA_BASE_URL=      # https://your-site.atlassian.net — no /rest path
JIRA_EMAIL=         # also the default assignee
JIRA_TOKEN=
SLACK_BOT_TOKEN=
ANTHROPIC_API_KEY=
```

`JIRA_BASE_URL` is a secret-store entry rather than YAML config because the site
is half of the credential: an `email:token` pair is only valid against the site
that issued it, and splitting them across two files makes a copied token look
like a working one.

Later introduce an encrypted secret store.

---

## 11. CLI Commands

Global flags, available on every command:

```text
--dry-run           suppress all external writes, log intended actions
--config <path>     default ./config/workflows.yaml
--log-level <lvl>
```

Initial commands:

```bash
talos workflow list

talos workflow run gitlab-ci-failure

talos workflow run gitlab-ci-failure --dry-run

talos workflow run gitlab-ci-failure --since 2026-08-01   # backfill

talos workflow run azure-assigned-ticket

talos workflow enable gitlab-ci-failure

talos workflow disable gitlab-ci-failure

talos workflow logs gitlab-ci-failure --steps

talos workflow enable gitlab-ci-failure --clear   # revert to the YAML setting

talos workflow reset gitlab-ci-failure --yes      # clear claims + watermark

talos doctor                                     # stranded claims, open runs

talos doctor --release gitlab-ci-failure --yes

talos connector list           # which connectors have their secrets

talos connector test           # check every configured connector

talos connector test gitlab

talos connector pipelines --jobs   # recent failed pipelines + their failed jobs

talos connector pipelines --schedule "Nightly tests"   # one schedule's pipelines

talos connector failures --schedule "Nightly tests" \
  --any-status --include-allowed-failures   # parsed failures, as a ticket would read

talos connector trace 7001         # a job log, truncated as a workflow sees it

talos connector test jira      # also prints issue types + accountIds

talos connector test azure

talos connector test slack

talos status                   # effective config + origin per field
```

Development commands:

```bash
bun install
bun test
bun run dev
```

Standalone build:

```bash
bun run build
```

---

## 12. Execution Lifecycle

Every workflow execution should follow the same lifecycle:

```text
1. Create execution ID
2. Write workflow_runs record
3. Initialize context
4. Execute trigger payload
5. Execute steps sequentially
6. Validate every external boundary
7. Retry recoverable failures
8. Persist state
9. Mark workflow run success/failure
10. Emit structured logs
```

Each step should log:

```text
workflow_id
execution_id
step_id
duration
status
error
```

This becomes critical once the web UI shows execution history.

---

## 13. Error Handling

Create explicit error categories:

```ts
class ConnectorError extends Error {}
class AuthenticationError extends ConnectorError {}
class RateLimitError extends ConnectorError {}
class ValidationError extends Error {}
class WorkflowError extends Error {}
class LlmError extends Error {}
```

Retry only transient errors.

Examples:

Retry:

- HTTP 429
- HTTP 502
- HTTP 503
- Temporary network failure

Do not automatically retry:

- Invalid credentials
- Invalid configuration
- Zod validation failure
- Jira permissions failure

Use exponential backoff for retryable errors.

---

## 14. Security

Initial security requirements:

- Never commit tokens.
- Keep secrets outside workflow YAML.
- Redact secrets from logs. Install a Pino redaction serializer at logger
  construction in Phase 1 — retrofitting this after connectors exist means
  auditing every log call. Redact `authorization`, `token`, `apiKey`,
  `password`, `*.headers.authorization`, and any value matching a known secret
  loaded from the environment.
- Limit connector permissions.
- Use dedicated bot/service accounts where practical.
- Avoid sending unnecessary source code or secrets to LLM APIs.
- Cap the amount of CI log data sent to an LLM.
- Store an audit trail of external actions.

Later:

- Encrypted credentials.
- Web UI authentication.
- Role-based permissions.
- Approval steps for sensitive actions.
- Secret rotation.

---

## 15. Observability

Logging should be structured from the beginning.

Example:

```json
{
  "workflow": "gitlab-ci-failure",
  "executionId": "exec-123",
  "step": "jira-create-ticket",
  "status": "success",
  "durationMs": 342
}
```

Later expose:

```text
Executions
Success rate
Average duration
Connector failures
LLM token usage
LLM cost
Retry count
Last successful execution
```

---

## 16. Development Phases

### Phase 1 — Project Skeleton

Create:

- Bun project
- TypeScript config
- Commander CLI with global `--dry-run`, `--config`, `--log-level`
- Pino logging **with the redaction serializer**
- Zod
- test setup
- configuration loader with precedence reporting

Deliverable:

```bash
talos status
```

works.

---

### Phase 2 — Workflow Engine

Implement:

- Workflow (function form)
- Trigger types
- Context with `ctx.step()`
- Executor
- `mutate()` dry-run guard
- error categories
- retry with exponential backoff
- manual execution

Deliverable:

```bash
talos workflow run example
talos workflow run example --dry-run
```

runs a test workflow and reports per-step timing.

---

### Phase 3 — Persistence

Implement:

- SQLite database
- numbered migrations
- workflow_runs, workflow_steps, processed_events, workflow_state,
  workflow_config
- StateStore with **atomic claims** (unique index + `INSERT OR IGNORE`)
- watermarks and `maxItemsPerRun`
- stale-claim detection

Deliverable:

A workflow remembers previously processed events, and a run killed mid-flight
does not re-execute its side effect on the next run.

Implementation notes:

- `claimEvent` is one `INSERT … ON CONFLICT … DO UPDATE … WHERE status = 'failed'`.
  A read followed by a write would reintroduce the race the protocol exists to
  remove.
- Atomicity is verified with separate OS processes, not `Promise.all`: `bun:sqlite`
  is synchronous, so single-process concurrency proves only that the SQL parses.
- `failEvent` is guarded on `status != 'completed'`, so a late error report cannot
  re-open a finished event.
- A corrupt watermark reads as unset, so a workflow reseeds rather than polling
  from an Invalid Date and fetching everything.
- Run rows open as `running` before the workflow starts, so a killed process
  leaves evidence. `talos doctor` reports them.
- `talos doctor` surfaces stranded claims but does **not** auto-release them.
  Whether a side effect landed is unknowable from our own records; the operator
  checks the target system first.

---

### Phase 4 — GitLab Connector

Implement:

- Authentication (GitLab.com PAT, `read_api`)
- projects/pipelines with `updated_after`
- jobs
- job traces, truncated at fetch to `maxTraceBytes`
- connector health check
- injectable `fetch` + recorded fixtures for tests

Deliverable:

```bash
talos connector test gitlab
```

and CLI can display recent failed pipelines.

Implementation notes:

- One shared `HttpClient` (`src/connectors/http.ts`) owns status-to-error mapping,
  so `429` means the same thing across every connector rather than being
  re-decided per client. It also carries `Retry-After` (and GitLab's
  `RateLimit-Reset`) onto the `RateLimitError`, which is where the retry policy
  reads it.
- The token travels in the `PRIVATE-TOKEN` header, never as a query parameter:
  query strings reach access logs and error messages.
- Pipelines are listed with `sort=asc`. Ascending matters because the workflow
  advances its watermark to the newest item it saw — processing newest-first
  would strand older pipelines behind the watermark whenever `maxItemsPerRun`
  caps the run.
- Paging follows `x-next-page` and is bounded by `MAX_PAGES`. A lost or wrong
  watermark must not turn one poll into thousands of pipelines.
- `listFailedJobs` excludes `allow_failure` jobs (they failed by design and the
  pipeline did not fail because of them) and asks GitLab for
  `include_retried=false` (a job that failed then passed on retry is not a
  failure).
- Trace truncation is byte-based, head plus tail, applied at fetch. `jobTraces`
  additionally caps the aggregate and **reports** how many jobs it omitted, so a
  ticket built from a partial set does not look complete.
- The health check reports every failure it can rather than stopping at the
  first, so a wrong project id and a missing scope are learned in one run. The
  one exception is authentication: once the token is rejected, every later check
  can only repeat the same 401, so the report stops and says so.
- `connector test <name>` exits non-zero, making it usable as a deploy check.
  `connector test` with no name treats an unconfigured connector as skipped, not
  failed — a Slack token is not required to have a working GitLab connector.

Corrected after running against a real project (`example-org/webapp`, Angular
+ Jest, ~12k tests). Each of these was wrong in the first implementation and only
live output revealed it:

- **A pipeline's `name` is not its schedule's description.** `name` comes from the
  `workflow:name:` keyword and is `null` for every pipeline on a project that
  never sets it — including scheduled ones. There is no `name` query parameter
  either. Targeting a schedule goes through
  `/pipeline_schedules/:id/pipelines`, resolved from the description with
  `scheduleByDescription`. Descriptions are compared **trimmed**: the real
  schedule is stored as `"Scheduled pipeline for webportal tests "`, and a
  trailing space is invisible in the UI.
- **That endpoint honours no filters** — not `status`, `ref`, `source`, `sort`, or
  `updated_after` — so `listPipelines` applies them client-side and sorts the
  result itself to keep its oldest-first contract.
- **`sort=asc` and `limit` together return the oldest page**, which is right for
  the watermark poller and wrong for everything else: `--limit 12` on this project
  reported pipelines from 2019. Hence `newestFirst`, which fetches `sort=desc` and
  trims the other end. The ordering returned is unchanged; only which end a cap
  keeps differs. The health check had the same bug and reported a five-year-old
  pipeline as "most recently updated".
- **`allow_failure: true` on a test job makes the pipeline green while tests are
  broken.** This is exactly how the target project runs its unit tests, so the
  default (exclude allowed failures, look only at failed pipelines) found nothing
  at all. `includeAllowedFailures` and `--any-status` exist for that shape, and the
  "no failed pipeline" error names it as the likely cause.
- **Traces carry per-line prefixes when `FF_TIMESTAMPS` is on**
  (`2026-08-21T02:46:53.491Z 01E `, with a `+` variant for continuations), which
  defeats every `^`-anchored pattern in the parser. Stripped first, and only when
  most lines match, so an unprefixed trace is left alone.
- **Jest prints each failure twice** under `--ci`: inline as each suite finishes,
  then again under `Summary of all failing tests`. Parsing both reported 26
  failures against a summary line saying 13, in the same output. The recap is also
  the better source because a parallel run interleaves other workers' console
  output into the inline blocks — one block had absorbed 375 unrelated lines.
- **A coverage reporter prints its own `Tests:` line after Jest's summary**, in a
  box and with grouped digits (`║  Tests:  11,997 total  ║`). Reading backwards
  found that one first and parsed `11,997` as `11`.
- **Angular stack traces are mostly `node_modules`.** Vendor frames are dropped
  from a failure's detail, with the count reported, leaving the one frame that
  names the spec file — the difference between a readable ticket and a wall of
  zone.js paths.

Also: secrets load from `config/.env` via `src/secrets/env-file.ts`, because Bun
only auto-loads a root `.env` and every command was otherwise running with no
credentials and failing as though the tokens were never set.

**The file takes precedence over the environment**, which is the opposite of the
dotenv convention and was corrected after it caused a real misdiagnosis. A stale
`GITLAB_TOKEN` exported in a shell profile beat the valid token in `config/.env`;
GitLab answered `401 invalid_token` with `"Token is expired"`, and that message —
truthfully describing a token the operator was never looking at — was taken at
face value and reported as "the PAT needs renewing". The file is what an operator
edits, so the file decides. An override is logged by name, an empty entry defers
to the environment (copying `example.env` must not clear a CI-injected secret),
and `--env-file` remains the explicit way to choose another source.

The general lesson, worth more than the fix: an error message from a remote
system is evidence about *a* credential, not about the credential you believe you
sent. `connector test` should make the binding visible, which is why the override
is now reported at `info`.

---

### Phase 5 — Jira Connector

Implement:

- Authentication (Jira Cloud, `email:apiToken` basic auth, REST v3)
- issue-type and accountId resolution with caching
- create issue
- assign issue
- search by pipeline URL — needed for stale-claim reconciliation
- connector health check that prints valid issue types and accountIds

Deliverable:

CLI can create a test Jira ticket, and `--dry-run` shows exactly what it would
create without creating it.

Implementation notes:

- Descriptions are **ADF** (Atlassian Document Format) JSON on REST v3. A plain
  string is rejected outright, so `src/connectors/jira/adf.ts` builds documents
  and — importantly — truncates them by **dropping whole nodes from the end**,
  never by cutting inside one. Half a JSON node is a 400, not a shortened ticket.
  An empty paragraph carries no `content` array at all, because an empty text
  node is also a 400.
- `check()` reports every resolved id it found — issue type, assignee, sprint,
  sprint field — rather than a bare "auth ok", because each of those is a
  separate way the first real run fails. It stops after an auth failure (every
  later check can only repeat the same 401) and never creates an issue.
- "Is this ticket closed?" is `statusCategory.key === 'done'`. Status *names* are
  per-workflow and translated; the category is not.
- The Agile API is a different base path (`/rest/agile/1.0/`) from the platform
  API (`/rest/api/3/`) on the same host with the same credentials.

Confirmed live against a Jira Cloud site: the
sprint field is `customfield_10020` there, and the project has two boards sharing
one active sprint — which is exactly why board discovery refuses to pick.

---

### Phase 6 — First Complete Workflow

Implement:

```text
GitLab failure
→ gather jobs/logs
→ group by spec file
→ Jira ticket (or a comment, or nothing)
→ persistence
```

Initially do this without an LLM.

Reason:

First prove that the deterministic workflow works correctly.

Implementation notes:

- The ticket unit is the **spec file**, not the pipeline and not the test. See §8
  for the identity argument and the not-refiling flow; the rule is enforced by a
  partial unique index (§7 `filed_issues`), not by application logic.
- The workflow requires the SQLite state store and says so by name if given
  another. A ledger without persistence would refile every night, which is the
  one failure the whole design exists to prevent.
- Both connectors take the same injectable `fetch`, lifted to a
  `CiFailureDeps` seam on the workflow, so the interesting behaviour — running
  twice and *not* filing the second time — is testable at all. Their paths
  (`/api/v4`, `/rest/api/3`) never collide, so one double serves both.
- A dry run creates nothing **and records nothing**, including the new signature
  when it would have commented. Storing it would make the following real run
  think it had already commented.
- Files left behind by `maxItemsPerRun` are reported as deferred, which holds the
  watermark. The first version sliced them away silently while the run still
  counted as clean — so the watermark advanced past them and they were never
  examined again. Found by a test, not by review.

---

### Phase 7 — LLM Provider Layer

Implement:

- LlmProvider returning `LlmResult<T>` with usage
- provider registry
- Anthropic adapter
- Zod structured output validation via tool-use
- token/cost logging

Deliverable:

GitLab logs can be summarized into a validated `FailureAnalysis`.

---

### Phase 8 — AI-enhanced GitLab Workflow

Insert the AI step:

```text
GitLab
→ failed job logs
→ AI analysis
→ validation
→ Jira
```

Add fallback behavior:

If AI analysis fails, still create a Jira ticket using raw deterministic information.

This prevents the LLM from becoming a single point of failure.

---

### Phase 9 — Azure DevOps Connector

Implement:

- authentication (PAT, Work Items read)
- WIQL query with `ChangedDate` watermark filter
- work item details
- `AssignedTo` filtering (note: `@Me` is the PAT owner)

Deliverable:

CLI displays tickets currently assigned to the configured identity.

---

### Phase 10 — Slack Connector

Implement:

- bot authentication (`chat:write`, `im:write`, `users:read`,
  `users:read.email`)
- resolve configured recipient by email → user id → DM channel
- send private message
- connector health check

Deliverable:

CLI sends a test DM.

---

### Phase 11 — Second Complete Workflow

Implement:

```text
Azure DevOps
→ assigned work items
→ detect new items
→ Slack DM
→ persistence
```

---

### Phase 12 — Scheduler / Daemon

Add:

```bash
bun run start
```

The process should:

```text
Start database
Load configuration
Register workflows
Start scheduler (croner, timezone-aware)
Reconcile stale claims from an unclean shutdown
Execute workflows, never two runs of the same workflow concurrently
Handle graceful shutdown: stop scheduling, let in-flight runs finish
```

Then Dockerize it.

---

## 17. Future Backend Evolution

Once the CLI/server is stable:

```text
                 Angular Web UI
                       │
                       ↓
                  REST / WS
                       │
               ┌───────▼────────┐
               │ Bun API Server │
               └───────┬────────┘
                       │
                Workflow Engine
                       │
          ┌────────────┼─────────────┐
          │            │             │
       Workers     PostgreSQL     Connectors
```

Do not create a separate core implementation for the UI.

The CLI and web API should invoke the same application services.

---

## 18. Future Web UI

Potential screens:

### Dashboard

- Running workflows
- Success/failure status
- Last execution
- Next execution
- Recent errors

### Workflows

- Create
- Enable/disable
- Run manually
- Schedule
- Configure steps

### Execution History

- Workflow
- Step
- Input
- Output
- Duration
- Errors
- Retry history

### Connectors

- GitLab
- Azure DevOps
- Jira
- Slack
- Anthropic
- OpenAI

### LLM Providers

- Provider
- Model
- Usage
- Estimated cost
- Availability

---

## 19. Future Workflow Representation

Do not build a visual workflow editor initially.

Start with TypeScript workflow definitions.

Later move toward a hybrid representation:

```text
Workflow definition
      ↓
JSON/YAML
      ↓
Workflow Engine
      ↑
Visual editor
```

Example future representation:

```yaml
id: gitlab-ci-failure

trigger:
  type: cron
  expression: "*/5 * * * *"

steps:

  - id: pipelines
    type: gitlab.listPipelines

  - id: failed
    type: filter
    condition: status == "failed"

  - id: logs
    type: gitlab.failedJobLogs

  - id: analyze
    type: llm.generate
    provider: anthropic

  - id: jira
    type: jira.createIssue
```

The visual editor would simply generate this representation.

Do not prematurely commit to this schema before several real workflows have been implemented.

---

## 20. Features to Avoid in V1

Do not start with:

- Visual workflow editor
- Kubernetes
- Microservices
- Distributed job workers
- Kafka
- Temporal
- LangGraph
- Autonomous multi-agent architecture
- Complex plugin marketplace
- Dynamic user-written JavaScript execution
- Multi-user RBAC
- Full secrets vault

These can be introduced if actual requirements justify them.

---

## 21. Design Principles

### 1. Deterministic by default

Use normal TypeScript logic whenever the problem can be solved deterministically.

Use AI only where fuzzy reasoning adds value.

### 2. AI is replaceable

No workflow should directly depend on Anthropic/OpenAI-specific APIs.

### 3. External actions are controlled

AI generates structured recommendations.

Application code decides whether and how to execute them.

### 4. Everything is idempotent

Repeated polling must not generate duplicate side effects.

### 5. Every external boundary is validated

Validate:

- Configuration
- HTTP responses
- LLM output
- Workflow inputs

### 6. CLI and UI share the same engine

The CLI is the first interface, not a throwaway prototype.

### 7. Start simple

Use:

```text
Bun
TypeScript
SQLite
HTTP
Cron
```

until the limitations become real.

---

## 22. Recommended Milestone Order

```text
M1
CLI skeleton

M2
Workflow engine

M3
SQLite + idempotency

M4
GitLab integration

M5
Jira integration

M6
GitLab → Jira workflow

M7
LLM abstraction

M8
AI failure analysis

M9
Azure DevOps integration

M10
Slack integration

M11
Azure → Slack workflow

M12
Long-running scheduler

M13
Docker deployment

M14
REST API

M15
Angular web UI

M16
Visual workflow builder
```

---

## 23. Definition of V1 Success

V1 is complete when a single Bun process can run continuously and:

1. Poll GitLab.
2. Detect a previously unseen failed pipeline.
3. Fetch relevant failure information.
4. Optionally analyze it using the configured LLM.
5. Create one Jira issue.
6. Assign the issue.
7. Never duplicate the Jira issue for the same **spec file** — including on the
   following night's pipeline, which is a different pipeline with the same broken
   file. Comment on the existing issue instead when its failures change.
8. Poll Azure DevOps.
9. Detect a newly assigned work item.
10. Send exactly one Slack DM.
11. Persist state across application restarts.
12. Expose useful CLI status and logs.
13. Recover gracefully from temporary connector failures.
14. Create no tickets or DMs for history predating installation.
15. Create no duplicate side effect when killed mid-run.

At this point the project is already useful in production-like personal usage and provides a solid base for the web application.

---

## 24. First Implementation Target

The first implementation session should focus only on:

```text
1. bun init
2. project structure
3. CLI with global --dry-run / --config / --log-level
4. config loader with Zod validation and precedence reporting
5. logging with secret redaction
6. core workflow interfaces (function form, ctx.step)
7. executor with retry and error categories
8. one fake/test workflow
9. bun:test coverage
```

Do not start with GitLab, Jira, or an LLM until the core executor can successfully run and report a simple workflow.

That gives the rest of the project a stable foundation.
