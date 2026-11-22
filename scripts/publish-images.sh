#!/usr/bin/env bash
set -euo pipefail

# Build and publish immutable, attested images. Authentication to the registry
# and (for keyless signing) an OIDC identity must already be configured by CI.
: "${REGISTRY_PREFIX:?set REGISTRY_PREFIX, for example 123456789012.dkr.ecr.us-east-1.amazonaws.com}"
: "${IMAGE_TAG:?set IMAGE_TAG to an immutable source revision such as CI_COMMIT_SHA}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v trivy >/dev/null || { echo "trivy is required" >&2; exit 1; }
command -v cosign >/dev/null || { echo "cosign is required" >&2; exit 1; }
docker buildx version >/dev/null

platforms="${PLATFORMS:-linux/amd64}"
declare -a images=(
  "talos-control-plane:."
  "talos-agent-worker:images/agent/v15"
  "talos-e2e-worker:images/e2e/v11"
)
declare -a immutable=()

for item in "${images[@]}"; do
  name="${item%%:*}"
  context="${item#*:}"
  tagged="${REGISTRY_PREFIX}/${name}:${IMAGE_TAG}"
  docker buildx build \
    --platform "$platforms" \
    --build-arg "BUILD_REVISION=${IMAGE_TAG}" \
    --build-arg "BUILD_SOURCE=${CI_PROJECT_URL:-https://gitlab.com/example-org/tools/talos}" \
    --provenance=mode=max \
    --sbom=true \
    --push \
    --tag "$tagged" \
    "$context"
  digest="$(docker buildx imagetools inspect "$tagged" --format '{{.Manifest.Digest}}')"
  immutable+=("${REGISTRY_PREFIX}/${name}@${digest}")
done

for image in "${immutable[@]}"; do
  trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$image"
done

for image in "${immutable[@]}"; do
  cosign sign --yes "$image"
done

printf '%s\n' "${immutable[@]}"
