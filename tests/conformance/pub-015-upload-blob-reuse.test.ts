import {createHash} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import nodePath from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Layer, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {publishPath} from "../../src/client/file-publication-client.js";
import {
  callMcp,
  mcpFailed,
  mcpToolErrorCode,
  type McpReply,
} from "../support/agent-dispatch.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
  uploadStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const storedFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
}).strict();
const planSchema = z.object({
  alreadyStored: z.array(storedFileSchema),
  files: z.array(z.object({
    method: z.literal("PUT"),
    path: z.string(),
    size: z.number().int().nonnegative(),
    uploadUrl: z.url(),
  }).loose()),
  uploadId: z.string(),
}).loose();
const httpPlanSchema = z.object({
  alreadyStored: z.array(storedFileSchema),
  files: z.array(z.object({path: z.string()}).loose()),
}).loose();
const committedSchema = z.object({
  version: z.object({id: z.string(), number: z.number().int().positive()}).loose(),
}).loose();
const projectSchema = z.object({project: z.object({id: z.string()}).loose()}).loose();
const readResultSchema = z.object({sha256: z.string()}).loose();

type ToolArguments = NonNullable<Parameters<typeof callMcp>[4]["arguments"]>;

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function siteFile(path: string, content: string, mediaType: string): TestSiteFile {
  return {bytes: encoder.encode(content), mediaType, path};
}

function declared(file: TestSiteFile) {
  return {
    mediaType: file.mediaType,
    path: file.path,
    sha256: sha256(file.bytes),
    size: file.bytes.byteLength,
  };
}

function structured(reply: McpReply) {
  expect(mcpFailed(reply)).toBe(false);
  return reply.result?.structuredContent;
}

const logo: TestSiteFile = {
  bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a),
  mediaType: "image/png",
  path: "logo.png",
};
const style = siteFile("style.css", "h1 { color: teal; }\n", "text/css");

describe("blob reuse on upload", () => {
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

  async function publishFiles(
    files: readonly TestSiteFile[],
    idempotencyKey: string,
    projectId?: string,
  ): Promise<PublishResponse> {
    const upload = await createStagedUpload(
      server,
      installation,
      files[0]?.path ?? "index.html",
      files,
      projectId,
    );
    const uploads = await uploadEveryStagedFile(installation, upload.body, files);
    expect(uploads.every((response) => response.ok)).toBe(true);
    return (await commitStagedUpload(installation, upload.body, idempotencyKey, {
      accessSetting: "private",
      kind: "new_artifact",
      name: "Blob reuse fixture",
    })).body;
  }

  function callTool(name: string, toolArguments: ToolArguments): Promise<McpReply> {
    return callMcp(server, installation.apiToken, "tools/call", name, {
      arguments: toolArguments,
      name,
    });
  }

  test("PUB-015-B: an upload against a base artifact asks only for files the artifact does not store and commits all of them", async () => {
    const first = siteFile("index.html", "<h1>One</h1>", "text/html");
    const base = await publishFiles([first, logo, style], "pub-015-b-base-artifact");
    const page = siteFile("index.html", "<h1>Two</h1>", "text/html");
    const next = [page, logo, style];

    const plan = planSchema.parse(structured(await callTool("artifact_create_upload", {
      baseArtifactId: base.artifact.id,
      entryPath: "index.html",
      files: next.map(declared),
    })));
    expect(plan.files.map((file) => file.path)).toEqual(["index.html"]);
    expect(plan.alreadyStored).toEqual([
      {path: "logo.png", size: logo.bytes.byteLength},
      {path: "style.css", size: style.bytes.byteLength},
    ]);
    const planned = plan.files[0];
    if (planned === undefined) throw new Error("The plan asked for no upload.");
    expect((await uploadStagedFile(installation, planned, page.bytes)).status).toBe(200);
    const committed = committedSchema.parse(structured(await callTool("artifact_commit_upload", {
      idempotencyKey: "pub-015-b-commit-version",
      target: {
        artifactId: base.artifact.id,
        expectedCurrentVersionId: base.version.id,
        kind: "new_version",
      },
      uploadId: plan.uploadId,
    })));
    expect(committed.version.number).toBe(2);
    await Promise.all(next.map(async (file) => {
      expect(readResultSchema.parse(structured(await callTool("artifact_read_file", {
        artifactId: base.artifact.id,
        path: file.path,
        versionId: committed.version.id,
      }))).sha256).toBe(sha256(file.bytes));
    }));

    const directory = await mkdtemp(nodePath.join(tmpdir(), "pub-015-cli-"));
    try {
      await Promise.all(next.map((file) => writeFile(nodePath.join(directory, file.path), file.bytes)));
      const puts: string[] = [];
      const recording = Layer.effect(
        HttpClient.HttpClient,
        HttpClient.HttpClient.pipe(Effect.map((client) =>
          client.pipe(HttpClient.tapRequest((request) =>
            Effect.sync(() => {
              if (request.method === "PUT") puts.push(request.url);
            })
          ))
        )),
      ).pipe(Layer.provide(FetchHttpClient.layer));
      const republished = await Effect.runPromise(publishPath(
        {apiToken: Redacted.make(installation.apiToken), serverOrigin: server.baseUrl},
        {
          idempotencyKey: "pub-015-b-cli-unchanged",
          inputPath: directory,
          target: {
            artifactId: base.artifact.id,
            expectedCurrentVersionId: committed.version.id,
            kind: "new_version",
          },
        },
      ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, recording))));
      expect(puts).toEqual([]);
      expect(republished.version.number).toBe(3);
    } finally {
      await rm(directory, {force: true, recursive: true});
    }

    const overHttp = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        baseArtifactId: base.artifact.id,
        entryPath: "index.html",
        files: [first, logo].map(declared),
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(overHttp.status).toBe(201);
    const httpPlan = httpPlanSchema.parse(await overHttp.json());
    expect(httpPlan.files).toEqual([]);
    expect(httpPlan.alreadyStored.map((file) => file.path)).toEqual(["index.html", "logo.png"]);
  });

  test("PUB-015-F: a hash stored only by another artifact or project still needs its upload, and an unusable base artifact is refused without disclosure", async () => {
    const page = siteFile("index.html", "<h1>Base</h1>", "text/html");
    const base = await publishFiles([page], "pub-015-f-base-artifact");
    const secret = siteFile("secret.txt", "stored only by the other artifact\n", "text/plain");
    await publishFiles(
      [siteFile("index.html", "<h1>Other</h1>", "text/html"), secret],
      "pub-015-f-other-artifact",
    );

    const plan = planSchema.parse(structured(await callTool("artifact_create_upload", {
      baseArtifactId: base.artifact.id,
      entryPath: "index.html",
      files: [declared(page), declared(secret)],
    })));
    expect(plan.alreadyStored).toEqual([{path: "index.html", size: page.bytes.byteLength}]);
    expect(plan.files.map((file) => file.path)).toEqual(["secret.txt"]);
    expect(mcpToolErrorCode(await callTool("artifact_commit_upload", {
      idempotencyKey: "pub-015-f-premature-commit",
      target: {
        artifactId: base.artifact.id,
        expectedCurrentVersionId: base.version.id,
        kind: "new_version",
      },
      uploadId: plan.uploadId,
    }))).toBe("UPLOAD_INCOMPLETE");

    const resized = planSchema.parse(structured(await callTool("artifact_create_upload", {
      baseArtifactId: base.artifact.id,
      entryPath: "index.html",
      files: [{...declared(page), size: page.bytes.byteLength + 1}],
    })));
    expect(resized.alreadyStored).toEqual([]);
    expect(resized.files.map((file) => file.path)).toEqual(["index.html"]);

    expect(mcpToolErrorCode(await callTool("artifact_create_upload", {
      baseArtifactId: "art_unknown",
      entryPath: "index.html",
      files: [declared(page)],
    }))).toBe("ARTIFACT_NOT_FOUND");

    const other = projectSchema.parse(structured(await callTool("project_create", {
      name: "PUB-015 other project",
    })));
    const foreign = await publishFiles([secret], "pub-015-f-foreign-artifact", other.project.id);
    const crossProject = await callTool("artifact_create_upload", {
      baseArtifactId: foreign.artifact.id,
      entryPath: "secret.txt",
      files: [declared(secret)],
      projectId: base.artifact.projectId,
    });
    expect(mcpToolErrorCode(crossProject)).toBe("ARTIFACT_NOT_FOUND");
    expect(JSON.stringify(crossProject)).not.toContain("alreadyStored");
  });
});
