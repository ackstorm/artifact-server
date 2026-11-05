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
unverified, so the page also shows the redirect host. Registrations with no
grant expire after 24 hours and the table is capped at 10,000 rows.

### Refresh reuse grace

The previous refresh token stays usable for 30 seconds so a retry after a lost
response succeeds. Presented later, it revokes the grant.
