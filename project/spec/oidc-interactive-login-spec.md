# Generic OIDC browser login

**Status:** Accepted; implemented — AUTH-019, AUTH-020, and AUTH-021 behavior-verified on the local deployment, and the real-IdP round trip proven by the `test:oidc` Keycloak suite, now part of `verify:iteration` (August 18, 2026)
**Date:** August 18, 2026
**Owner:** Artifact Server product engineering
**Companion documents:** [Product specification](./artifact-server-product-spec.html), [Conformance ledger](./conformance.yml)

## 1. What this adds and why

Browser login for a private-team installation goes through one generic OpenID Connect implementation of the `InteractiveIdentityProvider` port (`src/identity/oidc-identity-provider.ts`). A team that runs its own OpenID Connect provider (Okta, Microsoft Entra, Google Workspace, Keycloak) points Artifact Server at it directly.

The port is provider-neutral; sessions, CSRF, admission, members, API keys, and the deployment token do not depend on the provider. OIDC only answers "who is this person"; explicit member admission remains the default. [OIDC automatic browser admission](./oidc-auto-admission-spec.md) adds an optional issuer-scoped registration policy.

## 2. Goal and non-goals

| In scope | Out of scope, and why |
| --- | --- |
| Browser login (`/auth/login` → provider → `/auth/callback`) through any spec-compliant OIDC provider on every private-team deployment. | **MCP OAuth through this login provider.** MCP OAuth is specified in [ADR 0028](./decisions/0028-oidc-mcp-oauth.md); managed API keys work everywhere. |
| One `ARTIFACT_SERVER_OIDC_*` variable family with all-or-nothing validation. | **Multiple providers.** One installation has one browser-login provider. |
| A nonce on login attempts, stored on the attempt row. | **Directory sync, role mapping, SCIM, JIT provisioning beyond the existing bootstrap-administrator rule.** Admission stays explicit. |
| RP-initiated logout is **deferred** (decision 2). | **Refresh tokens / offline_access.** Artifact Server sessions are server-side with their own lifetime; the id_token is used once at login. |

API keys, the deployment token, local browser login (`/auth/local`), and content sessions are unaffected.

The original provisioning exclusion above is extended only by the optional
[OIDC automatic browser-admission policy](./oidc-auto-admission-spec.md).
Directory sync, SCIM, and role/group mapping remain outside its scope.

## 3. Configuration

Variables use the `ARTIFACT_SERVER_` prefix and the repository secret conventions (`loadOptionalCredential` supports `<NAME>` xor `<NAME>_FILE`, `src/lifecycle/runtime-configuration.ts:554-595`):

| Variable | Required | Rule |
| --- | --- | --- |
| `ARTIFACT_SERVER_OIDC_ISSUER` | yes | `https://` origin-or-path URL, trailing slashes stripped, query/hash refused. Plain `http://` allowed only for `localhost`, `127.0.0.1`, `::1` (development). |
| `ARTIFACT_SERVER_OIDC_CLIENT_ID` | yes | Non-empty string. |
| `ARTIFACT_SERVER_OIDC_CLIENT_SECRET` / `…_FILE` | no | Optional: a public client using PKCE alone is valid. When set, sent as `client_secret` in the token-request form body (`client_secret_post`). |
| `ARTIFACT_SERVER_OIDC_SCOPES` | no | Default `"openid email profile"`. |
| `ARTIFACT_SERVER_ORIGIN` | yes (shared) | Required for browser login; the redirect URI is exactly `<origin>/auth/callback`. |
| `ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL` | yes (shared) | Required for browser login; names the first administrator. |

Rules, enforced at startup by an all-or-nothing loader (`src/cli/oidc-configuration.ts`):

1. **Partial configuration fails startup** with a message naming every required variable.
2. **One browser-login provider.** Presence of the `ARTIFACT_SERVER_OIDC_*` family selects OIDC; there is no mode variable.
3. **No provider configured** keeps the provider-neutral application-layer behavior: `InteractiveLoginService` is constructed with `provider: null` and `/auth/login` answers `InteractiveLoginUnavailable` (`src/application/interactive-login.ts:105-106`). [The access-mode specification](./local-owner-and-private-team-access-spec.md) supersedes the old process-startup behavior for private-team entry points: they require one provider and do not enable `/auth/local` or the installation bearer.
4. There is **no cookie-secret variable**: Artifact Server sessions are server-side records with digested tokens, so no stateless-cookie secret exists to manage.
5. `interactiveIdentityProvider` in runtime inspection is `"local"` or `"oidc"`.

## 4. The provider implementation

One new class, `OidcIdentityProvider` (`src/identity/oidc-identity-provider.ts`), implementing the port:

```
InteractiveIdentityProvider
  name: "oidc"                     // the login_attempts discriminator
  start(): { authorizationUrl, codeVerifier, state, nonce }
  complete(code, codeVerifier, nonce): ExternalIdentity
```

Flow:

- **Discovery** is lazy at first login and cached per process: `GET <issuer>/.well-known/openid-configuration`, `issuer` echo must normalize to the configured issuer, `authorization_endpoint` / `token_endpoint` / `jwks_uri` required and validated as `https://` URLs with no credentials or fragment (local `http` only for local issuers). Discovery failure produces one operator-actionable log line naming the issuer and cause — and surfaces to the browser as the existing generic `IdentityProviderFailure`.
- **Authorization redirect**: `response_type=code`, `client_id`, `redirect_uri=<origin>/auth/callback`, `scope`, `state` (256-bit random, digested into the attempt row exactly as today), `nonce` (128-bit random), `code_challenge` = S256(codeVerifier), `code_challenge_method=S256`. The service, not the provider, keeps owning attempt persistence: `start()` mints the values, `InteractiveLoginService.start` stores `{stateDigest, codeVerifier, nonce, provider: "oidc", returnTo, expiresAt}` (`interactive-login.ts:103-118`).
- **Token exchange**: form-encoded `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`, plus `client_secret` when configured. Response must contain an `id_token`.
- **id_token verification** with `jose` (already a dependency, `package.json:84`): signature against a cached `createRemoteJWKSet(discovery.jwks_uri)`, `issuer` = discovery issuer, `audience` = client id, `exp`/`nbf` with a fixed 30-second `clockTolerance` (self-hosted IdPs drift), and the `nonce` claim strictly equal to the attempt's stored nonce.
- **Claim mapping** to the existing `ExternalIdentity`:
  - `subject` = `sub` (required, non-empty).
  - `email` = `email` claim (required, non-empty; login fails without it — scope must include `email`).
  - `emailVerified` = the `email_verified` claim; **absent means `true`** (the operator configured this issuer as the trust anchor, and requiring the claim would break IdPs that omit it — Entra, some Keycloak realms — out of the box). An **explicit `email_verified: false`** maps to `false`, and the existing admission gate then refuses the login (`installation-access.ts:401-404`) — that is the IdP itself flagging the address, and honoring it costs nothing. This is the industry-standard posture (decided by the owner, August 18, 2026): trust the configured IdP, no extra configuration, refuse only what the IdP explicitly disavows. No `ASSUME_EMAIL_VERIFIED` variable exists.
  - `displayName` = `name`, else `given_name` + `family_name`, else the email.
  - `provider` = **`"oidc:" + normalized issuer`** (e.g. `oidc:https://idp.example.com`). This is the durable half of the `(provider, subject)` member binding (`bindExternalIdentity`, `installation-access.ts`), and `sub` values are only unique per issuer, so the issuer belongs in the binding. Note the split: the *port's* `name` stays the constant `"oidc"` (it discriminates login-attempt rows), while the *identity's* `provider` is issuer-qualified (it discriminates people). If a deployment later changes issuer, existing `(provider, subject)` bindings stop matching by design; login then falls through to the active-member **email match**, which re-binds the member to the new issuer identity (`resolveExternalMember` always writes the binding after resolution, `installation-access.ts:442-448`) — so an issuer migration self-heals through verified email, and no data migration is needed.

**Nonce storage.** `InteractiveAuthorization` and `LoginAttempt` carry `nonce`, and `complete()` takes it; the `login_attempts` table has a nullable `nonce` column in the SQLite and Postgres identity repositories. Rejected alternative: deriving the nonce from a hash of the stored `codeVerifier` avoids the column but is nonstandard cleverness; the column is boring and auditable.

## 5. Security requirements

- Redirect URI is exactly `<ARTIFACT_SERVER_ORIGIN>/auth/callback`; nothing caller-supplied ever reaches it. `returnTo` keeps the existing same-origin sanitizer, which validates the path **after** WHATWG normalization as well as before it: `/..//host` normalizes to the scheme-relative pathname `//host`, and a normalized path whose second character is `/` falls back to `/api/v1/session`.
- State is single-use and expiring (existing `consume` semantics, digest-matched); nonce is single-use by riding the attempt row; the code is single-use at the IdP and bound to the PKCE verifier.
- The callback is bound to the browser that started the login. `/auth/login` sets a short-lived `HttpOnly`, `SameSite=Lax` handshake cookie (`artifact_login`, `__Host-artifact_login` on HTTPS origins) carrying the raw `state`; `/auth/callback` refuses with `LoginAttemptRejected` unless the cookie matches the `state` query parameter under a constant-time comparison, before the attempt is consumed and before the provider is called. Without it, anyone could mint a state, authenticate as themselves, and drive a victim's top-level navigation to `/auth/callback` — planting the attacker's session in the victim's browser (RFC 6749 §10.12, OIDC Core §15.5.2). The cookie is cleared on completion.
- Discovery and token requests never follow redirects (`redirect: "manual"`; a 3xx is a provider failure) and carry a five-second budget, so no redirect can replay the client secret, authorization code, and PKCE verifier to an unvalidated host, and a stalled issuer cannot pin `/auth/callback` requests open.
- `login_attempts` rows created by the unauthenticated `/auth/login` are bounded: every insert first deletes the attempts that have passed `expires_at` in both identity repositories.
- No id_token is accepted from any issuer other than the configured one; the JWKS is fetched only from the discovered `jwks_uri` under the issuer's validated origin rules; `alg` is whatever the JWKS key advertises via jose's verification (no `alg: none`, jose refuses it structurally).
- HTTPS-only endpoints except explicit local-development hosts (section 3 rule).
- Logged: provider name, issuer, and cause on discovery/exchange failure. Never logged: authorization codes, tokens, verifiers, client secret, id_token contents, email addresses at failure paths (match the existing generic `IdentityProviderFailure` message discipline).
- Admission remains last: by default, a verified OIDC identity that is not an admitted active member (or the bootstrap administrator on first contact, `installation-access.ts:417-440`) is refused with `IdentityAdmissionDenied`. The optional [automatic-admission policy](./oidc-auto-admission-spec.md) can admit an eligible new browser user as a normal member after the same validation.

## 6. Deployment surface

The provider uses only `fetch` and `jose`. Single-server, Kubernetes, Compose, and external-storage private-team deployments can use it. Direct local-owner mode deliberately refuses an external browser provider.

| Deployment | Change |
| --- | --- |
| Private-team CLI / single server / compose / Helm | `loadOidcConfiguration` reads the provider variables; private-team entry points require a complete OIDC configuration (none or partial is a startup error). Direct `artifactserver start` stays local-owner mode and refuses a provider. Compose and Helm document and validate the same provider variables. |

Docs: `.env.example`, `packaging/compose/README.md`, Helm chart values and README, product spec sharing/login prose.

## 7. Conformance

Module `authorization`, three new requirements in the existing ledger style (source: this file; statuses start `specified`, empty evidence):

| ID | Kind | Behavior (short) | -B acceptance | -F acceptance |
| --- | --- | --- | --- | --- |
| AUTH-019 | behavior | A deployment configured with a generic OIDC issuer completes browser login through discovery, auth-code with PKCE and nonce, id_token verification, and normal admission, on every deployment kind. | Sign in against a real stub OIDC provider; an admitted member gets a session, the bootstrap administrator is admitted on first contact, display name and issuer-qualified binding are recorded, and a second login reuses the binding. | With automatic admission disabled, an unadmitted verified identity, an unverified email, and a missing email are refused without creating members or sessions. |
| AUTH-020 | security | The OIDC callback fails closed on every token-validation defect. | Valid logins succeed under a 30-second clock skew. | Wrong signature, wrong issuer, wrong audience, expired token, replayed or unknown state, expired attempt, and wrong nonce are each refused; no session or member is created; codes and tokens never appear in logs. |
| AUTH-021 | constraint | OIDC configuration is all-or-nothing, and issuer/endpoint URLs obey the HTTPS rules. | A complete OIDC configuration boots and reports `interactiveIdentityProvider: "oidc"`; an application layer without a provider keeps login unavailable while keys still work. | Partial OIDC configuration, a non-HTTPS non-local issuer, and discovery documents with a mismatched issuer or credentialed/fragmented endpoint URLs each fail startup or login without weakening the running server. |

**Test plan** (repo rules: no module mocks, real boundaries): a stub OIDC provider in `tests/support/stub-oidc-provider.ts` — a real in-process HTTP server that serves `/.well-known/openid-configuration`, a JWKS for a freshly generated ES256 key, an authorize endpoint that redirects with `code` and echoes `state`, and a token endpoint that signs real id_tokens with configurable claims (`nonce`, `aud`, `iss`, `exp`, `email_verified`). Conformance tests drive the real HTTP app: `GET /auth/login` → follow the redirect to the stub → callback → assert session cookie, member records, and the failure matrix. Local `http://127.0.0.1` issuers are legitimate under the section-3 rule, so the stub needs no TLS.

## 8. Decisions recorded (owner, August 18, 2026)

1. **`email_verified`:** absent means verified; only an explicit `email_verified: false` refuses the login. No escape-hatch variable. Rationale: this is an open-source self-host path — it must work out of the box with every mainstream IdP, with no extra configuration and no invented guardrails. Section 4 carries the behavior.
2. **Logout stays local:** signing out revokes the Artifact Server session only — the normal behavior for SSO-connected applications. RP-initiated IdP logout (`end_session_endpoint`) is a small later addition if a customer's security team asks for it; discovery already fetches the document that advertises it.
