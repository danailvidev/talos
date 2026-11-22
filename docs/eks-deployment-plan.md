# Deploy Talos to EKS

## Decisions

- Target an existing Amazon EKS cluster.
- Keep the Talos API, scheduler, queue, and SQLite database in one control-plane pod.
- Preserve Docker-based execution for local development.
- Run agent and E2E workloads as Kubernetes Jobs in EKS.
- Package the application with Helm, deploy it through Argo CD, and use Ansible for cluster and environment prerequisites. Use ECR for images and S3 for E2E artifacts and oversized execution payloads.

## Architecture

- Use `replicas: 1`, an EBS `ReadWriteOnce` PVC, and the `Recreate` deployment strategy. The daemon lease in [`src/server.ts`](src/server.ts) prevents multiple control-plane instances from sharing the SQLite database.
- Add a runtime-selected executor: `docker` locally and `kubernetes` on EKS. Existing task call sites continue using `runAgentJob` and `runE2eAgent`.
- Publish three immutable ECR images: control plane, agent worker, and E2E worker.
- Keep interactive chat in the control-plane pod initially and include its required CLI/runtime. Moving chat to Jobs is outside this deployment.
- Horizontal control-plane scaling remains out of scope until SQLite and in-process scheduling are replaced or split.

## Application readiness

- Add unauthenticated `/healthz` and `/readyz` endpoints in [`src/api/serve.ts`](src/api/serve.ts). Readiness should require an open database, an active daemon lease, and a non-shutdown state.
- Add executor configuration and lifecycle wiring in [`src/server.ts`](src/server.ts) and [`src/app.ts`](src/app.ts): executor mode, namespace, ECR image references, Job TTL, resource limits, cancellation, and shutdown cleanup.
- Set `HOST=0.0.0.0` in the deployment.
- Preserve a stable `TALOS_SECRET_KEY`; losing it makes encrypted stored credentials unreadable.
- Mark session cookies `Secure` behind HTTPS and test proxy/origin behavior for OAuth callbacks and webhooks.

## Hybrid job execution

- Introduce a shared execution contract under [`src/infrastructure/agent/`](src/infrastructure/agent/) covering inputs, secrets, image, resources, timeout, logs, result, cancellation, and cleanup.
- Move current Docker spawning from [`src/infrastructure/agent/run.ts`](src/infrastructure/agent/run.ts) and [`src/infrastructure/e2e/run.ts`](src/infrastructure/e2e/run.ts) into Docker executor implementations without changing local behavior.
- Add a Kubernetes executor using the kubeconfig/in-cluster authentication foundation in [`src/connectors/kubernetes/client.ts`](src/connectors/kubernetes/client.ts).
- For each execution, create a Job and short-lived Secret, wait for its pod, stream logs through the existing NDJSON parser, enforce `activeDeadlineSeconds`, delete it on cancellation, and clean up all resources.
- Keep credentials in per-execution Secrets rather than Job arguments.
- Give worker Jobs a restricted ServiceAccount with no general Kubernetes API access. Give the control-plane ServiceAccount namespace-scoped permissions for Jobs, Pods/logs, Secrets, and ConfigMaps.
- Retain existing process-level concurrency limits and add namespace ResourceQuota and LimitRange controls.

## E2E artifacts and networking

- Refactor [`src/infrastructure/e2e/artifacts.ts`](src/infrastructure/e2e/artifacts.ts) into a storage interface with filesystem and S3 implementations.
- Continue using bind-mounted artifact directories with local Docker.
- Upload EKS E2E screenshots, traces, and logs to S3 through IRSA, with retention and size limits.
- Replace Docker host networking with normal pod networking.
- Ensure EKS VPC and DNS connectivity to the QA environment through the organization’s VPN, Transit Gateway, or Direct Connect. `hostNetwork` alone cannot provide access to a VPN running on a developer machine.

## Images and delivery

- Add a multi-stage control-plane Dockerfile that installs locked Bun dependencies, builds `web/dist`, runs as non-root, exposes port 4317, and writes state only under the mounted data path.
- Extract embedded agent and E2E image definitions and entrypoints from [`src/infrastructure/agent/image.ts`](src/infrastructure/agent/image.ts) and [`src/infrastructure/e2e/image.ts`](src/infrastructure/e2e/image.ts) into versioned build contexts.
- Keep local Docker image builds available. Kubernetes mode must only reference CI-published ECR digests.
- Add a GitLab CI/CD pipeline to run `bun run check`, build and scan all images, push immutable commit-SHA tags to ECR, and commit the published image digests to Git.
- Authenticate GitLab CI/CD to AWS through GitLab-issued OIDC ID tokens rather than static access keys. Limit that role to image publishing.
- Let Argo CD deploy the committed Helm release to EKS. GitLab CI does not apply Kubernetes manifests or hold cluster credentials.

## Helm, Argo CD, and Ansible

- Add `deploy/helm/talos` with:
  - Control-plane Deployment and Service.
  - ALB Ingress and TLS configuration.
  - EBS-backed PVC.
  - `workflows.yaml` ConfigMap.
  - Existing Secret references.
  - Control-plane and worker ServiceAccounts.
  - Namespace-scoped executor RBAC.
  - Worker namespace, ResourceQuota, LimitRange, and optional NetworkPolicies.
- Add an Argo CD Application that tracks the chart and environment-specific values, deploys only committed image digests, and rolls back by syncing a reverted Git revision.
- Use Ansible to prepare the target environment: namespace, ServiceAccounts and IRSA bindings, secret or External Secrets material, ResourceQuota, LimitRange, and registration of the Argo CD Application. Keep application rollout in Argo CD.
- Require these existing cluster capabilities:
  - EBS CSI driver.
  - AWS Load Balancer Controller.
  - IRSA.
  - Metrics and log shipping.
- Require ECR repositories, an S3 artifact bucket, ACM certificate and DNS, a GitLab OIDC role restricted to image publishing, and separate IRSA roles for the running application. Argo CD uses its existing cluster access.
- Configure `workflows.yaml` with an absolute database path under the PVC.
- Consume secrets from an existing Kubernetes Secret or External Secrets integration. Do not put plaintext credentials in Helm values.
- Preserve release-verifier permissions from [`config/kubernetes-release-verifier-rbac.yaml`](config/kubernetes-release-verifier-rbac.yaml) separately from worker-executor RBAC.

## Verification

- Unit-test executor selection, Job manifests, secret redaction, log streaming, success, failure, timeout, cancellation, health/readiness, and both artifact stores.
- Add a kind integration test that loads local worker images and exercises Kubernetes Job completion and cancellation.
- Keep the existing test suite exercising the local Docker path.
- On EKS, verify:
  - HTTPS, authentication, OAuth callbacks, and webhooks.
  - SQLite persistence after pod replacement.
  - One agent task and one E2E task.
  - E2E artifact retrieval.
  - Cancellation and Job cleanup.
  - Upgrade and rollback through an Argo CD sync of the intended Git revision.

## Operations

- Define resource requests and limits for the control plane and both worker types.
- Add consistent SQLite backup and restore procedures, EBS snapshots before upgrades, and a restore drill.
- Configure S3 lifecycle and retention rules.
- Alert on control-plane crash loops, Pending/failed Jobs, PVC pressure, and repeated readiness failures.
- Set `terminationGracePeriodSeconds` high enough for worker cancellation and the existing shutdown drain.

## Implementation order

1. Add probes, production container packaging, secure proxy behavior, and persistent single-replica runtime configuration.
2. Define the executor interface and move existing behavior into Docker executors.
3. Extract worker image build contexts and publish all images to ECR.
4. Implement Kubernetes Job execution, logs, secrets, cancellation, cleanup, and RBAC.
5. Add filesystem/S3 artifact backends and EKS-compatible E2E evidence transfer.
6. Create the Helm chart, Argo CD Application, and Ansible prerequisite playbook.
7. After the repository is migrated, add GitLab CI/CD image publishing with GitLab OIDC federation to AWS. Argo CD performs the EKS rollout from Git.
8. Add unit and kind tests, run EKS smoke tests, and document backup, restore, upgrade, monitoring, and network prerequisites.
