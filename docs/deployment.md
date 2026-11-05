# Deploy Artifact Server

Artifact Server supports local, single-server, Kubernetes, and managed-cloud deployments.

## Choose a deployment

| Deployment | Data layer | Detailed guide |
| --- | --- | --- |
| Compact Compose | SQLite and one file volume | [Compose](../packaging/compose/README.md) |
| External-storage Compose | PostgreSQL and S3-compatible storage | [Compose](../packaging/compose/README.md) |
| Kubernetes | PostgreSQL and object storage | [Helm](../packaging/helm/artifact-server/README.md) |

## Configure the shared boundaries

Each remote deployment needs these boundaries:

1. Configure one HTTPS application origin.
2. Configure a separate wildcard content domain.
3. Configure one generic OIDC provider.
4. Admit team members through Artifact Server, or enable OIDC automatic admission.
5. Store service credentials outside source control.
6. Back up the database and artifact files.
7. Pin release deployments to an immutable image digest.

The application origin serves Artifact Server, its API, and its MCP endpoint. The content domain serves untrusted artifact files.

## Select storage

Compact Compose uses one SQLite database and one file volume. Run only one application process with this data layer.

External-storage deployments use PostgreSQL and object storage. These deployments support replaceable application processes and horizontal scaling.

## Configure authentication

Local-owner access works only on an exact loopback origin. Do not use it for remote access.

Remote deployments use a generic OIDC provider. Network access and application authorization remain separate controls.

### Admit members through OIDC browser login

By default, a successful identity-provider login still requires an active Artifact
Server membership. For an issuer that already restricts who may sign in, such as
Dex with a corporate-domain filter, set `ARTIFACT_SERVER_OIDC_AUTO_ADMIT=true` to
admit new browser users as normal members after OIDC token validation succeeds.
The switch accepts exactly `true` or `false` and defaults to `false`.

Leave `ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS` unset or empty to trust the
configured issuer's access restrictions. To restrict new registrations further,
set a comma-separated list such as `example.com,example.org`. Domains are trimmed
and lowercased, then matched against the complete email domain: `example.com`
does not accept `sub.example.com`, `otherexample.com`, or wildcard entries.

The domain list applies only to new automatic registrations. Explicitly admitted
members keep their roles and can sign in outside that list. A deactivated member
cannot regain access by changing the email attached to the same issuer and subject.
The first member still must be the configured bootstrap administrator; automatic
admission does not replace that bootstrap step or grant administrator privileges.
An explicitly unverified email remains denied. Local-owner login and MCP
bearer authentication keep their existing admission rules.

Both policy variables require a complete OIDC configuration, even when automatic
admission is disabled. Invalid switch values or malformed domain lists fail startup.
For Helm, use `identity.oidcAutoAdmit` and `identity.oidcAllowedEmailDomains`.

### Sign in MCP and CLI clients

An installation with OIDC login authorizes its own clients. Point a client at
`<ARTIFACT_SERVER_ORIGIN>/mcp`, or run
`artifactserver auth login <ARTIFACT_SERVER_ORIGIN>`. The client registers itself,
opens a browser, and asks you to approve it. Any provider that supports browser
login works, and the provider needs no extra client.

Each connected client gets an expiring member key, which administrators see and revoke under API keys.

Redirects must be loopback. For a hosted client, set
`ARTIFACT_SERVER_OAUTH_ALLOWED_REDIRECT_URIS` to a comma-separated list of exact
HTTPS URIs, or `identity.oauthAllowedRedirectUris` for Helm.

Access tokens from the configured issuer stay accepted at `/mcp` when they are
JWTs signed with RS256 or ES256 and their `aud` contains exactly
`<ARTIFACT_SERVER_ORIGIN>/mcp`. Clients that cannot open a browser use
administration-issued API keys.

## Back up the installation

Back up metadata and artifact files as one coordinated recovery set. Use the procedure in the selected deployment guide.

Do a restore test before the first production release. Then repeat the test after a storage or deployment change.
