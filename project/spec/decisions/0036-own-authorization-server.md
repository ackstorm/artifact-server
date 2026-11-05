# 0036: Artifact Server authorizes its own clients

**Status:** Accepted
**Date:** November 5, 2026

Amends [0028: MCP OAuth through the configured OIDC issuer](0028-oidc-mcp-oauth.md):
MCP and CLI clients no longer discover the issuer. Issuer access tokens that
already bind `<origin>/mcp` stay accepted at `/mcp`.

## Decision

An installation with OIDC login is the OAuth 2.1 authorization server for
`<origin>/mcp` and `<origin>/api`. The configured issuer only logs people in.

Most providers cannot serve MCP clients directly. Dex offers no dynamic client
registration, sets `aud` to the client ID, and carries `at_hash` in its access
tokens. Cognito and Entra have comparable gaps. An installation still owes each
person their own identity, so the server closes the gap itself.

## What it does

- `POST /oauth/register` registers public clients (RFC 7591).
- `GET /oauth/authorize` needs a browser session and sends anyone without one
  through `/auth/login`.
- A consent page names the client and its redirect host. A client that already
  holds a grant for this member skips it.
- `POST /oauth/token` exchanges the code with S256 PKCE, and refreshes.

## Recorded decisions

### A token is a managed member key

The access token is an `as_key_` key bound to the member, so token checks,
revocation and member deactivation need nothing new. Refresh replaces the key's
secret in place, so one client stays one row. A signed JWT would add key
rotation for no gain, because the same server issues and verifies it.

### One token for both resources

`/mcp` and `/api` share one origin, one member and one credential check. A
token requested for either works on both, and `resource` is validated against
those two values.

### Written by hand

The specification names Better Auth as a candidate, but its MCP path is beta
and it would add a second authentication stack. MCP-014 is closed as not
applicable.

### Open registration

Anyone may register a client, so consent is mandatory for a new client and
redirects are limited to loopback or an operator allowlist. The client name is
unverified, so the page also shows the redirect host.

Registered clients stay, so a persisted MCP client keeps its `client_id`. The
table is capped at 10,000 rows. At the cap, the oldest client with no live grant
is evicted with its dead grants, their keys, and its codes, and registration
answers 503 only when every client holds a live grant. A client whose
`client_id` was evicted must register again.

### Refresh reuse grace

The previous refresh token stays usable for 30 seconds so a retry after a lost
response succeeds. Presented later, it revokes the grant.

Two callers racing with one current token both succeed. The loser re-reads the
grant, finds its token superseded inside the grace, and rotates from the new
one. A key has one secret, so only the last access token issued works; the other
caller's refresh token stays usable for the grace.

### Grant lifetime

A grant ends 30 days after its creation and refresh does not extend it. Past
that, refresh returns `invalid_grant` and the client goes back through
`/oauth/authorize`.

### Revocation

`/oauth/revoke` acts on refresh tokens only. An access token is a managed key,
which administrators revoke under API keys.

### OAuth key capabilities

An OAuth key manages projects only when its member is an administrator,
matching the browser. Every OAuth key carries `artifact:manage:any`, so a plain member's key can delete other people's
comments on that member's own artifacts, which their browser session cannot.
This is accepted: the member owns the artifact, and the client acts for them.
