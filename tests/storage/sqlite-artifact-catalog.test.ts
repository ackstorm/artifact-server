import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, expect, test} from "vitest";

import {defaultProjectId, type AccessSetting} from "../../src/core/model.js";
import type {ListArtifacts} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {requiredSqliteSchemaVersion} from "../../src/storage/sqlite-schema.js";

const manifest = createManifest({
  entryPath: "index.html",
  files: [{mediaType: "text/html", path: "index.html", sha256: "a".repeat(64), size: 1}],
  routingMode: "static",
});

let directory: string;
let databasePath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "artifact-catalog-"));
  databasePath = path.join(directory, "artifact-server.db");
});

afterEach(async () => {
  await rm(directory, {force: true, recursive: true});
});

function listCommand(overrides: Partial<ListArtifacts> = {}): ListArtifacts {
  return {
    access: [],
    comments: "all",
    cursor: null,
    limit: 10,
    pinned: "all",
    projectId: defaultProjectId,
    sort: "newest",
    tags: [],
    viewer: {includeServiceOwned: false, principalId: "ada"},
    ...overrides,
  };
}

async function ids(repository: SqliteArtifactRepository, overrides: Partial<ListArtifacts> = {}) {
  return (await repository.listArtifacts(listCommand(overrides))).items.map((item) => item.id);
}

async function pageThrough(
  repository: SqliteArtifactRepository,
  sort: "comments" | "newest",
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: ListArtifacts["cursor"] = null;
  for (let page = 0; page < 10; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await repository.listArtifacts(listCommand({cursor, limit: 1, sort}));
    seen.push(...result.items.map((item) => item.id));
    if (result.nextCursor === null) {
      return seen;
    }
    expect(result.nextCursor.group).toBeDefined();
    cursor = result.nextCursor;
  }
  throw new Error("paging did not end");
}

test("artifact pins on SQLite are per principal, survive reopen, and order pinned artifacts first in both sorts", async () => {
  let repository = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    for (const [index, id] of ["a1", "a2", "a3", "a4"].entries()) {
      // eslint-disable-next-line no-await-in-loop
      await publishNew(repository, id, "private", `2026-10-31T08:00:0${index}.000Z`);
    }
    const pin = (artifactId: string, principalId: string, pinned: boolean) =>
      repository.setArtifactPin({artifactId, pinned, principalId, projectId: defaultProjectId});
    await pin("a1", "ada", true);
    await pin("a2", "ada", true);
    await pin("a4", "bob", true);

    await repository.createThread({
      anchor: null,
      artifactId: "a3",
      author: {
        authorizedByPrincipalId: null,
        displayName: "Ada",
        principalId: "ada",
        principalKind: "human",
      },
      body: "A comment.",
      createdAt: "2026-10-31T08:01:00.000Z",
      id: "thr_a3",
      idempotencyKey: "thread_a3",
      installationId: "test-installation",
      path: null,
      projectId: defaultProjectId,
      versionId: "ver_a3_1",
    });

    const expected = ["a2", "a1", "a4", "a3"];
    expect(await ids(repository)).toEqual(expected);
    const first = await repository.listArtifacts(listCommand());
    expect(first.items.map((item) => item.pinned)).toEqual([true, true, false, false]);

    repository.close();
    repository = new SqliteArtifactRepository(databasePath, "test-installation");
    expect(await ids(repository)).toEqual(expected);
    expect(await ids(repository, {pinned: "only"})).toEqual(["a2", "a1"]);

    expect(await pageThrough(repository, "newest")).toEqual(expected);
    expect(await pageThrough(repository, "comments")).toEqual(["a2", "a1", "a3", "a4"]);

    await pin("a1", "ada", false);
    await pin("a1", "ada", false);
    expect(await ids(repository, {pinned: "only"})).toEqual(["a2"]);
  } finally {
    repository.close();
  }
});

test("catalog access filter on SQLite keeps only the selected stored levels", async () => {
  const repository = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    await publishNew(repository, "levels_private", "private", "2026-10-31T08:00:00.000Z");
    await publishNew(repository, "levels_org", "account_required", "2026-10-31T08:00:01.000Z");
    await publishNew(repository, "levels_public", "public_link", "2026-10-31T08:00:02.000Z");

    expect(await ids(repository, {access: ["private", "public_link"]})).toEqual([
      "levels_public",
      "levels_private",
    ]);
    expect(await ids(repository, {access: []})).toHaveLength(3);
  } finally {
    repository.close();
  }
});

test("a schema-17 SQLite database gains artifact_pins without changing artifacts", async () => {
  new SqliteArtifactRepository(databasePath, "test-installation").close();
  const database = new DatabaseSync(databasePath);
  database.exec("DROP TABLE artifact_pins; PRAGMA user_version = 17;");
  database.close();

  const repository = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    await publishNew(repository, "kept", "private", "2026-10-31T08:00:00.000Z");
  } finally {
    repository.close();
  }
  const reopened = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    expect(await ids(reopened)).toEqual(["kept"]);
  } finally {
    reopened.close();
  }
  const check = new DatabaseSync(databasePath, {readOnly: true});
  try {
    expect(requiredSqliteSchemaVersion).toBe(18);
    expect(check.prepare("PRAGMA user_version").get()).toEqual({
      user_version: requiredSqliteSchemaVersion,
    });
    expect(check.prepare("SELECT COUNT(*) AS n FROM artifact_pins").get()).toEqual({n: 0});
  } finally {
    check.close();
  }
});

async function publishNew(
  repository: SqliteArtifactRepository,
  artifactId: string,
  accessSetting: AccessSetting,
  createdAt: string,
): Promise<void> {
  const uploadId = `upl_${artifactId}`;
  const principalId = "ada";
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
