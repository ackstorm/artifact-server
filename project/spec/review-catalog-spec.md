# Review catalog: names, pins, Shared with me and Duplicate

**Status:** Proposed
**Date:** November 2, 2026
**Companion documents:** [Artifact sharing levels](./artifact-sharing-levels-spec.md),
[Decision 0035](./decisions/0035-owner-listed-and-opened-artifacts.md),
[Product specification](./artifact-server-product-spec.html#sharing),
[Conformance ledger](./conformance.yml)

## 1. Outcome

Four changes to the Review app, each backed by server state:

1. **Names.** Details, Versions and Activity show a person's name and an initials
   avatar instead of a principal id.
2. **Filters and pins.** The catalog filters by sharing level and pins artifacts
   to a **Pinned** group at the top. Pins are per person and persist.
3. **Shared with me.** The catalog has two tabs, **Mine** and **Shared with me**.
   Shared with me lists other people's artifacts that their owner listed for the
   organization, and artifacts the reader opened by link.
4. **Duplicate.** A **⋯** menu next to Download makes a Private copy of the
   current version, owned by the reader.

Inviting people by email is out of scope.

Delivery is three pull requests, in order: **A** names, filters and pins; **B**
Shared with me and the listing switch; **C** Duplicate. Each one migrates both
stores where it needs to and adds its own ledger rows.

## 2. Names

### Server

The artifact list, artifact details, version list and action page responses
carry one extra top-level field:

```json
"principals": {"mem_ada": "Ada Lovelace", "service:key_ci": "CI deploy"}
```

It maps every principal id that appears in that response's records to a display
name:

| Response | Ids it names |
| --- | --- |
| `GET /api/v1/artifacts` | each item's `ownerPrincipalId` |
| `GET /api/v1/artifacts/:id` | `artifact.ownerPrincipalId`, `current.version.publisherPrincipalId` |
| `GET /api/v1/artifacts/:id/versions` | each version's `publisherPrincipalId` |
| `GET /api/v1/artifacts/:id/actions` | each action's `principalId` |

Names are resolved when the response is built, so every surface shows a
member's current display name:

- **A member** (a human principal, including a member-bound API key acting as the
  member) is named by `installation_members.display_name`, active or not.
- **A service principal** (`service:…`) is named by its API key's `name`, the same
  name its comments already carry as author.
- **Anything else**, including `local-api-token`, is left out of the map.

`InstallationAccessService.principalDisplayNames(ids)` does the lookup through
one identity-repository query per kind. It runs no authorization of its own. It
is called only by the four handlers above, after the application service
authorized the read, and only with ids taken from the records it returned.

**No directory leak.** A reader learns a name only when that principal already
appears on an artifact the reader can read. A response that fails (`404`,
`401`) carries no names. Emails are never returned. `GET /api/v1/members` stays
administrator-only.

### Review

- **Details:** an **owner** row in the Artifact section and a **published by**
  row in the Version section, each a name chip whose title is the principal id.
  The section counts follow the rows.
- **Versions:** each version row shows the publisher's chip after its time.
- **Activity:** the principal id is replaced by the actor's chip. When
  `authorizedByPrincipalId` is set, the chip adds "via API key".
- **The chip:** a round avatar with up to two initials (the first letter of the
  first two words that start with a letter), then the name.
- **Fallbacks:** `local-api-token` reads "You · local CLI". An id missing from
  every `principals` map seen for the selected artifact reads as its compact id,
  as today.

The chip always names the principal in `principalId`. For a member-bound key that
principal is the member the key acts for. `authorizedByPrincipalId` is the key's
issuer, which can be an administrator, so naming it would credit the wrong
person.

## 3. Catalog filters and pins

### Filters

The filter popover gains a **Sharing** group above **Comments**:

- **Private**, **Organization**, **Public**: checkboxes that filter by the stored
  access setting. None checked means every level.
- **Pinned only**: shows only pinned artifacts.

The trigger counts each checked box. "1 filter" is singular. **Clear** resets
the Sharing group too.

The **Comments** filter (With comments / Without comments) already exists
server-side (ART-011), and stays as it is.

Every filter runs on the server, before pagination, like the existing ones:

| Query parameter | Values | Default |
| --- | --- | --- |
| `access` (repeatable, like `tag`) | `private`, `account_required`, `public_link` | every level |
| `pinned` | `all`, `only` | `all` |

### Pins

- **Who.** Any principal that can read the artifact can pin it. A pin belongs to
  one principal and is invisible to everyone else.
- **API.** `PUT /api/v1/artifacts/:id/pin` pins and `DELETE …/pin` unpins. Both
  answer `204` and are idempotent by nature, so they take no `Idempotency-Key`
  and write no action record. A reader without read authority gets `404
  ARTIFACT_NOT_FOUND`. Browser calls need the CSRF token.
- **List items** carry `pinned: boolean` for the reader.
- **Order.** The list returns the reader's pinned artifacts first, then the
  rest, each part in the selected sort. The page cursor carries the group, so
  pages never repeat or skip an artifact across the boundary. A cursor without
  a group is refused with `422 INVALID_INPUT`, as a cursor from another
  sort is today.
- **Stale pins.** A pin on an artifact that was deleted, or that the reader can
  no longer read, is ignored by the list. The row stays.

MCP `artifact_list` is unchanged except that, for a principal with pins, pinned
artifacts come first. Its cursor accepts the group field.

### Review

- **The pin button** sits at the top right of each card. It shows on hover and
  keyboard focus, and stays visible, in the accent color, while pinned. Its label
  is "Pin {name}" or "Unpin {name}", with `aria-pressed`, and its title is "Pin
  to the top" or "Unpin".
- **Groups.** Cards are grouped under small uppercase labels. The **Pinned** group
  comes first. In Mine, the rest is labelled **All**, and only when a Pinned group
  is present.
- **Pinning** reloads the first page, so the card moves into its group.

## 4. Shared with me

This reverses the "never listed" rule of the sharing levels spec (§3 List). See
[decision 0035](./decisions/0035-owner-listed-and-opened-artifacts.md).

### What it lists

Shared with me lists an artifact for a reader when all of these hold:

- it is not deleted, and it is in the selected project;
- it is at Organization or Public;
- the reader does not own it, and for a human administrator it is not
  service-owned (those are already in the administrator's Mine);
- the reader holds read authority (`requireArtifactListing`);
- and either its owner **listed** it, or the reader **opened** it.

| Group | Contents | Label | Hover note |
| --- | --- | --- | --- |
| Pinned | the reader's pinned shared artifacts | "Pinned" | — |
| Listed | listed by the owner | "Listed for {organization}" | "Owners chose to list these." |
| Opened | opened by the reader and not listed | "Opened by link" | "You opened these from a link." |

{organization} falls back to "this Artifact Server", as in the Share modal.

Search, tags, comments, sharing and pinned filters apply within the tab. Private
matches nothing in Shared with me.

### Listing

- **Storage.** One boolean on the artifact, `listed`, off by default. Existing
  artifacts stay unlisted.
- **Who changes it.** The principals that may raise the level: the owner, or a
  human administrator for a service-owned artifact (`requireArtifactControl`).
  Listing widens who finds the artifact, so it follows the raise rule. An
  administrator who must hide a member's artifact lowers it to Private, which
  unlists it.
- **API.** `PUT /api/v1/artifacts/:id/listing` with the strict body
  `{listed: boolean}` returns `{artifact}`. Listing makes nothing readable that
  the level does not already allow. Checks run in this order:
  1. read visibility: a non-reader gets `404`;
  2. control: a reader who does not control the artifact gets `403`;
  3. level: `listed: true` on a Private artifact gets `409 ARTIFACT_PRIVATE`,
     "Share it with the organization first." `listed: false` always succeeds.
- **Activity.** A change writes one action record in the same transaction:
  `list` when listing turns on and `unlist` when it turns off. The record
  carries the principal, the authorizer and the time, like every action, and
  points at the current version.
- **Idempotency.** Setting a value is idempotent by nature, so the route takes no
  `Idempotency-Key`, as comment updates and resolves do. The store writes the
  value and its action only when the value changes. A retry or a repeat of the
  same value answers `200` and writes nothing. The action's key is generated by
  the store (`listing:{artifactId}:{uuid}`), as comment actions' keys are.
- **Lowering to Private** clears `listed` in the same transaction as the level
  change. When the artifact was listed, that transaction writes an `unlist`
  action next to the `change_access` one, so Activity shows both "Changed
  access" and "Removed from Shared with me". The `unlist` action takes the key
  `{change_access key}:unlist`, so a replay of the level change, which returns
  before writing, adds neither. Raising the level again leaves the artifact
  unlisted until the owner lists it again. Lowering from Public to Organization
  keeps it listed.
- **Responses.** Every artifact record carries `listed` (HTTP, MCP and the CLI
  publish response). No MCP tool or CLI command changes it.

### Openings

- **What is recorded.** One row per (principal, artifact), with no timestamp.
- **When.** Only when the Review web app opens an artifact. The HTTP handler of
  `GET /api/v1/artifacts/:id` passes `openedInBrowser: true` to
  `ArtifactManagementService.getArtifact` when the request authenticated with
  the application session cookie (`authenticationMethod === "session"`, set by
  the HTTP authentication middleware). The service records the opening after a
  successful read, when that flag is set and the reader does not control the
  artifact. The insert ignores an existing row.
- **When not.** Every other caller leaves the flag unset:
  - a bearer request to the same route (API key, member-bound key, or OIDC
    bearer);
  - MCP `artifact_get`, which calls the service directly, whatever its
    credential.

  The principal alone cannot decide: an MCP client signed in with OIDC OAuth
  is a direct human principal, exactly like the person's browser. An agent that
  polls an artifact must not fill its person's list. Anonymous public-link opens
  and raw content URLs are not recorded either.
- **No timestamp.** The Opened group sorts like every list, by the artifact's
  creation time or comment count, so no time is stored.
- **Lowering to Private** hides an opened artifact from every non-owner's list,
  because the list requires Organization or Public. The row stays, and the
  artifact reappears if the level is raised again, since the reader already
  had the link.
- **History.** The server only knows of opens it recorded itself, so artifacts
  opened before then are not in the group.

### API

`GET /api/v1/artifacts` gains `scope=mine|shared` (default `mine`). The order is
by group, then by the selected sort: pinned (0), then listed (1), then opened
(2). In Mine, every unpinned artifact is group 1. The Review app derives a
card's group from `pinned` and `artifact.listed`.

### Review

- **Tabs.** "Mine" and "Shared with me" (`role="tablist"`) sit above the search
  field. Mine is selected on load.
- **Cards** in Shared with me show the owner's name in place of the creation
  date.
- **Mine cards** of listed artifacts show "Listed" after the version count.
- **Empty Shared with me:** the title is "Nothing shared with you yet", and the
  description "Artifacts people list for {organization}, and ones you open from
  a link, appear here." A filtered empty state keeps today's copy.
- **Activity labels.** `list` reads "Listed in Shared with me" and `unlist`
  reads "Removed from Shared with me", with the actor's name chip as for every
  action.
- **A deep link.** An artifact opened by link that is not in the loaded page is
  prepended to the tab it belongs to: Mine if the reader controls it, otherwise
  Shared with me.

### Share modal

A row under **General access**, above the Public link row:

```
List it in {organization}'s Shared with me                        [switch]
Everyone signed in to {organization} sees it in Shared with me.
```

| State | Switch | Line under the label |
| --- | --- | --- |
| Reader controls it, level Organization or Public, listed | on | "Everyone signed in to {organization} sees it in Shared with me." |
| Reader controls it, level Organization or Public, unlisted | off | "Only people who have the link find it." |
| Reader controls it, level Private | off, disabled | "Share it with the organization first." |
| Reader does not control it | shows `listed`, disabled | "Only {owner} can change this." |

- **The switch** is `<input type="checkbox" role="switch">`, labelled by the row
  heading.
- **Saving.** Toggling saves at once. While saving the switch is disabled. A
  failure restores the saved state and shows the server's message with
  `role="alert"`.
- **{owner}** is the owner's display name from `principals`, or "the owner" when
  it is unknown.
- **Lowering to Private** in the same modal shows the switch off and disabled as
  soon as the level saves, because the response carries `listed: false`.

## 5. Duplicate

### Server

`POST /api/v1/artifacts/:id/duplicate?projectId=…`, with the strict body
`{versionId}` and a required `Idempotency-Key`, creates a new artifact:

- **Contents.** One version whose manifest is the source version's manifest. File
  bytes are not copied: blobs are content-addressed by SHA-256 and never deleted,
  so the new version's entries name the existing blobs.
- **Name:** "{source name} (copy)". When that passes 200 characters, the source
  name is cut at a character boundary so the result fits.
- **Level and owner.** Private, owned by the caller. The version 1 publisher is
  the caller, through the ordinary new-artifact commit.
- **Kept and dropped.** Same project and review mode as the source. No tags,
  comments, pins, listing or source binding.
- **History.** Version 1 and one `publish` action by the caller. The source's
  versions, current pointer, actions and comments do not change.
- **Response.** The same body as an upload commit, `201` on create and `200` on
  replay.

**Who may duplicate.** Any principal that can read the source version, and that
may create artifacts (`requireArtifactCreation`). Read is checked first, so a
non-reader gets `404` and a reader without creation rights gets `403`. A reader
can already download the version archive and publish it as their own, so
Duplicate grants nothing new; it only skips the round trip. Owner-only would
block the main use, building on a colleague's shared artifact.

**Idempotency.** The input digest covers the source version id, the caller and
the project.

- The same key and the same source replay the original copy.
- The same key with another source is refused with `409 IDEMPOTENCY_CONFLICT`.
- A new key makes another copy.
- A `versionId` that is not a version of that artifact gets `404
  VERSION_NOT_FOUND`.
- An archived project gets `409 PROJECT_ARCHIVED`.

**Port.** `PublicationSource` gains `{kind: "saved_version"}`. The new-artifact
commit skips the staged-upload check and seal for it. Everything else, including
the replay lookup, is the ordinary commit.

No MCP tool or CLI command duplicates.

### Review

- **The menu.** A secondary icon button "More actions" (⋯) sits next to
  Download in the artifact header, disabled while no artifact is selected. Its
  popover holds one item:

  ```
  [copy icon]  Duplicate
               A Private copy of the current version, owned by you, with its own history.
  ```

- **On success** the Review app switches to Mine, reloads the first page and
  selects the copy.
- **On failure** the popover stays open and shows the server's message with
  `role="alert"`.
- **Retries.** One click uses one idempotency key, and a retry of the same click
  reuses it.

## 6. API summary

| Method and path | Body | Answer | PR |
| --- | --- | --- | --- |
| `GET /api/v1/artifacts` | query adds `access`, `pinned`, `scope` | items add `pinned`; adds `principals` | A, B |
| `GET /api/v1/artifacts/:id` | — | adds `principals`; a browser-session read records an opening | A, B |
| `GET /api/v1/artifacts/:id/versions` | — | adds `principals` | A |
| `GET /api/v1/artifacts/:id/actions` | — | adds `principals` | A |
| `PUT`/`DELETE /api/v1/artifacts/:id/pin` | — | `204` | A |
| `PUT /api/v1/artifacts/:id/listing` | `{listed}` | `{artifact}`; writes `list`/`unlist` on a change | B |
| `POST /api/v1/artifacts/:id/duplicate` | `{versionId}` + `Idempotency-Key` | publish response | C |

Artifact records gain `listed: boolean`.

## 7. Storage and migration

| PR | Backend | Change | Schema step |
| --- | --- | --- | --- |
| A | SQLite | `artifact_pins (principal_id TEXT, artifact_id TEXT REFERENCES artifacts(id), PRIMARY KEY (principal_id, artifact_id)) STRICT` | `user_version` 17 → 18 |
| A | Postgres | `artifact_pins (installation_id, principal_id, artifact_id)`, primary key on all three, foreign key to `artifacts (installation_id, id)` | migration `0017_artifact_pins` |
| B | SQLite | `artifacts.listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0, 1))`; `artifact_openings`, shaped like `artifact_pins` (the SQLite `actions.action` column has no CHECK, so `list` and `unlist` need no rebuild) | `user_version` 18 → 19 |
| B | Postgres | `artifacts.listed BOOLEAN NOT NULL DEFAULT FALSE`; `artifact_openings`, shaped like `artifact_pins`; `actions_action_check` admits `list` and `unlist` | migration `0018_artifact_listing` |
| C | — | none | — |

- **Existing data.** No version, blob, idempotency record or action changes.
  Every artifact starts unlisted, unpinned and unopened.
- **Display names** need no schema: they are read from the identity tables
  already in the same database.
- **Recovery.** SQLite backups copy the whole file. Postgres keeps the tables in
  the same database.
- **Downgrade** after a schema step is unsupported, as for every schema step.
- **No new indexes.** The shared query scans the project's artifacts with
  `EXISTS` probes on primary keys. The external-storage performance gate
  measures it.

## 8. Out of scope

- invite by email, and sharing with named people or groups
- removing an artifact from Opened by link
- notifying an owner that someone duplicated, pinned or opened their artifact
- recording where a copy came from
- MCP tools or CLI commands for pins, listing or Duplicate
- names in comparisons, comments (which already carry author names) and the
  administration screens
- ordering Opened by link by time opened

## 9. Conformance

New requirements:

| ID | PR | Acceptance (B = behavior, F = failure) |
| --- | --- | --- |
| ART-013 | A | **B:** Details, Versions and Activity show the owner's, publishers' and actors' names with initials avatars, and "via API key" for key-authorized actions. **F:** List, details, versions and actions responses name only principals recorded on artifacts the reader can read. A failed read names nobody, emails never appear, and members cannot list the directory. |
| ART-014 | A | **B:** The catalog filters by sharing level, and pinned artifacts stay grouped at the top across reloads and under Pinned only. **F:** Pins are per principal and need read authority. Pages never repeat or skip an artifact across the pinned boundary in either sort, and a cursor without a group, or an unknown level, is refused. |
| AUTH-038 | B | **B:** An owner lists an Organization artifact from the Share modal and a colleague finds it under "Listed for {organization}". An artifact the colleague opened by link appears under "Opened by link". **F:** Shared with me never contains Private artifacts, service-owned artifacts for an administrator, or another reader's openings. Non-controllers cannot change the listing, and a Private artifact cannot be listed. Each listing change, and the unlisting by a lowering to Private, writes one Activity record, and a repeat writes none. Only a browser-session read records an opening: API-key and MCP OAuth-bearer reads record nothing. |
| ART-015 | C | **B:** Duplicate from the ⋯ menu creates "{name} (copy)", Private and owned by the reader, with one version identical to the source, and opens it in Mine. **F:** A non-reader gets 404 and a reader without creation rights 403. A replay returns the same copy, a reused key with another source conflicts, and the source's versions, pointer, actions and bytes never change. |

Reworded:

| ID | Current | Proposed |
| --- | --- | --- |
| AUTH-034 behavior | "…an Organization or Public artifact owned by someone else is opened by link and never listed." | "…an Organization or Public artifact owned by someone else appears only in the reader's Shared with me list, when its owner listed it or the reader opened it." |
| AUTH-034-F | "Another member's Organization and Public artifacts never appear in lists or search results." | "Another member's artifacts never appear in Mine lists or search results, and appear in Shared with me only when listed by their owner or opened by the reader." |

Prose updates:

- **`artifact-sharing-levels-spec.md`:** §1, §3 List and §9, pointing to 0035
  (done with this spec).
- **`artifact-server-product-spec.html` (#sharing):** "Lists show each person
  only the artifacts they own, so nobody discovers another person's artifact by
  browsing." becomes "Lists show each person the artifacts they own. Another
  person's artifact appears only in Shared with me, when its owner lists it for
  the organization or the reader has opened its link." The Organization card's
  "it stays out of their lists" and the Public card's "Only the owner sees the
  item in lists" get the same qualification.
- **`docs/cli.md:19`:** "only the publisher sees them in lists" adds "until the
  owner lists an Organization or Public artifact in Shared with me from the
  Review app".
