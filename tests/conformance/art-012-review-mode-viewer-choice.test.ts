import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {callMcp, mcpFailed} from "../support/agent-dispatch.js";
import {
  createStagedUpload,
  publishNew,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  readHeaders,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const artifactBodySchema = z.object({artifact: z.object({id: z.string()}).loose()}).loose();

describe("ART-012 review mode is a viewer choice", () => {
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

  test("ART-012-B: HTTP and MCP publication and reads return no review mode, and stored review mode history still reads", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required", content: "<p>View</p>", idempotencyKey: "art-012-b-publish",
    });
    const artifactId = published.body.artifact.id;
    const httpRead = artifactBodySchema.parse(await (await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}`, {headers: readHeaders(installation)},
    )).json());
    const mcpRead = artifactBodySchema.parse((await callMcp(server, installation.apiToken, "tools/call",
      "artifact_get", {arguments: {artifactId}, name: "artifact_get"})).result?.structuredContent);
    for (const artifact of [published.body.artifact, httpRead.artifact, mcpRead.artifact]) {
      expect(artifact).not.toHaveProperty("reviewMode");
    }

    // Stored change_review_mode actions stay readable.
    await server.stop();
    const database = new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"));
    try {
      database.prepare(`INSERT INTO actions (
          id, project_id, artifact_id, version_id, action, principal_id,
          authorized_by_principal_id, idempotency_key, created_at
        ) SELECT 'act_art012_history', project_id, artifact_id, version_id, 'change_review_mode',
          principal_id, authorized_by_principal_id, 'art-012-history', created_at
        FROM actions WHERE artifact_id = ? AND action = 'publish'`).run(artifactId);
    } finally {database.close();}
    server = await startTestServer(installation);
    const history = await fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/actions`, {
      headers: readHeaders(installation),
    });
    expect(history.status).toBe(200);
    expect(z.object({actions: z.array(z.object({action: z.string()}).loose())}).parse(await history.json())
      .actions.map(({action}) => action).toSorted()).toEqual(["change_review_mode", "publish"]);
  });

  test("ART-012-F: no tool or route sets a review mode, and a commit target carrying one is rejected without creating state", async () => {
    const tools = z.object({tools: z.array(z.object({name: z.string()}).loose())}).parse(
      (await callMcp(server, installation.apiToken, "tools/list", "", {})).result,
    ).tools.map(({name}) => name);
    expect(tools).toContain("artifact_commit_upload");
    expect(tools).not.toContain("artifact_set_review_mode");

    const published = await publishNew(server, installation, {
      accessSetting: "account_required", content: "<p>Route</p>", idempotencyKey: "art-012-f-publish",
    });
    const patched = await fetch(`${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/review-mode`, {
      body: JSON.stringify({expectedCurrentVersionId: published.body.version.id, reviewMode: "annotate"}),
      headers: apiHeaders(installation, "art-012-f-patch"),
      method: "PATCH",
    });
    expect(patched.status).toBe(404);

    const file = {bytes: new TextEncoder().encode("<p>Mode</p>"), mediaType: "text/html", path: "index.html"};
    const upload = await createStagedUpload(server, installation, file.path, [file]);
    await uploadEveryStagedFile(installation, upload.body, [file]);
    const target = {accessSetting: "private", kind: "new_artifact", name: "Mode", tags: []};
    const commit = (commitTarget: typeof target & {readonly reviewMode?: string}) => fetch(upload.body.commitUrl, {
      body: JSON.stringify({target: commitTarget}), headers: apiHeaders(installation, "art-012-f-commit"), method: "POST",
    });
    expect((await commit({...target, reviewMode: "interact"})).status).toBe(422);
    expect(mcpFailed(await callMcp(server, installation.apiToken, "tools/call", "artifact_commit_upload", {
      arguments: {idempotencyKey: "art-012-f-mcp", target: {...target, reviewMode: "interact"}, uploadId: upload.body.uploadId},
      name: "artifact_commit_upload",
    }))).toBe(true);
    const committed = await commit(target);
    expect(committed.status).toBe(201);
    expect(await committed.json()).toMatchObject({replayed: false});
  });
});
