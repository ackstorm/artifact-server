#!/usr/bin/env bash
# Prints verified=true when the tagged commit needs no gate of its own: main's
# full gate passed on that commit, or on its parent and the commit is exactly
# the version bump of that parent. Prints verified=false otherwise, including
# when the gate is still running or an API call fails, so the release runs the
# full gate. Needs GITHUB_SHA, GITHUB_REF_NAME, GITHUB_REPOSITORY and GH_TOKEN,
# and a checkout that holds the parent commit.
set -uo pipefail

full_gate_passed() {
  local commit="$1" runs run jobs
  runs="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs?head_sha=${commit}&event=push&branch=main" \
    --jq '.workflow_runs[] | select(.path == ".github/workflows/ci.yml") | .id')" || return 1
  for run in $runs; do
    jobs="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run}/jobs" \
      --jq '.jobs[] | select(.name == "Full / Linux iteration gate" and .conclusion == "success") | .id')" || return 1
    [[ -n "$jobs" ]] && return 0
  done
  return 1
}

is_version_bump_of() {
  local parent="$1" bump status
  bump="$(mktemp)"
  cp scripts/set-release-version.sh "$bump"
  git checkout --quiet "$parent" || return 1
  bash "$bump" "${GITHUB_REF_NAME#v}" || return 1
  git diff --quiet "$GITHUB_SHA"
  status=$?
  rm -f -- "$bump"
  return "$status"
}

parent="$(git rev-parse --quiet --verify "${GITHUB_SHA}^")"
if full_gate_passed "$GITHUB_SHA"; then
  echo "verified=true"
elif [[ -n "$parent" ]] && full_gate_passed "$parent" && is_version_bump_of "$parent"; then
  echo "verified=true"
else
  echo "verified=false"
fi
