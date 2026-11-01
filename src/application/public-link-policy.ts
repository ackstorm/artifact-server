import {Context, Effect, Layer} from "effect";

import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  PublicLinkPolicyLocked,
  PublicLinksDisabled,
} from "../core/errors.js";
import type {Principal} from "../core/identity.js";

/** Persistence of the installation's public-link switch. */
export interface PublicLinkPolicyRepository {
  readonly countPublicLinks: Effect.Effect<number, ArtifactRepositoryFailure>;
  readonly readPublicLinksEnabled: Effect.Effect<boolean, ArtifactRepositoryFailure>;
  readonly setPublicLinksEnabled: (
    enabled: boolean,
  ) => Effect.Effect<void, ArtifactRepositoryFailure>;
}

/** The effective switch, whether configuration sets it, and the stored-Public artifacts it governs. */
export interface PublicLinkPolicySetting {
  readonly publicArtifactCount: number;
  readonly publicLinksEnabled: boolean;
  readonly setByConfiguration: boolean;
}

interface PublicLinkPolicyOperations {
  readonly change: (
    principal: Principal,
    enabled: boolean,
  ) => Effect.Effect<
    PublicLinkPolicySetting,
    AuthorizationDenied | PublicLinkPolicyLocked | ArtifactRepositoryFailure
  >;
  /** The configured value, or the stored one read on every decision: several processes may serve one installation. */
  readonly enabled: Effect.Effect<boolean, ArtifactRepositoryFailure>;
  readonly read: (
    principal: Principal,
  ) => Effect.Effect<PublicLinkPolicySetting, AuthorizationDenied | ArtifactRepositoryFailure>;
  readonly requireEnabled: Effect.Effect<void, PublicLinksDisabled | ArtifactRepositoryFailure>;
}

/** Owns whether artifacts may be Public in this installation. */
export class PublicLinkPolicyService extends Context.Service<
  PublicLinkPolicyService,
  PublicLinkPolicyOperations
>()("artifact-server/application/PublicLinkPolicyService") {
  /** `configured` is the startup value of ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED, or null when unset. */
  static readonly layer = (
    repository: PublicLinkPolicyRepository,
    configured: boolean | null,
  ): Layer.Layer<PublicLinkPolicyService, never, AuthorizationService> =>
    Layer.effect(
      PublicLinkPolicyService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        return makePublicLinkPolicyService(repository, configured, authorization);
      }),
    );
}

function makePublicLinkPolicyService(
  repository: PublicLinkPolicyRepository,
  configured: boolean | null,
  authorization: AuthorizationOperations,
): PublicLinkPolicyOperations {
  const effective = configured === null
    ? repository.readPublicLinksEnabled
    : Effect.succeed(configured);

  const setting = Effect.all({
    publicArtifactCount: repository.countPublicLinks,
    publicLinksEnabled: effective,
  }).pipe(Effect.map((values) => ({...values, setByConfiguration: configured !== null})));

  const requireEnabled = Effect.gen(function*() {
    if (yield* effective) return;
    yield* new PublicLinksDisabled({
      message: "An administrator has turned off public links for this installation.",
    });
  });

  const read = Effect.fn("PublicLinkPolicyService.read")(function*(principal: Principal) {
    yield* authorization.requireInstallationAdministration(principal);
    return yield* setting;
  });

  const change = Effect.fn("PublicLinkPolicyService.change")(
    function*(principal: Principal, enabled: boolean) {
      yield* authorization.requireInstallationAdministration(principal);
      if (configured !== null) {
        return yield* new PublicLinkPolicyLocked({
          message:
            "ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED in the server configuration sets this policy. Change it there.",
        });
      }
      yield* repository.setPublicLinksEnabled(enabled);
      return yield* setting;
    },
  );

  return PublicLinkPolicyService.of({change, enabled: effective, read, requireEnabled});
}
