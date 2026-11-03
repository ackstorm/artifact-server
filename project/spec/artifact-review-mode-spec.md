# Artifact Review mode

**Status:** Implemented with local behavior evidence; equivalent live deployment evidence pending.
**Owner:** Artifact core and web application
**Companion documents:** [Product specification](./artifact-server-product-spec.html), [Media previews](./media-preview-spec.md), [Conformance ledger](./conformance.yml)

## Outcome

Artifacts open in Interact by default, so an HTML prototype accepts clicks at once. An author can choose Annotate for a page meant for comments. A reviewer can override the initial mode in a shared Review link and continue using the existing toggle and Escape shortcut.

## Artifact metadata

`ArtifactRecord.reviewMode` is required and is either `annotate` or `interact`. Creation inputs may omit it; omission means `interact`. The default belongs to the artifact, not a version or manifest, and survives new versions, restoration, and reads from SQLite or PostgreSQL. Upgrading to SQLite schema 20 or PostgreSQL migration `0019_review_mode_interact` sets every existing artifact to `interact` once; the upgrade records no action, and later changes are kept.

The publication idempotency digest is keyed on the mode the caller sent and hashes an omitted mode like `annotate`, so a retry saved before the default changed still replays its original result. A retry that names `interact` under a key first used without a mode is a conflict.

Staged HTTP upload commit and MCP `artifact_commit_upload` accept `target.reviewMode` only for `target.kind: new_artifact`. CLI `publish --review-mode annotate|interact` forwards that creation choice. Combining an explicit CLI option with `--artifact` is rejected rather than silently changing existing metadata.

## Change contract

`PATCH /api/v1/artifacts/:artifactId/review-mode` accepts `{reviewMode, expectedCurrentVersionId}`, the standard idempotency-key header, and an optional `projectId` query. MCP `artifact_set_review_mode` accepts the equivalent metadata plus `artifactId`, `idempotencyKey`, and optional `projectId`.

Both adapters use the normal artifact-management authorization and shared application operation. A stale expected current-version ID or an idempotency key reused with different input fails without changing the default or action history. An exact retry returns the original result. A successful change records `change_review_mode` with normal action attribution and does not create a version, move the current-version pointer, alter a manifest, or rewrite bytes. Archived-project and deleted-artifact rules remain the existing management rules.

## Browser contract

The initial HTML Review mode uses this precedence:

1. An exact `mode=annotate` or `mode=interact` query value.
2. The selected artifact's stored default.
3. `annotate` when metadata is unavailable.

Invalid query values are ignored. Review URL construction retains a valid mode override when changing artifact, version, file, or focus view. Browser history restores the mode associated with its URL. Once the reviewer manually changes mode with the existing toggle or Escape, data refresh and selected-version loading cannot overwrite that choice. Moving to another artifact without a link override uses that artifact's default.

Interact allows actual clicks to reach the isolated HTML frame; Annotate retains its current comment-selection behavior. Selecting a mode does not alter authentication, access settings, the frame sandbox, stored content, or native media presentation.

## Conformance

| ID | Contract |
| --- | --- |
| `ART-012` | Persist the artifact default, migrate existing artifacts to Interact, expose creation and management through supported adapters, preserve versions, and enforce normal authorization, concurrency, and idempotency. |
| `PRV-006` | Resolve initial HTML mode from URL and artifact metadata, allow real interaction, retain URL overrides through navigation and history, and preserve manual choices during refresh and version loading. |

Requirements are `behavior_verified` with passing local evidence. A local run cannot establish live behavior on every supported deployment.
