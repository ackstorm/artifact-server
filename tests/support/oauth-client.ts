import {createHash, randomBytes} from "node:crypto";

import {z} from "zod";

import type {ApplicationCookies} from "./browser-session.js";
import {ownOAuthResources} from "../../src/identity/own-oauth-resources.js";
import {reserveLoopbackPort, startTestServer, type RunningTestServer, type TestInstallation} from "./runtime-harness.js";

/** Any server reachable over HTTP, in-process or spawned. */
type OAuthServer = Pick<RunningTestServer, "baseUrl">;

export const oauthRedirectUri = "http://127.0.0.1:43123/callback";

const registrationSchema = z.object({client_id: z.string()});
const tokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  token_type: z.literal("Bearer"),
});

export function oauthPkce(): {readonly challenge: string; readonly verifier: string} {
  const verifier = randomBytes(32).toString("base64url");
  return {
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    verifier,
  };
}

/** Start a server whose origin is known, with its own OAuth routes enabled. */
export async function startOAuthServer(
  installation: TestInstallation,
  allowedRedirectUris: readonly string[] = [],
): Promise<RunningTestServer> {
  const port = await reserveLoopbackPort();
  const applicationOrigin = `http://127.0.0.1:${port}`;
  return startTestServer(installation, {
    ...ownOAuthResources(applicationOrigin, allowedRedirectUris),
    applicationOrigin,
    port,
  });
}

export async function registerOAuthClient(
  server: OAuthServer,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await postRegistration(server, overrides);
  if (response.status !== 201) {
    throw new Error(`Registration failed with ${response.status}.`);
  }
  return registrationSchema.parse(await response.json()).client_id;
}

export function postRegistration(
  server: OAuthServer,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${server.baseUrl}/oauth/register`, {
    body: JSON.stringify({
      client_name: "Test Client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [oauthRedirectUri],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...overrides,
    }),
    headers: {"Content-Type": "application/json"},
    method: "POST",
  });
}

export function authorizationUrl(
  server: OAuthServer,
  clientId: string,
  challenge: string,
  overrides: Record<string, string> = {},
): string {
  const url = new URL("/oauth/authorize", server.baseUrl);
  const parameters = {
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: oauthRedirectUri,
    response_type: "code",
    scope: "artifactserver offline_access",
    state: "state-1",
    ...overrides,
  };
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== "") url.searchParams.set(name, value);
  }
  return url.toString();
}

export function getAuthorization(
  url: string,
  cookies: ApplicationCookies | null,
): Promise<Response> {
  return fetch(url, {
    headers: cookies === null ? {} : {Cookie: cookies.header},
    redirect: "manual",
  });
}

/** Submit the consent page the way a same-origin browser form does. */
export function postConsent(
  server: OAuthServer,
  page: string,
  cookies: ApplicationCookies,
  input: {
    readonly decision?: "approve" | "deny";
    readonly headers?: Record<string, string>;
    readonly origin?: string;
    readonly overrides?: Record<string, string>;
  } = {},
): Promise<Response> {
  const fields = new URLSearchParams();
  for (const match of page.matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)">/gu,
  )) {
    fields.set(match[1] ?? "", match[2]?.replaceAll("&amp;", "&") ?? "");
  }
  fields.set("decision", input.decision ?? "approve");
  for (const [name, value] of Object.entries(input.overrides ?? {})) {
    fields.set(name, value);
  }
  return fetch(`${server.baseUrl}/oauth/authorize`, {
    body: fields,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies.header,
      Origin: input.origin ?? server.baseUrl,
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      ...input.headers,
    },
    method: "POST",
    redirect: "manual",
  });
}

export async function approveOAuthClient(
  server: OAuthServer,
  cookies: ApplicationCookies,
  clientId: string,
  challenge: string,
  origin?: string,
): Promise<string> {
  const page = await getAuthorization(
    authorizationUrl(server, clientId, challenge),
    cookies,
  );
  const response = page.status === 200
    ? await postConsent(
      server,
      await page.text(),
      cookies,
      origin === undefined ? {} : {origin},
    )
    : page;
  const location = response.headers.get("location");
  if (location === null) throw new Error(`No redirect: ${response.status}.`);
  const code = new URL(location).searchParams.get("code");
  if (code === null) throw new Error(`No code in ${new URL(location).search}.`);
  return code;
}

export function postToken(
  server: OAuthServer,
  fields: Record<string, string>,
): Promise<Response> {
  return fetch(`${server.baseUrl}/oauth/token`, {
    body: new URLSearchParams(fields),
    method: "POST",
  });
}

export async function exchangeOAuthCode(
  server: OAuthServer,
  input: {
    readonly clientId: string;
    readonly code: string;
    readonly verifier: string;
  },
): Promise<z.infer<typeof tokenSchema>> {
  const response = await postToken(server, {
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    grant_type: "authorization_code",
    redirect_uri: oauthRedirectUri,
  });
  if (response.status !== 200) throw new Error(`Exchange failed: ${response.status}.`);
  return tokenSchema.parse(await response.json());
}

export async function refreshOAuthToken(
  server: OAuthServer,
  clientId: string,
  refreshToken: string,
): Promise<z.infer<typeof tokenSchema>> {
  const response = await postToken(server, {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (response.status !== 200) throw new Error(`Refresh failed: ${response.status}.`);
  return tokenSchema.parse(await response.json());
}
