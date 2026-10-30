# Artifact sharing levels

**Status:** Proposed
**Date:** October 30, 2026
**Companion documents:** [Product specification](./artifact-server-product-spec.html#sharing),
[Decision 0032](./decisions/0032-owner-private-artifacts.md),
[Conformance ledger](./conformance.yml)

## 1. Outcome

Every artifact has an owner and one of three sharing levels:

| Level | Wire value | Who opens it with the link | Who sees it in lists |
| --- | --- | --- | --- |
| Private | `private` | The owner | The owner |
| Organization | `account_required` | Any principal of the installation with read authority | The owner |
| Public | `public_link` | Anyone who can reach the server, signed in or not | The owner |

New artifacts are Private. The owner shares an artifact by raising its level and
handing out the link. Nobody discovers another person's artifact by browsing.

This replaces SCP-008, under which every admitted member reads and manages every
artifact. The two existing wire values keep their names and their reach for a
reader who has the link. They no longer put the artifact in other people's lists.

## 2. Owner

- The owner is the principal that published version 1. It is stored on the
  artifact as `owner_principal_id` and never changes.
- An agent using a member-bound API key acts as that member, so what it publishes
  belongs to the member.
- An artifact published with a service key belongs to that service principal.
  Human administrators treat service-owned artifacts as their own: they list,
  read and manage them. The service key keeps its own owner rights.
- A local installation's API token is a service principal, so the local
  administrator reads and manages what the CLI and agents publish locally.
- The owner appears in artifact responses as `ownerPrincipalId`.

## 3. Authority

### Read

A principal reads an artifact when any of these holds:

1. It is the owner.
2. The artifact is service-owned and the principal is a human administrator.
3. The level is Organization or Public and the principal holds read authority
   today (`requireArtifactRead`: direct human, `artifact:read` or
   `artifact:manage:any`).
4. The level is Public and the request is anonymous. This reaches only the current
   version through the public link, as AUTH-004 already requires.

A principal that cannot read an artifact receives `404 ARTIFACT_NOT_FOUND`, never
`403`, on every surface, so a private artifact's existence does not leak. An
anonymous request for a Private artifact gets the same sign-in requirement as for
an Organization one, so a signed-out owner is asked to sign in. The rule applies
to:

- artifact get, versions, a single version, files, download archive and media
- comparisons
- actions
- comments: list and get
- content bootstrap, `artifact_open`, preview leases, and the live origin of linked artifacts
- the Git clone token
- the MCP equivalents of each, and WebMCP through the same API

Dispatch records and agent presence carry thread ids and agent names, never
artifact data, so they keep today's project-level read rule. A dispatched
thread is read through the comment surfaces above.

### List

`listArtifacts` returns only artifacts the principal owns. For a human
administrator it also returns service-owned ones. Search and tag filters apply on
top. An Organization or Public artifact owned by someone else is opened by link,
never listed.

### Change

Only these principals may publish a version, capture or relink, restore, tag,
change review mode, or raise the level:

- the owner
- a human administrator, for a service-owned artifact

`artifact:publish:any` and `artifact:manage:any` keep their names. They let a
service principal act on artifacts it owns, not on other people's.

Human administrators moderate without reading:

- They may **lower** the level of any artifact: Public → Organization →
  Private.
- They may delete any artifact (AUTH-030).
- They cannot read a member's Private artifact, publish to it, tag it or restore it.

### Comments

- Reading comments requires read authority on the artifact.
- Writing a thread or reply requires read authority plus today's comment-write
  rule (direct human or `comment:write`). An anonymous public visitor never
  comments.
- On a Private artifact this leaves only the owner.
- Deleting a thread or reply requires read authority on the artifact, plus one
  of: the author, a human administrator, or a principal with
  `artifact:manage:any` that controls the artifact.
- Clearing an artifact's threads in bulk is for principals that control the
  artifact, or a human administrator.

### Dispatch

Sending threads of a Private artifact to an agent is refused with
`409 ARTIFACT_PRIVATE`. The message says to share the artifact with the
organization first. Agents connect with service keys and could not read the
artifact.

## 4. Changing the level

`PATCH /api/v1/artifacts/:id/access`, MCP `artifact_set_visibility` and the CLI
accept `private`, `account_required` and `public_link`.

- Raising the level is for the owner, or a human administrator on a
  service-owned artifact.
- Lowering it is also open to any human administrator.
- AUTH-006 still holds: when an administrator has disabled public links, no
  artifact can be raised to Public.

Lowering the level does not end existing grants early:

- A content session already issued keeps serving the version it was issued for
  until it expires, at most 15 minutes later.
- A public response is sent `no-cache, must-revalidate`, so caches stop serving it
  on their next check.

The UI warns about both. Revoking sessions early is out of scope.

The admin Public links screen (ADM-005) keeps its inventory. Its bulk action
lowers the selected artifacts to Organization and is labelled "Stop public
access".

## 5. Defaults

| Surface | Default level |
| --- | --- |
| HTTP upload target, MCP `artifact_commit_upload` | `private` |
| CLI `artifactserver publish` | `private`; `--public` keeps its meaning, and the new `--organization` selects `account_required` |
| Linked artifacts (local) | `private` |
| New versions of an existing artifact | Unchanged level |

## 6. Organization name

The optional setting `ARTIFACT_SERVER_ORGANIZATION_NAME` names the installation's
people in the UI, for example "ACKstorm":

- It is at most 64 characters, with no control characters, and is not a credential.
- The Helm value is `configuration.organizationName`.
- The session response carries it as `installation.organizationName`, or `null`
  when unset.

## 7. Review interface

### Share modal

A **General access** selector at the top of the Share modal replaces
"Manage access" and its separate screen:

```
GENERAL ACCESS
[🔒 Private               ▾]  Only you can open it.
   🔒 Private        Only you
   🏢 Organization   Anyone signed in to ACKstorm with the link
   🌐 Public         Anyone with the link, no sign-in
```

- **Labels:** without an organization name, Organization reads "Anyone signed in
  to this Artifact Server with the link".
- **Saving:** choosing a level saves it immediately. The selector shows a pending
  state, and on failure it returns to the saved level with the server's message.
- **Raising to Public** shows one line before it saves: "Anyone with the link,
  including people outside {organization}, can open the latest version." The
  reader confirms in place, not with a browser dialog.
- **When the reader may not raise the level:**
  - A non-owner sees the selector disabled, with "Shared with {organization}" or
    "Public".
  - A human administrator sees only the levels below the current one.
- **The note under the Review link follows the level:**

  | Level | Note |
  | --- | --- |
  | Private | "Only you can open this link." |
  | Organization | "Anyone signed in to {organization} can open this link." |
  | Public | Adds a **Public link** row first: the raw latest URL, which needs no sign-in. The Review link follows it, marked "for signed-in members". |

- **Other links** and **Review with an AI agent** are unchanged.

### Elsewhere

- The project list shows only what the reader may list.
- A Review deep link to an Organization or Public artifact opens normally.
- The details inspector shows the level as Private, Organization or Public.
- The danger zone and other management controls appear only for principals that
  hold that authority.

## 8. Migration

- **Schema:** each backend (SQLite, Postgres, Cloudflare D1) adds
  `artifacts.owner_principal_id`, filled from the version 1 publisher. It also
  widens the `access_setting` CHECK on `artifacts` and `idempotency_records` to
  allow `private`, and indexes `(project_id, owner_principal_id)`. Postgres
  leads the index with `installation_id`, like its other indexes.
- **No existing level changes.** Account-required artifacts stay readable by
  every member who has the link; they leave other people's lists.
- **Downgrading** the server after the migration is not supported, as with every
  schema step.

## 9. Out of scope

Each of these can be added later on top of this model:

- links that expire
- a "Shared with me" list
- sharing with named people or groups
- per-project membership
- transfer of ownership
- anonymous Review with comments
- early revocation of content sessions

## 10. Conformance

These requirements are new:

| ID | Acceptance (B = behavior, F = failure) |
| --- | --- |
| AUTH-032 | **B:** New artifacts from HTTP, MCP and CLI are Private and record the version 1 publisher as owner; a member-bound key's artifact belongs to its member. **F:** No surface creates an artifact without an owner, and later publishers never change the owner. |
| AUTH-033 | **B:** The owner reads a Private artifact on every surface in §3. Any member, member-bound key or read-capable service key reads an Organization artifact by id. **F:** Another member, a member-bound key of another member, a service key and an administrator each receive 404 on every read surface of a Private artifact, including content bootstrap, comments, comparisons and the Git clone token. An anonymous request receives the same sign-in requirement for a Private artifact as for an Organization one. |
| AUTH-034 | **B:** Lists return the reader's own artifacts; an administrator's lists also contain service-owned ones. **F:** Another member's Organization and Public artifacts never appear in lists or search results. |
| AUTH-035 | **B:** The owner publishes, tags, restores, changes review mode and raises the level. An administrator lowers any level and manages service-owned artifacts. **F:** Another member, and a non-owning key with `manage:any` or `publish:any`, receive 403 on Organization or Public artifacts and 404 on Private ones. An administrator cannot raise a member's level or publish to it. |
| AUTH-036 | **B:** The migration fills the owner from version 1 on SQLite, Postgres and D1 and keeps every level and idempotency replay unchanged. **F:** A migrated artifact whose version 1 publisher is another member is unlisted for the reader but readable by link at Organization. |
| AUTH-037 | **B:** In the Share modal the owner moves between the three levels, confirming in place before Public, and the note and links follow. **F:** A non-owner sees the selector disabled; a failed save returns to the saved level with the message. |
| DSP-014 | **B:** Dispatching threads of an Organization artifact works as before. **F:** Dispatching threads of a Private artifact returns 409 `ARTIFACT_PRIVATE` and creates no dispatch. |

These existing requirements are reworded:

| ID | Change |
| --- | --- |
| SCP-008 | Reworded: one installation membership group; per-artifact access is the owner plus the sharing level, with no per-project or per-person list. |
| AUTH-008 | Reworded: members act on artifacts they own; service principals act within their capabilities on artifacts they own. |
| CMT-006, CMT-007 | Add "with read authority on the artifact". |
| CMT-008 | A principal that can manage any artifact deletes others' comments only on artifacts it controls. |
| PRS-005 | Bulk clearing is for the artifact's controller or a human administrator. |
| AUTH-030 | An administrator deletes a Private artifact it cannot read; non-readers receive not found. |
| AUTH-002 | Account required is no longer the default. |
| ADM-005 | The bulk action lowers to Organization. |

AUTH-003 to AUTH-006 and GIT-005 keep their wording; their tests run against the
new levels.
