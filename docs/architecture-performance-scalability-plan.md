# Architecture, performance, and scalability implementation plan

Status: Phases 0–6 implemented; Phase 7 intentionally deferred (2026-09-11).  
Assessment date: 2026-09-10.  
Scope: the current working tree, including the changes that were uncommitted during the assessment.

Implemented in the first optimization delivery:

- Phase 1 lease fencing: every lease has an opaque token; renewal, execution
  attachment, completion, failure, and release are ownership-checked. A lost
  lease aborts the stale execution, and completion plus subject advancement is
  one SQLite transaction.
- Phase 4 list-read and retention safeguards: task summaries batch run metrics,
  active job counts, and subject counts; finished-job pruning preserves the
  newest dead row for each dedupe key so cleanup cannot restart exhausted work.
- Phase 5 memory safeguards: slow cache loads stay coalesced until they settle,
  capped HTTP trace reads retain a bounded head/tail capture instead of
  accumulating an entire response, and schema-validated JSON has an 8 MiB
  default response ceiling (overridable per connector call).
- Phase 3 incremental read protocol: persisted log rows expose a monotonic
  cursor; the live UI snapshots history once and then appends bounded pages of
  unseen rows, including one final terminal drain. The compatible full-history
  endpoint remains available while older clients are in use.

The implementation packages through Phase 6 are now present. Phase 7 remains
explicitly unsupported because the plan's measured-capacity or availability
entry criteria have not been demonstrated; SQLite is protected by a
single-daemon lease and is not presented as a multi-host database.

Phase 6 has shared provider admission: HTTP clients use a priority-aware, cancellable,
bounded process-wide concurrency budget per connector origin and opaque
credential fingerprint. `Retry-After` produces a coordinated cooldown, the
request deadline includes permit wait time, and interactive traffic retains
reserved capacity during background scans.

GitLab list fan-out across states, filtered repositories, and groups now uses a
cancellable ordered mapper capped at four active operations, in addition to the
shared credential/origin HTTP budget.

Connector errors now carry their HTTP status as structured data. Filtered
GitLab repository listing suppresses only an actual 404 (a stale/removed
repository); authentication, authorization, rate-limit, timeout, and provider
failures propagate into the existing provider-failure response instead of
masquerading as an empty result.

The HTTP boundary now admits at most eight concurrent provider-heavy GETs
(graph, pull-request, release, and search reads), returning an explicit 429 with
`Retry-After` under overload. Server idle time is bounded at 60 seconds instead
of unlimited; connector-level deadlines remain shorter by default.

Task/loop connector clients now identify as background traffic. Shared provider
budgets reserve one slot (when concurrency permits) for interactive clients and
drain interactive waiters first, preventing a sustained discovery scan from
occupying every credential-scoped request slot.

Phase 2 now has a process-wide agent-container admission guard at the shared
agent runtime entry point. It covers queued handlers, manual task runs, and
custom loops. `TALOS_AGENT_JOBS` exposes its container ceiling separately
from lightweight `TALOS_JOBS` workers; SQLite-backed renewable host permits
coordinate concurrent server work.

Agent containers now have independently configurable memory, CPU, and PID
limits (`TALOS_AGENT_MEMORY`, `TALOS_AGENT_CPUS`, and
`TALOS_AGENT_PIDS`). Concurrent first-use image checks/builds are coalesced
within the server.

Agent admission also acquires a renewable SQLite-backed host permit. The permit
table coordinates server work using the same database, and expired permits are
reclaimed after a crashed process.

Custom loops now remain lightweight orchestrators: every repository or scratch
target becomes a durable `custom-loop-target` child job carrying the parent run,
actor, complete parameter/prompt snapshot, permissions, and retry policy.
Scheduled overlap is suppressed while children remain active; manual repeats are
explicitly allowed, and cancelling a parent propagates to queued/running children.
Task and merge-request run-history pages batch-load those parent links and expose
live queued/running/succeeded/failed child totals plus child execution IDs in the
parent details, so aggregation survives daemon restarts.

Agent NDJSON parsing now caps any individual unterminated line at 1 MiB and
resumes at the next delimiter, preventing malformed or verbose tool output from
growing the host-side stream buffer without bound. Parsed event retention keeps
only a 256-event diagnostic tail plus the final result/push facts, while tool
errors are counted incrementally.
Agent container stderr is retained as a rolling 256 KiB diagnostic tail rather
than being buffered to EOF without a limit.

Execution-log persistence now uses a bounded 2 MiB in-process queue, 100-row
transactions, a short flush interval, and asynchronous SQLite-busy backoff in a
dedicated file-backed SQLite worker. Run completion and bounded daemon shutdown
wait for worker acknowledgement; in-memory and one-shot application instances
retain synchronous read-after-write behavior.
Run completion awaits a final flush and live reads flush opportunistically;
error lines are favored when overflow requires eviction.

New UI clients request step metadata without the legacy full-log snapshot, then
initialize from an explicitly latest-first 500-line tail. They can page backward
on demand; forward polling remains cursor-based and browser retention is capped
at 5,000 raw lines. Off-screen top-level timeline events use rendering
containment so long retained windows do not all incur layout and paint work.

The response cache now separately caps distinct pending loads and estimated
settled-value bytes. Pending single flights are never evicted into duplicate
provider work; excess distinct loads fail explicitly and are counted.

Cache bypass/refresh no longer deletes an in-flight single flight. The first
refresh queues exactly one fresh load after it settles, and repeated refresh
clicks join that follow-up rather than multiplying provider traffic.

Application refresh is now revision-aware: triggers on task-instance, schedule,
general-setting, and prompt tables increment one shared SQLite scalar. Routine
requests and worker ticks pay one scalar read instead of rebuilding the task
registry and resolved configuration when nothing changed; logs/jobs/runs do not
invalidate configuration.

`GET /api/tasks` now applies authorization and search before any run/job/subject
summary work and accepts stable bounded `limit`/`offset` pages (maximum 100).
The legacy unpaginated form remains compatible. The shared UI consumer loads 50
rows at a time and exposes explicit continuation in both loop views.

`/api/system` now counts only queued/leased rows directly for its live job badge;
it no longer groups the entire completed/dead job history on each status poll.

The ticket graph response now declares `total`, `offset`, and `limit`, accepts
bounded page parameters, and computes its live flag across all matching clusters
so active work beyond the visible recency page remains discoverable. The graph UI
now exposes previous/next navigation for datasets beyond the 60-cluster page.

Job leasing now has a partial index aligned to priority/availability/FIFO order;
an `EXPLAIN QUERY PLAN` regression test prevents reintroducing the temporary
B-tree sort on the hot claim path.

The ticket graph now batch-loads per-loop recent runs, open subjects, and
per-subject job history with window functions. Its core persistence query count
is constant with respect to the number of visible loops and subjects.

Completed runs now persist indexed ticket and merge-request resource links in
the same transaction as their structured result. Migration 55 backfills existing
structured details with provenance, and graph assembly prefers these explicit
links while retaining heuristic fallback for legacy records.

Phase 0 now has a reproducible SQLite adapter baseline via `bun run bench`,
`bun run bench --small`, `bun run bench --large`, and opt-in `--xlarge`. It measures serialized
task-list, system-status, graph-batch, incremental-log, and legacy full-log
payload paths with p50/p95/p99, approximate throughput, response bytes, runtime,
host, database size, WAL settings, cold reads, process memory deltas, and an
eight-client burst with event-loop lag. `--active-ratio=<0..1>` varies queue
distribution. Credential-free slow-provider and 429 fixtures report observed
concurrency and coordinated cooldown timing.

On the 2026-09-11 reference run (Bun 1.4.0, i7-11850H), the small scenario's
single task-list p95 was about 14 ms, while an eight-client burst exposed about
133 ms p99 wall/event-loop delay. This is diagnostic evidence for keeping pages
bounded, not a production capacity guarantee.

The HTTP serving boundary now records low-cardinality route-template duration,
status, and available request/response byte counts, and returns `Server-Timing`
for request-level inspection. Route labels normalize task/run/resource IDs and
webhook secrets.

The serving process now emits 30-second runtime capacity telemetry for p50/p99
event-loop delay, active workers, active agent containers, and response-cache
hit/coalescing/eviction/capacity state. The histogram is reset per reporting
window and disabled during shutdown.

Runtime capacity telemetry also reports ready-job count and oldest queue age,
plus log-buffer records/bytes, dropped-line count, SQLite busy retries,
unexpected write errors, and flushed batch count.

Provider request logs now distinguish limiter/cooldown wait from provider
request time. Durable job starts report queue wait, and agent runs separately
report admission wait, context preparation, and container execution duration.

Phase 1 now enforces a database-backed single-daemon lease for SQLite. A second
server fails before orphan recovery or scheduler/worker startup, and ownership
is renewed while serving.

Normal cancellation now removes only containers carrying the target execution
label. The image-wide fallback is reserved for explicit daemon shutdown or
operator cleanup, so one missing/stale label cannot terminate unrelated runs.

Phase 4 retention begins with `talos maintenance retention`, a report-only
preview of eligible runs/log rows/jobs that explicitly distinguishes dead jobs
which remain protected as retry-suppression evidence. No scheduled deletion is
enabled by this command.

An explicit `--apply` mode now removes eligible finished runs and disposable
jobs oldest-first in configurable transactions of at most 5,000 rows, yielding
between batches. Active rows and the newest dead retry-suppression record remain
protected.

`TALOS_RETENTION_DAYS=<n> bun run start` opts a deployment into scheduled
retention. Startup and six-hour ticks delete only one configured batch of runs
jobs, and webhook delivery diagnostics, keeping each maintenance lock/time slice bounded; installs without the
flag remain report-only.

Lifetime run statistics now live in a trigger-maintained summary table and are
not decremented by raw-history retention. Cleanup preserves the newest run for
every task, so last-run status remains available after older details/logs are
removed.

Raw log retention is independently configurable from execution-history
retention (`--log-older-than-days` for maintenance and
`--log-retention-days` for serve). Eligibility and deletion join only finished
runs and operate in bounded indexed ID batches.

The pino execution-log capture now discards an unterminated record beyond 1 MiB
and resumes after its delimiter, matching the bounded agent NDJSON behavior.

The authenticated web shell now uses route-level chunks. On the 2026-09-11
production build, initial JavaScript fell from 1,166 kB (354 kB gzip) to 416 kB
(132 kB gzip); the 345 kB graph chunk and other route code load on demand.

## 1. Objective and direction

Make resource consumption predictable as the number of users, scheduled loops, jobs, and retained executions grows. Preserve the modular monolith and its application/adapter boundaries while removing the bottlenecks that currently couple browser traffic, execution, and persistence.

The first delivery target is a reliable single-host installation. Multiple server processes and multiple hosts are later milestones with explicit prerequisites. Increasing `--jobs` or adding replicas is not sufficient: execution admission, lease ownership, recovery, cancellation, and external API budgets must work across the intended deployment boundary.

The implementation should achieve these outcomes:

- Every expensive agent execution is subject to a common resource budget.
- A worker that loses ownership cannot change a replacement worker's job or subject state.
- Routine status reads scale with the visible page and active work, rather than all historical work.
- Live logs transfer and process new records incrementally.
- Log writes, downloads, caches, and agent streams have explicit memory bounds.
- Retention controls storage growth without erasing deduplication or retry-suppression state.
- Provider traffic has bounded concurrency, coordinated backoff, and useful partial-failure reporting.
- Measurements show when to increase capacity or introduce a shared database.

## 2. Assessment evidence

The local database inspected during the assessment contained 10 task instances, 315 runs, 101 jobs, 28 tracked subjects, and 8,614 log lines. The largest recorded run log contained 329 lines. This is a small development dataset, not evidence of current production saturation.

The assessment also ran isolated probes against the application's actual SQLite adapters and migrations. No application code was changed. Sixty-five existing tests passed across the task sink, HTTP client, scheduler, claim-race, and migration suites.

| Probe | Observed result | Interpretation |
| --- | --- | --- |
| Statistics and job counts across 100 tasks, with 10,000 runs and 10,000 jobs | Approximately 5 ms median | Small histories are inexpensive. |
| Same queries, with 100,000 runs and 100,000 jobs | Approximately 70 ms median | Cost grows with retained history. |
| Same queries, with 500,000 runs and 500,000 jobs | Approximately 628 ms median | Historical aggregation can occupy the shared event loop for a substantial interval. |
| Read and serialize 10,000 log lines, each with a 200-character message | Approximately 12 ms and 2.6 MB of JSON | Full-log polling becomes costly as a run grows. |
| Worker A completes after its lease is reclaimed and assigned to B | Job becomes `done` with A's execution ID | Terminal updates do not enforce current ownership. |
| Pending cache load exceeds its TTL | A second load starts for the same key | Single-flight protection does not survive a slow load. |
| Fetch an 8 MiB trace with a 1 KiB configured cap | All 8 MiB consumed before truncation | The existing cap protects the returned text, not download memory. |
| Explain the job lease candidate query | Temporary B-tree used for ordering | Index/filter/order alignment needs evaluation with realistic queue distributions. |

Timing probes used an in-memory database, synthetic data, one warm-up, and the median of seven measurements. The history probe measured only per-task run statistics and job counts, not complete task summaries or HTTP responses. These numbers are diagnostic evidence, not capacity forecasts. Recreate durable benchmark fixtures during Phase 0; this plan must not depend on a temporary assessment script.

## 3. Current architecture and constraints

The React UI calls a Bun HTTP server. The same daemon owns the application services, scheduler, worker pool, synchronous SQLite adapters, provider clients, and agent container lifecycle. Docker isolates agent execution, but host-side stream parsing, logging, and persistence remain in the daemon.

Existing foundations to preserve:

- Application services and repository/gateway ports separate behavior from adapters.
- SQLite claims and queued-job deduplication use atomic database operations.
- Job leases and heartbeats support recovery of abandoned queued work.
- Response caching is scoped to the requesting identity.
- Frontend query caching and conditional polling reduce navigation traffic.
- ETags avoid transmitting unchanged responses, although many responses are fully rebuilt before the ETag comparison.
- Some expensive provider operations already have bounded batches, such as release-history diff fetching.

Current constraints:

- `--jobs` bounds queued jobs, but custom loops can start agents directly through the executor.
- SQLite operations and synchronous log retry sleeps can block HTTP requests and heartbeats.
- Scheduler exclusion is local to the process; startup closes all running execution rows as orphaned.
- Task and graph views reconstruct substantial state on each request.
- Completed jobs and run logs have no scheduled retention mechanism.
- Job completion, failure, execution attachment, and release do not consistently require the current lease identity.
- Provider limits are mostly per operation, not shared across UI traffic and background work.

SQLite WAL permits concurrent readers and a writer, but only one writer at a time, and participating processes must use the database on the same host. A network-mounted WAL file is not the multi-host storage strategy. See the [SQLite WAL documentation](https://sqlite.org/wal.html).

## 4. Delivery sequence

| Phase | Priority | Deliverable | Dependencies |
| --- | --- | --- | --- |
| 0 | First | Repeatable measurements and bounded operational telemetry | None |
| 1 | Highest correctness priority | Lease ownership, recovery, and cancellation guarantees | Phase 0 baseline |
| 2 | Highest resource priority | Shared admission for all agent execution | Phase 1 for durable admission |
| 3 | High | Incremental logs and bounded log persistence | Phase 0; integrate with Phase 1 lifecycle rules |
| 4 | High | Efficient task/graph reads and safe retention | Phase 0; summary semantics before deletion |
| 5 | High | Bounded downloads, agent streams, and cache memory | Phase 0; can be delivered independently |
| 6 | Medium | Shared provider budgets and overload behavior | Phase 0; account for Phase 2 workloads |
| 7 | Conditional | Separate process roles and multi-host deployment | Phases 1–6 and demonstrated capacity/availability need |

This sequence describes dependencies, not permission to implement the entire roadmap at once. Each work package should be independently reviewable and retain a usable application after deployment.

## 5. Phase 0 — establish a repeatable baseline

### Changes

- Add a synthetic benchmark harness that creates a temporary database using the real migrations. Do not benchmark by inserting into an operator's database.
- Cover 10, 100, and 1,000 task instances; 10,000, 100,000, and 500,000 historical runs/jobs; 1,000, 10,000, and 100,000 log lines; and different active-to-completed job ratios. Large scenarios can be opt-in.
- Measure full task-list, graph, system-status, and incremental/full log requests, separately from adapter microbenchmarks.
- Exercise one and multiple browser clients, warm and cold caches, and slow or rate-limited provider fixtures.
- Record the runtime version, CPU/RAM, filesystem, database size, WAL settings, warm-up, sample count, and workload distribution with each result.
- Add low-cardinality measurements for request duration/response size, event-loop delay, database latency and busy errors, queue age, active agents, log-buffer size, provider latency/429s, and cache hit/coalescing/eviction counts.
- Distinguish queue wait, container preparation, provider wait, and agent execution duration. Aggregate run duration alone cannot identify the limiting resource.

### Relevant code

[HTTP serving](src/api/serve.ts), [routing](src/api/router.ts), [workers](src/core/worker-pool.ts), [database](src/persistence/database.ts), [HTTP connector](src/connectors/http.ts), [cache](src/core/ttl-cache.ts), and [agent runtime](src/infrastructure/agent/run.ts).

### Acceptance and validation

- A developer can reproduce the benchmark from one documented command without provider credentials.
- Reports include p50/p95/p99 latency, throughput, response bytes, memory, and event-loop delay where applicable.
- Metric labels use route templates and bounded workload classes, not user IDs, job IDs, repository paths, tokens, or raw URLs.
- Suggested initial targets on a documented reference host: p95 local status/page reads below 100 ms and p99 event-loop delay below 50 ms under the agreed workload. These are proposed engineering targets, not current guarantees.
- Compare before/after on identical workloads. Do not introduce hard CI timing failures until normal variance is understood.

## 6. Phase 1 — enforce execution ownership

### Changes

1. Add a monotonically changing lease generation or unique lease token returned with each successful lease. A process owner string alone is insufficient if the same process later reacquires a job.
2. Require job ID, current owner, current lease token, and leased state for worker-originated renewal, execution attachment, completion, failure, and release. Define explicitly whether an expired-but-not-yet-reclaimed lease may renew; use one consistent rule.
3. Make ownership-sensitive mutations report success or ownership loss. Do not silently accept a zero-row update.
4. Complete the job and advance its subject fingerprint within one ownership-checked transaction. The current separate subject update can otherwise occur even when the worker no longer owns the job. Put this operation behind a dedicated application port so the core does not depend on SQLite.
5. Only remove job notifications as a consequence of an accepted state transition. A stale worker must not clear a replacement worker's notification.
6. On lease loss, stop scheduling further steps, request cancellation of the owned execution/container, and prevent stale local finalization. Preserve evidence of any external operation that may already have completed.
7. Record an execution owner and liveness information. Replace blanket startup orphan closure with recovery based on expired ownership. Until this exists, enforce one daemon owner for a database at startup.
8. Scope container cleanup to the execution/daemon that owns the container. Remove broad fallback cleanup from normal cancellation; retain any deliberate global emergency cleanup as a clearly separate operator operation.
9. Keep operator cancellation distinct from worker completion: a cancelled job must not be revived or overwritten by a late success/failure callback.

Lease fencing protects application state. It cannot undo an already accepted GitLab/Jira request. Continue using deterministic branch names, reconciliation, provider idempotency where available, and conditional Git writes. Document at-least-once execution rather than claiming exactly-once external effects.

### Relevant code

[Job contracts](src/core/job.ts), [worker pool](src/core/worker-pool.ts), [job queue](src/persistence/job-queue.ts), [subject store](src/persistence/subject-store.ts), [ports](src/application/ports.ts), [cancellation](src/application/cancellation-service.ts), [run sink](src/persistence/sqlite-task-sink.ts), [serve lifecycle](src/server.ts), and [container cleanup](src/infrastructure/agent/containers.ts).

### Acceptance and validation

- Reproduce lease A → expiry → lease B → late A completion/failure/attachment/release. Every stale mutation is rejected; B's execution and subject state remain intact.
- Verify the same behavior when one process reacquires a job under a new lease token.
- Test cancellation racing with completion and failure, heartbeat loss, process termination, and restart during an external side effect.
- A second daemon either fails with an explicit single-owner error or starts only in a supported role; it never marks another live process's runs failed.
- Migrations preserve existing jobs. Stop/drain old workers during the first ownership-contract rollout; additive columns alone do not make old unfenced worker code safe to mix with new workers.

## 7. Phase 2 — put all expensive work behind admission control

### Changes

- Inventory every call path to agent execution: queued handlers, custom loops, manual task runs, scheduler ticks, and CLI runs.
- Convert custom-loop agent work into durable child jobs, with one target repository or scratch execution per job. Keep discovery/orchestration lightweight.
- Preserve the parent invocation, actor, prompt and parameter snapshot, permissions, cancellation relationship, and result aggregation when splitting a custom loop into jobs.
- Preserve the existing overlap policy where appropriate: if a custom-loop invocation still has pending children, a later scheduled tick must not silently create a duplicate invocation. Manual repeat behavior should be explicit.
- Introduce separate workload budgets for agents and lightweight orchestration. Keep the existing total-job limit meaningful and document how it interacts with these budgets.
- Add configurable per-agent memory, CPU, and process limits plus a host reserve. Check configuration against the intended maximum concurrency; four containers each allowed 2 GiB do not fit safely on an 8 GiB host without room for other processes.
- Ensure every execution path shares the same host budget. Use the durable queue
  or an ownership-aware shared permit mechanism.
- Add bounded pending-work admission and fair scheduling so one actor/loop cannot occupy every slot indefinitely. Deduplicated submissions should remain cheap and should not consume another queue slot.
- Return a clear queued or capacity-exhausted result when work cannot start immediately. Do not silently drop admitted jobs.
- Prebuild the agent image during deployment or coalesce first-use image builds so concurrent jobs do not all build it.

### Relevant code

[Custom loops](src/tasks/custom-loop/index.ts), [task service](src/application/task-service.ts), [executor](src/core/executor.ts), [scheduler](src/core/scheduler.ts), [workers](src/core/worker-pool.ts), [server options](src/server.ts), [agent image](src/infrastructure/agent/image.ts), and [agent execution](src/infrastructure/agent/run.ts).

### Acceptance and validation

- Trigger more scheduled custom loops, queued actions, manual runs, and CLI invocations than available agent slots. Observed concurrent containers never exceed the configured host budget.
- Lightweight discovery and cancellation remain responsive while all agent slots are occupied.
- Cancelling a parent invocation prevents queued children from starting and stops only its active children.
- Restart resumes admitted work with its original actor and parameters.
- A sustained overload produces a bounded queue or explicit rejection, with oldest-job age visible.
- Validate resource limits using controlled containers and stub agents; real token spend is unnecessary for the concurrency tests.

## 8. Phase 3 — make logs incremental and persistence bounded

### Changes

- Expose the existing monotonically increasing log row ID in the log contract.
- Add a bounded log-read API accepting `afterLogId` and `limit`, with `nextCursor`, `hasMore`, and execution status. Use an indexed query equivalent to `execution_id = ? AND id > ? ORDER BY id LIMIT ?`.
- Support a bounded initial tail and loading older pages. Specify whether an initial request means oldest-first history or the latest tail; do not leave this ambiguous.
- Separate step/run metadata from log transfer, or version them independently, so unchanged metadata does not force a full log reload.
- Update frontend queries to append unseen log IDs, drain paginated backlogs, and perform a final drain after a run becomes terminal.
- Preserve incremental timeline grouping for events split across page boundaries. Bound retained browser history and virtualize long timelines while allowing users to load older history.
- Replace one synchronous write per log line with a bounded batch writer. Use small transactions and flush on byte count, record count, or a short interval.
- Host the writer in a worker thread or dedicated persistence process. Do not move the same synchronous database operations into an `async` function and assume they are nonblocking.
- Preserve ordering: persist the run before its logs; make completion wait for the necessary final flush; drain within a bounded shutdown deadline.
- Define buffer overflow and disk-full behavior. Prefer backpressure; if low-priority logs must be dropped, emit a counted gap marker and preserve errors/terminal state through a reserved path. Never recurse through the same failing log sink.
- Replace synchronous sleep retries with bounded asynchronous retry/backoff outside the HTTP event loop.

SSE is an optional follow-up after cursor semantics work. If introduced, reconnect using persisted cursors, authorize each connection, cap connections/output buffers, and disconnect slow clients safely. The database remains the source for replay; an in-memory event stream alone is insufficient.

### Relevant code

[Log capture](src/logging/capture.ts), [run sink](src/persistence/sqlite-task-sink.ts), [router](src/api/router.ts), [shared contract](shared/api-contract.ts), [frontend API](web/src/api.ts), [queries](web/src/queries.ts), [timeline rendering](web/src/runs/RunTimeline.tsx), and [timeline folding](web/src/runs/timeline.ts).

### Acceptance and validation

- Repeated polling without new lines returns no historical lines and does not read/serialize the entire run.
- A new line costs approximately the new payload size, not the accumulated log size.
- Reconnection, pagination, retries, and completion produce no duplicate or missing committed lines.
- Long-running tests with 100,000 log lines keep browser and server buffers within configured limits.
- Under forced SQLite contention, HTTP requests and heartbeats continue to meet the agreed responsiveness target.
- Crash tests document the maximum unflushed log-loss window. Job completion and audit semantics must not claim persistence that has not been acknowledged.
- Roll out the new endpoint and consumer before retiring the old endpoint; retain compatibility for an already-open older UI during the transition.

## 9. Phase 4 — efficient reads, summaries, and retention

### Task and system views

- Separate frequently polled live state from full task definitions, parameter schemas, prompts, and historical summaries.
- Filter and authorize task instances before assembling their views; introduce bounded page sizes and stable pagination.
- Change the globally mounted job-queue provider to read compact live counters. It must not require an unpaginated copy of every task.
- Fetch latest runs, active-job counts, and subject counts in batches for the visible page. Avoid one query per row.
- Count `queued` and `leased` jobs directly for live indicators; do not group the entire completed-job history to answer an active-work question.
- Maintain task summary counters on accepted run transitions, with idempotent updates and a reconciliation/backfill command. Define whether statistics are lifetime or retained-window values; label them accordingly.
- Preserve lifetime counters when raw history is purged if the UI continues to promise lifetime statistics.
- Replace unconditional full registry/config reloads on every request and worker
  tick with revision-based refresh. Detect edits through a database revision or
  equivalent shared signal.

### Graph and relationship reads

- Persist explicit ticket-to-MR/run/job relationships when a handler establishes them. Add structured action/resource fields instead of relying on wildcard searches over `dedupe_key` for routine history lookup.
- Backfill known relationships from existing subjects and run metadata in batches. Record their provenance and do not overwrite explicit links with heuristic matches.
- Select the visible ticket/cluster page before loading its runs, jobs, and subjects. Replace per-subject queries with batched reads for that page.
- Ensure active work remains discoverable even when it falls beyond a recency page. Expose pagination and totals rather than silently treating the first 60 clusters as the complete dataset.
- Apply authorization during candidate selection and again where necessary for attached resources; faster shared read models must not widen private-task visibility.

### Retention

- Add a scheduled maintenance job with independently configurable retention for raw logs, execution details, completed jobs, webhook deliveries, and diagnostic data.
- Begin with report-only mode: eligible row counts, estimated storage, and the oldest retained timestamp. Enable deletion only after retention semantics and archive needs are configured.
- Keep active jobs/runs and unresolved recovery records. Account for notifications, release watches, graph links, and other references before removing history.
- Preserve deduplication and retry-suppression records separately from disposable job history. In particular, deleting `dead` jobs must not make `deadFor()` forget a permanently failed fingerprint and restart expensive work automatically.
- Retain subject fingerprints and required external-effect reconciliation evidence according to correctness requirements, not merely log age.
- Delete in small indexed batches with a time/row budget, yielding between batches. Avoid a large cascading log deletion in one foreground transaction.
- Monitor database/WAL size and checkpoint duration. Do not run an unconditional full `VACUUM` on the request path or after each cleanup batch; file compaction is separate planned maintenance.

### Relevant code

[Task views](src/api/views.ts), [graph](src/api/graph-view.ts), [router](src/api/router.ts), [app refresh](src/app.ts), [run sink](src/persistence/sqlite-task-sink.ts), [job queue](src/persistence/job-queue.ts), [subjects](src/persistence/subject-store.ts), [migrations](src/persistence/migrations.ts), and [job-queue context](web/src/JobQueueContext.tsx).

### Acceptance and validation

- Fixed-size live pages have bounded query counts independent of total tasks/subjects; poll cost no longer scans all completed history.
- Increasing retained history from 10,000 to 500,000 rows does not produce the previously observed growth in active-job/status queries.
- `EXPLAIN QUERY PLAN` supports each hot query/index change. Evaluate lease selection with mixed priorities, kinds, delayed jobs, and ready backlogs before choosing a replacement index.
- Summary reconciliation exactly matches a direct aggregate over equivalent source data before and after backfill and retention.
- Maintenance is restartable and bounded; readers and job heartbeats remain responsive during cleanup.
- Purging raw job history does not requeue a previously exhausted fingerprint.
- Cross-user/private-task visibility tests pass for every new batch or relationship query.

## 10. Phase 5 — bound downloads, stream state, and caches

### Changes

- Add explicit maximum-body policies to the shared HTTP client. Check `Content-Length` when available, but enforce limits against actual streamed bytes as well.
- For traces requiring both head and tail, retain a bounded head buffer and rolling tail buffer. This bounds memory but still downloads the full trace; distinguish that from bandwidth savings.
- Use range requests only where the provider supports them and the head/tail are known to belong to the same resource version. If the network byte budget is exceeded, cancel with an explicit truncation/limit result instead of silently pretending the tail is complete.
- Bound JSON response bodies before decoding and schema validation. Oversized bodies should produce typed, actionable errors.
- Keep timeout/cancellation active through body consumption and map body-read failures consistently with fetch failures.
- Replace retention of all agent events with a compact accumulator for the final result, pushed branch/commit metadata, and a bounded diagnostic tail. Add a maximum NDJSON line size and a bounded stderr tail.
- Audit every consumer of the agent event array before removing it; retain all facts required for success and failure interpretation.
- Separate pending loads from settled cache entries. A pending load should remain coalesced until completion or a real load deadline, regardless of the settled-value TTL.
- Bound distinct pending loads as well as settled entry count and estimated bytes. Large diff responses must not be allowed to consume arbitrary memory simply because there are fewer than 500 entries.
- Define refresh behavior when a load already exists. Repeated bypass requests should not create unlimited duplicate loads; if a follow-up fresh load is necessary, schedule at most one.
- Define an explicit policy for upstream failures: optional last-good data with freshness/error metadata, plus a short retry cooldown. Authorization failures must not expose cached content after access has changed.

### Relevant code

[HTTP client](src/connectors/http.ts), [GitLab client](src/connectors/gitlab/client.ts), [agent runtime](src/infrastructure/agent/run.ts), [stream parser](src/infrastructure/agent/stream.ts), [cache](src/core/ttl-cache.ts), [cache policy](src/api/cached.ts), and [cached reads](src/api/cached-reads.ts).

### Acceptance and validation

- Stream large responses with missing or incorrect length headers and verify bounded retained memory.
- Test chunk boundaries, split UTF-8 characters, maximum line/body sizes, timeout during body read, and cancellation.
- Agent result/commit extraction remains correct without storing the full event sequence.
- Concurrent callers join a slow pending cache load even after the normal value TTL; capacity eviction does not silently permit duplicate pending work.
- Distinct-key overload and repeated refresh clicks remain within configured concurrency and memory limits.
- Existing credential-scoping and cache invalidation behavior remains covered.

## 11. Phase 6 — coordinate provider traffic and overload handling

### Changes

- Introduce a shared request limiter keyed by provider host and effective credential identity. Use an opaque internal identifier; never expose a token as a key, log field, or metric label.
- Bound concurrency and waiting requests across UI reads, discovery loops, and background actions using the same credential. Leave enough capacity for interactive operations so a background scan does not monopolize it.
- Replace repository/state `Promise.all` fan-out with bounded scheduling. Apply an explicit repository/work limit or pagination for large filters.
- Honor `Retry-After` and provider reset information through a shared cooldown. Use bounded jittered retries and avoid multiplying connector, step, and job retry policies.
- Report unavailable repositories separately from transient failures and rate limits. Do not turn every failure into an apparently successful empty list.
- Preserve independently successful provider results where the API supports partial data, with clear warnings and freshness metadata.
- Give requests an end-to-end deadline that includes limiter wait time. Propagate cancellation, while ensuring that one subscriber cannot cancel a cached load still needed by others.
- Add request admission limits for expensive endpoints and appropriate server/proxy timeout settings. The current unlimited idle timeout should not be the only protection for slow routes.
- Keep provider request limits and local job admission separate: long-lived agent slots and short HTTP calls consume different resources.

### Relevant code

[HTTP client](src/connectors/http.ts), [GitLab PR provider](src/connectors/gitlab/pull-requests.ts), [PR service](src/application/pull-request-service.ts), [release service](src/application/release-service.ts), [retry policy](src/core/retry.ts), [worker retry handling](src/core/worker-pool.ts), and [HTTP server](src/api/serve.ts).

### Acceptance and validation

- Many users/tabs with overlapping and distinct cache keys cannot exceed the configured provider/credential concurrency budget.
- A 429 produces one coordinated cooldown rather than a burst of independent retries.
- Interactive requests make progress during sustained background scans.
- Partial errors remain visible; a provider outage does not masquerade as no tickets/MRs.
- Admission queues have bounded length and wait time, and cancellation removes work that no longer has consumers.
- Fixture-based tests exercise slow responses, resets, repeated 429s, 401/403s, deleted repositories, and recovery.

## 12. Phase 7 — scale process roles only when justified

Current decision: deferred. The entry criteria below have not been established,
and this repository therefore continues to enforce one serving daemon per
SQLite database. PostgreSQL, multi-host workers, and independent scheduler/API
roles are not claimed as supported.

### Entry criteria

Proceed when the measurements show sustained queue growth at a safe single-host resource limit, local request targets remain unmet after query/log improvements, or availability requirements require surviving the loss of a host. User count alone is not a sufficient trigger.

### Stage A: independent roles on one host

- Introduce explicit `api`, `scheduler`, `worker`, and `maintenance` roles; retain a combined mode for simple installations.
- Make role startup read-only with respect to unrelated running executions. Separate schema migration ownership from routine process startup.
- Add scheduler leadership and durable trigger/run identity so duplicate scheduler instances do not duplicate cron work. Define missed-fire and slow-overlap behavior explicitly.
- Persist cancellation requests so the worker owning an execution can observe them. The API process must not mark a remote active run finished merely because its own executor cannot find it.
- Coordinate host-wide resource admission and provider budgets across processes; multiplying process-local limits must not multiply the intended host limit.
- Keep SQLite on local storage and measure write contention under the separated roles before expanding worker counts.

### Stage B: shared database and multiple hosts

- Implement a PostgreSQL adapter behind the existing ports, including authentication/session storage, configuration, queue state, run ownership, relationships, summaries, and cancellation state.
- Preserve atomic deduplication, ownership-checked transitions, scheduler leadership, and summary updates with shared database transactions. Verify behavior in repository contract tests across both adapters.
- Use database-coordinated time/leases where feasible to reduce sensitivity to clock differences between hosts.
- Move or route agent account state deliberately. Current managed agent homes live beside the local database; encrypted database credentials alone do not make filesystem-based account sessions available on another worker.
- Distribute a versioned agent image and define worker capabilities, account affinity, host resource budgets, and cluster-wide provider/admission limits.
- Keep API caches local initially unless measurements justify a shared cache. Use an explicit invalidation/revision mechanism and preserve authorization boundaries.
- Store large archived logs/artifacts outside the transactional database if measurements justify it, retaining ownership, cursors, and lookup metadata in SQL.
- Plan cutover: stop admission, drain or checkpoint work, take a consistent backup, migrate, compare counts and critical invariants, switch roles, then reopen admission.
- Define rollback before cutover. After new writes reach PostgreSQL, reverting to an old SQLite snapshot would lose work; rollback requires reconciliation or a controlled reverse migration.

### Acceptance and validation

- Two schedulers competing for the same trigger produce one admitted invocation.
- Multiple workers do not share a job lease, exceed configured budgets, or accept stale completion.
- Restarting one API/worker does not close another worker's run or stop its containers.
- Terminating a worker host allows recovery while preserving external-effect reconciliation.
- Remote cancellation, deployment draining, credentials/account routing, backup restore, and migration rollback procedures are exercised before production rollout.

## 13. Suggested review packages

Use focused changes in this order, adjusting only where the dependencies above permit it:

1. Benchmark fixtures, measurement hooks, and documented reference workload.
2. Lease tokens, ownership-sensitive queue contract, and transactional completion.
3. Owner-aware recovery and execution-scoped cancellation/cleanup.
4. Shared agent admission and configurable resource budgets.
5. Durable custom-loop child jobs with parent progress/cancellation.
6. Incremental log API and frontend cursor consumption.
7. Bounded background log writer and lifecycle flushing.
8. Compact live status API, paginated task reads, and batched aggregates.
9. Explicit graph relationships and bounded graph reads.
10. Summary backfill/reconciliation and report-only retention, followed by configured cleanup.
11. Streaming response limits and compact agent event accumulation.
12. Pending-load coalescing and cache byte/concurrency limits.
13. Provider limiter, shared cooldown, and partial-failure responses.
14. Separate process roles and PostgreSQL deployment, only after the Phase 7 entry criteria are met.

Each package should explain the changed behavior, show its relevant benchmark or correctness evidence, document compatibility, and identify rollback limits. Follow the repository's required Jira-bearing title convention when creating actual commits or merge requests; this plan assigns no invented ticket numbers.

## 14. Completion checklist

- [x] Repeatable baseline and operational measurements are available.
- [x] Stale workers cannot modify job, subject, execution-link, or notification state.
- [x] Recovery and cancellation respect ownership.
- [x] Every agent invocation obeys the configured shared resource budget.
- [x] Queues, pending provider calls, and memory buffers remain bounded under overload.
- [x] Live log reads are incremental and completion drains the final records.
- [x] Database log contention does not block the HTTP event loop.
- [x] Hot status/page queries scale with active work and page size.
- [x] Graph relationships are indexed and authorized.
- [x] Retention preserves retry suppression, idempotency, and audit requirements.
- [x] Downloads, agent streams, and caches have enforced byte limits.
- [x] Provider failures and shared cooldowns are observable and tested.
- [x] Documentation distinguishes measured capacity from proposed targets.
- [x] Relevant repository checks and risk-specific tests pass for each implementation package.
- [x] Multi-process/multi-host mode is either validated against Phase 7 criteria or remains explicitly unsupported.

## 15. Validation and operating notes

Run focused checks while developing each package, then the repository's `bun run check` before integration. Add tests for meaningful failure modes—ownership races, incremental replay, retention correctness, overload, and migration compatibility—rather than tests that repeat the implementation mechanically.

Use synthetic data and injected provider/container fixtures for routine verification. Real integrations are reserved for narrow smoke tests against designated repositories/accounts. Performance reports should separate application overhead from external provider and agent time.

Roll out additive schemas and new read contracts before switching consumers. Backfill in restartable batches. Keep legacy fields until supported clients have moved, and require a drain/restart whenever old worker code would violate a new ownership invariant.

The plan does not authorize deleting current history, changing production retention, deploying additional servers, or migrating the database. Those are implementation/deployment actions to be carried out under the corresponding task scope. Writing this document changes no runtime behavior.
