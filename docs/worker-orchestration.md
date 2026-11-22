# Worker orchestration

Talos uses one durable agent budget for background agents, QA E2E agents, and
interactive assistant turns. Lightweight queue handlers remain bounded by
`TALOS_JOBS` and can continue while every agent slot is occupied.

## Capacity

`TALOS_AGENT_CAPACITY` is the total budget. `TALOS_AGENT_INTERACTIVE_JOBS`
reserves part of that total for interactive work. Background work can use
`total - interactive reservation`; interactive work can use any free slot.

For backward compatibility, when `TALOS_AGENT_CAPACITY` is unset the total is:

```text
TALOS_AGENT_JOBS + TALOS_AGENT_INTERACTIVE_JOBS
```

The defaults therefore remain two background agents and one interactive
reservation, for three total slots.

Examples:

- Total 3, interactive reservation 1: at most two background agents; an
  interactive request may use the third slot.
- Three interactive requests may use all three slots when they are otherwise
  idle. The reservation is within the total, never extra capacity.
- Reducing total capacity below current occupancy does not kill work. Existing
  attempts retain their slots and new admissions wait until occupancy falls
  below the new limit.
- Draining prevents new durable reservations and preserves queued work.

Interactive waiters are admitted first, but no more than three consecutive
interactive grants may pass a ready background waiter. Background selection is
actor-fair: the actor with the fewest running background agents goes first,
FIFO among equal actors. Job priority is considered before actor fairness.

## Lifecycle and ownership

| State | Entered by | Allowed next states |
| --- | --- | --- |
| `starting` | scheduler after atomically reserving a slot and runtime identity | `running`, `stopping`, terminal, `uncertain` |
| `running` | execution layer when runtime creation begins | `stopping`, terminal, `uncertain` |
| `stopping` | cancellation or shutdown | terminal, `uncertain` |
| `uncertain` | lost ownership, failed inspection, or unconfirmed cleanup | terminal after reconciliation |
| `succeeded` | current fenced owner after confirmed runtime completion | none |
| `failed` | current owner or reconciler after confirmed absence | none |
| `cancelled` | administrative stop after confirmed absence | none |
| `superseded` | opt-in replacement after confirmed stop | none |

Every attempt records an ownership token, slot, execution, optional job,
runtime kind, stable runtime ID, and installation ID before runtime creation.
Heartbeats extend ownership. An expired heartbeat never frees a slot. A stale
owner cannot renew or finalize an attempt.

Docker containers and Kubernetes Jobs carry installation, attempt, and
execution labels. Cleanup and discovery use the installation label so one
Talos database cannot stop another installation's resources.

## Reconciliation

Reconciliation runs before workers start and every 30 seconds afterward.
Startup treats active attempts as stale because the single-daemon database
lease proves their old process is gone.

- Reservation without a runtime identity: finalize as confirmed non-creation.
- Missing runtime: finalize as failed and release the slot.
- Surviving or exited runtime: stop it, confirm absence, then release the slot.
- Runtime API unavailable or inspection unknown: mark `uncertain` and retain
  the slot.
- Installation-scoped runtime with no attempt: stop it idempotently.

Surviving executions are stopped and retried through the durable job queue;
Talos does not claim it can reattach to their output streams.

## Job management semantics

- Hold applies only to queued work, persists across restarts, and spends no
  attempt. Resume makes it eligible again.
- Operator cancellation records terminal outcome `cancelled`; it cannot race
  with a worker release and requeue itself.
- Exhausted or non-retryable execution records terminal outcome `failed`.
- Supersession is explicit and requires the same job kind and subject with a
  different fingerprint. Running work is stopped only when the request opts in.
- Priority changes apply to queued work and preserve queue durability.

Interactive assistant turns are not durable requests, but their host process
PID and a per-attempt environment marker are persisted. Startup verifies the
marker before stopping a survivor, so PID reuse cannot target an unrelated
process. The request is not resumed afterward.
