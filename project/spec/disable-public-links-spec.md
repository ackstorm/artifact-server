# Disable public links

**Status:** Accepted; implemented — AUTH-006 behavior-verified on the local deployment (October 31, 2026)
**Date:** October 31, 2026
**Companion documents:** [Product specification](./artifact-server-product-spec.html#sharing),
[Artifact sharing levels](./artifact-sharing-levels-spec.md),
[Decision 0033](./decisions/0033-installation-public-link-switch.md),
[Conformance ledger](./conformance.yml)

## 1. Outcome

An installation administrator can turn public links off, and back on, from
**Settings › Public links**. While public links are off:

- Nobody can make an artifact Public, on any surface.
- Artifacts that are already Public keep their stored level (`public_link`) but
  no longer open without sign-in.
- Signed-in readers open those artifacts exactly as if they were Organization.

Turning public links back on restores public reading of those artifacts
unchanged. Public links are on by default, which is today's behavior.

An operator can instead set the policy at startup with
`ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED=true|false`. A configured value is the
effective policy, and administrators cannot change it in Settings.

This implements AUTH-006.

## 2. Policy

The effective policy is one boolean, `publicLinksEnabled`:

- **Configured.** When `ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED` is set, its value
  is the policy, and the policy is locked (see "Configuration lock" below).
- **Not configured.** Otherwise it is the installation setting stored in the
  database, which an administrator changes in Settings and which defaults to on.

`PublicLinkPolicyService` is the only place that resolves the effective value.

| Question | Public links on | Public links off |
| --- | --- | --- |
| Raise an artifact to Public | Owner, as in the sharing spec §4 | Refused: `409 PUBLIC_LINKS_DISABLED` |
| Publish a new artifact as Public | Allowed | Refused: `409 PUBLIC_LINKS_DISABLED` |
| Lower a level | Allowed | Allowed |
| Anonymous read of a stored-Public artifact | Current version, through the public link | Same answer as an Organization artifact: sign-in required |
| Signed-in read of a stored-Public artifact | Any principal with read authority | Same: rule 3 of the sharing spec §3 (Organization) |
| Lists | Owner only | Owner only |

Details:

- **Error.** `409 PUBLIC_LINKS_DISABLED`, with the message "An administrator has
  turned off public links for this installation." HTTP and MCP use it, and the
  CLI prints it. A 409 matches `ARTIFACT_PRIVATE`: the request is valid, but the
  installation's state refuses it.
- **Order of checks.** Authorization runs first. A caller that may not raise the
  level still gets `403` or `404`, as today. Only a caller that would otherwise
  succeed sees `PUBLIC_LINKS_DISABLED`.
- **What counts as a raise.** A change whose target is `public_link` while the
  stored level is lower. Setting `public_link` on an artifact that is already
  Public makes nothing more readable, so it is allowed and behaves as today
  (including an idempotent replay).
- **Idempotent replay.** A publish that succeeded before the switch was turned
  off replays its original result under the same key. The artifact keeps
  `public_link` and is not publicly readable. The replay check runs before the
  policy check, so a retry never reports failure for work that was done, and the
  read-time rule keeps the artifact closed. A level change retried under its key
  while the artifact is still Public is a no-op, as above. If the level has
  dropped since, the retry is a new raise and is refused. A new key, or a
  changed body, is a new request and is refused.
- **Anonymous answer.** Anonymous requests receive exactly the response for an
  Organization artifact (`401 CONTENT_NOT_PUBLIC`, `Cache-Control: private,
  no-store`). An anonymous reader learns nothing about the policy, and nothing
  about the artifact beyond what an Organization link already reveals.
- **No cache of the setting.** Every decision reads the stored setting. The
  external-storage runtime and the Cloudflare worker run several processes or
  isolates, so an in-process copy would keep serving public reads after an
  administrator turned them off. The setting is read only on the would-be-public
  path, on a raise and on `GET /api/v1/session`, so Private and Organization
  content reads pay nothing extra.
- **Concurrent raise.** A raise checks the policy and then stores the level, with
  no transaction around both. A raise that lands while an administrator turns
  public links off can still store `public_link`. Nothing becomes readable: the
  read-time check keeps it closed until public links are turned back on.

### Configuration lock

`ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED` is read once at startup on every
deployment.

| Value | Effect |
| --- | --- |
| Unset or empty | Not configured: administrators choose in Settings, and the stored value applies. |
| `true` | Public links are on and locked. |
| `false` | Public links are off and locked. |
| Anything else (`TRUE`, `1`, `yes`, ` true`) | Startup fails, naming the field: "ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED must be true or false, or unset so administrators choose in Settings." |

While the policy is locked:

- **The stored value is ignored.** It is kept unchanged, and applies again if
  the variable is later unset.
- **Changes are refused.** An administrator's
  `PUT /api/v1/administration/public-link-policy` returns `409
  PUBLIC_LINK_POLICY_LOCKED`, with the message
  "ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED in the server configuration sets this
  policy. Change it there." Authorization still runs first, so a
  non-administrator gets `403`. A PUT of the value already in effect is refused
  too.
- **Reads report the lock.** `GET` reports `setByConfiguration: true`.
- **Everything else follows the configured value.** The session response, MCP
  `artifact_capabilities`, raise refusals and anonymous reads all reflect it. For
  example, with `false` an administrator cannot turn public links on, and nobody
  can make an artifact Public.

Where each deployment sets it:

| Deployment | Setting |
| --- | --- |
| Local and Compose (`artifactserver start`, `start-external-storage`) | the environment variable; both Compose files pass it through |
| Helm | `configuration.publicLinksEnabled` (boolean, unset by default); rendered only when set |
| Cloudflare Worker | the Worker variable, accepted as `true`/`false` or the strings `"true"`/`"false"`; an invalid value fails initialization with the same message |

## 3. Surfaces

### Raising is refused while off

| Surface | Path |
| --- | --- |
| HTTP | `PATCH /api/v1/artifacts/:id/access` with `accessSetting: "public_link"` |
| HTTP upload commit | `POST /api/v1/uploads/:uploadId/commit` with a new-artifact target at `public_link` |
| MCP | `artifact_set_visibility` and `artifact_commit_upload` with `accessSetting: "public_link"` |
| CLI | `artifactserver publish --public` (through the HTTP upload commit) |
| WebMCP and the Review UI | Through the same HTTP API |

The refusal leaves the upload open and stores nothing, so the caller can commit
the same upload at another level.

Linked artifacts start Private, and capture and relink never change the level,
so they have nothing to refuse. The admin bulk action only lowers.

### Anonymous reads are refused while off

| Surface | Today's anonymous Public behavior | While off |
| --- | --- | --- |
| `GET /artifacts/:artifactId` (public latest URL) | `302` to the current version origin | `401 CONTENT_NOT_PUBLIC` |
| Content origin of the current version (`GET`/`HEAD`, any path, conditional or range requests) | `200`/`206`/`304`, `Cache-Control: public, no-cache, must-revalidate` | `401 CONTENT_NOT_PUBLIC`; authorization runs before the ETag check, so a revalidation never gets `304` |

No other surface is anonymous. Bootstraps, content sessions, Review preview
leases, the live origin of linked artifacts, the API, MCP and Git all require a
signed-in principal.

### Signed-in reads while off

- A stored-Public artifact is read as an Organization artifact: the Review app,
  API, MCP and content bootstraps work for every principal with read authority
  who has the link.
- Content served under a content session is sent `private, no-store`, never
  `public`.
- MCP `artifact_open` returns a content-bootstrap URL for a stored-Public
  artifact, as it does for Organization, instead of the raw public URL.

### Grants that already exist when the switch turns off

- **Content sessions** need no caveat. Every session belongs to a signed-in
  principal who keeps read authority over a stored-Public artifact.
- **Shared caches** stored earlier public responses with `no-cache,
  must-revalidate`. Their next revalidation reaches the origin, receives `401`,
  and stops serving the page.
- **Copies cannot be recalled:** pages already open in an anonymous browser,
  downloaded copies, and copies kept by caches outside Artifact Server.

### API additions

| Surface | Change |
| --- | --- |
| `GET /api/v1/administration/public-link-policy` | Human administrators only. Returns `{publicLinksEnabled: boolean, publicArtifactCount: number, setByConfiguration: boolean}`, where `publicLinksEnabled` is the effective value. |
| `PUT /api/v1/administration/public-link-policy` | Human administrators only. Body `{publicLinksEnabled: boolean}` (strict). Returns the same shape. Browser calls need the usual CSRF token. When not locked, setting the current value again succeeds unchanged; when locked, it returns `409 PUBLIC_LINK_POLICY_LOCKED`. |
| `GET /api/v1/session` | `installation.publicLinksEnabled: boolean` (effective), next to `organizationName`. |
| MCP `artifact_capabilities` | `sharing.modes` omits `public_link` while the effective policy is off; `sharing.default` stays `private`. |
| MCP `artifact_set_visibility` description | Adds: "Public is refused with PUBLIC_LINKS_DISABLED while an administrator has turned public links off." |

Anyone else gets `403 AUTHORIZATION_DENIED` on the policy routes, including
service keys and member-bound keys of an administrator. `publicArtifactCount`
counts non-deleted artifacts stored at `public_link` that have a current
version, the same set the inventory lists.

No MCP tool or CLI command changes the policy. Changing it is a human
administrator's decision, made in Settings, or an operator's, made in the
server configuration.

## 4. Admin UI

The switch sits at the top of **Settings › Public links**
(`apps/web/src/review/settings-public-links.tsx`), above the inventory.

```
PUBLIC LINKS FOR THIS INSTALLATION
On. Owners can make an artifact Public, so anyone with its link
opens it without signing in.                 [Turn off public links]
```

```
Off. No artifact opens without sign-in, and nobody can make one
Public.                                       [Turn on public links]
```

### Turning off

The button opens an in-place confirmation (`role="group"`, label "Confirm
turning off public links"). Browser dialogs (`confirm()`, `alert()`) are not
used.

- **With N ≥ 2 Public artifacts:** "{N} artifacts are Public now. They stop
  opening without sign-in as soon as you turn public links off. They keep their
  Public setting, and open without sign-in again if you turn public links back
  on. Until then, people signed in to {organization} with the link can still
  open them."
- **With N = 0:** "No artifact is Public now."
- **Then, always:** "Nobody can make an artifact Public while public links are
  off. Pages already open or downloaded, and copies cached outside Artifact
  Server, cannot be recalled."
- **Buttons:** **Cancel** and **Turn off public links**.

{organization} falls back to "this Artifact Server", as in the Share modal.
For N = 1 the copy is singular: "1 artifact is Public now. It stops opening
without sign-in… It keeps its Public setting, and opens without sign-in again…"

### Turning on

Turning public links back on makes every stored-Public artifact readable
without sign-in at once, so it also confirms in place:

- **With N ≥ 2:** "{N} artifacts keep their Public setting and open without
  sign-in again as soon as you turn public links on." For N = 1: "1 artifact
  keeps its Public setting and opens without sign-in again as soon as you turn
  public links on."
- **With N = 0:** "Owners can make artifacts Public again."
- **Buttons:** **Cancel** and **Turn on public links**.

### States

- While the change is saving, both buttons are disabled and the action reads
  "Saving…".
- A failure shows the server's message inline, and the switch keeps its saved
  state.
- Success announces the new state in a `role="status"` line.

### Set by configuration

When `setByConfiguration` is true:

- The state line shows the effective value as usual.
- The button is shown disabled, and no confirmation opens.
- Under it, a note reads: "Set by the server configuration. Change
  ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED to change it."

### Inventory while off

The inventory still lists stored-Public artifacts, so an administrator can lower
them for good. A note above the table reads: "Public links are off. These
artifacts keep their Public setting but do not open without sign-in. Stop public
access lowers them to Organization."

## 5. Share modal

The policy comes from `session.installation.publicLinksEnabled`, loaded with the
page.

While public links are off:

- **Public option.** The selector still lists Public, but as a disabled option
  labelled "Public — Turned off by an administrator".
- **Note.** For a reader who may raise the level, one line under the selector
  reads "Public links are turned off by an administrator."
- **A stored-Public artifact:**
  - The selector shows Public, and still offers the levels below it to the owner
    and to administrators, so they can lower it.
  - The description reads "Public links are turned off by an administrator. Only
    people signed in to {organization} with the link can open it until they are
    turned back on."
  - The **Public link** row is hidden. The Review link note is the Organization
    one.
- **Stale page.** If an administrator turns public links off after the page
  loaded, the server refuses the raise. The selector returns to the saved level
  with the server's message, which is the existing failed-save behavior
  (AUTH-037-F).

Nothing else in the modal changes.

## 6. Storage and migration

| Backend | Change | Schema step |
| --- | --- | --- |
| SQLite | `CREATE TABLE IF NOT EXISTS installation_settings (installation_id TEXT PRIMARY KEY, public_links_enabled INTEGER NOT NULL CHECK (public_links_enabled IN (0, 1))) STRICT` | `user_version` 15 → 16 |
| Cloudflare D1 | The same table, without `STRICT` (as for the other D1 tables), in the create path | `runtime` 12 → 13 |
| Postgres | `ALTER TABLE artifact_installations ADD COLUMN public_links_enabled BOOLEAN NOT NULL DEFAULT TRUE` | migration `0015_public_link_policy` |

- **Defaults.** SQLite and D1 have no installation row, so a missing row means
  on. Writes upsert one row per installation. Postgres already keeps one
  `artifact_installations` row per installation, so the setting is a column on
  it.
- **Existing data.** No artifact or idempotency record changes. Every existing
  installation starts with public links on.
- **Configured value.** It is never written to the database, so setting or
  unsetting the variable needs no migration and leaves the stored choice intact.
- **Recovery.** The Cloudflare recovery worker's state digest includes
  `installation_settings`, so a restore proves the setting survived. SQLite
  backups copy the whole file, and Postgres keeps the column with its row.
- **Downgrade.** A build older than this one ignores the setting, so public
  links come back on. Downgrading after a schema step is unsupported, as for
  every schema step.

## 7. Out of scope

- a per-project or per-member public-link policy
- an audit record of who changed the switch and when (the action ledger is
  artifact-scoped)
- a Cloudflare deployment-manifest default for the variable (operators set the
  Worker variable, as for `ARTIFACT_SERVER_ORGANIZATION_NAME`)
- a CLI flag for the policy, separate from the environment variable
- an MCP tool or CLI command to change the policy
- lowering existing Public artifacts automatically (administrators use Stop
  public access)
- notifying owners whose artifacts stopped being public
- early revocation of content sessions
- Plannotator delegated requests. That integration is specified but not built
  (PLN-001 to PLN-017). When it is built, it calls the same application services
  and inherits this policy; PLN-007-F already requires that a Plannotator-signed
  request cannot bypass installation policy.

## 8. Conformance

AUTH-006 keeps its ID, owner, `deployments: *all` and `depends_on: [AUTH-003]`.
It moves to `behavior_verified` with local evidence:

| ID | Proof | Evidence |
| --- | --- | --- |
| AUTH-006-B | Browser: an administrator turns public links off in place, an existing Public artifact stops opening anonymously, the Share modal shows Public disabled, and turning them back on restores the anonymous read | `project/evidence/browser.json` |
| AUTH-006-F | HTTP, MCP and CLI: every raise path is refused for every principal kind, anonymous reads and revalidation are refused on every public route, non-administrators cannot read or change the policy, and an administrator cannot change a configured policy (the configured value overrides the stored one in both directions) | `project/evidence/local-foundation.json` |

The acceptance text is reworded to match the decisions:

| ID | Current | Proposed |
| --- | --- | --- |
| AUTH-006-B | Disable public links and confirm that new and existing artifacts cannot be made or remain publicly readable under server policy. | Turn public links off in Settings and confirm that no artifact can be made Public, existing Public artifacts keep their level but stop opening without sign-in, and turning public links back on restores them unchanged. |
| AUTH-006-F | Members, agents, API keys, and Plannotator cannot bypass the administrator's public-link policy. | Members, administrators, member-bound and service API keys, MCP agents and the CLI cannot make an artifact Public, read a stored-Public artifact without sign-in, or change the policy without human administrator authority while public links are off, and no administrator can change a policy the server configuration sets. |

The F rewording moves Plannotator to PLN-007-F, which already holds that
promise, because no Plannotator entry point exists to test. The configuration
lock is part of F, so it needs no new ID. The parsing of the variable on each
deployment is proved by tests without acceptance IDs: the lifecycle CLI test,
the Helm verify script and the Cloudflare runtime test.

No other requirement is reworded, and no requirement ID is added:

- **ADM-005.** Unchanged: its inventory and Stop public access keep their
  behavior, and the switch on the same screen belongs to AUTH-006.
- **SEC-003.** Stays `specified`; this provides one of its policies.

Prose updates:

- **`artifact-server-product-spec.html` (#sharing, about :2044).** "An
  administrator can disable public links." becomes "An administrator can turn
  public links off for the installation. Public artifacts then require sign-in
  and keep their setting, and they open without sign-in again when public links
  are turned back on."
- **`single-application-administration-spec.md`.**
  - :44: the route purpose adds "and turn public links off or on for the
    installation".
  - §Public links: one paragraph that points to §4 of this spec.
- **Configuration docs.** Both `.env.example` files, the Compose docs page and
  the Helm `values.yaml` describe `ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED` /
  `configuration.publicLinksEnabled` next to the organization name.
- **Docs and skill.** `docs/mcp.md:97` and
  `skills/artifact-server/references/artifact-operations.md:51` gain one
  sentence each about `PUBLIC_LINKS_DISABLED`.
