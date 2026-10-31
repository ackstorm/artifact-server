# 0033: Public links are an installation switch that gates reads, not stored levels

**Status:** Accepted
**Date:** October 31, 2026

Specified in [Disable public links](../disable-public-links-spec.md). Implements
AUTH-006.

## Decision

- **Where the switch lives.** By default, a human administrator turns public
  links off or on in Settings › Public links. It is a runtime setting stored in
  the database on every backend (SQLite, Postgres, Cloudflare D1), and it is on
  by default.
- **Configuration lock.** An operator may set
  `ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED=true|false` at startup, or
  `configuration.publicLinksEnabled` in Helm.
  - A configured value is the effective policy and is locked: the stored value
    is ignored, and the Settings change is refused with `409
    PUBLIC_LINK_POLICY_LOCKED`.
  - Any other value fails startup.
  - Unset means the stored setting applies.
- **Raising.** While the effective policy is off, no surface can make an
  artifact Public: raising the level or publishing as Public fails with `409
  PUBLIC_LINKS_DISABLED`. Lowering is always allowed.
- **Existing Public artifacts.** They keep their stored level. While the policy
  is off, every anonymous read is refused, and signed-in readers read them as
  Organization. Turning public links back on restores public reading unchanged.

## Why

- **A runtime setting by default.** Turning public links off is a moderation
  action. It has to take effect at once, without a redeploy, and it has to be in
  the hands of the person who sees the inventory.
- **A configuration lock as well.** Some operators must guarantee the policy as
  part of the deployment, for example "never public" on an internal
  installation. An administrator in the UI must not be able to undo that.
  Leaving the variable unset keeps the runtime switch.
- **Reads are gated instead of levels being rewritten.**
  - It is reversible.
  - It preserves every owner's choice and every idempotency record.
  - It keeps one place that decides anonymous access.
  - An administrator who wants an artifact closed for good still lowers it with
    Stop public access.

## Consequences

- **The prompt states the effect.** The admin confirmation states how many
  artifacts are Public, that they stop opening without sign-in now, keep their
  setting, and reopen when the switch is turned back on.
- **A locked switch says where to change it.** Under a configured policy, the
  Settings switch is disabled with "Set by the server configuration. Change
  ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED to change it."
- **One place resolves the policy.** `PublicLinkPolicyService` returns the
  configured value if there is one, otherwise the stored setting.
- **The stored setting is read on every would-be-public request.** Several
  processes or isolates may serve one installation, so it is never cached in
  process.
- **Copies are out of reach.** Pages already downloaded or cached outside
  Artifact Server cannot be recalled. Shared caches revalidate and receive
  `401`.
- **No history.** There is no record of who changed the switch. The action
  ledger is artifact-scoped.
