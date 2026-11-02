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
    scope: "mine",
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
    expect(requiredSqliteSchemaVersion).toBe(19);
    expect(check.prepare("PRAGMA user_version").get()).toEqual({
      user_version: requiredSqliteSchemaVersion,
    });
    expect(check.prepare("SELECT COUNT(*) AS n FROM artifact_pins").get()).toEqual({n: 0});
  } finally {
    check.close();
  }
});

const listingStamp = {authorizedByPrincipalId: null, projectId: defaultProjectId};

function setListing(
  repository: SqliteArtifactRepository,
  artifactId: string,
  listed: boolean,
  principalId = "ada",
  createdAt = "2026-10-31T09:00:00.000Z",
) {
  return repository.setArtifactListing({
    ...listingStamp, artifactId, createdAt, listed, principalId,
  });
}

function lowerToPrivate(
  repository: SqliteArtifactRepository,
  artifactId: string,
  key: string,
  principalId = "ada",
) {
  return repository.changeAccessSetting({
    accessSetting: "private",
    artifactId,
    authorizedByPrincipalId: null,
    createdAt: "2026-10-31T10:00:00.000Z",
    expectedCurrentVersionId: `ver_${artifactId}_1`,
    idempotencyKey: key,
    inputDigest: `digest_${key}`,
    principalId,
    projectId: defaultProjectId,
  });
}

async function actionKinds(repository: SqliteArtifactRepository, artifactId: string) {
  const page = await repository.listArtifactActions({
    artifactId, cursor: null, limit: 20, projectId: defaultProjectId,
  });
  return page.items.map((item) => item.action).toReversed();
}

test("shared scope on SQLite lists listed and opened artifacts of others, listed first, never Private", async () => {
  const repository = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    await publishNew(repository, "L", "account_required", "2026-10-31T08:00:00.000Z");
    await publishNew(repository, "U", "account_required", "2026-10-31T08:00:01.000Z");
    await publishNew(repository, "P", "account_required", "2026-10-31T08:00:02.000Z");
    await publishNew(repository, "O", "public_link", "2026-10-31T08:00:03.000Z", "carol");
    await publishNew(repository, "X", "account_required", "2026-10-31T08:00:04.000Z", "carol");
    await setListing(repository, "L", true);
    await setListing(repository, "P", true);
    await repository.recordArtifactOpening(defaultProjectId, "O", "bob");
    await repository.recordArtifactOpening(defaultProjectId, "O", "bob");
    await repository.recordArtifactOpening(defaultProjectId, "P", "bob");
    await lowerToPrivate(repository, "P", "lower_P");

    const bob = {viewer: {includeServiceOwned: false, principalId: "bob"}};
    expect(await ids(repository, {...bob, scope: "shared"})).toEqual(["L", "O"]);
    const page = await repository.listArtifacts(listCommand({...bob, scope: "shared"}));
    expect(page.items.map((item) => item.listed)).toEqual([true, false]);
    expect(await ids(repository, {scope: "shared"})).toEqual([]);

    await repository.setArtifactPin({
      artifactId: "O", pinned: true, principalId: "bob", projectId: defaultProjectId,
    });
    expect(await ids(repository, {...bob, scope: "shared"})).toEqual(["O", "L"]);

    const rows = new DatabaseSync(databasePath, {readOnly: true});
    try {
      expect(rows.prepare("SELECT COUNT(*) AS n FROM artifact_openings WHERE artifact_id = 'O'").get())
        .toEqual({n: 1});
    } finally {
      rows.close();
    }
  } finally {
    repository.close();
  }
});

test("listing on SQLite writes one action per change and none for a repeat", async () => {
  const repository = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    await publishNew(repository, "L", "account_required", "2026-10-31T08:00:00.000Z");
    const first = await setListing(repository, "L", true, "ada", "2026-10-31T09:00:00.000Z");
    expect(first.listed).toBe(true);
    expect((await setListing(repository, "L", true, "ada", "2026-10-31T09:01:00.000Z")).listed).toBe(true);
    await repository.setArtifactListing({
      ...listingStamp,
      artifactId: "L",
      authorizedByPrincipalId: "admin",
      createdAt: "2026-10-31T09:02:00.000Z",
      listed: false,
      principalId: "ada",
    });
    expect((await setListing(repository, "L", false, "ada", "2026-10-31T09:03:00.000Z")).listed).toBe(false);

    const page = await repository.listArtifactActions({
      artifactId: "L", cursor: null, limit: 20, projectId: defaultProjectId,
    });
    const listing = page.items.filter((item) => item.action === "list" || item.action === "unlist");
    expect(listing.map((item) => item.action)).toEqual(["unlist", "list"]);
    expect(listing[0]).toMatchObject({
      authorizedByPrincipalId: "admin", createdAt: "2026-10-31T09:02:00.000Z", principalId: "ada",
    });
    expect(listing[1]).toMatchObject({
      authorizedByPrincipalId: null, createdAt: "2026-10-31T09:00:00.000Z", principalId: "ada",
    });
  } finally {
    repository.close();
  }
});

test("lowering to Private on SQLite clears the listing, records the unlisting, and raising keeps it cleared", async () => {
  const repository = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    await publishNew(repository, "L", "account_required", "2026-10-31T08:00:00.000Z");
    await publishNew(repository, "N", "account_required", "2026-10-31T08:00:01.000Z");
    await setListing(repository, "L", true);

    await lowerToPrivate(repository, "L", "lower_L", "mallory");
    expect((await repository.findArtifact(defaultProjectId, "L"))?.listed).toBe(false);
    expect(await actionKinds(repository, "L")).toEqual(["publish", "list", "change_access", "unlist"]);
    const tail = await repository.listArtifactActions({
      artifactId: "L", cursor: null, limit: 2, projectId: defaultProjectId,
    });
    expect(tail.items.map((item) => item.principalId)).toEqual(["mallory", "mallory"]);

    await lowerToPrivate(repository, "L", "lower_L", "mallory");
    expect(await actionKinds(repository, "L")).toHaveLength(4);

    await lowerToPrivate(repository, "N", "lower_N");
    expect(await actionKinds(repository, "N")).toEqual(["publish", "change_access"]);

    await repository.changeAccessSetting({
      accessSetting: "account_required",
      artifactId: "L",
      authorizedByPrincipalId: null,
      createdAt: "2026-10-31T11:00:00.000Z",
      expectedCurrentVersionId: "ver_L_1",
      idempotencyKey: "raise_L",
      inputDigest: "digest_raise_L",
      principalId: "ada",
      projectId: defaultProjectId,
    });
    expect((await repository.findArtifact(defaultProjectId, "L"))?.listed).toBe(false);
    expect(await actionKinds(repository, "L")).toEqual([
      "publish", "list", "change_access", "unlist", "change_access",
    ]);
  } finally {
    repository.close();
  }
});

test("listing a Private artifact on SQLite is refused and writes no action", async () => {
  const repository = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    await publishNew(repository, "P", "private", "2026-10-31T08:00:00.000Z");
    await expect(setListing(repository, "P", true)).rejects.toMatchObject({_tag: "ArtifactPrivate"});
    expect((await repository.findArtifact(defaultProjectId, "P"))?.listed).toBe(false);
    expect(await actionKinds(repository, "P")).toEqual(["publish"]);
    expect((await setListing(repository, "P", false)).listed).toBe(false);
  } finally {
    repository.close();
  }
});

test("a schema-18 SQLite database gains listing and openings with every artifact unlisted", async () => {
  const first = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    await publishNew(first, "kept", "account_required", "2026-10-31T08:00:00.000Z");
    await setListing(first, "kept", true);
  } finally {
    first.close();
  }
  const database = new DatabaseSync(databasePath);
  database.exec("DROP TABLE artifact_openings; ALTER TABLE artifacts DROP COLUMN listed; PRAGMA user_version = 18;");
  database.close();

  const repository = new SqliteArtifactRepository(databasePath, "test-installation");
  try {
    expect((await repository.findArtifact(defaultProjectId, "kept"))?.listed).toBe(false);
    await repository.recordArtifactOpening(defaultProjectId, "kept", "bob");
    expect(await ids(repository, {viewer: {includeServiceOwned: false, principalId: "bob"}, scope: "shared"}))
      .toEqual(["kept"]);
  } finally {
    repository.close();
  }
});

async function publishNew(
  repository: SqliteArtifactRepository,
  artifactId: string,
  accessSetting: AccessSetting,
  createdAt: string,
  principalId = "ada",
): Promise<void> {
  const uploadId = `upl_${artifactId}`;
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
