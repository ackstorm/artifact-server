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
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {admitMember, callMcp, issueApiKey} from "../support/agent-dispatch.js";
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
const projectId = "prj_default";
const keyCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
];
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliExecutable = path.join(repositoryRoot, "node_modules/.bin/tsx");
const cliEntrypoint = path.join(repositoryRoot, "src/cli/main.ts");

const publishedSchema = z.object({
  artifact: z.object({
    accessSetting: z.string(),
    id: z.string(),
    ownerPrincipalId: z.string(),
  }).loose(),
  version: z.object({id: z.string(), publisherPrincipalId: z.string()}).loose(),
}).loose();
const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({uploadUrl: z.url()})),
  uploadId: z.string(),
});
const listSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()}).loose()}).loose()),
});

type Published = z.infer<typeof publishedSchema>;

type Credential =
  | {readonly kind: "bearer"; readonly token: string}
  | {readonly kind: "session"; readonly cookies: ApplicationCookies};

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

interface RequestContent {
  readonly bytes?: Uint8Array<ArrayBuffer>;
  readonly idempotencyKey?: string;
  readonly json?: string;
}

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

describe("private artifacts by default", () => {
  let installation: TestInstallation;
  let oidc: RunningStubOidcProvider;
  let server: RunningTestServer;
  let workspace: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    workspace = await mkdtemp(path.join(tmpdir(), "artifact-server-auth-032-"));
    oidc = await startStubOidcProvider({
      clientId: "artifact-server-auth-032",
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
    await rm(workspace, {force: true, recursive: true});
  });

  test("AUTH-032-B: new artifacts from HTTP, MCP and the CLI are Private and owned by the version 1 publisher, and a member-bound key's artifact belongs to its member", async () => {
    const {adaId, adaKey, serviceKey} = await setUp();

    const byHttp = await commitNew(bearer(adaKey), "Ada over HTTP", "auth-032-http-commit");
    const byService = await commitNew(bearer(serviceKey), "Service over HTTP", "auth-032-service-commit");
    const mcpPlan = await stage(bearer(adaKey), "<h1>Ada over MCP</h1>");
    const byMcp = publishedSchema.parse((await callMcp(
      server,
      adaKey,
      "tools/call",
      "artifact_commit_upload",
      {
        arguments: {
          idempotencyKey: "auth-032-mcp-commit",
          target: {kind: "new_artifact", name: "Ada over MCP"},
          uploadId: mcpPlan.uploadId,
        },
        name: "artifact_commit_upload",
      },
    )).result?.structuredContent);
    const byCli = await cliPublish(adaKey, "default", []);
    const byCliOrganization = await cliPublish(adaKey, "organization", ["--organization"]);
    const byCliPublic = await cliPublish(adaKey, "public", ["--public"]);

    expect([byHttp, byMcp, byCli].map(({artifact}) => artifact)).toMatchObject([
      {accessSetting: "private", ownerPrincipalId: adaId},
      {accessSetting: "private", ownerPrincipalId: adaId},
      {accessSetting: "private", ownerPrincipalId: adaId},
    ]);
    expect(byService.artifact).toMatchObject({
      accessSetting: "private",
      ownerPrincipalId: byService.version.publisherPrincipalId,
    });
    expect(byService.artifact.ownerPrincipalId).not.toBe(adaId);
    expect([byCliOrganization, byCliPublic].map(({artifact}) => artifact)).toMatchObject([
      {accessSetting: "account_required", ownerPrincipalId: adaId},
      {accessSetting: "public_link", ownerPrincipalId: adaId},
    ]);
  });

  test("AUTH-032-F: a later publisher never changes the owner, and the CLI refuses --public with --organization and creates nothing", async () => {
    const {adaId, adaKey, administrator, serviceKey} = await setUp();

    const service = await commitNew(bearer(serviceKey), "Release notes", "auth-032-service-commit");
    const serviceOwner = service.artifact.ownerPrincipalId;
    const moderated = await commitVersion(administrator, service, "auth-032-admin-version-2");
    expect(moderated.version.publisherPrincipalId).not.toBe(serviceOwner);
    expect(moderated.artifact).toMatchObject({
      accessSetting: "private",
      ownerPrincipalId: serviceOwner,
    });

    const ada = await commitNew(bearer(adaKey), "Ada's plan", "auth-032-ada-commit");
    const revised = await commitVersion(bearer(adaKey), ada, "auth-032-ada-version-2");
    expect(revised.artifact).toMatchObject({accessSetting: "private", ownerPrincipalId: adaId});

    const before = await listIds(adaKey);
    const fixture = path.join(workspace, "conflict.html");
    await writeFile(fixture, "<h1>Both levels</h1>");
    const refused = await runCli(adaKey, [
      "publish",
      fixture,
      "--public",
      "--organization",
      "--profile-data",
      path.join(workspace, "profiles"),
    ]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("option '--public' cannot be used with option '--organization'");
    expect(refused.stdout).toBe("");
    expect(await listIds(adaKey)).toEqual(before);
  });

  async function setUp() {
    const administrator = await signInWithStubOidc(
      server.baseUrl,
      oidc,
      administratorEmail,
      "auth-032-administrator",
    );
    const adaId = await admitMember(server, administrator, "Ada", "ada@example.test");
    const [adaKey, serviceKey] = await Promise.all([
      issueApiKey(server, administrator, keyCapabilities, "Ada's agent", adaId),
      issueApiKey(server, administrator, keyCapabilities, "Release bot"),
    ]);
    return {adaId, adaKey, administrator: session(administrator), serviceKey};
  }

  async function stage(credential: Credential, content: string) {
    const bytes = new TextEncoder().encode(content);
    const created = await request(credential, "POST", "/api/v1/uploads", {
      json: JSON.stringify({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html",
          path: "index.html",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        }],
        projectId,
      }),
    });
    expect(created.status).toBe(201);
    const plan = uploadPlanSchema.parse(await created.json());
    const uploaded = await Promise.all(plan.files.map((file) =>
      request(credential, "PUT", file.uploadUrl, {bytes})
    ));
    expect(uploaded.map(({status}) => status)).toEqual(plan.files.map(() => 200));
    return plan;
  }

  async function commitNew(
    credential: Credential,
    name: string,
    idempotencyKey: string,
  ): Promise<Published> {
    const plan = await stage(credential, `<h1>${name}</h1>`);
    return commit(credential, plan.commitUrl, {kind: "new_artifact", name}, idempotencyKey);
  }

  async function commitVersion(
    credential: Credential,
    published: Published,
    idempotencyKey: string,
  ): Promise<Published> {
    const plan = await stage(credential, `<h1>${idempotencyKey}</h1>`);
    return commit(credential, plan.commitUrl, {
      artifactId: published.artifact.id,
      expectedCurrentVersionId: published.version.id,
      kind: "new_version",
    }, idempotencyKey);
  }

  async function commit(
    credential: Credential,
    commitUrl: string,
    target: Readonly<Record<string, string>>,
    idempotencyKey: string,
  ): Promise<Published> {
    const response = await request(
      credential,
      "POST",
      commitUrl,
      {idempotencyKey, json: JSON.stringify({target})},
    );
    expect(response.status).toBe(201);
    return publishedSchema.parse(await response.json());
  }

  async function listIds(token: string): Promise<readonly string[]> {
    const response = await request(
      bearer(token),
      "GET",
      `/api/v1/artifacts?projectId=${projectId}`,
    );
    expect(response.status).toBe(200);
    return listSchema.parse(await response.json()).artifacts.map(({artifact}) => artifact.id);
  }

  async function cliPublish(
    token: string,
    label: string,
    flags: readonly string[],
  ): Promise<Published> {
    const fixture = path.join(workspace, `${label}.html`);
    await writeFile(fixture, `<h1>Ada over the CLI, ${label}</h1>`);
    const result = await runCli(token, [
      "publish",
      fixture,
      ...flags,
      "--profile-data",
      path.join(workspace, "profiles"),
    ]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    return publishedSchema.parse(JSON.parse(result.stdout));
  }

  function runCli(token: string, argumentsToPass: readonly string[]): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(cliExecutable, [cliEntrypoint, ...argumentsToPass], {
        cwd: workspace,
        env: {
          ...process.env,
          ARTIFACT_SERVER_API_TOKEN: token,
          ARTIFACT_SERVER_URL: server.baseUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({
        exitCode: code ?? -1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
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
    if (content.json !== undefined) headers.set("Content-Type", "application/json");
    if (content.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", content.idempotencyKey);
    }
    const body = content.json ?? content.bytes ?? null;
    return fetch(new URL(pathOrUrl, server.baseUrl), {body, headers, method});
  }
});

function bearer(token: string): Credential {
  return {kind: "bearer", token};
}

function session(cookies: ApplicationCookies): Credential {
  return {cookies, kind: "session"};
}
