#!/bin/sh
set -eu

case "${PROJECT:-}" in
  ""|/*|*..*) echo "refusing to cache project path '${PROJECT:-}'" >&2; exit 2 ;;
esac

GITLAB_TOKEN=""
if [ -f /run/talos-secrets/gitlab-token ]; then
  GITLAB_TOKEN="$(cat /run/talos-secrets/gitlab-token)"
  rm -f /run/talos-secrets/gitlab-token
fi

auth_url="https://oauth2:${GITLAB_TOKEN}@gitlab.com/${PROJECT}.git"
cache_dir="/cache/git/${PROJECT}.git"
mkdir -p "$(dirname "$cache_dir")"

# One refresh per project at a time; agent containers read without the lock, so
# a fetch only ever adds packs and moves refs, which a concurrent clone tolerates.
exec 9>"$cache_dir.lock"
flock -w 600 9

if [ ! -f "$cache_dir/HEAD" ]; then
  rm -rf "$cache_dir"
  git init --bare --quiet "$cache_dir"
  git -C "$cache_dir" config gc.auto 0
fi

refspecs="+refs/heads/$BRANCH:refs/heads/$BRANCH"
if [ -n "${TARGET:-}" ] && [ "$TARGET" != "$BRANCH" ]; then
  refspecs="$refspecs +refs/heads/$TARGET:refs/heads/$TARGET"
fi
git -C "$cache_dir" fetch --quiet --no-tags --no-write-fetch-head "$auth_url" $refspecs

# Every fetch adds a pack. Consolidated occasionally, under the lock; a clone
# racing the repack fails and falls back to the network rather than corrupting.
packs=$(find "$cache_dir/objects/pack" -name '*.pack' | wc -l)
if [ "$packs" -gt 50 ]; then
  git -C "$cache_dir" repack -a -d -q
fi
