# 0035: Owners may list shared artifacts, and readers see what they opened

**Status:** Accepted
**Date:** November 2, 2026

Amends [0032](./0032-owner-private-artifacts.md): "Only the owner sees an
artifact in lists, at every level" no longer holds for Organization and Public
artifacts. Specified in [Review catalog](../review-catalog-spec.md#4-shared-with-me).
Rewords AUTH-034 and adds AUTH-038.

## Decision

- **Two tabs.** The Review catalog has **Mine**, which lists exactly what lists
  hold today, and **Shared with me**.
- **What Shared with me holds.** Organization and Public artifacts the reader
  does not own and may read. Each one is either:
  - **listed**: its owner turned on "List it in {organization}'s Shared with me";
  - **opened**: the reader opened it by link in the Review web app, signed in
    with a browser session.
- **Off by default.** Listing is off, so every existing artifact stays unlisted.
- **Who lists.** The principals that may raise the level: the owner, or a human
  administrator for a service-owned artifact. A Private artifact cannot be
  listed.
- **Lowering to Private unlists.** Raising the level again does not relist.
- **Listing is in Activity.** Turning listing on or off writes a `list` or
  `unlist` action record, like every other artifact mutation. Lowering a listed
  artifact to Private writes an `unlist` record next to its `change_access`
  record.
- **What an opening records.** One row per (principal, artifact), with no time.
  Only the Review web app's read of artifact details, authenticated by the
  browser session cookie, writes it. Bearer requests never do: API keys,
  member-bound keys, OIDC bearers, and every MCP call, including an MCP client
  signed in with OIDC OAuth.
- **Private stays private.** Shared with me never contains a Private artifact,
  whatever was listed or opened before.

## Why

- **The gap.** People asked to find what colleagues shared without hunting for
  links in chat. 0032 made the link the only way in, which kept drafts private
  but left no way to publish something on purpose for the whole organization.
- **Listing is an owner's choice on top of the level.** The level decides who may
  read. Listing only decides whether people who may read are told it exists. It
  widens no read authority, so it needs no new authorization rule. It reuses the
  raise rule, because telling everyone is a step up in exposure.
- **Openings reveal nothing new.** An opened artifact is one the reader already
  reached with a link. Remembering it saves the reader the link, and shows no one
  else anything.
- **Browser only.** Agents poll artifacts, and recording their reads would fill
  their person's list with whatever the agent touched. The principal cannot tell
  them apart: an MCP client signed in with OIDC OAuth is the same direct human
  principal as the person's browser. The transport can, so the browser-session
  route is the only one that records.
- **Listing is visible.** Listing tells the organization an artifact exists. The
  owner, and anyone reading the artifact's Activity, should see when that
  started and stopped, and who did it.
- **Unlisting on Private.** An owner who hides an artifact and later shares one
  link to it should not find it announced to the whole organization again.

## Consequences

- **Two promises change.** "Nobody discovers another person's artifact by
  browsing" now holds only for unlisted artifacts. The sharing levels spec (§1,
  §3 List, §9) and the product specification say so.
- **AUTH-034** is reworded: Mine lists stay owner-only, and Shared with me is
  bounded by listing and openings. **AUTH-038** proves the bounds.
- **Administrators.** An administrator cannot list a member's artifact. To take
  one out of everyone's list, they lower it to Private.
- **No notifications.** The owner is not told who opened, and readers are not
  told what was listed. No one can remove an item from Opened by link.
- **Storage.** One boolean on each artifact, one small table of (principal,
  artifact) pairs, and two action kinds. Both stores migrate.
