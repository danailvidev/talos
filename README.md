# Talos

Self-hosted web application for scheduled automation across GitLab, Jira,
Azure DevOps, Slack, Datadog, and LogRocket, with optional LLM reasoning.

Talos is currently supported through its web UI and JSON API only. The
former Talos command-line interface has been removed.

## Requirements

- [Bun](https://bun.sh) 1.3+
- Docker for tasks that run coding agents

## Local development

```bash
bun install
cp config/workflows.example.yaml config/workflows.yaml
cp config/example.env config/.env
bun run dev
```

Open <http://127.0.0.1:4317>. Vite serves the UI with hot reload and proxies
API requests to the Bun server on port 4318.

Public registration is disabled. For a fresh install, set a strong
`TALOS_ADMIN_PASSWORD` in `config/.env`, sign in as `admin@talos.local`, and
create named user accounts under Administration → Users. The optional
`operator@talos.local` recovery account is disabled unless
`TALOS_OPERATOR_PASSWORD` is also configured.

Integration credentials and task settings can be managed from Settings in the
web UI. Values in `config/.env` provide boot-time defaults; values saved through
Settings override them.

## Production

Build the UI, then start the web server:

```bash
bun run build
bun run start
```

The server listens on `http://127.0.0.1:4317` and serves both the built SPA and
the API. Runtime configuration is available through environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address to bind |
| `PORT` | `4317` | HTTP port |
| `TALOS_CONFIG` | `config/workflows.yaml` | Bootstrap config path |
| `TALOS_ENV_FILE` | `config/.env` | Secrets file path |
| `TALOS_UI_DIR` | `web/dist` | Built UI directory |
| `TALOS_JOBS` | `4` | Concurrent queued jobs |
| `TALOS_AGENT_CAPACITY` | legacy-derived | Total agent budget; defaults to background plus interactive settings below |
| `TALOS_AGENT_JOBS` | `2` | Legacy background capacity, used to derive total when `TALOS_AGENT_CAPACITY` is unset |
| `TALOS_AGENT_INTERACTIVE_JOBS` | `1` | Slots within the total reserved from background work for interactive chat |
| `TALOS_AGENT_CACHE` | `1` | `0` disables the shared repository and package caches |
| `TALOS_AGENT_MEMORY` | `2g` | Memory limit per agent container |
| `TALOS_AGENT_CPUS` | `1` | CPU limit per agent container |
| `TALOS_AGENT_PIDS` | `256` | Process limit per agent container |
| `TALOS_E2E_JOBS` | `1` | Concurrent QA E2E jobs |
| `TALOS_E2E_MEMORY` | `4g` | Memory limit per QA E2E container |
| `TALOS_E2E_CPUS` | `2` | CPU limit per QA E2E container |
| `TALOS_E2E_PIDS` | `1024` | Process limit per QA E2E container |
| `TALOS_E2E_SHM` | `1g` | Shared memory available to Chromium |
| `TALOS_RETENTION_DAYS` | unset | Finished-history retention |
| `TALOS_LOG_RETENTION_DAYS` | retention value | Raw-log retention |
| `TALOS_RETENTION_BATCH_SIZE` | `250` | Rows removed per retention pass |

The app uses SQLite and permits only one running server for a database. Put a
reverse proxy in front of the server when exposing it outside the host.

## Ticket E2E tests

The ticket Actions menu can run an AI-driven Playwright check for a linked
GitLab merge request. The isolated container checks out the MR source commit,
then fetches exactly two additional inputs from the GitLab project in
`TALOS_E2E_SETTINGS_PROJECT` (default `example-org/qa/test-automation`, ref
`main`) using the acting developer's GitLab token:

- the mandatory exploratory testing instructions at
  `.claude/agents/qa-exploratory-tester.md`; and
- `core/src/main/resources/default.conf`, which supplies the mandatory main QA
  portal URL and principal login, plus any optional portal URLs or fixture
  logins.

The agent follows the Markdown instructions, opens the URL extracted from
`default.conf`, tests the Jira issue in Playwright, captures screenshots and
publishes a pass/fail/inconclusive result in ticket Activity. A run fails when
either mandatory file cannot be read.

Only configured URL fields and fixture-login placeholders are copied into the
agent workspace. Credential values are written to Playwright MCP's transient
secrets file and represented to Claude only by placeholder names such as
`QA_STUDENT_USERNAME` and `QA_STUDENT_PASSWORD`; the raw configuration never
reaches the prompt, artifacts, or run details. `webSettings.baseUrl` is the only
mandatory URL property. The main portal's `userSettings.principalEmail` and
`userSettings.principalPass` are also required while authentication cannot be
bypassed. Student and parent logins are optional, but each configured
username/email must have its matching password.

Screenshots and diagnostics are stored beside the SQLite database under
`e2e-artifacts/` and follow run retention.

The Talos host must be connected to the corporate VPN before an E2E run starts.
The browser container uses Docker's default bridge network. Some VPN clients
block bridge forwarding; set `TALOS_E2E_NETWORK=host` to share the host's VPN
routes and split DNS instead. A URL preflight fails the job immediately with an
actionable VPN message when the configured portal is unreachable.

## Kubernetes release verification

Every release can be verified against the cluster rather than inferred from
Argo CD or a load-balancer response. The Releases page polls a read-only status
endpoint using:

- the pod's ServiceAccount when Talos runs in Kubernetes; or
- `KUBECONFIG`, then the Talos process user's `~/.kube/config`, when Talos runs
  outside Kubernetes.

Host kubeconfigs with exec authentication are supported, including EKS
credentials obtained with `aws eks get-token`. The `aws` executable and its
profile, environment, and credential files must be available to the OS user
running Talos. Talos talks to the Kubernetes API directly; it does not invoke
`kubectl` or `jq`.

The convention is:

- an environment folder maps to the lowercase Kubernetes namespace;
- a manifest service name maps to both its Deployment and container name;
- `image` (or the service name when omitted) plus `version` is the expected
  container image;
- release version tags are immutable.

For in-cluster access, apply the `ClusterRole` in
`config/kubernetes-release-verifier-rbac.yaml` once, then apply a copy of its
`RoleBinding` in every release namespace after setting the Talos
ServiceAccount name and namespace. Do not use a `ClusterRoleBinding`: namespace
RoleBindings keep access limited to environments Talos is allowed to inspect.
For host kubeconfig access, grant that kubeconfig identity equivalent `get` and
`list` access. The verifier only reads Deployments, ReplicaSets, and Pods.

A release is shown as released only after Kubernetes has observed the current
Deployment generation, all desired replicas are updated, ready, and available,
and every active pod reports the expected image and the same runtime digest.
Until then it moves from `pending` (Deployment still references the previous
image) to `progressing` (the expected image is rolling out).
Kubernetes API failures remain visible as unavailable and are never treated as
successful releases. This live status is independent from the existing
production post-deploy watch: it adds no jobs, state transitions, or database
records.

## EKS deployment

Production deployment assets live under `deploy/`:

- `deploy/helm/talos` owns Talos application resources, executor RBAC, the EBS
  PVC, quotas, and optional network policies.
- `deploy/argocd` defines the Git-tracked Argo CD Application.
- `deploy/ansible` bootstraps AWS/EKS prerequisites and registers that
  Application. It does not apply the Talos Deployment directly.

Follow [`deploy/PRODUCTION-RUNBOOK.md`](deploy/PRODUCTION-RUNBOOK.md) for image
attestation, External Secrets, state migration, NetworkPolicy rollout, backup,
restore, and the production go/no-go checklist.

Build the three images with `make images`. EKS values must use immutable
`@sha256:` ECR references. Configure `TALOS_EXECUTOR=kubernetes`,
`TALOS_PUBLIC_URL=https://...`, the worker image digests, and the S3 artifact
bucket. The worker ServiceAccount has no Kubernetes API token; only the control
plane can create and inspect Jobs and their short-lived input Secrets.

Keep `TALOS_SECRET_KEY` in the existing Secret/External Secret and back it up
with the SQLite database. Losing it makes stored credentials unreadable. The
chart deliberately uses one `Recreate` replica and an EBS `ReadWriteOnce` PVC.
Take an EBS snapshot before upgrades and periodically test restore into an
isolated namespace.

Argo CD performs rollouts from Git. Upgrade by committing new image digests;
roll back by reverting that Git revision and syncing the Application. Configure
S3 lifecycle expiry as a second guard behind application retention. Alert on
control-plane restarts/readiness failures, Pending or failed worker Jobs, and
PVC pressure.

The EKS VPC must have DNS and routing to the QA environment through the
organization VPN, Transit Gateway, or Direct Connect. Docker's local
`TALOS_E2E_NETWORK=host` option is not applicable to pods.

After deployment, verify `/healthz` and `/readyz`, HTTPS login and callbacks,
SQLite persistence after pod replacement, one agent Job, one E2E Job and its S3
evidence, cancellation cleanup, then an Argo CD rollback. GitLab CI image
publishing and OIDC digest-update automation are intentionally deferred until
the repository migration.

## Quality checks

```bash
bun run check
```

Individual commands are available for backend tests and typechecking:

```bash
bun test
bun run typecheck
bun run ui:typecheck
bun run ui:build
```

With `kind` and `kubectl` installed, run the opt-in Kubernetes executor test:

```bash
scripts/test-kind-executor.sh
```

## Project layout

```text
src/api/             HTTP API, webhooks, and static UI server
src/application/     Application services
src/connectors/      GitLab, Jira, Slack, and observability clients
src/core/            Task execution, scheduling, and worker pool
src/infrastructure/  Coding-agent runtime
src/persistence/     SQLite repositories and migrations
src/tasks/           Built-in automation tasks
shared/              API contracts shared with the browser
web/                 React web application
tests/               Backend tests
```
