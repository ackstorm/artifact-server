import {createHash, randomUUID} from "node:crypto";

import {Context, Effect, Layer} from "effect";

import {IdentityRepositoryFailure} from "../core/errors.js";
import type {Principal} from "../core/identity.js";
import type {OAuthClient, OAuthRepository} from "../core/oauth.js";
import {
  InstallationAccessService,
  type IdentitySecretProvider,
  type InstallationAccessOperations,
} from "./installation-access.js";

const accessLifetimeMilliseconds = 60 * 60 * 1_000;
const codeLifetimeMilliseconds = 60 * 1_000;
const grantLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1_000;
const refreshReuseGraceMilliseconds = 30 * 1_000;
const unboundClientMilliseconds = 24 * 60 * 60 * 1_000;
const maximumClients = 10_000;
const maximumRedirectUris = 5;
const maximumClientNameLength = 100;
const supportedScopes = new Set(["artifactserver", "offline_access"]);
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
const pkceChallengePattern = /^[A-Za-z0-9_-]{43,128}$/u;

/** RFC 6749 and RFC 7591 error codes this server returns. */
export type OAuthErrorCode =
  | "access_denied"
  | "invalid_client"
  | "invalid_client_metadata"
  | "invalid_grant"
  | "invalid_redirect_uri"
  | "invalid_request"
  | "invalid_scope"
  | "invalid_target"
  | "temporarily_unavailable"
  | "unsupported_response_type";

/** A protocol result. Refusals are answers on the wire, not application failures. */
export type OAuthOutcome<A> =
  | {readonly ok: true; readonly value: A}
  | {
    readonly description: string;
    readonly error: OAuthErrorCode;
    readonly ok: false;
    /** True only once the client and redirect URI are proved safe to redirect to. */
    readonly redirectable: boolean;
  };

export interface OAuthAuthorizationConfiguration {
  readonly allowedRedirectUris: readonly string[];
  readonly applicationOrigin: string;
}

export interface OAuthAuthorizationRequest {
  readonly clientId: string | undefined;
  readonly codeChallenge: string | undefined;
  readonly codeChallengeMethod: string | undefined;
  readonly redirectUri: string | undefined;
  readonly resource: string | undefined;
  readonly responseType: string | undefined;
  readonly scope: string | undefined;
  readonly state: string | undefined;
}

export interface ValidatedAuthorization {
  readonly client: OAuthClient;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly state: string | undefined;
}

export interface OAuthRegistration {
  readonly clientName: string | undefined;
  readonly grantTypes: readonly string[] | undefined;
  readonly redirectUris: readonly string[];
  readonly responseTypes: readonly string[] | undefined;
  readonly tokenEndpointAuthMethod: string | undefined;
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly refreshToken: string;
}

export interface OAuthAuthorizationOperations {
  readonly approve: (
    principal: Principal,
    authorization: ValidatedAuthorization,
  ) => Effect.Effect<string, IdentityRepositoryFailure>;
  readonly exchangeCode: (input: {
    readonly clientId: string | undefined;
    readonly code: string | undefined;
    readonly codeVerifier: string | undefined;
    readonly redirectUri: string | undefined;
  }) => Effect.Effect<OAuthOutcome<OAuthTokens>, IdentityRepositoryFailure>;
  readonly hasLiveGrant: (
    clientId: string,
    memberId: string,
  ) => Effect.Effect<boolean, IdentityRepositoryFailure>;
  readonly refresh: (input: {
    readonly clientId: string | undefined;
    readonly refreshToken: string | undefined;
  }) => Effect.Effect<OAuthOutcome<OAuthTokens>, IdentityRepositoryFailure>;
  readonly register: (
    registration: OAuthRegistration,
  ) => Effect.Effect<OAuthOutcome<OAuthClient>, IdentityRepositoryFailure>;
  /** RFC 7009: revoke the grant behind a refresh token; an unknown token is ignored. */
  readonly revokeToken: (
    token: string | undefined,
  ) => Effect.Effect<void, IdentityRepositoryFailure>;
  readonly validateAuthorization: (
    request: OAuthAuthorizationRequest,
  ) => Effect.Effect<OAuthOutcome<ValidatedAuthorization>, IdentityRepositoryFailure>;
}

export interface OAuthAuthorizationDependencies {
  readonly clock: {readonly now: () => Date};
  readonly configuration: OAuthAuthorizationConfiguration | null;
  readonly repository: OAuthRepository;
  readonly secrets: IdentitySecretProvider;
}

/** Issues OAuth credentials for members, without any knowledge of HTTP. */
export class OAuthAuthorizationService extends Context.Service<
  OAuthAuthorizationService,
  OAuthAuthorizationOperations
>()("artifact-server/application/OAuthAuthorizationService") {
  static readonly layer = (
    dependencies: OAuthAuthorizationDependencies,
  ): Layer.Layer<OAuthAuthorizationService, never, InstallationAccessService> =>
    Layer.effect(
      OAuthAuthorizationService,
      InstallationAccessService.use((access) =>
        Effect.succeed(makeOAuthAuthorizationService(dependencies, access))
      ),
    );
}

function refused<A>(
  error: OAuthErrorCode,
  description: string,
  redirectable = false,
): OAuthOutcome<A> {
  return {description, error, ok: false, redirectable};
}

function repositoryEffect<A>(
  run: () => Promise<A>,
): Effect.Effect<A, IdentityRepositoryFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new IdentityRepositoryFailure({cause, operation: "oauthRepository"}),
  });
}

function isLoopbackRedirect(uri: URL): boolean {
  return uri.protocol === "http:" && loopbackHostnames.has(uri.hostname);
}

function parseUri(value: string): URL | null {
  return URL.canParse(value) ? new URL(value) : null;
}

/** RFC 8252 section 7.3: a loopback redirect may use any port at authorization. */
function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  const left = parseUri(registered);
  const right = parseUri(presented);
  if (left === null || right === null) return false;
  return isLoopbackRedirect(left) && isLoopbackRedirect(right) &&
    left.hostname === right.hostname && left.pathname === right.pathname &&
    left.search === right.search;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function makeOAuthAuthorizationService(
  dependencies: OAuthAuthorizationDependencies,
  access: InstallationAccessOperations,
): OAuthAuthorizationOperations {
  const {clock, repository, secrets} = dependencies;
  const configuration = dependencies.configuration;
  const allowedRedirects = new Set(configuration?.allowedRedirectUris ?? []);
  const resources = configuration === null
    ? new Set<string>()
    : new Set([
      new URL("/mcp", configuration.applicationOrigin).toString(),
      new URL("/api", configuration.applicationOrigin).toString(),
    ]);
  const later = (milliseconds: number): string =>
    new Date(clock.now().getTime() + milliseconds).toISOString();

  const redirectAllowed = (value: string): boolean => {
    const uri = parseUri(value);
    if (uri === null || uri.hash !== "") return false;
    return isLoopbackRedirect(uri) || allowedRedirects.has(value);
  };

  const register: OAuthAuthorizationOperations["register"] = (registration) =>
    Effect.gen(function*() {
      if ((registration.tokenEndpointAuthMethod ?? "none") !== "none") {
        return refused<OAuthClient>(
          "invalid_client_metadata",
          "Only public clients may register.",
        );
      }
      const grantTypes = registration.grantTypes ?? ["authorization_code"];
      if (!grantTypes.includes("authorization_code") ||
        grantTypes.some((grant) =>
          grant !== "authorization_code" && grant !== "refresh_token"
        )) {
        return refused<OAuthClient>(
          "invalid_client_metadata",
          "Only authorization_code and refresh_token grants are supported.",
        );
      }
      if (registration.responseTypes?.some((type) => type !== "code") === true) {
        return refused<OAuthClient>(
          "invalid_client_metadata",
          "Only the code response type is supported.",
        );
      }
      const uris = registration.redirectUris;
      if (uris.length === 0 || uris.length > maximumRedirectUris ||
        !uris.every(redirectAllowed)) {
        return refused<OAuthClient>(
          "invalid_redirect_uri",
          "Redirect URIs must be loopback or on this installation's allowlist.",
        );
      }
      const name = registration.clientName?.trim() ?? "";
      const client: OAuthClient = {
        createdAt: clock.now().toISOString(),
        id: `cli_${randomUUID()}`,
        name: (name === "" ? "Unnamed client" : name)
          .slice(0, maximumClientNameLength),
        redirectUris: uris,
      };
      const stored = yield* repositoryEffect(() =>
        repository.registerClient(
          client,
          new Date(clock.now().getTime() - unboundClientMilliseconds).toISOString(),
          maximumClients,
        )
      );
      return stored
        ? {ok: true, value: client}
        : refused<OAuthClient>(
          "temporarily_unavailable",
          "This installation has too many pending client registrations.",
        );
    });

  const validateAuthorization: OAuthAuthorizationOperations["validateAuthorization"] =
    (request) =>
      Effect.gen(function*() {
        const clientId = request.clientId;
        const client = clientId === undefined
          ? null
          : yield* repositoryEffect(() => repository.findClient(clientId));
        if (client === null) {
          return refused<ValidatedAuthorization>("invalid_client", "Unknown client.");
        }
        const presented = request.redirectUri ??
          (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
        if (
          presented === undefined ||
          !client.redirectUris.some((registered) =>
            redirectMatches(registered, presented)
          )
        ) {
          return refused<ValidatedAuthorization>(
            "invalid_request",
            "The redirect URI does not match this client.",
          );
        }
        // From here on the redirect URI is proved safe to send the browser to.
        if (request.responseType !== "code") {
          return refused<ValidatedAuthorization>(
            "unsupported_response_type",
            "Only the code response type is supported.",
            true,
          );
        }
        if (
          request.codeChallengeMethod !== "S256" ||
          request.codeChallenge === undefined ||
          !pkceChallengePattern.test(request.codeChallenge)
        ) {
          return refused<ValidatedAuthorization>(
            "invalid_request",
            "S256 PKCE is required.",
            true,
          );
        }
        const scopes = (request.scope ?? "").split(/\s+/u).filter((s) => s !== "");
        if (scopes.some((scope) => !supportedScopes.has(scope))) {
          return refused<ValidatedAuthorization>(
            "invalid_scope",
            "An unknown scope was requested.",
            true,
          );
        }
        if (request.resource !== undefined && !resources.has(request.resource)) {
          return refused<ValidatedAuthorization>(
            "invalid_target",
            "This server does not protect that resource.",
            true,
          );
        }
        return {
          ok: true,
          value: {
            client,
            codeChallenge: request.codeChallenge,
            redirectUri: presented,
            state: request.state,
          },
        };
      });

  const approve: OAuthAuthorizationOperations["approve"] = (
    principal,
    authorization,
  ) =>
    Effect.gen(function*() {
      const code = `as_orc_${secrets.issue()}`;
      yield* repositoryEffect(() =>
        repository.createCode({
          clientId: authorization.client.id,
          codeChallenge: authorization.codeChallenge,
          codeDigest: secrets.digest(code),
          createdAt: clock.now().toISOString(),
          expiresAt: later(codeLifetimeMilliseconds),
          memberId: principal.id,
          redirectUri: authorization.redirectUri,
        })
      );
      const redirect = new URL(authorization.redirectUri);
      redirect.searchParams.set("code", code);
      if (authorization.state !== undefined) {
        redirect.searchParams.set("state", authorization.state);
      }
      return redirect.toString();
    });

  const exchangeCode: OAuthAuthorizationOperations["exchangeCode"] = (input) =>
    Effect.gen(function*() {
      const {clientId, code, codeVerifier, redirectUri} = input;
      if (
        clientId === undefined || code === undefined ||
        codeVerifier === undefined || redirectUri === undefined
      ) {
        return refused<OAuthTokens>(
          "invalid_request",
          "client_id, code, code_verifier, and redirect_uri are required.",
        );
      }
      const stored = yield* repositoryEffect(() =>
        repository.consumeCode(secrets.digest(code), clock.now().toISOString())
      );
      if (
        stored === null || stored.clientId !== clientId ||
        stored.redirectUri !== redirectUri ||
        pkceChallenge(codeVerifier) !== stored.codeChallenge
      ) {
        return refused<OAuthTokens>("invalid_grant", "The code is not valid.");
      }
      const client = yield* repositoryEffect(() => repository.findClient(clientId));
      if (client === null) {
        return refused<OAuthTokens>("invalid_grant", "The code is not valid.");
      }
      const prepared = yield* access.prepareOAuthMemberKey({
        clientName: client.name,
        expiresAt: later(accessLifetimeMilliseconds),
        memberId: stored.memberId,
      });
      if (prepared === null) {
        return refused<OAuthTokens>("invalid_grant", "The code is not valid.");
      }
      const {key, token} = prepared;
      const refreshToken = `as_ort_${secrets.issue()}`;
      const now = clock.now().toISOString();
      const connected = yield* repositoryEffect(() =>
        repository.connectGrant({
          apiKeyId: key.id,
          clientId,
          id: `grt_${randomUUID()}`,
          expiresAt: later(grantLifetimeMilliseconds),
          memberId: stored.memberId,
          previousRefreshDigest: null,
          refreshDigest: secrets.digest(refreshToken),
          refreshedAt: now,
        }, key, now)
      );
      if (!connected) {
        return refused<OAuthTokens>("invalid_grant", "The code is not valid.");
      }
      access.evictManagedKeys();
      return {
        ok: true,
        value: {
          accessToken: token,
          expiresInSeconds: accessLifetimeMilliseconds / 1_000,
          refreshToken,
        },
      };
    });

  const refresh: OAuthAuthorizationOperations["refresh"] = (input) =>
    Effect.gen(function*() {
      const {clientId, refreshToken} = input;
      if (clientId === undefined || refreshToken === undefined) {
        return refused<OAuthTokens>(
          "invalid_request",
          "client_id and refresh_token are required.",
        );
      }
      const digest = secrets.digest(refreshToken);
      // A concurrent caller holding the same token loses the rotation once, then
      // finds its token superseded inside the grace and rotates from the new one.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const grant = yield* repositoryEffect(() =>
          repository.findGrantByRefreshDigest(digest)
        );
        const now = clock.now();
        if (
          grant === null || grant.clientId !== clientId ||
          grant.expiresAt <= now.toISOString()
        ) {
          return refused<OAuthTokens>("invalid_grant", "The refresh token is not valid.");
        }
        if (grant.refreshDigest !== digest) {
          const age = now.getTime() - new Date(grant.refreshedAt).getTime();
          if (age > refreshReuseGraceMilliseconds) {
            yield* repositoryEffect(() =>
              repository.revokeConnection(grant.id, grant.memberId, now.toISOString())
            );
            access.evictManagedKeys();
            return refused<OAuthTokens>(
              "invalid_grant",
              "The refresh token is not valid.",
            );
          }
        }
        const {prefix, secretDigest, token} = access.prepareOAuthKeySecret(grant.apiKeyId);
        const nextRefresh = `as_ort_${secrets.issue()}`;
        const rotated = yield* repositoryEffect(() =>
          repository.rotateGrant({
            apiKeyId: grant.apiKeyId,
            expectedRefreshDigest: grant.refreshDigest,
            grantId: grant.id,
            keyExpiresAt: later(accessLifetimeMilliseconds),
            keyPrefix: prefix,
            keySecretDigest: secretDigest,
            memberId: grant.memberId,
            refreshDigest: secrets.digest(nextRefresh),
            refreshedAt: now.toISOString(),
          })
        );
        if (rotated) {
          access.evictManagedKeys();
          return {
            ok: true,
            value: {
              accessToken: token,
              expiresInSeconds: accessLifetimeMilliseconds / 1_000,
              refreshToken: nextRefresh,
            },
          };
        }
      }
      return refused<OAuthTokens>("invalid_grant", "The refresh token is not valid.");
    });

  return OAuthAuthorizationService.of({
    approve,
    exchangeCode,
    hasLiveGrant: (clientId, memberId) =>
      repositoryEffect(() =>
        repository.hasLiveGrant(clientId, memberId, clock.now().toISOString())
      ),
    refresh,
    register,
    revokeToken: (token) =>
      Effect.gen(function*() {
        if (token === undefined) return;
        const grant = yield* repositoryEffect(() =>
          repository.findGrantByRefreshDigest(secrets.digest(token))
        );
        if (grant === null) return;
        yield* repositoryEffect(() =>
          repository.revokeConnection(grant.id, grant.memberId, clock.now().toISOString())
        );
        access.evictManagedKeys();
      }),
    validateAuthorization,
  });
}
