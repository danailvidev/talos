# Checkpoint-based suspension

Checkpoint suspension is capability-gated. Talos currently has no production
checkpoint provider, so the administration UI reports suspension as
unavailable and the suspension endpoint returns `409` without changing the
execution.

This is intentional. Cancelling and starting a new agent is not suspension, and
freezing a container does not free its memory-backed capacity slot.

## Required checkpoint

Protocol version 1 requires one durable manifest containing:

- a content-addressed workspace artifact;
- a content-addressed agent-session artifact and provider session identity;
- a completed tool/turn/task-step boundary;
- runtime adapter, image, agent CLI, and session compatibility metadata;
- a serializable task cursor and task-owned state;
- an external-effect watermark and explicit proof that no effect is in flight;
- source attempt and execution identities;
- an invocation fingerprint used to reject input drift;
- supported resume runtime kinds.

Artifact references are opaque storage keys, never credential-bearing URLs.
Both artifacts require SHA-256 digests. A provider cannot declare a checkpoint
ready until the source runtime is confirmed stopped.

## Provider contract

A checkpoint provider must implement:

1. capability detection for a concrete attempt;
2. atomic checkpoint preparation at a replay-safe boundary;
3. durable workspace and session persistence;
4. confirmed source-runtime termination;
5. resume from those exact artifacts under fresh capacity admission;
6. idempotent artifact discard.

Talos validates the manifest before making it ready. Resume consumes a ready
checkpoint only after the resumed runtime has been admitted successfully.
Checkpoint state and every transition are persisted in
`agent_checkpoints` and `agent_checkpoint_events`.

## Why current runtimes are unsupported

- Docker agent workspaces live inside `--rm` containers and are not durably
  mounted.
- Kubernetes workspaces and agent homes use `emptyDir`.
- Host assistant chat explicitly disables session persistence.
- Connected account homes are credential sources, not writable per-execution
  session stores.
- Claude CLI output exposes no Talos-controlled atomic boundary that combines a
  flushed provider session, workspace snapshot, and external-effect watermark.

Adding `--resume`, retaining a temporary directory, or restarting from the same
prompt would not satisfy this contract.

## API behavior

`GET /api/admin/orchestration` includes the current suspension capability and
checkpoint history.

`POST /api/admin/orchestration/executions/:executionId/suspend` is reserved for
checkpoint-capable providers. Without one it returns `409` and the capability
reason. It never cancels or restarts the execution as a fallback.
