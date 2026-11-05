import type {Context, Hono, MiddlewareHandler} from "hono";
import type {Effect} from "effect";
import {z} from "zod";

import {
  OAuthAuthorizationService,
  type OAuthAuthorizationRequest,
  type OAuthOutcome,
  type ValidatedAuthorization,
} from "../application/oauth-authorization.js";
import type {ApplicationServices} from "../application/application-runtime.js";
import type {Principal} from "../core/identity.js";
import type {HttpEnvironment} from "./create-http-app.js";

const registrationBodySchema = z.object({
  client_name: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  redirect_uris: z.array(z.string()).default([]),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

interface ConsentSession {
  readonly csrfDigest: string;
  readonly principal: Principal;
}

export interface OAuthRouteHelpers {
  readonly csrfCookie: (context: Context<HttpEnvironment>) => string | undefined;
  readonly requireConsentSecurity: (
    context: Context<HttpEnvironment>,
    csrfDigest: string,
    csrfToken: string | undefined,
  ) => void;
  readonly run: <A, E>(
    context: Context<HttpEnvironment>,
    effect: Effect.Effect<A, E, ApplicationServices>,
  ) => Promise<A>;
  readonly session: (
    context: Context<HttpEnvironment>,
  ) => Promise<ConsentSession | null>;
  readonly textBody: MiddlewareHandler<HttpEnvironment>;
}

/** A form with a file or repeated field is read as empty, so it is refused. */
const formSchema = z.record(z.string(), z.string()).catch({});

function field(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function authorizationRequest(
  source: Readonly<Record<string, string>>,
): OAuthAuthorizationRequest {
  return {
    clientId: field(source["client_id"]),
    codeChallenge: field(source["code_challenge"]),
    codeChallengeMethod: field(source["code_challenge_method"]),
    redirectUri: field(source["redirect_uri"]),
    resource: field(source["resource"]),
    responseType: field(source["response_type"]),
    scope: field(source["scope"]),
    state: field(source["state"]),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function refusalPage(context: Context<HttpEnvironment>, description: string): Response {
  context.header("Cache-Control", "no-store");
  return context.text(`Authorization failed: ${description}`, 400);
}

/** Send a refusal back to a client whose redirect URI is proved. */
function redirectError(
  context: Context<HttpEnvironment>,
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
): Response {
  const location = new URL(redirectUri);
  location.searchParams.set("error", error);
  location.searchParams.set("error_description", description);
  if (state !== undefined) location.searchParams.set("state", state);
  context.header("Cache-Control", "no-store");
  return context.redirect(location.toString(), 302);
}

function consentPage(
  context: Context<HttpEnvironment>,
  authorization: ValidatedAuthorization,
  request: OAuthAuthorizationRequest,
  csrfToken: string,
): Response {
  const client = escapeHtml(authorization.client.name);
  const host = escapeHtml(new URL(authorization.redirectUri).host);
  const hidden: readonly (readonly [string, string | undefined])[] = [
    ["client_id", request.clientId],
    ["code_challenge", request.codeChallenge],
    ["code_challenge_method", request.codeChallengeMethod],
    ["csrf_token", csrfToken],
    ["redirect_uri", authorization.redirectUri],
    ["resource", request.resource],
    ["response_type", request.responseType],
    ["scope", request.scope],
    ["state", request.state],
  ];
  const inputs = hidden
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .map(([name, value]) =>
      `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
    )
    .join("");
  context.header("Cache-Control", "private, no-store");
  // No form-action directive: browsers apply it to the redirect after the POST,
  // which would block the client's loopback callback.
  context.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );
  // no-referrer would turn this form's Origin header into "null" and fail the origin check.
  context.header("Referrer-Policy", "same-origin");
  return context.html([
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Connect a client</title>",
    "<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:Canvas;color:CanvasText;color-scheme:light dark}",
    "main{max-width:480px;margin:0 auto;display:grid;gap:16px}h1{font-size:24px;margin:0}p{margin:0}",
    "form{display:flex;gap:8px}button{font:inherit;padding:8px 16px}</style></head>",
    "<body><main>",
    `<h1>Connect ${client}?</h1>`,
    `<p>${client} will act as you on this Artifact Server. It sends you back to <strong>${host}</strong>.</p>`,
    "<p>The name comes from the client itself. Approve only if you just started this sign-in.</p>",
    `<form method="post" action="/oauth/authorize">${inputs}`,
    '<button type="submit" name="decision" value="approve">Approve</button>',
    '<button type="submit" name="decision" value="deny">Deny</button>',
    "</form></main></body></html>",
  ].join(""));
}

/** The OAuth 2.1 protocol surface. Product rules live in OAuthAuthorizationService. */
export function registerOAuthRoutes(
  app: Hono<HttpEnvironment>,
  helpers: OAuthRouteHelpers,
): void {
  const validate = (
    context: Context<HttpEnvironment>,
    request: OAuthAuthorizationRequest,
  ): Promise<OAuthOutcome<ValidatedAuthorization>> =>
    helpers.run(
      context,
      OAuthAuthorizationService.use((oauth) => oauth.validateAuthorization(request)),
    );

  const refuse = (
    context: Context<HttpEnvironment>,
    request: OAuthAuthorizationRequest,
    outcome: Extract<OAuthOutcome<ValidatedAuthorization>, {readonly ok: false}>,
  ): Response => {
    const redirectUri = request.redirectUri;
    return outcome.redirectable && redirectUri !== undefined
      ? redirectError(context, redirectUri, outcome.error, outcome.description, request.state)
      : refusalPage(context, outcome.description);
  };

  app.post("/oauth/register", helpers.textBody, async (context) => {
    const parsed = registrationBodySchema.safeParse(
      await context.req.json().catch(() => null),
    );
    context.header("Cache-Control", "no-store");
    if (!parsed.success) {
      return context.json({error: "invalid_client_metadata"}, 400);
    }
    const body = parsed.data;
    const outcome = await helpers.run(
      context,
      OAuthAuthorizationService.use((oauth) =>
        oauth.register({
          clientName: body.client_name,
          grantTypes: body.grant_types,
          redirectUris: body.redirect_uris,
          responseTypes: body.response_types,
          tokenEndpointAuthMethod: body.token_endpoint_auth_method,
        })
      ),
    );
    if (!outcome.ok) {
      return context.json(
        {error: outcome.error, error_description: outcome.description},
        outcome.error === "temporarily_unavailable" ? 503 : 400,
      );
    }
    return context.json({
      client_id: outcome.value.id,
      client_id_issued_at: Math.floor(
        new Date(outcome.value.createdAt).getTime() / 1_000,
      ),
      client_name: outcome.value.name,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: outcome.value.redirectUris,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201);
  });

  app.get("/oauth/authorize", async (context) => {
    const request = authorizationRequest(context.req.query());
    const outcome = await validate(context, request);
    if (!outcome.ok) return refuse(context, request, outcome);
    const session = await helpers.session(context);
    if (session === null) {
      const url = new URL(context.req.url);
      const returnTo = `${url.pathname}${url.search}`;
      context.header("Cache-Control", "no-store");
      return context.redirect(
        `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
        302,
      );
    }
    const authorization = outcome.value;
    const connected = await helpers.run(
      context,
      OAuthAuthorizationService.use((oauth) =>
        oauth.hasLiveGrant(authorization.client.id, session.principal.id)
      ),
    );
    if (connected) {
      const location = await helpers.run(
        context,
        OAuthAuthorizationService.use((oauth) =>
          oauth.approve(session.principal, authorization)
        ),
      );
      context.header("Cache-Control", "no-store");
      return context.redirect(location, 302);
    }
    const csrfToken = helpers.csrfCookie(context);
    if (csrfToken === undefined) {
      return refusalPage(context, "Sign in again and retry.");
    }
    return consentPage(context, authorization, request, csrfToken);
  });

  app.post("/oauth/authorize", helpers.textBody, async (context) => {
    const session = await helpers.session(context);
    if (session === null) return refusalPage(context, "Sign in again and retry.");
    const form = formSchema.parse(await context.req.parseBody());
    helpers.requireConsentSecurity(
      context,
      session.csrfDigest,
      field(form["csrf_token"]),
    );
    const request = authorizationRequest(form);
    const outcome = await validate(context, request);
    if (!outcome.ok) return refuse(context, request, outcome);
    const authorization = outcome.value;
    if (form["decision"] !== "approve") {
      return redirectError(
        context,
        authorization.redirectUri,
        "access_denied",
        "The member denied this client.",
        authorization.state,
      );
    }
    const location = await helpers.run(
      context,
      OAuthAuthorizationService.use((oauth) =>
        oauth.approve(session.principal, authorization)
      ),
    );
    context.header("Cache-Control", "no-store");
    return context.redirect(location, 303);
  });

  app.post("/oauth/token", helpers.textBody, async (context) => {
    const form = formSchema.parse(await context.req.parseBody());
    context.header("Cache-Control", "no-store");
    const grantType = field(form["grant_type"]);
    const clientId = field(form["client_id"]);
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return context.json({error: "unsupported_grant_type"}, 400);
    }
    const outcome = await helpers.run(
      context,
      OAuthAuthorizationService.use((oauth) =>
        grantType === "authorization_code"
          ? oauth.exchangeCode({
            clientId,
            code: field(form["code"]),
            codeVerifier: field(form["code_verifier"]),
            redirectUri: field(form["redirect_uri"]),
          })
          : oauth.refresh({
            clientId,
            refreshToken: field(form["refresh_token"]),
          })
      ),
    );
    if (!outcome.ok) {
      return context.json(
        {error: outcome.error, error_description: outcome.description},
        400,
      );
    }
    return context.json({
      access_token: outcome.value.accessToken,
      expires_in: outcome.value.expiresInSeconds,
      refresh_token: outcome.value.refreshToken,
      scope: "artifactserver offline_access",
      token_type: "Bearer",
    });
  });

  app.post("/oauth/revoke", helpers.textBody, async (context) => {
    const form = formSchema.parse(await context.req.parseBody());
    await helpers.run(
      context,
      OAuthAuthorizationService.use((oauth) => oauth.revokeToken(field(form["token"]))),
    );
    context.header("Cache-Control", "no-store");
    return context.body(null, 200);
  });
}
