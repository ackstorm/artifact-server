#!/usr/bin/env bash
# Publishes vVERSION from an up-to-date main: commits the version bump (when
# needed), pushes an annotated tag, and waits for ackstorm-release.yml, which
# runs the release gate and then publishes the image, the Helm chart and the
# GitHub release.
set -euo pipefail

fail() {
  printf 'release: %s\n' "$1" >&2
  exit 1
}

version="${1:-}"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  fail "usage: make release VERSION=X.Y.Z"
tag="v${version}"

cd "$(git rev-parse --show-toplevel)"
command -v gh >/dev/null || fail "gh is required to watch the release workflow."
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated; run gh auth login."

[[ "$(git branch --show-current)" == main ]] || fail "run from the main branch."
[[ -z "$(git status --porcelain)" ]] || fail "the working tree is not clean."
git fetch --quiet origin main --tags
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] ||
  fail "main is not identical to origin/main; pull or push first."
if git rev-parse --quiet --verify "refs/tags/${tag}" >/dev/null; then
  fail "tag ${tag} already exists."
fi

bash scripts/set-release-version.sh "$version"
node scripts/check-release-version.mjs --tag "$tag"

if [[ -n "$(git status --porcelain)" ]]; then
  git commit --quiet --all --message "chore(release): set the release version to ${version}"
  git push --quiet origin main
  printf 'release: pushed the %s version bump to main\n' "$version"
fi

git tag --annotate "$tag" --message "$tag"
git push --quiet origin "$tag"
printf 'release: pushed %s\n' "$tag"

# The tag push starts the run asynchronously; give GitHub up to 2 minutes to list it.
run_id=""
for _ in $(seq 1 12); do
  run_id="$(gh run list --workflow ackstorm-release.yml --event push --branch "$tag" \
    --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [[ -n "$run_id" ]] && break
  sleep 10
done
[[ -n "$run_id" ]] || fail "no ackstorm-release.yml run appeared for ${tag}; check the Actions tab."

# A run takes minutes after a passed main gate, and up to 70 minutes otherwise.
timeout 5400 gh run watch "$run_id" --exit-status --interval 60 >/dev/null ||
  fail "release run ${run_id} failed or timed out: gh run view ${run_id} --log-failed"
gh release view "$tag" --json url --jq '"release: published " + .url'
