import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {MutableClock, signInAdministrator} from "../support/agent-dispatch.js";
import {ownOAuthResources} from "../../src/identity/own-oauth-resources.js";
import {browserMutationHeaders, type ApplicationCookies} from "../support/browser-session.js";
import {
  approveOAuthClient,
  exchangeOAuthCode,
  oauthPkce,
  oauthRedirectUri,
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

const keysSchema = z.object({
  apiKeys: z.array(z.object({id: z.string(), name: z.string(), revokedAt: z.string().nullable()})),
});

describe("OAuth tokens", () => {
  let cookies: ApplicationCookies;
  let installation: TestInstallation;
  let server: RunningTestServer;

  const connect = async (): Promise<{
    readonly accessToken: string;
    readonly clientId: string;
    readonly refreshToken: string;
  }> => {
    const clientId = await registerOAuthClient(server);
    const {challenge, verifier} = oauthPkce();
    const code = await approveOAuthClient(server, cookies, clientId, challenge);
    const tokens = await exchangeOAuthCode(server, {clientId, code, verifier});
    return {
      accessToken: tokens.access_token,
      clientId,
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

  test("an OAuth key cannot administer", async () => {
    const {accessToken} = await connect();
    const response = await fetch(`${server.baseUrl}/api/v1/members`, {
      headers: {Authorization: `Bearer ${accessToken}`},
    });
    expect(response.status).toBe(403);
  });
});

describe("OAuth refresh expiry", () => {
  test("a stale refresh token after the grace revokes the grant", async () => {
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
      const first = await exchangeOAuthCode(server, {clientId, code, verifier});
      const second = await refreshOAuthToken(server, clientId, first.refresh_token);
      clock.advance(31_000);
      const reused = await postToken(server, {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
      });
      expect(reused.status).toBe(400);
      const victim = await postToken(server, {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: second.refresh_token,
      });
      expect(victim.status).toBe(400);
    } finally {
      await server.stop();
      await removeTestInstallation(installation);
    }
  });
});
