import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {getPlatformProxy} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {defaultProjectId, type AccessSetting} from "../../../src/core/model.js";
import {createManifest} from "../../../src/manifest/create-manifest.js";
import {createD1ArtifactRepository} from "../src/d1-artifact-repository.js";
import {migrateD1} from "../src/d1-migrations.js";

const installationId = "d1-listing-installation";
const createdAt = "2026-10-30T08:00:00.000Z";
const manifest = createManifest({
  entryPath: "index.html",
  files: [{mediaType: "text/html", path: "index.html", sha256: "e".repeat(64), size: 4}],
  routingMode: "static",
});

let directory: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{DB: D1Database}>>>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "artifact-server-d1-listing-"));
  const configPath = join(directory, "wrangler.jsonc");
  await writeFile(configPath, JSON.stringify({
    compatibility_date: "2026-08-15",
    d1_databases: [{binding: "DB", database_id: "d1-listing", database_name: "d1-listing"}],
    name: "artifact-server-d1-listing",
  }));
  proxy = await getPlatformProxy<{DB: D1Database}>({
    configPath,
    envFiles: [],
    persist: {path: join(directory, "state")},
    remoteBindings: false,
  });
  await migrateD1(proxy.env.DB, installationId);
}, 30_000);

afterAll(async () => {
  await proxy.dispose();
  await rm(directory, {force: true, recursive: true});
});

describe("D1 artifact listing", () => {
  it("lists only the viewer's artifacts, plus service-owned ones for an administrator", async () => {
    const repository = createD1ArtifactRepository(proxy.env.DB, installationId);
    const publish = async (artifactId: string, principalId: string, accessSetting: AccessSetting) => {
      const uploadId = `upl_${artifactId}`;
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
    await publish("art_member", "mem_a", "account_required");
    await publish("art_service", "service:key1", "public_link");
    await publish("art_private", "mem_a", "private");
    const listFor = async (principalId: string, includeServiceOwned: boolean) =>
      (await repository.listArtifacts({
        comments: "all",
        cursor: null,
        limit: 10,
        projectId: defaultProjectId,
        sort: "newest",
        tags: [],
        viewer: {includeServiceOwned, principalId},
      })).items.map((artifact) => artifact.id).toSorted();

    expect(await listFor("mem_b", false)).toEqual([]);
    expect(await listFor("mem_a", false)).toEqual(["art_member", "art_private"]);
    expect(await listFor("mem_admin", true)).toEqual(["art_service"]);
    expect(await repository.findArtifact(defaultProjectId, "art_private")).toMatchObject({
      accessSetting: "private",
      ownerPrincipalId: "mem_a",
    });
  }, 30_000);
});
