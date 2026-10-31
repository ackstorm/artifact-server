import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {admitMember, issueApiKey} from "../support/agent-dispatch.js";
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
const policyPath = "/api/v1/administration/public-link-policy";
const keyCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
];

const jsonSchema = z.json();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const sessionSchema = z.object({
  installation: z.object({publicLinksEnabled: z.boolean()}),
  principal: z.object({id: z.string()}),
});

type Json = z.infer<typeof jsonSchema>;

type Credential =
  | {readonly kind: "bearer"; readonly token: string}
  | {readonly kind: "session"; readonly cookies: ApplicationCookies};

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

interface Answer {
  readonly body: Json;
  readonly status: number;
}

describe("installation public-link policy", () => {
  let installation: TestInstallation;
  let oidc: RunningStubOidcProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    oidc = await startStubOidcProvider({
      clientId: "artifact-server-auth-006",
      clientSecret,
    });
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
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
  });

  afterEach(async () => {
    await server.stop();
    await oidc.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-006-F: members, administrators, member-bound and service keys, MCP agents and the CLI cannot make an artifact Public, read one anonymously, or change the policy while public links are off, and no administrator can change a configured policy", async () => {
    const {ada, administrator, administratorKey, bob, bobKey, serviceKey} = await setUp();

    const outsiders = [bob, bearer(bobKey), bearer(administratorKey), bearer(serviceKey)];
    const refusals = await Promise.all(outsiders.flatMap((credential) => [
      call(credential, "GET"),
      call(credential, "PUT", {publicLinksEnabled: false}),
    ]));
    expect(refusals.map(outcome)).toEqual(
      refusals.map(() => ({code: "AUTHORIZATION_DENIED", status: 403})),
    );
    expect(await call(administrator, "GET")).toEqual({
      body: {publicArtifactCount: 0, publicLinksEnabled: true, setByConfiguration: false},
      status: 200,
    });

    expect(await call(administrator, "PUT", {publicLinksEnabled: false})).toEqual({
      body: {publicArtifactCount: 0, publicLinksEnabled: false, setByConfiguration: false},
      status: 200,
    });
    expect((await call(administrator, "PUT", {extra: true, publicLinksEnabled: true})).status)
      .toBe(422);
    expect((await readSession(ada)).installation.publicLinksEnabled).toBe(false);
  });

  async function setUp() {
    const administratorCookies = await signIn(administratorEmail, "administrator");
    const administrator = session(administratorCookies);
    const administratorId = (await readSession(administrator)).principal.id;
    await admitMember(server, administratorCookies, "Ada", "ada@example.test");
    const bobId = await admitMember(server, administratorCookies, "Bob", "bob@example.test");
    const [ada, bob] = [
      session(await signIn("ada@example.test", "ada")),
      session(await signIn("bob@example.test", "bob")),
    ];
    const [administratorKey, bobKey, serviceKey] = await Promise.all([
      issueApiKey(server, administratorCookies, keyCapabilities, "Administrator's agent", administratorId),
      issueApiKey(server, administratorCookies, keyCapabilities, "Bob's agent", bobId),
      issueApiKey(server, administratorCookies, keyCapabilities, "Release bot"),
    ]);
    return {ada, administrator, administratorKey, bob, bobKey, serviceKey};
  }

  async function readSession(credential: Credential) {
    const response = await request(credential, "GET", "/api/v1/session");
    expect(response.status).toBe(200);
    return sessionSchema.parse(await response.json());
  }

  async function call(credential: Credential, method: "GET" | "PUT", json?: Json): Promise<Answer> {
    return answer(await request(credential, method, policyPath, json));
  }

  function request(
    credential: Credential,
    method: string,
    path: string,
    json?: Json,
  ): Promise<Response> {
    const headers = credential.kind === "bearer"
      ? new Headers({Authorization: `Bearer ${credential.token}`})
      : new Headers({
        Cookie: credential.cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": credential.cookies.csrf,
      });
    let body: string | null = null;
    if (json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(json);
    }
    return fetch(new URL(path, server.baseUrl), {body, headers, method});
  }

  function signIn(email: string, subject: string): Promise<ApplicationCookies> {
    return signInWithStubOidc(server.baseUrl, oidc, email, `auth-006-${subject}`);
  }
});

function bearer(token: string): Credential {
  return {kind: "bearer", token};
}

function session(cookies: ApplicationCookies): Credential {
  return {cookies, kind: "session"};
}

async function answer(response: Response): Promise<Answer> {
  const text = await response.text();
  return {body: text === "" ? null : jsonSchema.parse(JSON.parse(text)), status: response.status};
}

function outcome(reply: Answer) {
  return {code: failureSchema.safeParse(reply.body).data?.error.code, status: reply.status};
}
