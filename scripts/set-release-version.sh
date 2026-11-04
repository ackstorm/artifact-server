#!/usr/bin/env bash
# Sets every versioned file under the current directory to the given version.
# scripts/check-release-gate.sh replays it, so it must stay deterministic.
set -euo pipefail

version="$1"
current="$(node -p 'require("./package.json").version')"
[[ "$current" != "$version" ]] || exit 0

old="${current//./\\.}"
sed -i "s/\"version\": \"${old}\"/\"version\": \"${version}\"/" \
  package.json integrations/*/package.json
sed -i "s/\"${old}\"/\"${version}\"/" \
  integrations/claude-channel/index.ts \
  src/mcp/artifact-mcp-server.ts \
  packaging/helm/artifact-server/values.yaml \
  packaging/helm/artifact-server/Chart.yaml
sed -i "s/^version: ${old}$/version: ${version}/" \
  packaging/helm/artifact-server/Chart.yaml
sed -i "s/--version ${old}/--version ${version}/" \
  packaging/helm/artifact-server/README.md
