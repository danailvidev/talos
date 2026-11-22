# Talos EKS production runbook

This runbook is intentionally fail-closed. Do not enable Argo CD sync until all
placeholders in `deploy/argocd/values/eks.yaml` have been replaced and the
preflight checks pass.

## 1. Required platform inputs

- An EKS cluster with EBS CSI, AWS Load Balancer Controller, External Secrets,
  Argo CD, and a NetworkPolicy-capable CNI.
- Three immutable ECR repositories and digest references for the control plane,
  agent worker, and E2E worker.
- Separate IRSA roles:
  - control plane: Kubernetes access comes from RBAC; AWS access is limited to
    the artifact operations the API performs;
  - worker: write-only artifact access to the configured S3 prefix.
- An encrypted S3 artifact bucket with public access blocked, TLS-only policy,
  versioning, and lifecycle expiry.
- Private network routes from worker pods to Git hosting, package registries,
  STS/S3, and the QA portal.
- An internal hostname and ACM certificate unless a separately reviewed public
  exposure is approved.

Run `ansible-playbook deploy/ansible/playbook.yml -i <inventory>` only after the
inventory points at the intended account, cluster, roles, secret store, and
bucket.

## 2. Secret inventory

Store values in the external secret provider, never in Git, Helm values, Ansible
inventory, shell history, or CI variables without masking/protection.

Required:

- `TALOS_SECRET_KEY`: restore the exact key used to encrypt the migrated
  database. Back it up separately from the database.

Strongly recommended recovery access:

- `TALOS_ADMIN_PASSWORD`: a unique high-entropy recovery password.

Required by features in use:

- `GITLAB_TOKEN`: required by E2E checkout even when personal GitLab
  credentials were migrated. Feedback uses only the submitting developer's
  api-scoped PAT from My provider access.
- Slack app, LLM, Jira, Datadog, and LogRocket credentials listed in
  `config/example.env` when those integrations are enabled.

The Helm chart injects only approved key names. Missing optional keys do not
block startup. `TALOS_SECRET_KEY` is deliberately non-optional.

Never rotate `TALOS_SECRET_KEY` independently. The application has no online
re-encryption path; a mismatched key makes stored credentials unreadable. For
an offline rotation, stop Talos, create mode-`0600` files containing the old and
new keys, and run:

```bash
TALOS_OLD_SECRET_KEY_FILE=/secure/old-key \
TALOS_NEW_SECRET_KEY_FILE=/secure/new-key \
bun run scripts/rotate-secret-key.ts data/talos.db data/talos.db.pre-key-rotation
```

Verify the rotated copy before replacing the key in the external provider.
Securely remove the old-key file only after login and credential checks pass.

The repository's historical secret scan must pass before production. If it
finds an old environment backup, revoke every provider credential found there,
rotate the database encryption key with the offline tool, remove the file from
Git history using an approved history-rewrite procedure, and have every clone
rebase or reclone. Deleting the file in a new commit is not remediation.

## 3. Build, scan, attest, and publish

Authenticate Docker to ECR and configure CI's OIDC identity, then run:

```bash
REGISTRY_PREFIX=<account>.dkr.ecr.<region>.amazonaws.com \
IMAGE_TAG="$(git rev-parse HEAD)" \
bash scripts/publish-images.sh
```

The script publishes SBOM and provenance attestations. CI must have `trivy` and
`cosign`; treat either warning as a release blocker. Copy the resulting
`repository@sha256:...` references into `deploy/argocd/values/eks.yaml`, commit
them, and run:

```bash
bash scripts/verify-kubernetes-release.sh deploy/argocd/values/eks.yaml
```

## 4. Migrate existing state

The migration includes the SQLite database, agent account homes, and any local
evidence under `data/`. It explicitly excludes `config/.env`.

1. Stop every local Talos process and container. Confirm ports 4317 and 4318 are
   no longer listening.
2. Create a consistent archive only after shutdown:

   ```bash
   archive="talos-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"
   tar -C data -czf "$archive" .
   sha256sum "$archive" > "$archive.sha256"
   ```

3. Encrypt the archive for the receiving operator or upload it to a restricted,
   short-lived, KMS-encrypted S3 location. Do not put it in the artifact bucket,
   repository, ticket, or chat.
4. Set `controlPlane.replicaCount: 0` in the committed environment values and
   sync Argo CD. Confirm the PVC is Bound and no Talos pod is running.
5. Copy `deploy/restore-pod.example.yaml` outside the repository, replace the
   image placeholder with the exact control-plane digest, verify the PVC claim
   name, and apply it. The manifest runs as UID/GID `10001`, uses
   `fsGroup: 10001`, drops all capabilities, and mounts no Service Account
   token.
6. Copy the archive to the restore pod, verify its checksum inside the pod, and
   extract it as UID 10001:

   ```bash
   kubectl -n talos cp "$archive" talos-restore:/var/lib/talos/restore.tgz
   kubectl -n talos exec talos-restore -- \
     tar -xzf /var/lib/talos/restore.tgz -C /var/lib/talos
   kubectl -n talos exec talos-restore -- \
     rm -f /var/lib/talos/restore.tgz
   ```

7. Delete the restore pod and the temporary encrypted transfer object.
8. Confirm the ExternalSecret is Ready and its generated Secret contains the
   required key names. Never print or decode the values.
9. Set `controlPlane.replicaCount: 1`, commit, and sync.

## 5. NetworkPolicy rollout

Keep `networkPolicies.enabled: false` until the following CIDRs are known:

- ALB/VPC ingress CIDRs;
- private Kubernetes API endpoint CIDRs;
- control-plane egress for Kubernetes, provider APIs, STS, and S3;
- worker egress for Git, package registries, STS/S3, and QA.

Standard Kubernetes NetworkPolicy cannot safely express provider FQDNs. Use
private VPC endpoints and stable CIDRs, or a CNI with reviewed FQDN policy.
Enabling the chart policy with an empty list fails template rendering instead of
silently causing an outage.

## 6. Backup and restore

- Enroll the EBS volume in AWS Backup with scheduled snapshots, retention, and
  cross-account or cross-region copy as required.
- Back up `TALOS_SECRET_KEY` in a separate recovery system with dual control.
- Preserve S3 versioning and lifecycle expiry.
- Quarterly, restore a snapshot and a copy of the key into an isolated
  namespace/account, then verify login and credential decryption.

PVC retention protects only against an accidental Helm deletion; it is not a
backup.

## 7. Go/no-go verification

Before production cutover:

- Helm lint, schema validation, secret-history scan, tests, and image scans pass.
- No placeholder account IDs, hosts, buckets, role ARNs, or image digests remain.
- Images are digest-pinned, scanned, attested, and signed.
- `kubectl auth can-i` confirms the control-plane ServiceAccount can only create,
  get, and delete the resources declared by the chart; the worker cannot access
  Kubernetes APIs.
- EBS is encrypted and a restore has been tested.
- `/healthz` and `/readyz` pass through the intended private route.
- Login works, migrated credentials decrypt, and SQLite persists across pod
  replacement.
- One coding Job and one E2E Job complete; no input Secret or completed Job
  remains; E2E evidence arrives in S3.
- Cancellation removes the Job and input Secret.
- Argo CD rollback to the prior digest has been rehearsed.

No-go on any missing secret key, unreadable credential, writable-volume failure,
unrestricted public ingress, unscanned image, failed backup restore, or missing
QA network route.
