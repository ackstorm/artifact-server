import {Redacted} from "effect";
import {exportJWK, generateKeyPair, SignJWT, type CryptoKey} from "jose";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {OidcMcpBearerVerifier} from "../../src/identity/oidc-mcp-bearer-verifier.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {loadOidcAuthorizationServer} from "../../src/identity/oidc-oauth-metadata.js";
import {admitMember, callMcp, issueApiKey, MutableClock} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {type ProviderBoundary, startProviderBoundary} from "../support/oidc-token-provider.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  type RunningStubOidcProvider,
  signInWithStubOidc,
  startStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const administratorEmail = "administrator@example.test";
const clientSecret = "stub-oidc-client-secret-with-entropy";
const mcpResource = "https://staging.artifactserver.test/mcp";
const keyCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
];

const pageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string(), listed: z.boolean(), name: z.string()}).loose(),
  })),
});
const actionsSchema = z.object({actions: z.array(z.object({action: z.string()}).loose())});
const artifactEnvelopeSchema = z.object({
  artifact: z.object({listed: z.boolean(), accessSetting: z.string()}).loose(),
});

interface ListingBody {
  readonly listed: boolean;
}

interface Cookies {
  readonly csrf: string;
  readonly header: string;
}

describe("Shared with me", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let oidc: RunningStubOidcProvider;
  let privateKey: CryptoKey;
  let server: RunningTestServer;
  let tokenProvider: ProviderBoundary;

  beforeEach(async () => {
    clock = new MutableClock();
    installation = await createTestInstallation();
    oidc = await startStubOidcProvider({clientId: "artifact-server-auth-038", clientSecret});
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    tokenProvider = await startProviderBoundary({
      jwk: {...await exportJWK(keys.publicKey), alg: "RS256", kid: "auth-038-key", use: "sig"},
    });
    const authorizationServer = await loadOidcAuthorizationServer(tokenProvider.issuer);
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      clock,
      externalMcpOAuthVerifier: new OidcMcpBearerVerifier({
        audience: mcpResource,
        issuer: tokenProvider.issuer,
        jwksUri: authorizationServer.jwksUri,
        userInfoEndpoint: authorizationServer.userInfoEndpoint,
      }),
      interactiveIdentityProvider: createOidcIdentityProvider({
        applicationOrigin,
        clientId: oidc.clientId,
        clientSecret: Redacted.make(clientSecret, {label: "oidc-client-secret"}),
        issuer: oidc.issuer,
        scopes: "openid email profile",
      }),
      mcpOAuthResource: {
        authorizationServerMetadata: authorizationServer.metadata,
        resource: mcpResource,
        scopes: ["openid"],
      },
      port,
    });
  });

  afterEach(async () => {
    await server.stop();
    await tokenProvider.close();
    await oidc.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-038-F: Shared with me holds only listed or opened Signed-in and Public artifacts of others, only controllers list, listing changes are in Activity, and only browser reads record openings", async () => {
    const administrator = await signIn(administratorEmail, "administrator");
    const adaId = await admitMember(server, administrator, "Ada", "ada@example.test");
    const bobId = await admitMember(server, administrator, "Bob", "bob@example.test");
    const carolId = await admitMember(server, administrator, "Carol", "carol@example.test");
    const ada = await signIn("ada@example.test", "ada");
    const bob = await signIn("bob@example.test", "bob");
    const carol = await signIn("carol@example.test", "carol");
    const adaKey = await issueApiKey(server, administrator, keyCapabilities, "Ada's agent", adaId);
    const bobKey = await issueApiKey(server, administrator, keyCapabilities, "Bob's agent", bobId);
    const carolKey = await issueApiKey(server, administrator, keyCapabilities, "Carol's agent", carolId);
    const serviceKey = await issueApiKey(server, administrator, keyCapabilities, "Release bot");

    // Listing.
    const listed = await publish(adaKey, "L", "account_required");
    expect(await shared(bob)).toEqual([]);
    clock.advance(1_000);
    const on = await put(ada, `/api/v1/artifacts/${listed}/listing`, {listed: true});
    expect(on.status).toBe(200);
    expect(artifactEnvelopeSchema.parse(await on.json()).artifact.listed).toBe(true);
    expect(await shared(bob)).toEqual([{listed: true, name: "L"}]);
    expect(await mine(bob)).toEqual([]);
    expect((await put(bob, `/api/v1/artifacts/${listed}/listing`, {listed: true})).status).toBe(403);
    expect((await put(administrator, `/api/v1/artifacts/${listed}/listing`, {listed: true})).status).toBe(403);

    const draft = await publish(adaKey, "P", "private");
    const refused = await put(ada, `/api/v1/artifacts/${draft}/listing`, {listed: true});
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("ARTIFACT_PRIVATE");
    expect((await put(ada, `/api/v1/artifacts/${draft}/listing`, {listed: false})).status).toBe(200);
    expect((await put(bob, `/api/v1/artifacts/${draft}/listing`, {listed: true})).status).toBe(404);

    clock.advance(1_000);
    expect(await actionKinds(ada, listed)).toEqual(["publish", "list"]);
    expect((await put(ada, `/api/v1/artifacts/${listed}/listing`, {listed: true})).status).toBe(200);
    expect(await actionKinds(ada, listed)).toEqual(["publish", "list"]);

    clock.advance(1_000);
    const lowered = await patchAccess(adaKey, listed, "private", "auth-038-lower-1");
    expect(artifactEnvelopeSchema.parse(await lowered.json()).artifact.listed).toBe(false);
    expect(await shared(bob)).toEqual([]);
    expect(await actionKinds(ada, listed)).toEqual(["publish", "list", "change_access", "unlist"]);
    await patchAccess(adaKey, listed, "private", "auth-038-lower-1");
    expect(await actionKinds(ada, listed)).toEqual(["publish", "list", "change_access", "unlist"]);

    clock.advance(1_000);
    await patchAccess(adaKey, listed, "account_required", "auth-038-raise-1");
    expect(await shared(bob)).toEqual([]);
    expect(await actionKinds(ada, listed)).toEqual([
      "publish", "list", "change_access", "unlist", "change_access",
    ]);

    clock.advance(1_000);
    await put(ada, `/api/v1/artifacts/${listed}/listing`, {listed: true});
    clock.advance(1_000);
    await put(ada, `/api/v1/artifacts/${listed}/listing`, {listed: false});
    expect((await actionKinds(ada, listed)).slice(-2)).toEqual(["list", "unlist"]);

    // Openings.
    const opened = await publish(carolKey, "O", "account_required");
    const byKey = await publish(carolKey, "K", "account_required");
    const byMcpKey = await publish(carolKey, "M", "account_required");
    const byOauth = await publish(carolKey, "N", "account_required");
    await publish(carolKey, "X", "account_required");

    expect((await fetch(`${server.baseUrl}/api/v1/artifacts/${byKey}`, {
      headers: {Authorization: `Bearer ${bobKey}`},
    })).status).toBe(200);
    const viaKey = await callMcp(server, bobKey, "tools/call", "artifact_get", {
      arguments: {artifactId: byMcpKey}, name: "artifact_get",
    });
    expect(viaKey.result?.isError).not.toBe(true);
    const viaOauth = await callMcp(server, await issueToken("bob@example.test", "bob-oauth"), "tools/call", "artifact_get", {
      arguments: {artifactId: byOauth}, name: "artifact_get",
    });
    expect(viaOauth.result?.isError).not.toBe(true);
    expect(await shared(bob)).toEqual([]);

    expect((await get(bob, `/api/v1/artifacts/${opened}`)).status).toBe(200);
    expect(await shared(bob)).toEqual([{listed: false, name: "O"}]);
    expect(await shared(ada)).toEqual([]);
    expect(await shared(carol)).toEqual([]);

    expect((await patchAccess(carolKey, opened, "private", "auth-038-lower-2")).status).toBe(200);
    expect(await shared(bob)).toEqual([]);
    expect((await get(bob, `/api/v1/artifacts/${opened}`)).status).toBe(404);

    // Administrator and service-owned artifacts.
    const service = await publish(serviceKey, "S", "account_required");
    expect((await put(administrator, `/api/v1/artifacts/${service}/listing`, {listed: true})).status).toBe(200);
    expect(await shared(administrator)).toEqual([]);
    expect(await mine(administrator)).toEqual(["S"]);
    expect(await shared(bob)).toEqual([{listed: true, name: "S"}]);

    // Filters.
    expect(await sharedQuery(bob, "access=private")).toEqual([]);
    expect(await sharedQuery(bob, "search=S")).toEqual(["S"]);
    expect(await sharedQuery(bob, "search=zzz")).toEqual([]);
    const unknownScope = await get(bob, "/api/v1/artifacts?scope=everyone");
    expect(unknownScope.status).toBe(422);
    expect(await unknownScope.text()).toContain("INVALID_INPUT");

    const details = await callMcp(server, adaKey, "tools/call", "artifact_get", {
      arguments: {artifactId: listed}, name: "artifact_get",
    });
    expect(details.result?.isError).not.toBe(true);
    expect(z.object({artifact: z.object({listed: z.boolean()})})
      .parse(details.result?.structuredContent).artifact.listed).toBe(false);
  });

  function signIn(email: string, subject: string): Promise<Cookies> {
    return signInWithStubOidc(server.baseUrl, oidc, email, `auth-038-${subject}`);
  }

  async function publish(
    token: string,
    name: string,
    accessSetting: "private" | "account_required" | "public_link",
  ): Promise<string> {
    const {body} = await publishNew(server, {...installation, apiToken: token}, {
      accessSetting,
      content: `<!doctype html><title>${name}</title>`,
      idempotencyKey: `auth-038-publish-${name}`,
      name,
    });
    return body.artifact.id;
  }

  function get(cookies: Cookies, pathname: string): Promise<Response> {
    return fetch(`${server.baseUrl}${pathname}`, {headers: {Cookie: cookies.header}});
  }

  function put(cookies: Cookies, pathname: string, body: ListingBody): Promise<Response> {
    return fetch(`${server.baseUrl}${pathname}`, {
      body: JSON.stringify(body),
      headers: new Headers({
        "Content-Type": "application/json",
        Cookie: cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": cookies.csrf,
      }),
      method: "PUT",
    });
  }

  async function patchAccess(
    token: string,
    artifactId: string,
    accessSetting: string,
    idempotencyKey: string,
  ): Promise<Response> {
    const current = z.object({artifact: z.object({currentVersionId: z.string()}).loose()})
      .parse(await (await fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}`, {
        headers: {Authorization: `Bearer ${token}`},
      })).json()).artifact.currentVersionId;
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/access`, {
      body: JSON.stringify({accessSetting, expectedCurrentVersionId: current}),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `${idempotencyKey}-0123456789`,
      },
      method: "PATCH",
    });
  }

  async function actionKinds(cookies: Cookies, artifactId: string): Promise<string[]> {
    const response = await get(cookies, `/api/v1/artifacts/${artifactId}/actions`);
    expect(response.status).toBe(200);
    return actionsSchema.parse(await response.json()).actions.map(({action}) => action).toReversed();
  }

  async function items(cookies: Cookies, query: string) {
    const response = await get(cookies, `/api/v1/artifacts?${query}`);
    expect(response.status).toBe(200);
    return pageSchema.parse(await response.json()).artifacts.map(({artifact}) => artifact);
  }

  async function shared(cookies: Cookies) {
    return (await items(cookies, "scope=shared")).map(({listed, name}) => ({listed, name}));
  }

  async function sharedQuery(cookies: Cookies, query: string) {
    return (await items(cookies, `scope=shared&${query}`)).map(({name}) => name);
  }

  async function mine(cookies: Cookies) {
    return (await items(cookies, "")).map(({name}) => name);
  }

  function issueToken(email: string, subject: string): Promise<string> {
    return new SignJWT({
      azp: "artifact-server",
      email,
      email_verified: true,
      name: subject,
      preferred_username: subject,
      scope: "openid profile email",
    })
      .setProtectedHeader({alg: "RS256", kid: "auth-038-key"})
      .setIssuer(tokenProvider.issuer)
      .setAudience(mcpResource)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1_000) + 300)
      .setSubject(subject)
      .sign(privateKey);
  }
});
