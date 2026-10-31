import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, expect, test} from "vitest";

import {defaultProjectId, type AccessSetting} from "../../src/core/model.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {requiredSqliteSchemaVersion} from "../../src/storage/sqlite-schema.js";

const createdAt = "2026-10-31T08:00:00.000Z";
const manifest = createManifest({
  entryPath: "index.html",
  files: [{mediaType: "text/html", path: "index.html", sha256: "a".repeat(64), size: 1}],
  routingMode: "static",
});

let directory: string;
let databasePath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "artifact-public-link-policy-"));
  databasePath = path.join(directory, "artifact-server.db");
});

afterEach(async () => {
  await rm(directory, {force: true, recursive: true});
});

test("public-link policy on SQLite defaults on for a schema-15 database, persists across reopen, and counts public artifacts", async () => {
  new SqliteArtifactRepository(databasePath, "test-installation").close();
  const database = new DatabaseSync(databasePath);
  database.exec(`
    DROP TABLE installation_settings;
    PRAGMA user_version = 15;
  `);
  database.close();

  let repository = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    expect(await repository.readPublicLinksEnabled()).toBe(true);
    const check = new DatabaseSync(databasePath, {readOnly: true});
    try {
      expect(check.prepare("PRAGMA user_version").get()).toEqual({
        user_version: requiredSqliteSchemaVersion,
      });
    } finally {
      check.close();
    }

    await publishNew(repository, "art_public", "public_link");
    await publishNew(repository, "art_organization", "account_required");
    expect(await repository.countPublicLinks()).toBe(1);

    await repository.setPublicLinksEnabled(false);
    repository.close();
    repository = new SqliteArtifactRepository(databasePath, "test-installation");
    expect(await repository.readPublicLinksEnabled()).toBe(false);

    await repository.setPublicLinksEnabled(true);
    expect(await repository.readPublicLinksEnabled()).toBe(true);
  } finally {
    repository.close();
  }
});

async function publishNew(
  repository: SqliteArtifactRepository,
  artifactId: string,
  accessSetting: AccessSetting,
): Promise<void> {
  const uploadId = `upl_${artifactId}`;
  const principalId = "mem_owner";
  await repository.createStagedUpload({
    createdAt,
    expiresAt: "2026-10-31T09:00:00.000Z",
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
    versionId: `ver_${artifactId}_1`,
  });
}
