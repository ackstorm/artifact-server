import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {defaultProjectId, type AccessSetting} from "../../src/core/model.js";
import type {CommitNewArtifact, ListArtifacts} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {requiredSqliteSchemaVersion} from "../../src/storage/sqlite-schema.js";

const createdAt = "2026-10-30T08:00:00.000Z";
const manifest = createManifest({
  entryPath: "index.html",
  files: [{mediaType: "text/html", path: "index.html", sha256: "a".repeat(64), size: 1}],
  routingMode: "static",
});

describe("sqlite artifact owner", () => {
  let directory: string;
  let databasePath: string;
  let repository: SqliteArtifactRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-owner-"));
    databasePath = path.join(directory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
  });

  afterEach(async () => {
    repository.close();
    await rm(directory, {force: true, recursive: true});
  });

  async function stage(uploadId: string, principalId: string) {
    await repository.createStagedUpload({
      createdAt,
      expiresAt: "2026-10-30T09:00:00.000Z",
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
    return {kind: "staged_upload" as const, principalId, projectId: defaultProjectId, uploadId};
  }

  async function publishNew(
    artifactId: string,
    principalId: string,
    accessSetting: AccessSetting,
  ): Promise<CommitNewArtifact> {
    const command: CommitNewArtifact = {
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
      source: await stage(`upl_${artifactId}`, principalId),
      tags: [],
      versionId: `ver_${artifactId}_1`,
    };
    await repository.commitNewArtifact(command);
    return command;
  }

  const listFor = async (principalId: string, includeServiceOwned = false) => {
    const command: ListArtifacts = {
      comments: "all",
      cursor: null,
      limit: 10,
      projectId: defaultProjectId,
      sort: "newest",
      tags: [],
      viewer: {includeServiceOwned, principalId},
    };
    return (await repository.listArtifacts(command)).items.map((artifact) => artifact.id);
  };

  test("a schema 14 database records each owner from version 1 and keeps levels and replays", async () => {
    const memberCommand = await publishNew("art_member", "mem_a", "account_required");
    const serviceCommand = await publishNew("art_service", "service:key1", "public_link");
    await repository.commitVersion({
      artifactId: "art_member",
      authorizedByPrincipalId: null,
      contentToken: "content_art_member_2",
      createdAt,
      expectedCurrentVersionId: "ver_art_member_1",
      idempotencyKey: "publish_art_member_2",
      inputDigest: "digest_art_member_2",
      manifest,
      principalId: "mem_other",
      projectId: defaultProjectId,
      source: await stage("upl_art_member_2", "mem_other"),
      versionId: "ver_art_member_2",
    });
    const objectsBefore = schemaObjects(databasePath);
    repository.close();
    downgradeToSchema14(databasePath);

    repository = new SqliteArtifactRepository(databasePath);

    expect(await repository.findArtifact(defaultProjectId, "art_member")).toMatchObject({
      accessSetting: "account_required",
      currentVersionId: "ver_art_member_2",
      ownerPrincipalId: "mem_a",
    });
    expect(await repository.findArtifact(defaultProjectId, "art_service")).toMatchObject({
      accessSetting: "public_link",
      ownerPrincipalId: "service:key1",
    });
    await expect(repository.commitNewArtifact(memberCommand)).resolves.toMatchObject({
      artifact: {accessSetting: "account_required", ownerPrincipalId: "mem_a"},
      replayed: true,
      version: {id: "ver_art_member_1"},
    });
    await expect(repository.commitNewArtifact(serviceCommand)).resolves.toMatchObject({
      artifact: {accessSetting: "public_link", ownerPrincipalId: "service:key1"},
      replayed: true,
      version: {id: "ver_art_service_1"},
    });
    expect(await listFor("mem_b")).toEqual([]);
    expect(await listFor("mem_a")).toEqual(["art_member"]);
    expect(await listFor("mem_admin", true)).toEqual(["art_service"]);

    const check = new DatabaseSync(databasePath, {readOnly: true});
    try {
      expect(check.prepare("PRAGMA user_version").get()).toEqual({
        user_version: requiredSqliteSchemaVersion,
      });
      expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      check.close();
    }
    expect(schemaObjects(databasePath)).toEqual(objectsBefore);
  });

  test("a new artifact stores its owner and may be private", async () => {
    await publishNew("art_private", "mem_c", "private");
    await publishNew("art_local", "local-api-token", "private");

    repository.close();
    repository = new SqliteArtifactRepository(databasePath);

    expect(await repository.findArtifact(defaultProjectId, "art_private")).toMatchObject({
      accessSetting: "private",
      ownerPrincipalId: "mem_c",
    });
    expect(await listFor("mem_c")).toEqual(["art_private"]);
    // The local API token is a service principal.
    expect(await listFor("mem_admin", true)).toEqual(["art_local"]);
  });
});

/** Indexes, triggers, owner-table columns, and whether each table admits `private`. */
function schemaObjects(databasePath: string): readonly string[] {
  const database = new DatabaseSync(databasePath, {readOnly: true});
  try {
    const objects = z.array(z.object({name: z.string(), type: z.string()})).parse(database.prepare(
      "SELECT type, name FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY type, name",
    ).all()).map(({name, type}) => `${type} ${name}`);
    for (const table of ["artifacts", "idempotency_records"]) {
      const columns = z.array(z.object({
        dflt_value: z.string().nullable(),
        name: z.string(),
        notnull: z.number(),
        pk: z.number(),
        type: z.string(),
      })).parse(database.prepare(`PRAGMA table_info(${table})`).all())
        .map((column) =>
          `column ${table}.${column.name} ${column.type} ${column.notnull} ${column.dflt_value ?? ""} ${column.pk}`
        );
      const {sql} = z.object({sql: z.string()}).parse(database.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).get(table));
      objects.push(...columns, `${table} admits private: ${sql.includes("'private'")}`);
    }
    return objects;
  } finally {
    database.close();
  }
}

/** Rewrites the two tables into their schema 14 shape: no owner, no private level. */
function downgradeToSchema14(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      BEGIN IMMEDIATE;
      CREATE TABLE artifacts_v14 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        search_name TEXT NOT NULL,
        access_setting TEXT NOT NULL CHECK (access_setting IN ('account_required', 'public_link')),
        current_version_id TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        review_mode TEXT NOT NULL DEFAULT 'annotate' CHECK (review_mode IN ('annotate', 'interact')),
        source_path TEXT,
        source_fingerprint TEXT,
        source_status TEXT,
        source_verified_at TEXT
      ) STRICT;
      INSERT INTO artifacts_v14 SELECT
        id, project_id, name, search_name, access_setting, current_version_id,
        created_at, deleted_at, review_mode, source_path, source_fingerprint,
        source_status, source_verified_at
      FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_v14 RENAME TO artifacts;
      CREATE TABLE idempotency_records_v14 (
        project_id TEXT NOT NULL REFERENCES projects(id),
        idempotency_key TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'change_review_mode', 'change_tags', 'delete')),
        access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
        tags_json TEXT,
        created_at TEXT NOT NULL,
        review_mode TEXT NOT NULL DEFAULT 'annotate' CHECK (review_mode IN ('annotate', 'interact')),
        PRIMARY KEY (project_id, idempotency_key)
      ) STRICT;
      INSERT INTO idempotency_records_v14 SELECT
        project_id, idempotency_key, input_digest, artifact_id, version_id,
        operation, access_setting, tags_json, created_at, review_mode
      FROM idempotency_records;
      DROP TABLE idempotency_records;
      ALTER TABLE idempotency_records_v14 RENAME TO idempotency_records;
      COMMIT;
      PRAGMA user_version = 14;
    `);
  } finally {
    database.close();
  }
}
