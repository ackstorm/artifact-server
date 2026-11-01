# 0034: Artifact Server ships for local, Compose, and Kubernetes only

**Status:** Accepted
**Date:** November 1, 2026

Amends [ADR 0017](./0017-native-cloud-projects-and-storage-provider-boundary.md):
its object-storage provider boundary stands, and its native cloud projects are
out of the product. Replaces ADR 0022 and ADR 0026 (Git history) and ADR 0027
(public site). Those records are deleted from the tree and remain in Git
history.

## Decision

- **Supported deployments.** The local command-line server with SQLite, Compact
  Compose, External-storage Compose, the Helm chart for any supported Kubernetes
  cluster (AKS included), and the one OCI image they share. The conformance
  ledger names three deployments: `local`, `single_server`, and `kubernetes`.
- **Storage.** Postgres plus the S3-compatible, native Google Cloud Storage, and
  preview Azure Blob adapters, unchanged.
- **Login.** Generic OIDC is the only browser-login provider for a private team.
  Local-owner access is unchanged.
- **Out of the product.**
  - the Cloudflare Workers/D1/R2 deployment
  - the Pulumi AWS and GCP projects and their qualification scripts, and the
    shared cloud deployment contract
  - the Astro public site
  - WorkOS login and hosted MCP authorization
  - the Cloudflare Artifacts Git-history mirror, with its CLI, HTTP, MCP, and
    Settings surfaces and its database tables
  - the upstream release and install-verification workflows
  - links to artifactserver.com
- **Releases.** `ackstorm-release.yml` publishes the image and Helm chart from a
  `vX.Y.Z` tag. Nothing publishes the Node package or the npm adapters.
- **No backward compatibility.** Compatibility shims and dated records are
  removed rather than kept beside the code.

## Why

- The installation is operated only on Kubernetes through the Helm chart.
- The repository will not sync with its upstream again, so each extra
  deployment target is maintained here alone. The Cloudflare target is a second
  server implementation with its own database adapter and test suite.
- Cloudflare Artifacts was the only Git-history provider, so the mirror has no
  provider without the Cloudflare account it was built for.
- WorkOS was configured only for the hosted Cloudflare service; OIDC covers
  every remaining deployment, including MCP OAuth (ADR 0028).

## Consequences

- **Schema.** Postgres migration 0016 drops the six `git_history_*` tables;
  migrations 0001–0015 are unchanged and apply forward. SQLite schema 17 drops
  the same tables when a file opens. Mirror metadata is deleted; artifacts,
  versions, and bytes are untouched.
- **Upgrade window.** Migration 0016 runs in the pre-upgrade migration Job,
  before the rolling update replaces old pods. Until it does, old pods return
  errors on publish and delete; retrying with the same idempotency key is safe.
  Take a Postgres backup before upgrading.
- **API.** `capabilities.gitHistory` disappears from `/api/v1/session` and
  `artifact_capabilities`; the `/api/v1/projects/:projectId/git-history` routes
  answer 404; the `project_git_history_status`, `project_git_history_estimate`,
  `project_set_git_history`, and `artifact_history_clone_token` MCP tools and the
  `artifactserver history` command no longer exist.
- **Configuration.** The server reads no `ARTIFACT_SERVER_WORKOS_*`,
  `ARTIFACT_SERVER_GIT_HISTORY_*`, or `ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_*`
  variable. A team server without OIDC configuration refuses to start. The Helm values
  `identity.workosClientId`, `identity.workosIssuer`, and
  `secret.keys.workosApiKey` are gone, and the values schema rejects them.
- **Ledger.** Requirements that applied only to Cloudflare, AWS, or GCP, the
  hosted-service policy that applied only to Cloudflare, and every GIT
  requirement are deleted. DEP-014, OPS-004, and OPS-005 return to
  `implementing` because their only behavior evidence came from removed
  deployments.
