#!/usr/bin/env bash
set -euo pipefail

values="${1:-deploy/argocd/values/eks.yaml}"
chart="deploy/helm/talos"

test -f "$values" || { echo "values file not found: $values" >&2; exit 1; }

if grep -En 'REPLACE_WITH|replace-me|000000000000|talos\.example\.com' "$values"; then
  echo "production values still contain placeholders" >&2
  exit 1
fi

if command -v helm >/dev/null; then
  helm_command=(helm)
elif command -v docker >/dev/null; then
  helm_command=(
    docker run --rm -v "$PWD:/repo" -w /repo
    alpine/helm:3.18.4@sha256:e7ecbf4a200dea73d64bfb8cb0936829164945f2b4d02a0274093073ee8d264f
  )
else
  echo "helm or docker is required" >&2
  exit 1
fi

"${helm_command[@]}" lint "$chart" -f "$values"

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
"${helm_command[@]}" template talos "$chart" -f "$values" --namespace talos > "$rendered"

if grep -Eq '^[[:space:]]*envFrom:' "$rendered"; then
  echo "broad envFrom secret injection is forbidden" >&2
  exit 1
fi
if grep -Eq '^kind:[[:space:]]+Secret$' "$rendered"; then
  echo "Helm output must not contain plaintext Kubernetes Secrets" >&2
  exit 1
fi
if ! grep -q 'key: TALOS_SECRET_KEY' "$rendered"; then
  echo "TALOS_SECRET_KEY is not explicitly sourced from the external Secret" >&2
  exit 1
fi

if command -v kubeconform >/dev/null; then
  kubeconform -strict -summary -kubernetes-version "${KUBERNETES_VERSION:-1.31.0}" "$rendered"
elif command -v docker >/dev/null; then
  docker run --rm -i \
    ghcr.io/yannh/kubeconform:v0.7.0@sha256:85dbef6b4b312b99133decc9c6fc9495e9fc5f92293d4ff3b7e1b30f5611823c \
    -strict -summary -kubernetes-version "${KUBERNETES_VERSION:-1.31.0}" < "$rendered"
else
  echo "kubeconform or docker is required" >&2
  exit 1
fi

echo "Kubernetes release preflight passed for $values"
