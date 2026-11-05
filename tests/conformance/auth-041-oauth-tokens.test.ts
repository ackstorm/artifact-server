import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {admitMember, MutableClock, signInAdministrator} from "../support/agent-dispatch.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {ownOAuthResources} from "../../src/identity/own-oauth-resources.js";
import {browserMutationHeaders, type ApplicationCookies} from "../support/browser-session.js";
import {
  approveOAuthClient,
  authorizationUrl,
  exchangeOAuthCode,
  getAuthorization,
  oauthPkce,
  oauthRedirectUri,
  postRegistration,
  postToken,
  refreshOAuthToken,
  registerOAuthClient,
  startOAuthServer,
} from "../support/oauth-client.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  type RunningStubOidcProvider,
  signInWithStubOidc,
  startStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const dayMilliseconds = 24 * 60 * 60 * 1_000;
const keysSchema = z.object({
  apiKeys: z.array(z.object({id: z.string(), name: z.string(), revokedAt: z.string().nullable()})),
});

async function connectClient(
  server: RunningTestServer,
  cookies: ApplicationCookies,
): Promise<Awaited<ReturnType<typeof exchangeOAuthCode>> & {readonly clientId: string}> {
  const clientId = await registerOAuthClient(server);
  const {challenge, verifier} = oauthPkce();
  const code = await approveOAuthClient(server, cookies, clientId, challenge);
  return {clientId, ...await exchangeOAuthCode(server, {clientId, code, verifier})};
}

describe("OAuth tokens", () => {
  let cookies: ApplicationCookies;
  let installation: TestInstallation;
  let server: RunningTestServer;

  const connect = async (): Promise<{
    readonly accessToken: string;
    readonly clientId: string;
    readonly refreshToken: string;
  }> => {
    const tokens = await connectClient(server, cookies);
    return {
      accessToken: tokens.access_token,
      clientId: tokens.clientId,
      refreshToken: tokens.refresh_token,
    };
  };

  const apiStatus = async (token: string): Promise<number> =>
    (await fetch(`${server.baseUrl}/api/v1/projects`, {
      headers: {Authorization: `Bearer ${token}`},
    })).status;

  const listKeys = async () => keysSchema.parse(await (await fetch(
    `${server.baseUrl}/api/v1/api-keys`,
    {headers: {Cookie: cookies.header}},
  )).json()).apiKeys;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startOAuthServer(installation);
    cookies = await signInAdministrator(server, installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-041-B: a code becomes an expiring member key usable at /api and /mcp", async () => {
    const {accessToken} = await connect();
    expect(accessToken).toMatch(/^as_key_/u);
    expect(await apiStatus(accessToken)).toBe(200);
    const mcp = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: {name: "test", version: "1"},
          protocolVersion: "2025-03-26",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(mcp.status).toBe(200);
  });

  test("refresh replaces the secret and keeps one key row", async () => {
    const first = await connect();
    const before = (await listKeys()).length;
    const next = await refreshOAuthToken(server, first.clientId, first.refreshToken);
    expect(next.access_token).not.toBe(first.accessToken);
    expect(await apiStatus(next.access_token)).toBe(200);
    expect(await apiStatus(first.accessToken)).toBe(401);
    expect((await listKeys()).length).toBe(before);
  });

  test("a retry inside the grace succeeds after a lost response", async () => {
    const first = await connect();
    await refreshOAuthToken(server, first.clientId, first.refreshToken);
    const retried = await refreshOAuthToken(server, first.clientId, first.refreshToken);
    expect(await apiStatus(retried.access_token)).toBe(200);
  });

  test("parallel refreshes of one token both answer with tokens that keep working", async () => {
    const first = await connect();
    const before = (await listKeys()).length;
    const [left, right] = await Promise.all([
      refreshOAuthToken(server, first.clientId, first.refreshToken),
      refreshOAuthToken(server, first.clientId, first.refreshToken),
    ]);
    const leftWorks = await apiStatus(left.access_token) === 200;
    expect(await apiStatus(right.access_token)).toBe(leftWorks ? 401 : 200);
    expect((await listKeys()).length).toBe(before);
    const superseded = leftWorks ? right : left;
    const recovered = await refreshOAuthToken(
      server,
      first.clientId,
      superseded.refresh_token,
    );
    expect(await apiStatus(recovered.access_token)).toBe(200);
  });

  test("AUTH-041-F: a code works once, and only with its verifier, client, and redirect", async () => {
    const clientId = await registerOAuthClient(server);
    const otherClient = await registerOAuthClient(server);
    const {challenge, verifier} = oauthPkce();
    const code = await approveOAuthClient(server, cookies, clientId, challenge);
    const base = {
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: oauthRedirectUri,
    };
    expect((await postToken(server, {...base, code_verifier: "wrong"})).status).toBe(400);

    const second = await approveOAuthClient(server, cookies, clientId, challenge);
    expect((await postToken(server, {...base, client_id: otherClient, code: second})).status)
      .toBe(400);

    const third = await approveOAuthClient(server, cookies, clientId, challenge);
    expect((await postToken(server, {
      ...base,
      code: third,
      redirect_uri: "http://127.0.0.1:1/other",
    })).status).toBe(400);

    const fourth = await approveOAuthClient(server, cookies, clientId, challenge);
    expect((await postToken(server, {...base, code: fourth})).status).toBe(200);
    expect((await postToken(server, {...base, code: fourth})).status).toBe(400);
  });

  test("a revoked key cannot refresh", async () => {
    const first = await connect();
    const key = (await listKeys()).find((candidate) => candidate.revokedAt === null
      && candidate.name.endsWith(" via Test Client"));
    const revoked = await fetch(`${server.baseUrl}/api/v1/api-keys/${key?.id}/revoke`, {
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(revoked.status).toBe(200);
    expect(await apiStatus(first.accessToken)).toBe(401);
    const response = await postToken(server, {
      client_id: first.clientId,
      grant_type: "refresh_token",
      refresh_token: first.refreshToken,
    });
    expect(response.status).toBe(400);
  });
});

describe("OAuth for team members", () => {
  const clientSecret = "stub-oidc-client-secret-with-entropy";
  let administrator: ApplicationCookies;
  let ada: ApplicationCookies;
  let adaId: string;
  let installation: TestInstallation;
  let oidc: RunningStubOidcProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    oidc = await startStubOidcProvider({clientId: "auth-041", clientSecret});
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {
      ...ownOAuthResources(applicationOrigin, []),
      applicationOrigin,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: createOidcIdentityProvider({
        applicationOrigin,
        clientId: oidc.clientId,
        clientSecret: Redacted.make(clientSecret, {label: "oidc-client-secret"}),
        issuer: oidc.issuer,
        scopes: "openid email profile",
      }),
      port,
    });
    administrator = await signInWithStubOidc(
      server.baseUrl,
      oidc,
      "administrator@example.test",
      "auth-041-administrator",
    );
    adaId = await admitMember(server, administrator, "Ada", "ada@example.test");
    ada = await signInWithStubOidc(server.baseUrl, oidc, "ada@example.test", "auth-041-ada");
  });

  afterEach(async () => {
    await server.stop();
    await oidc.stop();
    await removeTestInstallation(installation);
  });

  test("an OAuth key cannot administer, and only an administrator's manages projects", async () => {
    const administratorKey = (await connectClient(server, administrator)).access_token;
    const members = await fetch(`${server.baseUrl}/api/v1/members`, {
      headers: {Authorization: `Bearer ${administratorKey}`},
    });
    expect(members.status).toBe(403);
    const administratorProject = await fetch(`${server.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name: "From an administrator's agent"}),
      headers: {
        Authorization: `Bearer ${administratorKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(administratorProject.status).toBe(201);

    const headers = {
      Authorization: `Bearer ${(await connectClient(server, ada)).access_token}`,
      "Content-Type": "application/json",
    };
    const created = await fetch(`${server.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name: "From an agent"}),
      headers,
      method: "POST",
    });
    expect(created.status).toBe(403);
    const archived = await fetch(`${server.baseUrl}/api/v1/projects/prj_default/archive`, {
      headers,
      method: "POST",
    });
    expect(archived.status).toBe(403);
  });

  test("a member deactivated after approval gets invalid_grant at code exchange", async () => {
    const clientId = await registerOAuthClient(server);
    const {challenge, verifier} = oauthPkce();
    const code = await approveOAuthClient(server, ada, clientId, challenge);
    const deactivated = await fetch(`${server.baseUrl}/api/v1/members/${adaId}/deactivate`, {
      headers: browserMutationHeaders(server.baseUrl, administrator),
      method: "POST",
    });
    expect(deactivated.status).toBe(200);
    const exchange = await postToken(server, {
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: oauthRedirectUri,
    });
    expect(exchange.status).toBe(400);
    expect(await exchange.json()).toMatchObject({error: "invalid_grant"});
  });
});

async function connectOnClock(
  run: (input: {
    readonly clientId: string;
    readonly clock: MutableClock;
    readonly installation: TestInstallation;
    readonly server: RunningTestServer;
    readonly tokens: Awaited<ReturnType<typeof exchangeOAuthCode>>;
  }) => Promise<void>,
): Promise<void> {
  const installation = await createTestInstallation();
  const clock = new MutableClock();
  const port = await reserveLoopbackPort();
  const applicationOrigin = `http://127.0.0.1:${port}`;
  const server = await startTestServer(installation, {
    ...ownOAuthResources(applicationOrigin, []),
    applicationOrigin,
    clock,
    port,
  });
  try {
    const cookies = await signInAdministrator(server, installation);
    const clientId = await registerOAuthClient(server);
    const {challenge, verifier} = oauthPkce();
    const code = await approveOAuthClient(server, cookies, clientId, challenge);
    const tokens = await exchangeOAuthCode(server, {clientId, code, verifier});
    await run({clientId, clock, installation, server, tokens});
  } finally {
    await server.stop();
    await removeTestInstallation(installation);
  }
}

describe("OAuth refresh expiry", () => {
  test("a stale refresh token after the grace revokes the grant", async () => {
    await connectOnClock(async ({clientId, clock, server, tokens}) => {
      const second = await refreshOAuthToken(server, clientId, tokens.refresh_token);
      clock.advance(31_000);
      const reused = await postToken(server, {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      });
      expect(reused.status).toBe(400);
      const victim = await postToken(server, {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: second.refresh_token,
      });
      expect(victim.status).toBe(400);
    });
  });

  test("a grant ends 30 days after creation however recently it refreshed", async () => {
    await connectOnClock(async ({clientId, clock, server, tokens}) => {
      clock.advance(29 * dayMilliseconds);
      const recent = await refreshOAuthToken(server, clientId, tokens.refresh_token);
      clock.advance(dayMilliseconds);
      const expired = await postToken(server, {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: recent.refresh_token,
      });
      expect(expired.status).toBe(400);
      expect(await expired.json()).toMatchObject({error: "invalid_grant"});
    });
  });

  test("at the cap, registration evicts the oldest client with no live grant", async () => {
    await connectOnClock(async ({clientId: renewed, clock, installation, server}) => {
      const dead = await registerOAuthClient(server, {client_name: "Dead Client"});
      const firstCookies = await signInAdministrator(server, installation);
      const {challenge, verifier} = oauthPkce();
      const code = await approveOAuthClient(server, firstCookies, dead, challenge);
      await exchangeOAuthCode(server, {clientId: dead, code, verifier});
      clock.advance(31 * dayMilliseconds);
      const cookies = await signInAdministrator(server, installation);
      const pkce = oauthPkce();
      const renewedCode = await approveOAuthClient(server, cookies, renewed, pkce.challenge);
      await exchangeOAuthCode(server, {
        clientId: renewed,
        code: renewedCode,
        verifier: pkce.verifier,
      });

      const database = new DatabaseSync(
        path.join(installation.dataDirectory, "artifact-server.db"),
      );
      database.exec(`
        WITH RECURSIVE seed(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seed WHERE n < 9998)
        INSERT INTO oauth_clients (installation_id, id, name, redirect_uris_json, created_at)
        SELECT (SELECT installation_id FROM oauth_clients LIMIT 1), 'cli_seed_' || n, 'Seed',
          '[]', '2099-01-01T00:00:00.000Z' FROM seed
      `);
      const authorize = (clientId: string) =>
        getAuthorization(authorizationUrl(server, clientId, pkce.challenge), cookies);
      expect((await postRegistration(server)).status).toBe(201);
      expect((await authorize(dead)).status).toBe(400);
      expect((await authorize(renewed)).status).toBe(302);
      const keys = keysSchema.parse(await (await fetch(`${server.baseUrl}/api/v1/api-keys`, {
        headers: {Cookie: cookies.header},
      })).json()).apiKeys;
      expect(keys.find((key) => key.name.endsWith(" via Dead Client"))?.revokedAt)
        .toEqual(expect.any(String));

      database.exec(`
        INSERT INTO oauth_grants (
          installation_id, id, client_id, member_id, api_key_id, refresh_digest,
          created_at, refreshed_at, expires_at
        )
        SELECT installation_id, 'grt_' || id, id, 'seed', 'seed', 'seed_' || id,
          created_at, created_at, '2099-01-01T00:00:00.000Z'
        FROM oauth_clients AS clients
        WHERE NOT EXISTS (SELECT 1 FROM oauth_grants WHERE client_id = clients.id)
      `);
      database.close();
      expect((await postRegistration(server)).status).toBe(503);
    });
  });
});
