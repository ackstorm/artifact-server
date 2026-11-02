import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, ManagedRuntime, Redacted, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {InstallationAccessService} from "../../src/application/installation-access.js";
import type {ExternalIdentity} from "../../src/core/installation-identity.js";
import {SystemClock, SystemIdGenerator} from "../../src/core/system.js";
import {createApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

const installationId = "auth-039-identity-provider-names";
const provider = "oidc:https://issuer.example.test";
const administrator: ExternalIdentity = {
  displayName: "Ada Administrator",
  email: "administrator@example.test",
  emailVerified: true,
  provider,
  subject: "administrator",
};
const jose: ExternalIdentity = {
  displayName: "José Romero",
  email: "jose.romero@example.test",
  emailVerified: true,
  provider,
  subject: "jose",
};

describe("identity provider names", () => {
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;
  let identityRepository: SqliteIdentityRepository;
  let runtime: ApplicationRuntime;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-auth-039-"));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
    identityRepository = new SqliteIdentityRepository(databasePath);
    runtime = ManagedRuntime.make(createApplicationLayer({
      apiToken: Redacted.make("test-api-token"),
      blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
      bootstrapAdministratorEmail: administrator.email,
      clock: new SystemClock(),
      dispatches: repository,
      externalApiBearerVerifier: null,
      externalIdentityAdmissionPolicy: {allowedEmailDomains: [], provider},
      externalMcpBearerVerifier: null,
      externalMcpOAuthVerifier: null,
      ids: new SystemIdGenerator(),
      identityRepository,
      installationId,
      interactiveIdentityProvider: null,
      localBootstrapCredential: null,
      protectBootstrapAdministrator: false,
      publicLinksEnabled: null,
      repository,
      staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
    }));
    await signIn(administrator);
  });

  afterEach(async () => {
    await runtime.dispose();
    identityRepository.close();
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("AUTH-039-B: a member admitted under the email's local part takes the provider's name at sign-in and follows later changes", async () => {
    // An administrator admits by email, the way an identity broker does.
    const admitted = await identityRepository.admitMember({
      createdAt: new Date().toISOString(),
      displayName: "jose.romero",
      email: jose.email,
      id: "member_jose",
      installationId,
      role: "member",
    });
    expect(admitted.displayName).toBe("jose.romero");

    expect(await signIn(jose)).toBe(admitted.id);
    expect(await nameOf(admitted.id)).toBe("José Romero");

    expect(await signIn({...jose, displayName: "José Romero Pérez"})).toBe(admitted.id);
    expect(await nameOf(admitted.id)).toBe("José Romero Pérez");

    // A bearer-token sign-in refreshes the name the same way.
    await runtime.runPromise(InstallationAccessService.use((access) =>
      access.authenticateExternalIdentity({...jose, displayName: "Pepe Romero"})
    ));
    expect(await nameOf(admitted.id)).toBe("Pepe Romero");
  });

  test("AUTH-039-F: a provider without a name keeps the stored one, and a deactivated member is refused without a rename", async () => {
    const memberId = await signIn(jose);
    expect(await signIn({...jose, displayName: ""})).toBe(memberId);
    expect(await signIn({...jose, displayName: "  "})).toBe(memberId);
    expect(await signIn({...jose, displayName: jose.email})).toBe(memberId);
    expect(await signIn({...jose, displayName: jose.email.toUpperCase()})).toBe(memberId);
    expect(await nameOf(memberId)).toBe("José Romero");

    const administratorPrincipal = await runtime.runPromise(
      InstallationAccessService.use((access) =>
        access.authenticateExternalIdentity(administrator)
      ),
    );
    await runtime.runPromise(InstallationAccessService.use((access) =>
      access.deactivateMember(administratorPrincipal, memberId)
    ));
    const denied = await runtime.runPromise(Effect.result(
      InstallationAccessService.use((access) =>
        access.completeExternalIdentity({...jose, displayName: "Renamed"})
      ),
    ));
    expect(Result.match(denied, {
      onFailure: (failure) => failure._tag,
      onSuccess: () => "UnexpectedSuccess",
    })).toBe("IdentityAdmissionDenied");
    expect(await nameOf(memberId)).toBe("José Romero");
  });

  async function signIn(identity: ExternalIdentity): Promise<string> {
    const completed = await runtime.runPromise(InstallationAccessService.use((access) =>
      access.completeExternalIdentity(identity)
    ));
    return completed.session.member.id;
  }

  async function nameOf(memberId: string): Promise<string | undefined> {
    return (await identityRepository.findMember(installationId, memberId))?.displayName;
  }
});
