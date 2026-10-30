import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const agentCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
];

const deletionSchema = z.object({
  artifact: z.object({deletedAt: z.string(), id: z.string()}),
  replayed: z.boolean(),
});

describe("artifact deletion ownership", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-030-B AUTH-030-F: only the creator or a browser administrator deletes an artifact", async () => {
    const cookies = await signInAdministrator(server, installation);
    const administratorId = await sessionPrincipalId(cookies);
    const adaId = await admitMember(cookies, "Ada", "ada@example.test");
    const bobId = await admitMember(cookies, "Bob", "bob@example.test");
    const ada = await issueKey(cookies, "Ada's agent", adaId);
    const bob = await issueKey(cookies, "Bob's agent", bobId);
    const administratorAgent = await issueKey(
      cookies,
      "Administrator's agent",
      administratorId,
    );
    const service = await issueKey(cookies, "Release bot", null);

    const adaArtifact = await publishNew(server, {...installation, apiToken: ada}, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Ada's report</title>",
      idempotencyKey: "auth-030-ada-publish",
      name: "Ada's report",
    });
    const bobArtifact = await publishNew(server, {...installation, apiToken: bob}, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Bob's notes</title>",
      idempotencyKey: "auth-030-bob-publish",
      name: "Bob's notes",
    });
    const adaArtifactId = adaArtifact.body.artifact.id;
    const adaVersionId = adaArtifact.body.version.id;

    const refused = await Promise.all([
      [bob, "auth-030-other-member"],
      [service, "auth-030-manage-any-service"],
      [administratorAgent, "auth-030-administrator-agent"],
    ].map(([token, idempotencyKey]) => deleteArtifact(
      adaArtifactId,
      adaVersionId,
      idempotencyKey ?? "",
      {Authorization: `Bearer ${token ?? ""}`},
    )));
    expect(refused.map(({status}) => status)).toEqual([403, 403, 403]);
    expect(await deletedAt(ada, adaArtifactId)).toBeNull();
    expect(await actionKinds(ada, adaArtifactId)).not.toContain("delete");

    const deleted = await deleteArtifact(
      adaArtifactId,
      adaVersionId,
      "auth-030-creator",
      {Authorization: `Bearer ${ada}`},
    );
    expect(deleted.status).toBe(200);
    expect(deletionSchema.parse(await deleted.json())).toMatchObject({
      artifact: {id: adaArtifactId},
      replayed: false,
    });
    const replay = await deleteArtifact(
      adaArtifactId,
      adaVersionId,
      "auth-030-creator",
      {Authorization: `Bearer ${ada}`},
    );
    expect(replay.status).toBe(200);
    expect(deletionSchema.parse(await replay.json()).replayed).toBe(true);

    const moderated = await deleteArtifact(
      bobArtifact.body.artifact.id,
      bobArtifact.body.version.id,
      "auth-030-administrator-browser",
      browserMutationHeaders(cookies),
    );
    expect(moderated.status).toBe(200);
  });

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
    const response = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName, email}),
      headers: browserMutationHeaders(cookies),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return z.object({member: z.object({id: z.string()})})
      .parse(await response.json()).member.id;
  }

  async function issueKey(
    cookies: ApplicationCookies,
    name: string,
    memberId: string | null,
  ): Promise<string> {
    const serviceKey: KeyRequest = {
      capabilities: agentCapabilities,
      expiresAt: "2099-01-01T00:00:00.000Z",
      name,
    };
    const request = memberId === null ? serviceKey : {...serviceKey, memberId};
    const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify(request),
      headers: browserMutationHeaders(cookies),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return z.object({token: z.string()}).parse(await response.json()).token;
  }

  function deleteArtifact(
    artifactId: string,
    expectedCurrentVersionId: string,
    idempotencyKey: string,
    credential: HeadersInit,
  ): Promise<Response> {
    const headers = new Headers(credential);
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", idempotencyKey);
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}`, {
      body: JSON.stringify({expectedCurrentVersionId}),
      headers,
      method: "DELETE",
    });
  }

  async function deletedAt(token: string, artifactId: string): Promise<string | null> {
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}`, {
      headers: {Authorization: `Bearer ${token}`},
    });
    expect(response.status).toBe(200);
    return z.object({artifact: z.object({deletedAt: z.string().nullable()})})
      .parse(await response.json()).artifact.deletedAt;
  }

  async function actionKinds(
    token: string,
    artifactId: string,
  ): Promise<readonly string[]> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/actions?limit=100`,
      {headers: {Authorization: `Bearer ${token}`}},
    );
    expect(response.status).toBe(200);
    return z.object({actions: z.array(z.object({action: z.string()}))})
      .parse(await response.json()).actions.map(({action}) => action);
  }

  function browserMutationHeaders(cookies: ApplicationCookies): Headers {
    return new Headers({
      "Content-Type": "application/json",
      Cookie: cookies.header,
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": cookies.csrf,
    });
  }
});

interface KeyRequest {
  readonly capabilities: readonly string[];
  readonly expiresAt: string;
  readonly memberId?: string;
  readonly name: string;
}

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}
