#!/usr/bin/env bash
set -euo pipefail

cluster="${TALOS_KIND_CLUSTER:-talos-executor}"
namespace="${TALOS_KIND_NAMESPACE:-talos-executor-test}"

command -v kind >/dev/null || { echo "kind is required" >&2; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 1; }

if ! kind get clusters | rg -x "$cluster" >/dev/null; then
  kind create cluster --name "$cluster" --wait 60s
fi

kubectl --context "kind-$cluster" create namespace "$namespace" \
  --dry-run=client -o yaml | kubectl --context "kind-$cluster" apply -f -
kubectl --context "kind-$cluster" -n "$namespace" create serviceaccount talos-worker \
  --dry-run=client -o yaml | kubectl --context "kind-$cluster" apply -f -

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
export TALOS_KIND_TEST=1
export TALOS_KIND_NAMESPACE="$namespace"
bun test tests/kind/kubernetes-executor.integration.test.ts
