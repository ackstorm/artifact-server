import {createHash} from "node:crypto";

import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {
  admitMember,
  ApiClient,
  callMcp,
  issueApiKey,
  type McpReply,
  mcpToolErrorCode,
} from "../support/agent-dispatch.js";
import {publishNew, publishVersion} from "../support/publishing.js";
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
const memberKeyCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
];
const publisherCapabilities = [
  "artifact:create",
  "artifact:publish:any",
  "artifact:read",
];
const outsiderCapabilities = [
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
];
const blockedWarning =
  "New public requests are blocked. Copies already downloaded or cached outside Artifact Server cannot be recalled.";

const jsonSchema = z.json();
const artifactSchema = z.object({
  accessSetting: z.string(),
  currentVersionId: z.string(),
  reviewMode: z.string(),
  tags: z.array(z.string()),
}).loose();
const stateSchema = z.object({
  artifact: artifactSchema,
  warning: z.string().nullable().optional(),
}).loose();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

type Level = "private" | "account_required" | "public_link";

type Credential =
  | {readonly kind: "bearer"; readonly token: string}
  | {readonly kind: "session"; readonly cookies: ApplicationCookies};

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

type Json = z.infer<typeof jsonSchema>;

interface Answer {
  readonly body: Json;
  readonly status: number;
}

interface RequestContent {
  bytes?: Uint8Array<ArrayBuffer>;
  idempotencyKey?: string;
  json?: Json;
}

interface Target {
  readonly artifactId: string;
  readonly currentVersionId: string;
  readonly firstVersionId: string;
}

describe("artifact control by owner", () => {
  let installation: TestInstallation;
  let oidc: RunningStubOidcProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    oidc = await startStubOidcProvider({
      clientId: "artifact-server-auth-035",
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

  test("AUTH-035-B: the owner publishes, tags, restores, sets review mode and raises the level, and an administrator lowers any level and manages service-owned artifacts", async () => {
    const {ada, adaKey, administrator, bobKey, serviceKey} = await setUp();
    const first = await publishNew(server, {...installation, apiToken: adaKey}, {
      accessSetting: "private",
      content: "<!doctype html><title>Ada's plan</title>",
      idempotencyKey: "auth-035-ada-first",
      name: "Ada's plan",
      projectId,
    });
    const artifactId = first.body.artifact.id;
    const owned = {
      artifactId,
      currentVersionId: first.body.artifact.currentVersionId,
      firstVersionId: first.body.version.id,
    };
    const bySession = await changeAsOwner(ada, owned, "session", "interact");
    const current = await changeAsOwner(
      bearer(adaKey),
      {...owned, currentVersionId: bySession},
      "key",
      "annotate",
    );

    const shared = await changeLevel(ada, artifactId, current, "account_required", "ada-raise-1");
    expect(shared.artifact.accessSetting).toBe("account_required");
    const opened = await changeLevel(bearer(adaKey), artifactId, current, "public_link", "ada-raise-2");
    expect(opened).toMatchObject({artifact: {accessSetting: "public_link"}, warning: null});

    const lowered = await changeLevel(administrator, artifactId, current, "account_required", "admin-lower-1");
    expect(lowered).toMatchObject({
      artifact: {accessSetting: "account_required"},
      warning: blockedWarning,
    });
    const kept = await changeLevel(administrator, artifactId, current, "account_required", "admin-same-level");
    expect(kept.artifact.accessSetting).toBe("account_required");
    const hidden = await changeLevel(administrator, artifactId, current, "private", "admin-lower-2");
    expect(hidden.artifact.accessSetting).toBe("private");
    await changeLevel(bearer(adaKey), artifactId, current, "public_link", "ada-raise-3");
    const closed = await changeLevel(administrator, artifactId, current, "private", "admin-lower-3");
    expect(closed).toMatchObject({artifact: {accessSetting: "private"}, warning: blockedWarning});

    const service = await publishNew(server, {...installation, apiToken: serviceKey}, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Release notes</title>",
      idempotencyKey: "auth-035-service-first",
      name: "Release notes",
      projectId,
    });
    const serviceId = service.body.artifact.id;
    const moderated = state(await publish(
      administrator,
      serviceId,
      service.body.artifact.currentVersionId,
      "<!doctype html><title>Release notes, edited</title>",
      "auth-035-admin-service-publish",
    ), 201);
    const adminTagged = state(await send(administrator, "PATCH", `${serviceId}/tags`, {
      expectedCurrentVersionId: moderated.artifact.currentVersionId,
      tags: ["moderated"],
    }, "auth-035-admin-service-tags"));
    expect(adminTagged.artifact.tags).toEqual(["moderated"]);

    const serviceCredential = bearer(serviceKey);
    const serviceTagged = state(await send(serviceCredential, "PATCH", `${serviceId}/tags`, {
      expectedCurrentVersionId: moderated.artifact.currentVersionId,
      tags: ["release"],
    }, "auth-035-service-own-tags"));
    expect(serviceTagged.artifact.tags).toEqual(["release"]);
    const serviceRestored = state(await send(serviceCredential, "POST", `${serviceId}/restore`, {
      expectedCurrentVersionId: moderated.artifact.currentVersionId,
      versionId: service.body.version.id,
    }, "auth-035-service-own-restore"));
    const servicePublic = await changeLevel(
      serviceCredential,
      serviceId,
      serviceRestored.artifact.currentVersionId,
      "public_link",
      "service-own-raise",
    );
    expect(servicePublic.artifact.accessSetting).toBe("public_link");
    const bobThread = await new ApiClient(server, bobKey).openThread(
      service.body,
      "Bob reviews the release notes.",
      "auth-035-bob-service-thread",
    );
    const serviceDeletes = await send(
      serviceCredential,
      "DELETE",
      `${serviceId}/comments/${bobThread.id}`,
    );
    expect(serviceDeletes.status).toBe(204);
  });

  test("AUTH-035-F: another member, a non-owning manage:any and publish:any key, and an administrator raising or publishing are refused, with 404 on a Private artifact", async () => {
    const {ada, administrator, adaKey, bob, bobKey, outsiderKey, publisherKey} = await setUp();
    const organization = await publishTwice(adaKey, "account_required", "organization");
    const hidden = await publishTwice(adaKey, "private", "private");
    const missing: Target = {...hidden, artifactId: "art_auth035_missing"};

    const refused: readonly [string, Credential][] = [
      ["bob-session", bob],
      ["bob-key", bearer(bobKey)],
      ["outsider-key", bearer(outsiderKey)],
    ];
    const onOrganization = await Promise.all(refused.map(([label, credential]) =>
      attemptEveryChange(credential, organization, "public_link", "private", `org-${label}`)
    ));
    expect(onOrganization.flat().map(outcome)).toEqual(
      onOrganization.flat().map(() => ({code: "AUTHORIZATION_DENIED", status: 403})),
    );

    const [onPrivate, onMissing] = await Promise.all([
      Promise.all(refused.map(([label, credential]) =>
        attemptEveryChange(credential, hidden, "account_required", "private", `private-${label}`)
      )),
      Promise.all(refused.map(([label, credential]) =>
        attemptEveryChange(credential, missing, "account_required", "private", `missing-${label}`)
      )),
    ]);
    expect(onPrivate.flat().map(outcome)).toEqual(
      onPrivate.flat().map(() => ({code: "ARTIFACT_NOT_FOUND", status: 404})),
    );
    expect(onPrivate).toEqual(onMissing);

    const administratorAttempts = [
      await send(administrator, "PATCH", `${organization.artifactId}/access`, {
        accessSetting: "public_link",
        expectedCurrentVersionId: organization.currentVersionId,
      }, "auth-035-admin-raise-organization"),
      await publish(
        administrator,
        organization.artifactId,
        organization.currentVersionId,
        "<!doctype html><title>Administrator edit</title>",
        "auth-035-admin-publish-organization",
      ),
    ];
    expect(administratorAttempts.map(outcome)).toEqual([
      {code: "AUTHORIZATION_DENIED", status: 403},
      {code: "AUTHORIZATION_DENIED", status: 403},
    ]);

    // Owning an artifact adds to the capability gates and replaces none: a
    // key without manage authority publishes its own artifact and changes
    // nothing else on it.
    const ownedWithoutManage = await publishTwice(publisherKey, "account_required", "publisher");
    const [ownPublish, ...withoutManage] = await attemptEveryChange(
      bearer(publisherKey),
      ownedWithoutManage,
      "public_link",
      "private",
      "publisher",
    );
    expect(ownPublish?.status).toBe(201);
    expect(withoutManage.map(outcome)).toEqual(
      withoutManage.map(() => ({code: "AUTHORIZATION_DENIED", status: 403})),
    );

    const toolsOnOrganization = await callEveryChangeTool(bobKey, organization, "mcp-org");
    expect(toolsOnOrganization.map(mcpToolErrorCode))
      .toEqual(toolsOnOrganization.map(() => "AUTHORIZATION_DENIED"));
    const [toolsOnPrivate, toolsOnMissing] = await Promise.all([
      callEveryChangeTool(bobKey, hidden, "mcp-private"),
      callEveryChangeTool(bobKey, missing, "mcp-missing"),
    ]);
    expect(toolsOnPrivate.map(mcpToolErrorCode))
      .toEqual(toolsOnPrivate.map(() => "ARTIFACT_NOT_FOUND"));
    expect(toolsOnPrivate).toEqual(toolsOnMissing);

    const bobThread = await send(
      bob,
      "POST",
      `${organization.artifactId}/versions/${organization.currentVersionId}/comments`,
      {body: "Bob reviews Ada's plan."},
      "auth-035-bob-organization-thread",
    );
    expect(bobThread.status).toBe(201);
    const threadId = z.object({thread: z.object({id: z.string()})})
      .parse(bobThread.body).thread.id;
    const outsiderDeletes = await send(
      bearer(outsiderKey),
      "DELETE",
      `${organization.artifactId}/comments/${threadId}`,
    );
    expect(outcome(outsiderDeletes)).toEqual({code: "AUTHORIZATION_DENIED", status: 403});
    expect((await send(ada, "GET", `${organization.artifactId}/comments/${threadId}`)).status)
      .toBe(200);

    const unchanged = await Promise.all([organization, hidden].map(async (target) =>
      z.object({artifact: artifactSchema}).parse(
        (await send(bearer(adaKey), "GET", target.artifactId)).body,
      ).artifact
    ));
    expect(unchanged).toMatchObject([
      {
        accessSetting: "account_required",
        currentVersionId: organization.currentVersionId,
        reviewMode: "annotate",
        tags: [],
      },
      {
        accessSetting: "private",
        currentVersionId: hidden.currentVersionId,
        reviewMode: "annotate",
        tags: [],
      },
    ]);
  });

  async function setUp() {
    const administrator = await signIn(administratorEmail, "administrator");
    const adaId = await admitMember(server, administrator, "Ada", "ada@example.test");
    const bobId = await admitMember(server, administrator, "Bob", "bob@example.test");
    const ada = await signIn("ada@example.test", "ada");
    const bob = await signIn("bob@example.test", "bob");
    const [adaKey, bobKey, serviceKey, outsiderKey, publisherKey] = await Promise.all([
      issueApiKey(server, administrator, memberKeyCapabilities, "Ada's agent", adaId),
      issueApiKey(server, administrator, memberKeyCapabilities, "Bob's agent", bobId),
      issueApiKey(server, administrator, memberKeyCapabilities, "Release bot"),
      issueApiKey(server, administrator, outsiderCapabilities, "Outside manager"),
      issueApiKey(server, administrator, publisherCapabilities, "Publisher without manage"),
    ]);
    return {
      ada: session(ada),
      adaKey,
      administrator: session(administrator),
      bob: session(bob),
      bobKey,
      outsiderKey,
      publisherKey,
      serviceKey,
    };
  }

  async function publishTwice(token: string, accessSetting: Level, label: string): Promise<Target> {
    const owner = {...installation, apiToken: token};
    const first = await publishNew(server, owner, {
      accessSetting,
      content: `<!doctype html><title>Ada's ${label} plan</title>`,
      idempotencyKey: `auth-035-${label}-first`,
      name: `Ada's ${label} plan`,
      projectId,
    });
    const second = await publishVersion(server, owner, {
      artifactId: first.body.artifact.id,
      content: `<!doctype html><title>Ada's ${label} plan, revised</title>`,
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: `auth-035-${label}-second`,
      projectId,
    });
    return {
      artifactId: first.body.artifact.id,
      currentVersionId: second.body.version.id,
      firstVersionId: first.body.version.id,
    };
  }

  async function changeAsOwner(
    credential: Credential,
    target: Target,
    label: string,
    reviewMode: "annotate" | "interact",
  ): Promise<string> {
    const {artifactId} = target;
    const published = state(await publish(
      credential,
      artifactId,
      target.currentVersionId,
      `<!doctype html><title>Ada's plan by ${label}</title>`,
      `auth-035-ada-publish-${label}`,
    ), 201);
    expect(published.artifact.currentVersionId).not.toBe(target.currentVersionId);
    const tagged = state(await send(credential, "PATCH", `${artifactId}/tags`, {
      expectedCurrentVersionId: published.artifact.currentVersionId,
      tags: [label],
    }, `auth-035-ada-tags-${label}`));
    expect(tagged.artifact.tags).toEqual([label]);
    const restored = state(await send(credential, "POST", `${artifactId}/restore`, {
      expectedCurrentVersionId: tagged.artifact.currentVersionId,
      versionId: target.firstVersionId,
    }, `auth-035-ada-restore-${label}`));
    expect(restored.artifact.currentVersionId).toBe(target.firstVersionId);
    const reviewed = state(await send(credential, "PATCH", `${artifactId}/review-mode`, {
      expectedCurrentVersionId: restored.artifact.currentVersionId,
      reviewMode,
    }, `auth-035-ada-review-${label}`));
    expect(reviewed.artifact.reviewMode).toBe(reviewMode);
    return reviewed.artifact.currentVersionId;
  }

  async function attemptEveryChange(
    credential: Credential,
    target: Target,
    raiseTo: Level,
    lowerTo: Level,
    label: string,
  ): Promise<readonly Answer[]> {
    const expectedCurrentVersionId = target.currentVersionId;
    const key = (operation: string) => `auth-035-${label}-${operation}`;
    return [
      await publish(
        credential,
        target.artifactId,
        expectedCurrentVersionId,
        `<!doctype html><title>${label}</title>`,
        key("publish"),
      ),
      await send(credential, "PATCH", `${target.artifactId}/tags`, {
        expectedCurrentVersionId,
        tags: ["taken"],
      }, key("tags")),
      await send(credential, "POST", `${target.artifactId}/restore`, {
        expectedCurrentVersionId,
        versionId: target.firstVersionId,
      }, key("restore")),
      await send(credential, "PATCH", `${target.artifactId}/review-mode`, {
        expectedCurrentVersionId,
        reviewMode: "interact",
      }, key("review-mode")),
      await send(credential, "PATCH", `${target.artifactId}/access`, {
        accessSetting: raiseTo,
        expectedCurrentVersionId,
      }, key("raise")),
      await send(credential, "PATCH", `${target.artifactId}/access`, {
        accessSetting: lowerTo,
        expectedCurrentVersionId,
      }, key("lower")),
    ];
  }

  function callEveryChangeTool(
    token: string,
    target: Target,
    label: string,
  ): Promise<readonly McpReply[]> {
    const common = {
      artifactId: target.artifactId,
      expectedCurrentVersionId: target.currentVersionId,
    };
    const key = (operation: string) => `auth-035-${label}-${operation}`;
    return Promise.all([
      callTool(token, "artifact_set_visibility", {
        ...common,
        accessSetting: "public_link",
        idempotencyKey: key("raise"),
      }),
      callTool(token, "artifact_set_visibility", {
        ...common,
        accessSetting: "private",
        idempotencyKey: key("lower"),
      }),
      callTool(token, "artifact_set_tags", {
        ...common,
        idempotencyKey: key("tags"),
        tags: ["taken"],
      }),
      callTool(token, "artifact_restore_version", {
        ...common,
        idempotencyKey: key("restore"),
        versionId: target.firstVersionId,
      }),
      callTool(token, "artifact_set_review_mode", {
        ...common,
        idempotencyKey: key("review-mode"),
        reviewMode: "interact",
      }),
    ]);
  }

  function callTool(
    token: string,
    name: string,
    parameters: Readonly<Record<string, Json>>,
  ): Promise<McpReply> {
    return callMcp(server, token, "tools/call", name, {arguments: parameters, name});
  }

  async function changeLevel(
    credential: Credential,
    artifactId: string,
    expectedCurrentVersionId: string,
    accessSetting: Level,
    label: string,
  ): Promise<z.infer<typeof stateSchema>> {
    return state(await send(credential, "PATCH", `${artifactId}/access`, {
      accessSetting,
      expectedCurrentVersionId,
    }, `auth-035-${label}-level`));
  }

  async function publish(
    credential: Credential,
    artifactId: string,
    expectedCurrentVersionId: string,
    content: string,
    idempotencyKey: string,
  ): Promise<Answer> {
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
    const plan = z.object({
      commitUrl: z.url(),
      files: z.array(z.object({uploadUrl: z.url()})),
    }).parse(await created.json());
    const uploaded = await Promise.all(plan.files.map((file) =>
      request(credential, "PUT", file.uploadUrl, {bytes})
    ));
    expect(uploaded.map(({status}) => status)).toEqual(plan.files.map(() => 200));
    return answer(await request(credential, "POST", plan.commitUrl, {
      idempotencyKey,
      json: {target: {artifactId, expectedCurrentVersionId, kind: "new_version"}},
    }));
  }

  async function send(
    credential: Credential,
    method: "DELETE" | "GET" | "PATCH" | "POST",
    artifactPath: string,
    json?: Json,
    idempotencyKey?: string,
  ): Promise<Answer> {
    const content: RequestContent = {};
    if (json !== undefined) content.json = json;
    if (idempotencyKey !== undefined) content.idempotencyKey = idempotencyKey;
    return answer(await request(
      credential,
      method,
      `/api/v1/artifacts/${artifactPath}`,
      content,
    ));
  }

  function request(
    credential: Credential,
    method: string,
    pathOrUrl: string,
    content: RequestContent,
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
    return signInWithStubOidc(server.baseUrl, oidc, email, `auth-035-${subject}`);
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

function state(reply: Answer, status = 200): z.infer<typeof stateSchema> {
  expect(reply.status).toBe(status);
  return stateSchema.parse(reply.body);
}

function outcome(reply: Answer) {
  return {code: failureSchema.safeParse(reply.body).data?.error.code, status: reply.status};
}
