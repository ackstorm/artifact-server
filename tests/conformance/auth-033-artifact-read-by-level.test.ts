import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {ApiClient, issueApiKey} from "../support/agent-dispatch.js";
import {
  availableHealthProbe,
  configuredGitHistory,
  RecordingGitHistoryProvider,
} from "../support/git-history-provider.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  reserveLoopbackPort,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  type RunningStubOidcProvider,
  startStubOidcLogin,
  startStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const administratorEmail = "administrator@example.test";
const clientSecret = "stub-oidc-client-secret-with-entropy";
const protocolVersion = "2026-07-28";
const projectId = "prj_default";
const memberKeyCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
  "content-session:issue",
];
const firstHtml = "<!doctype html><title>Ada's private draft</title>";
const secondHtml = "<!doctype html><title>Ada's private draft, revised</title>";

const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const jsonSchema = z.json();
const mcpReplySchema = z.object({
  error: jsonSchema.optional(),
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: jsonSchema.optional(),
  }).loose().optional(),
}).loose();

type McpReply = z.infer<typeof mcpReplySchema>;

interface McpParameters {
  readonly arguments?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly uri?: string;
}

interface CloneTokenRequest {
  readonly ttlSeconds: number;
}

type Credential =
  | {readonly kind: "bearer"; readonly token: string}
  | {readonly kind: "session"; readonly cookies: ApplicationCookies};

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

interface ReadTarget {
  readonly artifactId: string;
  readonly firstVersionId: string;
  readonly secondVersionId: string;
  readonly threadId: string;
}

interface Answer {
  readonly body: z.infer<typeof jsonSchema> | string;
  readonly status: number;
}

describe("artifact read authority by sharing level", () => {
  let installation: TestInstallation;
  let oidc: RunningStubOidcProvider;
  let gitHistory: RecordingGitHistoryProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    oidc = await startStubOidcProvider({
      clientId: "artifact-server-auth-033",
      clientSecret,
    });
    gitHistory = new RecordingGitHistoryProvider();
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      gitHistory: configuredGitHistory(),
      gitHistoryHealthProbe: availableHealthProbe,
      gitHistoryProvider: gitHistory,
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

  test("AUTH-033-B AUTH-033-F: only the owner reads a Private artifact on every surface, and raising the level opens it by link", async () => {
    const administrator = await signIn(administratorEmail, "administrator");
    const administratorId = await sessionPrincipalId(administrator);
    const adaId = await admitMember(administrator, "Ada", "ada@example.test");
    const bobId = await admitMember(administrator, "Bob", "bob@example.test");
    const adaSession = await signIn("ada@example.test", "ada");
    const bobSession = await signIn("bob@example.test", "bob");
    const [adaKey, bobKey, administratorKey, serviceKey] = await Promise.all([
      issueApiKey(server, administrator, memberKeyCapabilities, "Ada's agent", adaId),
      issueApiKey(server, administrator, memberKeyCapabilities, "Bob's agent", bobId),
      issueApiKey(
        server,
        administrator,
        memberKeyCapabilities,
        "Administrator's agent",
        administratorId,
      ),
      issueApiKey(server, administrator, ["artifact:read"], "Reader bot"),
    ]);
    await enableGitHistory(administrator);

    const adaInstallation = {...installation, apiToken: adaKey};
    const first = await publishNew(server, adaInstallation, {
      accessSetting: "private",
      content: firstHtml,
      idempotencyKey: "auth-033-ada-first",
      name: "Ada's private draft",
      projectId,
    });
    expect(first.body.artifact.accessSetting).toBe("private");
    const second = await publishVersion(server, adaInstallation, {
      artifactId: first.body.artifact.id,
      content: secondHtml,
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "auth-033-ada-second",
      projectId,
    });
    await expect.poll(() => gitHistory.commitCalls, {timeout: 8_000}).toBe(2);
    const thread = await new ApiClient(server, adaKey).openThread(
      second.body,
      "Only Ada should see this.",
      "auth-033-ada-thread",
    );
    const target: ReadTarget = {
      artifactId: first.body.artifact.id,
      firstVersionId: first.body.version.id,
      secondVersionId: second.body.version.id,
      threadId: thread.id,
    };
    const missing: ReadTarget = {...target, artifactId: "art_auth033_missing"};

    const ownerStatuses = [200, 200, 200, 200, 200, 415, 200, 200, 200, 200, 201, 201, 201, 201];
    const ada = await Promise.all([
      readEverySurface({kind: "session", cookies: adaSession}, target),
      readEverySurface({kind: "bearer", token: adaKey}, target),
    ]);
    expect(ada.map((answers) => answers.map(({status}) => status)))
      .toEqual([ownerStatuses, ownerStatuses]);
    const adaTools = await callEveryTool(adaKey, target);
    expect(adaTools.map(mcpFailed)).toEqual(adaTools.map(() => false));

    const refusedCredentials: readonly Credential[] = [
      {kind: "session", cookies: bobSession},
      {kind: "bearer", token: bobKey},
      {kind: "bearer", token: serviceKey},
      {kind: "bearer", token: administratorKey},
      {kind: "session", cookies: administrator},
    ];
    const [refused, probes] = await Promise.all([
      Promise.all(refusedCredentials.map((credential) => readEverySurface(credential, target))),
      Promise.all(refusedCredentials.map((credential) => readEverySurface(credential, missing))),
    ]);
    expect(refused.flat().map(({body, status}) => ({
      code: failureSchema.safeParse(body).data?.error.code,
      status,
    }))).toEqual(refused.flat().map(() => ({code: "ARTIFACT_NOT_FOUND", status: 404})));
    expect(refused).toEqual(probes);

    const refusedTokens = [bobKey, serviceKey, administratorKey];
    const [refusedTools, probedTools] = await Promise.all([
      Promise.all(refusedTokens.map((token) => callEveryTool(token, target))),
      Promise.all(refusedTokens.map((token) => callEveryTool(token, missing))),
    ]);
    expect(refusedTools.flat().map(mcpFailed)).toEqual(refusedTools.flat().map(() => true));
    const refusedToolCodes = refusedTools.flatMap((bodies) => bodies.slice(0, -1).map(toolErrorCode));
    expect(refusedToolCodes).toEqual(refusedToolCodes.map(() => "ARTIFACT_NOT_FOUND"));
    expect(refusedTools).toEqual(probedTools);

    const anonymousPrivate = await anonymousOpen(target.artifactId);
    await changeLevel(adaKey, target.artifactId, target.secondVersionId, "account_required");
    const shared = await Promise.all([
      {kind: "session", cookies: bobSession} as const,
      {kind: "bearer", token: bobKey} as const,
      {kind: "bearer", token: serviceKey} as const,
    ].map((credential) => Promise.all([
      get(credential, `/api/v1/artifacts/${target.artifactId}`),
      get(credential, `/api/v1/artifacts/${target.artifactId}/versions`),
      get(credential, `/api/v1/artifacts/${target.artifactId}/comments`),
      get(credential, `/api/v1/artifacts/${target.artifactId}/comments/${target.threadId}`),
    ])));
    expect(shared.map((answers) => answers.map(({status}) => status)))
      .toEqual([[200, 200, 200, 200], [200, 200, 200, 200], [200, 200, 200, 200]]);
    const anonymousOrganization = await anonymousOpen(target.artifactId);
    expect(anonymousOrganization.status).toBe(401);
    expect(anonymousPrivate).toEqual(anonymousOrganization);

    await changeLevel(adaKey, target.artifactId, target.secondVersionId, "public_link");
    const anonymousPublic = await fetch(`${server.baseUrl}/artifacts/${target.artifactId}`, {
      redirect: "manual",
    });
    expect(anonymousPublic.status).toBe(302);
    const current = await fetchVersion(
      server,
      String(anonymousPublic.headers.get("location")),
    );
    expect(await current.text()).toBe(secondHtml);
  });

  function readEverySurface(
    credential: Credential,
    target: ReadTarget,
  ): Promise<readonly Answer[]> {
    const artifact = `/api/v1/artifacts/${target.artifactId}`;
    const firstVersion = `${artifact}/versions/${target.firstVersionId}`;
    const secondVersion = `${artifact}/versions/${target.secondVersionId}`;
    return Promise.all([
      get(credential, artifact),
      get(credential, `${artifact}/versions`),
      get(credential, firstVersion),
      get(credential, `${firstVersion}/file?path=index.html`),
      get(credential, `${firstVersion}/archive`),
      get(credential, `${firstVersion}/media?path=index.html`),
      get(
        credential,
        `${artifact}/comparisons?fromVersionId=${target.firstVersionId}` +
          `&toVersionId=${target.secondVersionId}`,
      ),
      get(credential, `${artifact}/actions`),
      get(credential, `${artifact}/comments`),
      get(credential, `${artifact}/comments/${target.threadId}`),
      post(credential, `${artifact}/content-sessions`),
      post(credential, `${firstVersion}/content-sessions`),
      post(credential, `${secondVersion}/preview-leases`),
      post(
        credential,
        `/api/v1/projects/${projectId}/artifacts/${target.artifactId}/history/clone-token`,
        {ttlSeconds: 60},
      ),
    ]);
  }

  function callEveryTool(
    token: string,
    target: ReadTarget,
  ): Promise<readonly McpReply[]> {
    const artifactId = target.artifactId;
    const manifest = `artifact://projects/${projectId}/artifacts/${artifactId}` +
      `/versions/${target.firstVersionId}/manifest`;
    return Promise.all([
      callTool(token, "artifact_get", {artifactId}),
      callTool(token, "artifact_version_list", {artifactId}),
      callTool(token, "artifact_diff", {
        artifactId,
        fromVersionId: target.firstVersionId,
        toVersionId: target.secondVersionId,
      }),
      callTool(token, "comment_list", {artifactId}),
      callTool(token, "comment_get", {artifactId, threadId: target.threadId}),
      callTool(token, "artifact_open", {artifactId}),
      callTool(token, "artifact_open", {artifactId, versionId: target.firstVersionId}),
      callTool(token, "artifact_history_clone_token", {artifactId, projectId}),
      mcp(token, "resources/read", manifest, {uri: manifest}),
    ]);
  }

  function callTool(
    token: string,
    name: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<McpReply> {
    return mcp(token, "tools/call", name, {arguments: parameters, name});
  }

  async function mcp(
    token: string,
    method: string,
    name: string,
    parameters: McpParameters,
  ): Promise<McpReply> {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method,
        params: {
          ...parameters,
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": method,
        "Mcp-Name": name,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    return mcpReplySchema.parse(await response.json());
  }

  async function get(credential: Credential, pathname: string): Promise<Answer> {
    return answer(await fetch(`${server.baseUrl}${pathname}`, {
      headers: credentialHeaders(credential, false),
    }));
  }

  async function post(
    credential: Credential,
    pathname: string,
    body?: CloneTokenRequest,
  ): Promise<Answer> {
    const headers = credentialHeaders(credential, true);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    return answer(await fetch(`${server.baseUrl}${pathname}`, {
      body: body === undefined ? null : JSON.stringify(body),
      headers,
      method: "POST",
    }));
  }

  async function anonymousOpen(artifactId: string): Promise<Answer> {
    return answer(await fetch(`${server.baseUrl}/artifacts/${artifactId}`, {
      redirect: "manual",
    }));
  }

  async function enableGitHistory(cookies: ApplicationCookies): Promise<void> {
    const session = {kind: "session", cookies} as const;
    await expect.poll(async () => z.object({
      capabilities: z.object({
        gitHistory: z.object({providerState: z.string()}).loose(),
      }).loose(),
    }).loose().parse((await get(session, "/api/v1/session")).body)
      .capabilities.gitHistory.providerState, {timeout: 5_000}).toBe("available");
    const headers = credentialHeaders(session, true);
    headers.set("Content-Type", "application/json");
    const response = await fetch(`${server.baseUrl}/api/v1/projects/${projectId}/git-history`, {
      body: JSON.stringify({confirmEstimate: true, enabled: true}),
      headers,
      method: "PUT",
    });
    expect(response.status).toBe(200);
  }

  async function changeLevel(
    token: string,
    artifactId: string,
    expectedCurrentVersionId: string,
    accessSetting: "account_required" | "public_link",
  ): Promise<void> {
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/access`, {
      body: JSON.stringify({accessSetting, expectedCurrentVersionId}),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `auth-033-level-${accessSetting}`,
      },
      method: "PATCH",
    });
    expect(response.status).toBe(200);
  }

  function credentialHeaders(credential: Credential, mutation: boolean): Headers {
    if (credential.kind === "bearer") {
      return new Headers({Authorization: `Bearer ${credential.token}`});
    }
    const headers = new Headers({
      Cookie: credential.cookies.header,
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    });
    if (mutation) headers.set("X-CSRF-Token", credential.cookies.csrf);
    return headers;
  }

  async function signIn(email: string, subject: string): Promise<ApplicationCookies> {
    oidc.claims.email = email;
    oidc.claims.name = subject;
    oidc.claims.subject = `auth-033-${subject}`;
    const authorization = await startStubOidcLogin(server.baseUrl);
    const completed = await fetch(authorization.callbackUrl, {
      headers: {Cookie: authorization.handshakeCookie},
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    const pairs = completed.headers.getSetCookie()
      .filter((value) =>
        value.startsWith("artifact_session=") || value.startsWith("artifact_csrf=")
      )
      .map((value) => value.split(";", 1)[0] ?? "");
    const csrfPair = pairs.find((pair) => pair.startsWith("artifact_csrf="));
    if (pairs.length !== 2 || csrfPair === undefined) {
      throw new Error("The login response did not issue both application cookies.");
    }
    return {
      csrf: csrfPair.slice(csrfPair.indexOf("=") + 1),
      header: pairs.join("; "),
    };
  }

  async function sessionPrincipalId(cookies: ApplicationCookies): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    expect(response.status).toBe(200);
    return z.object({principal: z.object({id: z.string()})})
      .parse(await response.json()).principal.id;
  }

  async function admitMember(
    cookies: ApplicationCookies,
    displayName: string,
    email: string,
  ): Promise<string> {
    const headers = credentialHeaders({kind: "session", cookies}, true);
    headers.set("Content-Type", "application/json");
    const response = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName, email}),
      headers,
      method: "POST",
    });
    expect(response.status).toBe(201);
    return z.object({member: z.object({id: z.string()})})
      .parse(await response.json()).member.id;
  }
});

async function answer(response: Response): Promise<Answer> {
  const text = await response.text();
  const isJson = response.headers.get("content-type")?.includes("json") === true;
  return {body: isJson ? jsonSchema.parse(JSON.parse(text)) : text, status: response.status};
}

function mcpFailed(reply: McpReply): boolean {
  return reply.error !== undefined || reply.result?.isError === true;
}

function toolErrorCode(reply: McpReply): string | undefined {
  return failureSchema.safeParse(reply.result?.structuredContent).data?.error.code;
}
