# Worker orchestration implementation plan

Status: delivery milestones 1 and 2 implemented; checkpoint contract, persistence,
capability gating, and test provider framework implemented for milestone 3.
Production checkpoint providers remain deferred.

Operational lifecycle and capacity semantics are documented in
`docs/worker-orchestration.md`; checkpoint requirements are documented in
`docs/checkpoint-suspension.md`.

## Objective

Evolve the existing durable job queue, worker pool, agent admission controls, and container execution code into one orchestration service. The service will own scheduling, capacity allocation, and execution lifecycle so the system can reliably operate within a fixed agent capacity.

New requests must wait when capacity is exhausted. Operators must be able to hold pending work, cancel work, and drain the pool. Resuming a suspended running agent is a later capability requiring an explicit checkpoint contract.

## Current foundation

- `src/core/worker-pool.ts`: bounded execution of queued jobs, lease heartbeats, retries, and cancellation handling.
- `src/core/job.ts` and `src/persistence/job-queue.ts`: durable jobs, priority and actor-aware selection, deduplication, and ownership fencing.
- `src/infrastructure/agent/capacity.ts`: process-local admission, actor fairness, and interactive capacity reservation.
- Legacy `src/persistence/agent-capacity-store.ts`: replaced by the durable orchestration store.
- `src/infrastructure/agent/run.ts`: agent preparation, runtime execution, output interpretation, and capacity release.
- `src/infrastructure/agent/containers.ts`: Docker identity and cleanup helpers.
- `src/infrastructure/agent/execution.ts`: existing runtime execution interface used by Kubernetes.
- `src/application/cancellation-service.ts`: job and run cancellation coordination.
- `src/server.ts`: worker configuration, daemon ownership, startup, and shutdown.

The current workers are concurrent executions that launch containers, not a persistent fleet of reusable Docker agents. Preserve this execution model initially.

The focused queue, worker-pool, and capacity tests passed during assessment: 16 tests. This does not establish crash-safe Docker reconciliation.

## Gaps to address

1. No single owner coordinates a job, its execution attempt, its capacity slot, and its container.
2. Expired host permits can become reusable without proving that their containers stopped.
3. Host-permit renewal does not currently act on loss of ownership.
4. Asynchronous container cleanup can allow capacity release before termination is confirmed.
5. Startup closes orphaned run records without a corresponding Docker reconciliation pass.
6. Work can wait in both the durable job queue and an in-memory admission queue, obscuring whether it is executing.
7. There is no explicit hold or suspend/resume lifecycle. Cancellation and failure share the job's `dead` state.

## Required invariants

- A slot becomes available only when its previous execution is confirmed stopped, or when reconciliation proves that no container was created for it.
- A permit expiring is evidence of lost ownership, not evidence of available physical capacity.
- No agent container may start without a persisted reservation and execution identity.
- A stale owner cannot finalize a replacement execution or release its slot.
- Scheduling decisions distinguish total agent capacity from lightweight job concurrency.
- Interactive reservations are part of the total capacity, not extra capacity above it.
- Capacity reductions drain naturally; they do not implicitly kill running work.
- Uncertain runtime state remains visible and retains its reservation until resolved.
- Queue holds, operator cancellation, supersession, failures, and resumable suspension have distinct semantics.
- Managed resources are scoped to an installation so cleanup cannot target another installation's containers.

## Proposed architecture

```text
Scheduled discovery / manual requests / interactive requests
                           |
                           v
             Orchestration service
             - admission and scheduling policy
             - job and execution transitions
             - slot ownership
             - cancellation and draining
             - reconciliation
                  |                  |
                  v                  v
       Durable queue and       Runtime adapter
       execution/slot store    Docker / Kubernetes
```

Keep task handlers, prompts, credentials, and agent output interpretation outside the orchestration service. Keep the existing durable queue and its useful guarantees. Prefer injected dependencies over additional process-global configuration.

The server currently enforces one daemon owner per database. Preserve that deployment model in the initial implementation; a multi-host scheduler is outside the first milestone.

## Phase 1: Define lifecycle and policy contracts

### Work

- Separate a logical job, an execution attempt, a capacity slot, and a runtime resource in the domain model.
- Specify transitions for queued, held, starting, running, stopping, and terminal work. Decide which states belong on the job versus its attempt before writing migrations.
- Represent completion, failure, operator cancellation, and supersession distinctly.
- Define which interruptions consume failure retry attempts. Holds and intentional administrative actions must not silently behave like execution failures.
- Define an explicit total agent budget and an interactive reservation within it.
- Define priority ordering, actor fairness, and starvation behavior across interactive and background lanes.
- Define drain behavior and behavior when capacity is lowered below current occupancy.
- Document what happens to interactive requests on disconnect or restart; their persistence requirements may differ from durable background jobs.

### Migration constraint

Current defaults allow two background agents plus one interactive reserve, for a total of three. Preserve existing effective capacity when translating old configuration, with clear precedence and validation if new settings are introduced.

### Acceptance criteria

- A documented state transition table identifies allowed transitions and their owners.
- Capacity semantics have concrete examples for full capacity, reservations, and reductions.
- Cancellation, failure retry, hold, and supersession have unambiguous outcomes.

## Phase 2: Introduce runtime adapters

### Work

- Extract Docker lifecycle operations from the agent runner behind an injected runtime interface.
- Align the interface with the existing Kubernetes executor without putting runtime-specific details into scheduling policy.
- Support starting an execution, inspecting it, listing managed executions, and stopping it.
- Give every execution a stable identity and installation-scoped runtime metadata before creation.
- Make stop operations idempotent and report confirmed termination versus unresolved cleanup.
- Account for cancellation during creation, including the race where cancellation arrives before the container becomes discoverable.
- Retain agent preparation, credential handling, stream parsing, and output interpretation in the agent execution layer.

### Acceptance criteria

- Docker and Kubernetes capability differences are explicit.
- Repeated start/stop handling cannot create unidentified or duplicate resources for an attempt.
- The orchestration layer can determine whether an execution is still consuming capacity.

## Phase 3: Persist slot ownership and execution identity

### Work

- Persist the association between job, attempt, slot, runtime resource, and ownership token.
- Coordinate durable job admission and slot reservation transactionally where possible.
- Model the boundary between database reservation and runtime creation as a recoverable sequence; Docker creation cannot share a database transaction.
- Fence state changes by ownership token.
- Detect failed ownership renewal and initiate stale execution handling.
- Retain reservations for uncertain runtime state instead of deleting them solely because a heartbeat expired.
- Ensure cleanup and completion release only the reservation belonging to that attempt.

### Acceptance criteria

- Crashes before and after runtime creation leave enough durable information for recovery.
- Stale completion and release calls cannot mutate a replacement attempt.
- No reservation is reused while its previous runtime resource may still be running.

## Phase 4: Introduce the orchestration service

### Work

- Centralize admission and lifecycle decisions in one application service.
- Select eligible queued jobs using existing priorities and actor-aware scheduling.
- Reserve capacity before starting an agent execution.
- Track preparation/startup, execution, stopping, and terminal outcomes accurately.
- Release capacity only after confirmed termination or confirmed non-creation.
- Route background jobs, direct agent runs, interactive requests, and other workloads consuming the same agent budget through this boundary.
- Preserve independent throughput for lightweight jobs.
- Remove redundant admission paths after all entry points use the service.
- Coordinate cancellation, retries, draining, and shutdown through the same lifecycle rules.

### Acceptance criteria

- No agent entry point bypasses capacity admission.
- Requests above capacity remain waiting without being reported as actively executing an agent.
- Existing durable queue, deduplication, and retry behavior remain intact unless explicitly migrated.
- Shutdown prevents new admissions before stopping or draining current work.

## Phase 5: Add startup and periodic reconciliation

### Work

- Compare durable execution and slot records with actual managed runtime resources.
- Run reconciliation before enabling new admissions at startup, then periodically.
- Handle containers surviving a daemon crash, reservations without containers, containers that exited without completion records, stale owners, and unknown managed resources.
- Define whether each recoverable execution is stopped and retried or can be adopted; do not assume a surviving container's output stream can be reattached.
- Treat Docker unavailability as unknown state, not an empty container list.
- Expose unresolved cleanup and reconciliation failures with actionable status.
- Scope resource discovery and cleanup to the installation.

### Acceptance criteria

- Restart recovery cannot create replacement work alongside an unaccounted surviving execution.
- Failed runtime inspection does not free occupied slots.
- Reconciliation is idempotent and safe to repeat after interruption.
- An operator can identify why capacity remains reserved.

## Phase 6: Add job management policies

### Initial capabilities

- Hold and resume pending jobs without losing queue durability.
- Cancel queued or running jobs with distinct outcomes.
- Drain the agent pool while preserving waiting work.
- Change job priority explicitly.
- Add opt-in supersession policies for a defined subject and job kind.

### Supersession rules

- Define the subject and version relationship explicitly; unrelated requests must not replace one another.
- Decide separately whether newer work supersedes only queued jobs or also running jobs.
- Stop a superseded running execution and confirm termination before releasing its slot.
- Retain audit history explaining which request superseded which job.

### Acceptance criteria

- Held jobs remain ineligible across restarts until resumed.
- Administrative interruption does not accidentally exhaust failure retries.
- Cancellation cannot requeue the job through a racing worker completion path.
- Supersession is opt-in and covered by race tests.

## Phase 7: Expose management and observability

### Work

- Expose total capacity, interactive reservation, actual occupancy, and immediately available capacity with clearly defined metrics.
- Expose waiting reasons, held state, draining state, and unresolved runtime state.
- Link jobs to attempts, slots, and runtime resources.
- Report queue position only where scheduling policy makes it meaningful; otherwise explain eligibility and waiting reason.
- Record orchestration transitions and reconciliation actions in logs and operational history.
- Add management API operations, respecting existing authorization boundaries.
- Add UI controls after lifecycle semantics stabilize, using existing shadcn components and Tailwind utilities.

### Acceptance criteria

- Operators can distinguish queued, starting, executing, stopping, and uncertain work.
- Displayed capacity agrees with durable reservations and confirmed runtime state.
- Cleanup failures are visible instead of appearing as unexplained lost capacity.

## Phase 8: Validate and migrate

### Verification

Retain existing queue and worker tests, and add meaningful lifecycle, integration, and failure-injection coverage:

- More requests than available slots.
- Interactive reservations, priorities, and actor fairness.
- Lowering capacity while executions are active.
- Cancellation during reservation, creation, execution, and cleanup.
- Crashes before creation, after creation, and before finalization.
- Delayed or failed container removal.
- Ownership expiration and stale finalization.
- Runtime inspection failure and recovery.
- Startup reconciliation without exceeding capacity.
- Hold/resume across restart.
- Supersession and cancellation races.
- Lightweight jobs progressing while agent capacity is full.

Use a controllable fake runtime for deterministic lifecycle tests and targeted Docker integration tests for real creation, inspection, termination, and orphan recovery. Existing unit tests alone are insufficient for the physical capacity guarantee.

### Migration

- Preserve existing queued jobs, deduplication history, and retry suppression records.
- Define handling for legacy in-flight jobs and containers during upgrade.
- Preserve effective capacity when converting configuration.
- Switch all admission paths together before removing the old capacity mechanism; avoid two independently admitting schedulers.
- Document rollback constraints introduced by new lifecycle states and schema changes.

### Acceptance criteria

- All affected existing checks and new orchestration tests pass.
- Upgrade behavior is demonstrated with queued and interrupted work.
- No runtime-capacity guarantee relies solely on an expired database lease.

## Deferred: production checkpoint providers

The durable checkpoint contract and provider framework are implemented. True
suspension remains unavailable until a runtime provider can persist workspace
and agent session state at a replay-safe boundary, confirm runtime termination,
and resume under fresh capacity admission.

Freezing a container is not sufficient for a memory-based capacity budget because the container retains its allocated memory. Cancel-and-restart must not be presented as resumable suspension.

Potential later lifecycle: running -> checkpointing -> suspended -> queued for resume -> starting -> running. Final states and policy depend on runtime and agent capabilities.

## Delivery milestones

1. **Reliable orchestration foundation:** phases 1–5, with the relevant tests and migration work from phase 8. Unified ownership, fixed capacity, confirmed cleanup, and crash recovery.
2. **Operator job management:** phase 6 and the API/UI work in phase 7, with corresponding migration and verification.
3. **Resumable suspension:** separate design and implementation after checkpoint capabilities are established.

Verification and migration are part of each milestone, not work deferred until every feature is built.

## Completion definition for the first milestone

The system can accept more work than it can execute, keep excess requests waiting, run only within its configured capacity, stop work reliably, and recover from a daemon crash without treating surviving containers as free slots. Every occupied or uncertain slot has an identifiable execution and a visible reason for remaining reserved.
