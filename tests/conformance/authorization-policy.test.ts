import {Effect, Layer, ManagedRuntime, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {AuthorizationService} from "../../src/application/authorization.js";
import type {ArtifactNotFound, AuthorizationDenied} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {
  accessSettings,
  type AccessSetting,
  type ArtifactRecord,
} from "../../src/core/model.js";

const memberOwner = humanPrincipal("member-owner", membershipRoles.member);
const otherMember = humanPrincipal("other-member", membershipRoles.member);
const administratorPrincipal = humanPrincipal(
  "administrator",
  membershipRoles.administrator,
);
const serviceOwner = servicePrincipal(
  "service:owner-key",
  [principalCapabilities.createArtifact],
);
const readerKey = servicePrincipal(
  "service:reader-key",
  [principalCapabilities.readArtifacts],
);
const managerKey = servicePrincipal(
  "service:manager-key",
  [
    principalCapabilities.manageAnyArtifact,
    principalCapabilities.publishAnyArtifact,
  ],
);
const foreignOwner: Principal = {
  ...memberOwner,
  installationId: "installation-b",
};
const foreignAdministratorPrincipal: Principal = {
  ...administratorPrincipal,
  installationId: "installation-b",
};
const levels = [
  accessSettings.private,
  accessSettings.accountRequired,
  accessSettings.publicLink,
] as const;

describe("authorization policy", () => {
  let runtime: ManagedRuntime.ManagedRuntime<AuthorizationService, never>;

  beforeEach(async () => {
    runtime = ManagedRuntime.make(Layer.mergeAll(
      AuthorizationService.layer({installationId: "installation-a"}),
    ));
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  test("AUTH-008-B AUTH-008-F: standalone mutations use membership and explicit capabilities", async () => {
    expect.hasAssertions();
    const artifact = artifactFixture();
    const member = humanPrincipal("member", membershipRoles.member);
    const administrator = humanPrincipal(
      "administrator",
      membershipRoles.administrator,
    );
    const scopedService = servicePrincipal(
      "publisher",
      [principalCapabilities.publishAnyArtifact],
    );
    const readerService = servicePrincipal(
      "reader",
      [principalCapabilities.readArtifacts],
    );
    const managerService = servicePrincipal(
      "manager",
      [principalCapabilities.manageAnyArtifact],
    );
    const unscopedService = servicePrincipal("reader", []);

    await expectAllowed((authorization) =>
      authorization.requireArtifactRead(member)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactListing(member)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactRead(readerService)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(member)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(administrator)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(managerService)
    );
    await expectAllowed((authorization) =>
      authorization.requireContentSession(member, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(member)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(administrator)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(scopedService)
    );
    await expectDenied((authorization) =>
      authorization.requireVersionPublication(unscopedService)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactRead(unscopedService)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactListing(unscopedService).pipe(Effect.asVoid)
    );
  });

  test("foundation: another installation or an unscoped service cannot acquire authority", async () => {
    expect.hasAssertions();
    const artifact = artifactFixture();
    const foreignAdministrator: Principal = {
      ...humanPrincipal("foreign-admin", membershipRoles.administrator),
      installationId: "installation-b",
    };
    await expectDenied((authorization) =>
      authorization.requireContentSession(foreignAdministrator, artifact)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactCreation(servicePrincipal("unscoped", []))
    );
  });

  test("project discovery follows membership and explicit service authority", async () => {
    expect.hasAssertions();
    const member = humanPrincipal("member", membershipRoles.member);
    const administrator = humanPrincipal(
      "administrator",
      membershipRoles.administrator,
    );
    const reader = servicePrincipal(
      "reader",
      [principalCapabilities.readArtifacts],
    );
    const projectManager = servicePrincipal(
      "project-manager",
      [principalCapabilities.manageProjects],
    );
    const unscoped = servicePrincipal("unscoped", []);
    const foreignAdministrator: Principal = {
      ...administrator,
      installationId: "installation-b",
    };

    await expectAllowed((authorization) =>
      authorization.requireProjectAccess(member)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectAccess(reader)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectAccess(projectManager)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectManagement(administrator)
    );
    await expectAllowed((authorization) =>
      authorization.requireProjectManagement(projectManager)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectManagement(member)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectAccess(unscoped)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectAccess(foreignAdministrator)
    );
    await expectDenied((authorization) =>
      authorization.requireProjectManagement(foreignAdministrator)
    );
  });

  test.each([
    {actor: memberOwner, name: "the owner", owner: "member-owner", reads: [true, true, true]},
    {actor: otherMember, name: "another member", owner: "member-owner", reads: [false, true, true]},
    {actor: administratorPrincipal, name: "an administrator on a member-owned artifact", owner: "member-owner", reads: [false, true, true]},
    {actor: administratorPrincipal, name: "an administrator on a service-owned artifact", owner: "service:owner-key", reads: [true, true, true]},
    {actor: readerKey, name: "a non-owning artifact:read key", owner: "member-owner", reads: [false, true, true]},
    {actor: foreignOwner, name: "the owner id from another installation", owner: "member-owner", reads: [false, false, false]},
  ])("$name reads at private, organization and public levels: $reads", async ({actor, owner, reads}) => {
    expect.hasAssertions();
    const outcomes = await Promise.all(levels.map((level) =>
      outcome((authorization) =>
        authorization.requireArtifactVisible(
          actor,
          artifactFixture({accessSetting: level, ownerPrincipalId: owner}),
        )
      )
    ));
    expect(outcomes).toEqual(reads.map((allowed) =>
      allowed ? "Allowed" : "ArtifactNotFound"
    ));
  });

  test.each([
    {actor: memberOwner, allowed: true, name: "the owner", owner: "member-owner"},
    {actor: administratorPrincipal, allowed: true, name: "an administrator on a service-owned artifact", owner: "service:owner-key"},
    {actor: administratorPrincipal, allowed: false, name: "an administrator on a member-owned artifact", owner: "member-owner"},
    {actor: otherMember, allowed: false, name: "another member", owner: "member-owner"},
    {actor: managerKey, allowed: false, name: "a non-owning manage:any and publish:any key", owner: "member-owner"},
    {actor: serviceOwner, allowed: true, name: "the service key that owns the artifact", owner: "service:owner-key"},
    {actor: foreignOwner, allowed: false, name: "the owner id from another installation", owner: "member-owner"},
  ])("$name controls a public artifact: $allowed", async ({actor, allowed, owner}) => {
    expect.hasAssertions();
    expect(await outcome((authorization) =>
      authorization.requireArtifactControl(
        actor,
        artifactFixture({
          accessSetting: accessSettings.publicLink,
          ownerPrincipalId: owner,
        }),
      )
    )).toBe(allowed ? "Allowed" : "AuthorizationDenied");
  });

  test.each([
    {actor: memberOwner, allowed: true, name: "the owner", owner: "member-owner"},
    {actor: serviceOwner, allowed: true, name: "the service key that owns the artifact", owner: "service:owner-key"},
    {actor: administratorPrincipal, allowed: true, name: "an administrator on a member-owned artifact", owner: "member-owner"},
    {actor: administratorPrincipal, allowed: true, name: "an administrator on a service-owned artifact", owner: "service:owner-key"},
    {actor: otherMember, allowed: false, name: "another member", owner: "member-owner"},
    {actor: managerKey, allowed: false, name: "a non-owning manage:any and publish:any key", owner: "member-owner"},
    {actor: foreignAdministratorPrincipal, allowed: false, name: "an administrator from another installation", owner: "member-owner"},
  ])("$name lowers the level: $allowed", async ({actor, allowed, owner}) => {
    expect.hasAssertions();
    expect(await outcome((authorization) =>
      authorization.requireArtifactLevelLowering(
        actor,
        artifactFixture({
          accessSetting: accessSettings.publicLink,
          ownerPrincipalId: owner,
        }),
      )
    )).toBe(allowed ? "Allowed" : "AuthorizationDenied");
  });

  async function outcome(
    operation: (
      authorization: AuthorizationService["Service"],
    ) => Effect.Effect<void, ArtifactNotFound | AuthorizationDenied>,
  ): Promise<string> {
    const result = await runtime.runPromise(
      Effect.result(AuthorizationService.use(operation)),
    );
    return Result.match(result, {
      onFailure: (failure) => failure._tag,
      onSuccess: () => "Allowed",
    });
  }

  async function expectAllowed(
    operation: (
      authorization: AuthorizationService["Service"],
    ) => Effect.Effect<void, AuthorizationDenied>,
  ): Promise<void> {
    const result = await runtime.runPromise(
      Effect.result(AuthorizationService.use(operation)),
    );
    expect(Result.isSuccess(result)).toBe(true);
  }

  async function expectDenied(
    operation: (
      authorization: AuthorizationService["Service"],
    ) => Effect.Effect<void, AuthorizationDenied>,
  ): Promise<void> {
    const result = await runtime.runPromise(
      Effect.result(AuthorizationService.use(operation)),
    );
    expect(Result.match(result, {
      onFailure: (failure) => failure._tag,
      onSuccess: () => "UnexpectedSuccess",
    })).toBe("AuthorizationDenied");
  }
});

function artifactFixture(
  overrides: {
    readonly accessSetting?: AccessSetting;
    readonly ownerPrincipalId?: string;
  } = {},
): ArtifactRecord {
  return {
    accessSetting: "account_required",
    createdAt: "2026-08-13T00:00:00.000Z",
    currentVersionId: "version-1",
    deletedAt: null,
    id: "artifact-1",
    name: "Authorization fixture",
    ownerPrincipalId: "member-owner",
    projectId: "prj_default",
    reviewMode: "annotate",
    tags: [],
    ...overrides,
  };
}

function humanPrincipal(
  id: string,
  membershipRole: Principal["membershipRole"],
): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Policy human",
    id,
    installationId: "installation-a",
    kind: principalKinds.human,
    membershipRole,
  };
}

function servicePrincipal(
  id: string,
  capabilities: Principal["capabilities"],
): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities,
    displayName: "Policy service",
    id,
    installationId: "installation-a",
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
  };
}
