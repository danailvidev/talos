# Loop configuration and Ask Talos

Ask Talos can discover loop handlers, read a loop's complete configuration, create
named loops, update them, delete them, and enable/disable/reschedule them. These
tools use the same SQLite instances and schedule records as the React interface.
Changes take effect without restarting. The assistant acts as the signed-in user;
private visibility, module access and ownership rules still apply.

## Version 1 document

```yaml
version: 1
definitionId: custom-loop
name: Daily repository audit
description: Identify missing tests and summarize findings
visibility: private
prompt: |
  Review the repository for missing regression tests.
  Summarize the most important gaps. Do not change files.
enabled: true
trigger:
  type: cron
  expression: '0 9 * * 1-5'
  timezone: Europe/Sofia
maxItemsPerRun: 10
params:
  repositories:
    - projectId: group/project
      branch: main
  agent:
    provider: claude
  permissions: read-only
```

JSON and YAML describe the same document. `prompt` contains the actual instructions
for `custom-loop`; it maps to the existing `params.prompt` field when executing.
For specialized handlers, it maps to the existing per-instance prompt-template
override (where supported by that handler). Parameters are validated against the
handler's schema. Credentials and ownership are never accepted in the document;
the authenticated creator becomes the owner. A replacement cannot change the
handler or visibility. Use `prompt: null` to inherit a specialized handler's prompt.

## HTTP and assistant interfaces

- `GET /api/tasks/loop-definitions`: available handlers and parameter JSON schemas.
- `POST /api/tasks/loop-config`: create from a JSON or YAML request body.
- `GET /api/tasks/:id/loop-config`: return `{ id, editable, config, yaml }`.
- `PUT /api/tasks/:id/loop-config`: replace the complete configuration.
- Existing task schedule, run, cancel, update and delete endpoints remain supported.

For JSON requests use `Content-Type: application/json`; for YAML use
`Content-Type: application/yaml`. Read the configuration before replacing it so
unrelated fields are preserved. The assistant exposes `talos_loop_definitions`,
`talos_loop_get`, `talos_loop_create`, `talos_loop_update`, `talos_loop_delete` and
`talos_loop_schedule`.

## Storage and migration

Existing loops already live in `task_instances` and `scheduled_task_config`, with
JSON parameters and per-instance prompt overrides. The document is a versioned
view over these records, not a second competing source of truth. Existing loops
are immediately exportable; no destructive database migration or new IDs are
needed. Imported documents create additional instances owned by the importer.

Specialized execution handlers (CI discovery, Jira work, review workers, etc.)
remain TypeScript. Their integration algorithms, deduplication and queue behavior
are executable code, not configuration. Their reusable named instances are
stored in the database. Built-in handler IDs remain available for compatibility:
they can be scheduled but cannot be deleted or have their metadata replaced.
New arbitrary prompt-driven loops require no TypeScript changes.

Deleting a loop retains run history and refuses while it has an active run or
queued/leased child jobs. Disabling a schedule does not cancel work already queued.

Other UI operations are discoverable through `talos_ui_operations` and available
through `talos_ui_read` and `talos_ui_action`. These dispatch directly to the same
authenticated routes as React, resolving the current user's permissions on every
call. The operation catalog is generated from `web/src/api.ts`; regenerate it with
`bun run scripts/generate-assistant-api-catalog.ts` after changing the UI client.
`bun run check` detects a stale catalog. Multipart actions accept fields and base64
files. Binary results return a download path. Authentication, interactive provider
sign-in and streaming subscriptions still require the interface.
