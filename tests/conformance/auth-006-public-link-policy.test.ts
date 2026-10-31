import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import type {AccessSetting} from "../../src/core/model.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {
  admitMember,
  callMcp,
  issueApiKey,
  type McpReply,
  mcpToolErrorCode,
} from "../support/agent-dispatch.js";
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
  signInWithStubOidc,
  startStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const administratorEmail = "administrator@example.test";
const clientSecret = "stub-oidc-client-secret-with-entropy";
const policyPath = "/api/v1/administration/public-link-policy";
const projectId = "prj_default";
const keyCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
  "content-session:issue",
];
const disabled = {code: "PUBLIC_LINKS_DISABLED", status: 409};
const locked = {code: "PUBLIC_LINK_POLICY_LOCKED", status: 409};
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliExecutable = path.join(repositoryRoot, "node_modules/.bin/tsx");
const cliEntrypoint = path.join(repositoryRoot, "src/cli/main.ts");

const jsonSchema = z.json();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const sessionSchema = z.object({
  installation: z.object({publicLinksEnabled: z.boolean()}),
  principal: z.object({id: z.string()}),
});
const publishedSchema = z.object({
  artifact: z.object({accessSetting: z.string(), id: z.string()}).loose(),
  links: z.object({version: z.url()}).loose(),
  replayed: z.boolean(),
  version: z.object({id: z.string()}).loose(),
}).loose();
const artifactSchema = z.object({
  artifact: z.object({accessSetting: z.string()}).loose(),
}).loose();
const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({uploadUrl: z.url()}).loose()),
  uploadId: z.string(),
}).loose();
const listSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()}).loose()}).loose()),
});
const bootstrapSchema = z.object({bootstrapUrl: z.url()}).loose();
const openedSchema = z.object({browserUrl: z.url()}).loose();
const capabilitiesSchema = z.object({
  sharing: z.object({default: z.string(), modes: z.array(z.string())}),
}).loose();

type Json = z.infer<typeof jsonSchema>;
type Published = z.infer<typeof publishedSchema>;

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

interface RequestContent {
  readonly bytes?: Uint8Array<ArrayBuffer>;
  readonly idempotencyKey?: string;
  readonly json?: Json;
}

describe("installation public-link policy", () => {
  let installation: TestInstallation;
  let oidc: RunningStubOidcProvider;
  let server: RunningTestServer;
  let serverOptions: NonNullable<Parameters<typeof startTestServer>[1]>;
  let workspace: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    workspace = await mkdtemp(path.join(tmpdir(), "artifact-server-auth-006-"));
    oidc = await startStubOidcProvider({
      clientId: "artifact-server-auth-006",
      clientSecret,
    });
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    serverOptions = {
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
    };
    server = await startTestServer(installation, serverOptions);
  });

  afterEach(async () => {
    await server.stop();
    await oidc.stop();
    await removeTestInstallation(installation);
    await rm(workspace, {force: true, recursive: true});
  });

  test("AUTH-006-F: members, administrators, member-bound and service keys, MCP agents and the CLI cannot make an artifact Public, read one anonymously, or change the policy while public links are off, and no administrator can change a configured policy", async () => {
    const {ada, adaKey, administrator, administratorKey, bob, bobKey, serviceKey} = await setUp();

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

    const organization = await publishNew(ada, "account_required", "organization");
    const hidden = await publishNew(ada, "private", "hidden");
    const serviceOwned = await publishNew(bearer(serviceKey), "account_required", "service");
    const stored = await publishNew(ada, "public_link", "stored");
    const lowered = await publishNew(ada, "public_link", "lowered");

    expect(await call(administrator, "PUT", {publicLinksEnabled: false})).toEqual({
      body: {publicArtifactCount: 2, publicLinksEnabled: false, setByConfiguration: false},
      status: 200,
    });
    expect((await call(administrator, "PUT", {extra: true, publicLinksEnabled: true})).status)
      .toBe(422);
    expect((await readSession(ada)).installation.publicLinksEnabled).toBe(false);
    expect(await sharing(adaKey)).toEqual({
      default: "private",
      modes: ["private", "account_required"],
    });

    const raises = [
      await changeLevel(ada, organization, "public_link", "ada-session-raise"),
      await changeLevel(bearer(adaKey), organization, "public_link", "ada-key-raise"),
      await changeLevel(administrator, serviceOwned, "public_link", "administrator-raise"),
      await changeLevel(bearer(serviceKey), serviceOwned, "public_link", "service-raise"),
    ];
    expect(raises.map(outcome)).toEqual(raises.map(() => disabled));
    expect(failureSchema.parse(raises[0]?.body).error.message)
      .toBe("An administrator has turned off public links for this installation.");
    const byTool = await callTool(adaKey, "artifact_set_visibility", {
      accessSetting: "public_link",
      artifactId: organization.artifact.id,
      expectedCurrentVersionId: organization.version.id,
      idempotencyKey: "auth-006-mcp-raise",
    });
    expect(mcpToolErrorCode(byTool)).toBe(disabled.code);
    expect([
      await levelOf(bearer(adaKey), organization),
      await levelOf(bearer(serviceKey), serviceOwned),
    ]).toEqual(["account_required", "account_required"]);

    expect([
      outcome(await changeLevel(bob, organization, "public_link", "bob-raise")),
      outcome(await changeLevel(bob, hidden, "public_link", "bob-raise-private")),
    ]).toEqual([
      {code: "AUTHORIZATION_DENIED", status: 403},
      {code: "ARTIFACT_NOT_FOUND", status: 404},
    ]);
    expect([
      (await changeLevel(ada, lowered, "account_required", "ada-lower")).status,
      (await changeLevel(administrator, lowered, "private", "administrator-lower")).status,
    ]).toEqual([200, 200]);
    const kept = await changeLevel(ada, stored, "public_link", "ada-keep-public");
    expect(kept.status).toBe(200);
    expect(artifactSchema.parse(kept.body).artifact.accessSetting).toBe("public_link");

    const upload = await stage(bearer(adaKey), "<h1>Ada's upload</h1>");
    const refusedCommit = await commit(
      bearer(adaKey),
      upload.commitUrl,
      newArtifact("public_link", "Ada's upload"),
      "auth-006-commit-public",
    );
    expect(outcome(refusedCommit)).toEqual(disabled);
    const privateCommit = await commit(
      bearer(adaKey),
      upload.commitUrl,
      newArtifact("private", "Ada's upload"),
      "auth-006-commit-private",
    );
    expect(privateCommit.status).toBe(201);
    expect(publishedSchema.parse(privateCommit.body).artifact.accessSetting).toBe("private");

    const before = await listIds(adaKey);
    const toolUpload = await stage(bearer(adaKey), "<h1>Ada over MCP</h1>");
    const toolCommit = await callTool(adaKey, "artifact_commit_upload", {
      idempotencyKey: "auth-006-mcp-commit",
      target: newArtifact("public_link", "Ada over MCP"),
      uploadId: toolUpload.uploadId,
    });
    expect(mcpToolErrorCode(toolCommit)).toBe(disabled.code);
    const fixture = path.join(workspace, "public.html");
    await writeFile(fixture, "<h1>Ada over the CLI</h1>");
    const cli = await runCli(adaKey, [
      "publish",
      fixture,
      "--public",
      "--profile-data",
      path.join(workspace, "profiles"),
    ]);
    expect(cli.exitCode).not.toBe(0);
    expect(cli.stderr).toContain(disabled.code);
    expect(await listIds(adaKey)).toEqual(before);

    const anonymousPublic = await anonymousOpen(stored.artifact.id);
    expect(anonymousPublic).toMatchObject({
      cacheControl: "private, no-store",
      code: "CONTENT_NOT_PUBLIC",
      status: 401,
    });
    expect(anonymousPublic).toEqual(await anonymousOpen(organization.artifact.id));
    const versionUrl = stored.links.version;
    const etag = `"${createHash("sha256").update(html("stored")).digest("hex")}"`;
    const conditional = {"If-None-Match": etag};
    const origin = await Promise.all([
      fetchVersion(server, versionUrl),
      fetchVersion(server, versionUrl, "HEAD"),
      fetchVersion(server, versionUrl, "GET", conditional),
    ].map(async (response) => contentOutcome(await response)));
    expect(origin.map(({status}) => status)).toEqual([401, 401, 401]);
    expect(origin.slice(0, 2)).toEqual(await Promise.all([
      fetchVersion(server, organization.links.version),
      fetchVersion(server, organization.links.version, "HEAD"),
    ].map(async (response) => contentOutcome(await response))));

    const issued = await request(ada, "POST", `/api/v1/artifacts/${stored.artifact.id}/content-sessions`);
    expect(issued.status).toBe(201);
    const exchange = await fetchVersion(
      server,
      bootstrapSchema.parse(await issued.json()).bootstrapUrl,
    );
    expect(exchange.status).toBe(200);
    const contentCookie = exchange.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const signedIn = await fetchVersion(server, versionUrl, "GET", {Cookie: contentCookie});
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("cache-control")).toBe("private, no-store");
    const opened = openedSchema.parse(
      (await callTool(adaKey, "artifact_open", {artifactId: stored.artifact.id}))
        .result?.structuredContent,
    );
    expect(opened.browserUrl).toContain("__artifact_bootstrap=");
    expect(opened.browserUrl).not.toContain(`/artifacts/${stored.artifact.id}`);

    expect((await call(administrator, "PUT", {publicLinksEnabled: true})).status).toBe(200);
    expect((await anonymousOpen(stored.artifact.id)).status).toBe(302);
    expect((await sharing(adaKey)).modes.at(-1)).toBe("public_link");
    const reopened = await fetchVersion(server, versionUrl);
    expect(reopened.status).toBe(200);
    expect(reopened.headers.get("cache-control")).toBe("public, no-cache, must-revalidate");
    expect((await fetchVersion(server, versionUrl, "GET", conditional)).status).toBe(304);
    expect(await call(administrator, "GET")).toEqual({
      body: {publicArtifactCount: 1, publicLinksEnabled: true, setByConfiguration: false},
      status: 200,
    });

    await restart({publicLinksEnabled: false});
    expect(await call(administrator, "GET")).toEqual({
      body: {publicArtifactCount: 1, publicLinksEnabled: false, setByConfiguration: true},
      status: 200,
    });
    const lockedChanges = [
      await call(administrator, "PUT", {publicLinksEnabled: true}),
      await call(administrator, "PUT", {publicLinksEnabled: false}),
    ];
    expect(lockedChanges.map(outcome)).toEqual(lockedChanges.map(() => locked));
    expect(failureSchema.parse(lockedChanges[0]?.body).error.message).toBe(
      "ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED in the server configuration sets this policy. Change it there.",
    );
    expect(outcome(await call(bob, "PUT", {publicLinksEnabled: true})))
      .toEqual({code: "AUTHORIZATION_DENIED", status: 403});
    expect(outcome(await changeLevel(ada, organization, "public_link", "ada-locked-raise")))
      .toEqual(disabled);
    expect((await anonymousOpen(stored.artifact.id)).status).toBe(401);
    expect((await readSession(ada)).installation.publicLinksEnabled).toBe(false);
    expect((await sharing(adaKey)).modes).not.toContain("public_link");

    await restart();
    expect(await call(administrator, "GET")).toEqual({
      body: {publicArtifactCount: 1, publicLinksEnabled: true, setByConfiguration: false},
      status: 200,
    });
    expect((await call(administrator, "PUT", {publicLinksEnabled: false})).status).toBe(200);
    await restart({publicLinksEnabled: true});
    expect(await call(administrator, "GET")).toEqual({
      body: {publicArtifactCount: 1, publicLinksEnabled: true, setByConfiguration: true},
      status: 200,
    });
    expect((await anonymousOpen(stored.artifact.id)).status).toBe(302);
    expect(outcome(await call(administrator, "PUT", {publicLinksEnabled: false}))).toEqual(locked);

    await restart();
    expect(await call(administrator, "GET")).toEqual({
      body: {publicArtifactCount: 1, publicLinksEnabled: false, setByConfiguration: false},
      status: 200,
    });
  });

  test("public-link policy: a publish that succeeded as Public before the switch turned off replays its original result and stays closed to anonymous readers", async () => {
    const {adaKey, administrator} = await setUp();
    const credential = bearer(adaKey);
    const upload = await stage(credential, "<h1>Ada's replayed plan</h1>");
    const target = newArtifact("public_link", "Ada's replayed plan");
    const first = await commit(credential, upload.commitUrl, target, "auth-006-replay-original");
    expect(first.status).toBe(201);
    const original = publishedSchema.parse(first.body);

    expect((await call(administrator, "PUT", {publicLinksEnabled: false})).status).toBe(200);
    const replay = await commit(credential, upload.commitUrl, target, "auth-006-replay-original");
    expect(replay.status).toBe(200);
    expect(publishedSchema.parse(replay.body)).toMatchObject({
      artifact: {accessSetting: "public_link", id: original.artifact.id},
      replayed: true,
      version: {id: original.version.id},
    });
    expect((await anonymousOpen(original.artifact.id)).status).toBe(401);
    expect(outcome(await commit(credential, upload.commitUrl, target, "auth-006-replay-new")))
      .toEqual(disabled);
  });

  async function setUp() {
    const administratorCookies = await signIn(administratorEmail, "administrator");
    const administrator = session(administratorCookies);
    const administratorId = (await readSession(administrator)).principal.id;
    const adaId = await admitMember(server, administratorCookies, "Ada", "ada@example.test");
    const bobId = await admitMember(server, administratorCookies, "Bob", "bob@example.test");
    const [ada, bob] = [
      session(await signIn("ada@example.test", "ada")),
      session(await signIn("bob@example.test", "bob")),
    ];
    const [adaKey, administratorKey, bobKey, serviceKey] = await Promise.all([
      issueApiKey(server, administratorCookies, keyCapabilities, "Ada's agent", adaId),
      issueApiKey(server, administratorCookies, keyCapabilities, "Administrator's agent", administratorId),
      issueApiKey(server, administratorCookies, keyCapabilities, "Bob's agent", bobId),
      issueApiKey(server, administratorCookies, keyCapabilities, "Release bot"),
    ]);
    return {ada, adaKey, administrator, administratorKey, bob, bobKey, serviceKey};
  }

  async function restart(configured: {readonly publicLinksEnabled?: boolean} = {}) {
    await server.stop();
    server = await startTestServer(installation, {...serverOptions, ...configured});
  }

  async function readSession(credential: Credential) {
    const response = await request(credential, "GET", "/api/v1/session");
    expect(response.status).toBe(200);
    return sessionSchema.parse(await response.json());
  }

  async function call(credential: Credential, method: "GET" | "PUT", json?: Json): Promise<Answer> {
    return answer(await request(
      credential,
      method,
      policyPath,
      json === undefined ? {} : {json},
    ));
  }

  async function publishNew(credential: Credential, accessSetting: AccessSetting, label: string) {
    const upload = await stage(credential, html(label));
    const committed = await commit(
      credential,
      upload.commitUrl,
      newArtifact(accessSetting, label),
      `auth-006-publish-${label}`,
    );
    expect(committed.status).toBe(201);
    return publishedSchema.parse(committed.body);
  }

  async function stage(credential: Credential, content: string) {
    const bytes = new TextEncoder().encode(content);
    const created = await request(credential, "POST", "/api/v1/uploads", {
      json: {
        entryPath: "index.html",
        files: [{
          mediaType: "text/html",
          path: "index.html",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        }],
        projectId,
      },
    });
    expect(created.status).toBe(201);
    const plan = uploadPlanSchema.parse(await created.json());
    const uploaded = await Promise.all(plan.files.map((file) =>
      request(credential, "PUT", file.uploadUrl, {bytes})
    ));
    expect(uploaded.map(({status}) => status)).toEqual(plan.files.map(() => 200));
    return plan;
  }

  async function commit(
    credential: Credential,
    commitUrl: string,
    target: Json,
    idempotencyKey: string,
  ): Promise<Answer> {
    return answer(await request(credential, "POST", commitUrl, {
      idempotencyKey,
      json: {target},
    }));
  }

  async function changeLevel(
    credential: Credential,
    published: Published,
    accessSetting: AccessSetting,
    label: string,
  ): Promise<Answer> {
    return answer(await request(
      credential,
      "PATCH",
      `/api/v1/artifacts/${published.artifact.id}/access`,
      {
        idempotencyKey: `auth-006-${label}`,
        json: {accessSetting, expectedCurrentVersionId: published.version.id},
      },
    ));
  }

  async function levelOf(credential: Credential, published: Published): Promise<string> {
    const response = await request(credential, "GET", `/api/v1/artifacts/${published.artifact.id}`);
    expect(response.status).toBe(200);
    return artifactSchema.parse(await response.json()).artifact.accessSetting;
  }

  async function listIds(token: string): Promise<readonly string[]> {
    const response = await request(bearer(token), "GET", `/api/v1/artifacts?projectId=${projectId}`);
    expect(response.status).toBe(200);
    return listSchema.parse(await response.json()).artifacts.map(({artifact}) => artifact.id);
  }

  async function anonymousOpen(artifactId: string) {
    const response = await fetch(`${server.baseUrl}/artifacts/${artifactId}`, {
      redirect: "manual",
    });
    const reply = await answer(response);
    const failure = failureSchema.safeParse(reply.body).data?.error;
    return {
      cacheControl: response.headers.get("cache-control"),
      code: failure?.code,
      message: failure?.message,
      status: reply.status,
    };
  }

  function callTool(
    token: string,
    name: string,
    parameters: Readonly<Record<string, Json>>,
  ): Promise<McpReply> {
    return callMcp(server, token, "tools/call", name, {arguments: parameters, name});
  }

  async function sharing(token: string) {
    const reply = await callTool(token, "artifact_capabilities", {});
    return capabilitiesSchema.parse(reply.result?.structuredContent).sharing;
  }

  function runCli(token: string, argumentsToPass: readonly string[]) {
    return new Promise<{exitCode: number; stderr: string}>((resolve, reject) => {
      const child = spawn(cliExecutable, [cliEntrypoint, ...argumentsToPass], {
        cwd: workspace,
        env: {
          ...process.env,
          ARTIFACT_SERVER_API_TOKEN: token,
          ARTIFACT_SERVER_URL: server.baseUrl,
        },
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 30_000,
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({
        exitCode: code ?? -1,
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
  }

  function request(
    credential: Credential,
    method: string,
    pathOrUrl: string,
    content: RequestContent = {},
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
    let body: BodyInit | null = content.bytes ?? null;
    if (content.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(content.json);
    }
    if (content.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", content.idempotencyKey);
    }
    return fetch(new URL(pathOrUrl, server.baseUrl), {body, headers, method});
  }

  function signIn(email: string, subject: string): Promise<ApplicationCookies> {
    return signInWithStubOidc(server.baseUrl, oidc, email, `auth-006-${subject}`);
  }
});

function html(label: string): string {
  return `<!doctype html><title>Ada's ${label} plan</title>`;
}

function newArtifact(accessSetting: AccessSetting, name: string) {
  return {accessSetting, kind: "new_artifact", name};
}

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

async function contentOutcome(response: Response) {
  return {
    cacheControl: response.headers.get("cache-control"),
    ...outcome(await answer(response)),
  };
}

function outcome(reply: Answer) {
  return {code: failureSchema.safeParse(reply.body).data?.error.code, status: reply.status};
}
