import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {signInAdministrator} from "../support/agent-dispatch.js";
import type {ApplicationCookies} from "../support/browser-session.js";
import {
  approveOAuthClient,
  authorizationUrl,
  exchangeOAuthCode,
  getAuthorization,
  oauthPkce,
  oauthRedirectUri,
  postConsent,
  postRegistration,
  registerOAuthClient,
  startOAuthServer,
} from "../support/oauth-client.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

describe("OAuth authorization", () => {
  let cookies: ApplicationCookies;
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startOAuthServer(installation, [
      "https://client.example.test/callback",
    ]);
    cookies = await signInAdministrator(server, installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-040-B: a signed-in member approves a named client and receives a code", async () => {
    const clientId = await registerOAuthClient(server);
    const {challenge} = oauthPkce();
    const page = await getAuthorization(
      authorizationUrl(server, clientId, challenge),
      cookies,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");
    const html = await page.text();
    expect(html).toContain("Test Client");
    expect(html).toContain("127.0.0.1");

    const decided = await postConsent(server, html, cookies);
    expect(decided.status).toBe(303);
    const location = new URL(decided.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(oauthRedirectUri);
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("code")).toMatch(/^as_orc_/u);
  });

  test("AUTH-040-B: a client with a live grant skips consent", async () => {
    const clientId = await registerOAuthClient(server);
    const pkce = oauthPkce();
    const code = await approveOAuthClient(server, cookies, clientId, pkce.challenge);
    await exchangeOAuthCode(server, {clientId, code, verifier: pkce.verifier});

    const again = await getAuthorization(
      authorizationUrl(server, clientId, oauthPkce().challenge),
      cookies,
    );
    expect(again.status).toBe(302);
    expect(new URL(again.headers.get("location") ?? "").searchParams.get("code"))
      .toMatch(/^as_orc_/u);
  });

  test("AUTH-040-B: without a session the browser goes to login and returns", async () => {
    const clientId = await registerOAuthClient(server);
    const response = await getAuthorization(
      authorizationUrl(server, clientId, oauthPkce().challenge),
      null,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", server.baseUrl);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("returnTo")).toContain("/oauth/authorize?");
  });

  test("AUTH-040-F: registration refuses confidential clients and unsafe redirects", async () => {
    for (const overrides of [
      {token_endpoint_auth_method: "client_secret_basic"},
      {redirect_uris: ["https://attacker.example.test/callback"]},
      {redirect_uris: ["http://10.0.0.1/callback"]},
      {redirect_uris: ["http://127.0.0.1/callback#fragment"]},
      {redirect_uris: []},
      {grant_types: ["client_credentials"]},
      {response_types: ["token"]},
    ]) {
      expect((await postRegistration(server, overrides)).status).toBe(400);
    }
  });

  test("AUTH-040-F: an unknown client or foreign redirect is never redirected to", async () => {
    const clientId = await registerOAuthClient(server);
    const {challenge} = oauthPkce();
    for (const url of [
      authorizationUrl(server, "cli_missing", challenge),
      authorizationUrl(server, clientId, challenge, {
        redirect_uri: "https://attacker.example.test/callback",
      }),
    ]) {
      const response = await getAuthorization(url, cookies);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  test("AUTH-040-F: missing or plain PKCE, unknown scopes, and foreign resources issue no code", async () => {
    const clientId = await registerOAuthClient(server);
    const {challenge} = oauthPkce();
    const cases: readonly [Record<string, string>, string][] = [
      [{code_challenge: ""}, "invalid_request"],
      [{code_challenge_method: "plain"}, "invalid_request"],
      [{scope: "admin"}, "invalid_scope"],
      [{resource: "https://other.example.test/mcp"}, "invalid_target"],
      [{response_type: "token"}, "unsupported_response_type"],
    ];
    for (const [overrides, error] of cases) {
      const response = await getAuthorization(
        authorizationUrl(server, clientId, challenge, overrides),
        cookies,
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("code")).toBeNull();
    }
  });

  test("AUTH-040-F: a cross-site or CSRF-less approval issues no code", async () => {
    const clientId = await registerOAuthClient(server);
    const page = await getAuthorization(
      authorizationUrl(server, clientId, oauthPkce().challenge),
      cookies,
    );
    const html = await page.text();
    const crossSite = await postConsent(server, html, cookies, {
      headers: {Origin: "https://attacker.example.test", "Sec-Fetch-Site": "cross-site"},
    });
    expect(crossSite.status).toBe(403);
    const wrongCsrf = await postConsent(server, html, cookies, {
      overrides: {csrf_token: "A".repeat(43)},
    });
    expect(wrongCsrf.status).toBe(403);
  });

  test("AUTH-040-F: a hostile client name is escaped on the consent page", async () => {
    const clientId = await registerOAuthClient(server, {
      client_name: '<script>alert("x")</script>',
    });
    const page = await getAuthorization(
      authorizationUrl(server, clientId, oauthPkce().challenge),
      cookies,
    );
    expect(await page.text()).not.toContain("<script>");
  });
});
