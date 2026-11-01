import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, expect, test} from "vitest";
import {z} from "zod";

import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {requiredSqliteSchemaVersion} from "../../src/storage/sqlite-schema.js";

let directory: string;
let databasePath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "artifact-git-history-drop-"));
  databasePath = path.join(directory, "artifact-server.db");
});

afterEach(async () => {
  await rm(directory, {force: true, recursive: true});
});

test("a schema-16 SQLite file with Git-history rows opens as schema 17 without the Git-history tables", () => {
  new SqliteArtifactRepository(databasePath, "test-installation").close();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE git_history_provider_identity (installation_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE git_history_project_settings (project_id TEXT PRIMARY KEY REFERENCES projects(id)) STRICT;
    CREATE TABLE git_history_repositories (artifact_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE git_history_jobs (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE git_history_mappings (commit_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE git_history_budget_reservations (
      job_id TEXT PRIMARY KEY REFERENCES git_history_jobs(id)
    ) STRICT;
    INSERT INTO git_history_jobs (id) VALUES ('job-1');
    INSERT INTO git_history_budget_reservations (job_id) VALUES ('job-1');
    PRAGMA user_version = 16;
  `);
  legacy.close();

  new SqliteArtifactRepository(databasePath, "test-installation").close();

  const check = new DatabaseSync(databasePath, {readOnly: true});
  try {
    const names = z.array(z.object({name: z.string()})).parse(check.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'git_history_%'",
    ).all());
    expect(names).toEqual([]);
    expect(check.prepare("PRAGMA user_version").get()).toEqual({
      user_version: requiredSqliteSchemaVersion,
    });
  } finally {
    check.close();
  }
});
