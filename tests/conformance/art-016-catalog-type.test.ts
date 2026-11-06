import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  publishVersion,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const artifactPageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string()}),
    entryMediaType: z.string(),
  })),
});

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("ART-016 catalog type", () => {
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

  async function entryMediaType(artifactId: string): Promise<string | undefined> {
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(response.status).toBe(200);
    const page = artifactPageSchema.parse(await response.json());
    return page.artifacts.find(({artifact}) => artifact.id === artifactId)?.entryMediaType;
  }

  test("ART-016-B: a catalog item reports its current entry file's media type and follows a new version", async () => {
    const first = await publishNew(server, installation, {
      accessSetting: "private",
      content: "<!doctype html><title>Page</title>",
      idempotencyKey: "art-016-catalog-first",
    });
    expect(await entryMediaType(first.body.artifact.id)).toBe("text/html; charset=utf-8");

    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "# Notes",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "art-016-catalog-second",
      mediaType: "text/markdown; charset=utf-8",
      path: "notes.md",
    });
    expect(second.response.status).toBe(201);
    expect(await entryMediaType(first.body.artifact.id)).toBe("text/markdown; charset=utf-8");
  });

  test("ART-016-F: a multi-file artifact reports its entry file, not another manifest file", async () => {
    const files = [
      {bytes: encode("body {}"), mediaType: "text/css; charset=utf-8", path: "a.css"},
      {bytes: encode("<!doctype html>"), mediaType: "text/html; charset=utf-8", path: "site/index.html"},
      {bytes: encode("{}"), mediaType: "application/json", path: "z.json"},
    ];
    const upload = await createStagedUpload(server, installation, "site/index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    const published = await commitStagedUpload(installation, upload.body, "art-016-catalog-site", {
      accessSetting: "private",
      kind: "new_artifact",
      name: "Site",
      tags: [],
    });

    expect(await entryMediaType(published.body.artifact.id)).toBe("text/html; charset=utf-8");
  });
});
