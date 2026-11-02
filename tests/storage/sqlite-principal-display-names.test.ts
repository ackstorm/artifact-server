import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
} from "../../src/core/identity.js";
import type {StoredManagedApiKey} from "../../src/core/installation-identity.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

const installationId = "test-installation";

function apiKey(
  id: string,
  name: string,
  principalId: string,
  principalKind: StoredManagedApiKey["principalKind"],
  createdAt: string,
): StoredManagedApiKey {
  return {
    authorizedByPrincipalId: "member-ada",
    capabilities: [principalCapabilities.readArtifacts],
    createdAt,
    expiresAt: "2027-01-01T00:00:00.000Z",
    id,
    installationId,
    name,
    prefix: `as_key_${id}`,
    principalId,
    principalKind,
    revokedAt: null,
    rotatedFromId: null,
    secretDigest: `digest-${id}`,
  };
}

describe("principal display names", () => {
  let directory: string;
  let repository: SqliteIdentityRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-principal-names-"));
    repository = new SqliteIdentityRepository(path.join(directory, "identity.db"));
  });

  afterEach(async () => {
    repository.close();
    await rm(directory, {force: true, recursive: true});
  });

  test("principal display names on SQLite name members and service keys and leave other ids out", async () => {
    await repository.admitMember({
      createdAt: "2026-10-09T00:00:00.000Z",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      id: "member-ada",
      installationId,
      role: membershipRoles.member,
    });
    await repository.admitMember({
      createdAt: "2026-10-09T00:00:01.000Z",
      displayName: "Bob",
      email: "bob@example.test",
      id: "member-bob",
      installationId,
      role: membershipRoles.member,
    });
    await repository.deactivateMember(installationId, "member-bob", "2026-10-10T00:00:00.000Z");
    await repository.createApiKey(apiKey(
      "key_ci",
      "CI deploy",
      "service:key_ci",
      principalKinds.service,
      "2026-10-11T00:00:00.000Z",
    ));
    await repository.rotateApiKey(
      installationId,
      "key_ci",
      {
        ...apiKey("key_ci2", "CI deploy v2", "service:key_ci", principalKinds.service, "2026-10-12T00:00:00.000Z"),
        rotatedFromId: "key_ci",
      },
      "2026-10-12T00:00:00.000Z",
    );
    await repository.createApiKey(apiKey(
      "key_ada",
      "Ada laptop",
      "member-ada",
      principalKinds.human,
      "2026-10-11T00:00:00.000Z",
    ));

    const ids = [
      "member-ada",
      "member-bob",
      "service:key_ci",
      "local-api-token",
      "mem_unknown",
      "member-ada",
    ];
    const names = await repository.findPrincipalDisplayNames(installationId, ids);
    expect(Object.fromEntries(names)).toEqual({
      "member-ada": "Ada Lovelace",
      "member-bob": "Bob",
      "service:key_ci": "CI deploy v2",
    });
    expect((await repository.findPrincipalDisplayNames("other-installation", ids)).size).toBe(0);
    expect((await repository.findPrincipalDisplayNames(installationId, [])).size).toBe(0);
  });
});
