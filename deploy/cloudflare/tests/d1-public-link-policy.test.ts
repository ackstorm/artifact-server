import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {getPlatformProxy} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {defaultProjectId, type AccessSetting} from "../../../src/core/model.js";
import {createManifest} from "../../../src/manifest/create-manifest.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const installationId = "d1-public-link-policy-installation";
const createdAt = "2026-10-31T08:00:00.000Z";
const manifest = createManifest({
  entryPath: "index.html",
  files: [{mediaType: "text/html", path: "index.html", sha256: "e".repeat(64), size: 4}],
  routingMode: "static",
});

let directory: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{DB: D1Database}>>>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "artifact-server-d1-public-link-policy-"));
  const configPath = join(directory, "wrangler.jsonc");
  await writeFile(configPath, JSON.stringify({
    compatibility_date: "2026-08-15",
    d1_databases: [{
      binding: "DB",
      database_id: "d1-public-link-policy",
      database_name: "d1-public-link-policy",
    }],
    name: "artifact-server-d1-public-link-policy",
  }));
  proxy = await getPlatformProxy<{DB: D1Database}>({
    configPath,
    envFiles: [],
    persist: {path: join(directory, "state")},
    remoteBindings: false,
  });
}, 30_000);

afterAll(async () => {
  await proxy.dispose();
  await rm(directory, {force: true, recursive: true});
});

describe("D1 public-link policy", () => {
  it("D1 public-link policy defaults on, persists across repositories, and counts public artifacts", async () => {
    await migrateD1(proxy.env.DB, installationId);
    const repository = createD1ArtifactRepository(proxy.env.DB, installationId);
    expect(await repository.readPublicLinksEnabled()).toBe(true);

    const publish = async (artifactId: string, accessSetting: AccessSetting) => {
      const uploadId = `upl_${artifactId}`;
      const principalId = "mem_owner";
      await repository.createStagedUpload({
        createdAt,
        expiresAt: "2099-01-01T00:00:00.000Z",
        files: manifest.entries.map((entry) => ({entry, storageToken: `${uploadId}_slot`})),
        grantDigest: null,
        id: uploadId,
        manifest,
        principalId,
        projectId: defaultProjectId,
      });
      await repository.markStagedFileUploaded(
        defaultProjectId, uploadId, principalId, `${uploadId}_slot`, createdAt,
      );
      await repository.commitNewArtifact({
        accessSetting,
        artifactId,
        authorizedByPrincipalId: null,
        contentToken: `content_${artifactId}`,
        createdAt,
        idempotencyKey: `publish_${artifactId}`,
        inputDigest: `digest_${artifactId}`,
        manifest,
        name: artifactId,
        principalId,
        projectId: defaultProjectId,
        source: {kind: "staged_upload", principalId, projectId: defaultProjectId, uploadId},
        tags: [],
        versionId: `ver_${artifactId}`,
      });
    };
    await publish("art_public", "public_link");
    await publish("art_private", "private");
    expect(await repository.countPublicLinks()).toBe(1);

    await repository.setPublicLinksEnabled(false);
    expect(await createD1ArtifactRepository(proxy.env.DB, installationId).readPublicLinksEnabled())
      .toBe(false);

    await migrateD1(proxy.env.DB, installationId);
    expect(await createD1ArtifactRepository(proxy.env.DB, installationId).readPublicLinksEnabled())
      .toBe(false);
  }, 30_000);
});
