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
import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";
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
const adaCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
  "content-session:issue",
];

interface Cookies {
  readonly csrf: string;
  readonly header: string;
}

describe("duplicate", () => {
  let installation: TestInstallation;
  let oidc: RunningStubOidcProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    oidc = await startStubOidcProvider({
      clientId: "artifact-server-art-015",
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

  test("ART-015-F: only readers with creation rights duplicate, replays return the same copy, a reused key conflicts, and the source never changes", async () => {
    const administrator = await signIn(administratorEmail, "administrator");
    const adaId = await admitMember(server, administrator, "Ada", "ada@example.test");
    const bobId = await admitMember(server, administrator, "Bob", "bob@example.test");
    const bob = await signIn("bob@example.test", "bob");
    const adaKey = await issueApiKey(server, administrator, adaCapabilities, "Ada's agent", adaId);
    const bobReadKey = await issueApiKey(
      server, administrator, ["artifact:read"], "Bob reads", bobId,
    );
    const ada = {...installation, apiToken: adaKey};

    const original = await publishNew(server, ada, {
      accessSetting: "account_required",
      content: "<!doctype html><title>first</title>",
      idempotencyKey: "art-015-publish-o",
      name: "O",
      projectId,
      reviewMode: "interact",
      tags: ["alpha", "beta"],
    });
    const originalId = original.body.artifact.id;
    const second = await publishVersion(server, ada, {
      artifactId: originalId,
      content: "<!doctype html><title>second</title>",
      expectedCurrentVersionId: original.body.version.id,
      idempotencyKey: "art-015-publish-o-2",
      projectId,
    });
    const privateOne = await publishNew(server, ada, {
      accessSetting: "private",
      content: "<!doctype html><title>private</title>",
      idempotencyKey: "art-015-publish-p",
      name: "P",
      projectId,
    });
    const comment = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${originalId}/versions/${original.body.version.id}/comments`,
      {
        body: JSON.stringify({body: "Looks good"}),
        headers: {
          Authorization: `Bearer ${adaKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "art-015-comment-1234",
        },
        method: "POST",
      },
    );
    expect(comment.status).toBe(201);
    const sourceState = () => snapshot(adaKey, originalId);
    const before = await sourceState();
    const listBefore = await names(bob);

    expect((await duplicate(bob, privateOne.body.artifact.id, privateOne.body.version.id, "art-015-key-private")).status).toBe(404);
    expect(await names(bob)).toEqual(listBefore);
    const noRights = await fetch(`${server.baseUrl}/api/v1/artifacts/${originalId}/duplicate`, {
      body: JSON.stringify({versionId: original.body.version.id}),
      headers: {
        Authorization: `Bearer ${bobReadKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "art-015-key-norights",
      },
      method: "POST",
    });
    expect(noRights.status).toBe(403);

    const created = await duplicate(bob, originalId, original.body.version.id, "art-015-key-first-copy");
    expect(created.status).toBe(201);
    const copy = copySchema.parse(await created.json());
    expect(copy.replayed).toBe(false);
    expect(copy.artifact).toMatchObject({
      accessSetting: "private",
      name: "O (copy)",
      reviewMode: "interact",
      tags: [],
    });
    expect(copy.version).toMatchObject({
      manifestDigest: original.body.version.manifestDigest,
      number: 1,
      publisherPrincipalId: bobId,
    });
    const details = detailsSchema.parse(await (await get(bob, `/api/v1/artifacts/${copy.artifact.id}`)).json());
    expect(details.artifact.ownerPrincipalId).toBe(bobId);
    const copyVersions = await (await get(bob, `/api/v1/artifacts/${copy.artifact.id}/versions`)).json();
    expect(z.object({versions: z.array(z.unknown())}).parse(copyVersions).versions).toHaveLength(1);
    const copyComments = await (await get(bob, `/api/v1/artifacts/${copy.artifact.id}/comments`)).json();
    expect(z.object({items: z.array(z.unknown())}).parse(copyComments).items).toHaveLength(0);
    const copyActions = z.object({actions: z.array(z.object({
      action: z.string(),
      principalId: z.string(),
    }))}).parse(await (await get(bob, `/api/v1/artifacts/${copy.artifact.id}/actions`)).json());
    expect(copyActions.actions.map(({action, principalId}) => ({action, principalId})))
      .toEqual([{action: "publish", principalId: bobId}]);
    const copyBytes = await (await fetchLoopbackContent(copy.links.version)).text();
    const sourceBytes = await (await fetchLoopbackContent(original.body.links.version)).text();
    expect(copyBytes).toBe(sourceBytes);

    const replay = await duplicate(bob, originalId, original.body.version.id, "art-015-key-first-copy");
    expect(replay.status).toBe(200);
    const replayed = copySchema.parse(await replay.json());
    expect(replayed.replayed).toBe(true);
    expect(replayed.artifact.id).toBe(copy.artifact.id);
    expect(replayed.version.id).toBe(copy.version.id);
    expect((await names(bob)).filter((name) => name === "O (copy)")).toHaveLength(1);

    const conflict = await duplicate(bob, originalId, second.body.version.id, "art-015-key-first-copy");
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toContain("IDEMPOTENCY_CONFLICT");
    const unkeyed = await fetch(`${server.baseUrl}/api/v1/artifacts/${originalId}/duplicate`, {
      body: JSON.stringify({versionId: original.body.version.id}),
      headers: mutationHeaders(bob),
      method: "POST",
    });
    expect(unkeyed.status).toBe(422);
    const foreign = await duplicate(bob, originalId, privateOne.body.version.id, "art-015-key-foreign");
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toContain("VERSION_NOT_FOUND");
    expect(await sourceState()).toEqual(before);

    const lowered = await fetch(`${server.baseUrl}/api/v1/artifacts/${originalId}/access?projectId=${projectId}`, {
      body: JSON.stringify({
        accessSetting: "private",
        expectedCurrentVersionId: second.body.version.id,
      }),
      headers: {
        Authorization: `Bearer ${adaKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "art-015-lower-original",
      },
      method: "PATCH",
    });
    expect(lowered.status).toBe(200);
    const afterLowering = await duplicate(bob, originalId, original.body.version.id, "art-015-key-first-copy");
    expect(afterLowering.status).toBe(200);
    expect(copySchema.parse(await afterLowering.json()).artifact.id).toBe(copy.artifact.id);

    // 192 letters, "e" plus a combining accent, and an emoji: 196 UTF-16 units.
    const longName = `${"x".repeat(192)}e\u0301\u{1F600}`;
    const long = await publishNew(server, ada, {
      accessSetting: "account_required",
      content: "<!doctype html><title>long</title>",
      idempotencyKey: "art-015-publish-long",
      name: longName,
      projectId,
    });
    const longCopy = copySchema.parse(
      await (await duplicate(bob, long.body.artifact.id, long.body.version.id, "art-015-key-long")).json(),
    );
    expect(longCopy.artifact.name).toBe(`${"x".repeat(192)} (copy)`);

    const projectResponse = await fetch(`${server.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name: "Archived"}),
      headers: mutationHeaders(administrator),
      method: "POST",
    });
    const archivedId = z.object({project: z.object({id: z.string()})})
      .parse(await projectResponse.json()).project.id;
    const inArchive = await publishNew(server, ada, {
      accessSetting: "account_required",
      content: "<!doctype html><title>archived</title>",
      idempotencyKey: "art-015-publish-archived",
      name: "Archived source",
      projectId: archivedId,
    });
    const archive = await fetch(`${server.baseUrl}/api/v1/projects/${archivedId}/archive`, {
      headers: mutationHeaders(administrator),
      method: "POST",
    });
    expect(archive.status).toBe(200);
    const archived = await duplicate(
      bob, inArchive.body.artifact.id, inArchive.body.version.id, "art-015-key-archived", archivedId,
    );
    expect(archived.status).toBe(409);
    expect(await archived.text()).toContain("PROJECT_ARCHIVED");
  });

  const copySchema = z.object({
    artifact: z.object({
      accessSetting: z.string(),
      id: z.string(),
      name: z.string(),
      reviewMode: z.string(),
      tags: z.array(z.string()),
    }),
    links: z.object({version: z.url()}),
    replayed: z.boolean(),
    version: z.object({
      id: z.string(),
      manifestDigest: z.string(),
      number: z.number(),
      publisherPrincipalId: z.string(),
    }),
  });
  const detailsSchema = z.object({artifact: z.object({ownerPrincipalId: z.string()})});

  function signIn(email: string, subject: string): Promise<Cookies> {
    return signInWithStubOidc(server.baseUrl, oidc, email, `art-015-${subject}`);
  }

  function get(cookies: Cookies, pathname: string): Promise<Response> {
    return fetch(`${server.baseUrl}${pathname}`, {headers: {Cookie: cookies.header}});
  }

  function mutationHeaders(cookies: Cookies): Headers {
    return new Headers({
      "Content-Type": "application/json",
      Cookie: cookies.header,
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": cookies.csrf,
    });
  }

  function duplicate(
    cookies: Cookies,
    artifactId: string,
    versionId: string,
    key: string,
    project = projectId,
  ): Promise<Response> {
    const headers = mutationHeaders(cookies);
    headers.set("Idempotency-Key", key);
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/duplicate?projectId=${project}`, {
      body: JSON.stringify({versionId}),
      headers,
      method: "POST",
    });
  }

  async function names(cookies: Cookies): Promise<string[]> {
    const page = z.object({artifacts: z.array(z.object({artifact: z.object({name: z.string()})}))})
      .parse(await (await get(cookies, "/api/v1/artifacts")).json());
    return page.artifacts.map(({artifact}) => artifact.name);
  }

  async function snapshot(token: string, artifactId: string): Promise<unknown[]> {
    const read = async (pathname: string) => {
      const response = await fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}${pathname}`, {
        headers: {Authorization: `Bearer ${token}`},
      });
      return response.json();
    };
    return Promise.all(["", "/versions", "/actions", "/comments"].map(read));
  }
});
