# 0032: Artifacts are private to their owner unless shared

**Status:** Proposed
**Date:** October 30, 2026

Supersedes SCP-008. Specified in
[Artifact sharing levels](../artifact-sharing-levels-spec.md).

## Decision

Every artifact has an owner, the principal that published version 1, and one of
three sharing levels:

| Level | Who can read it |
| --- | --- |
| Private (the default) | Only the owner |
| Organization (`account_required`) | Any member, or a key with read authority, that has the link |
| Public (`public_link`) | Anyone who has the link |

Only the owner sees an artifact in lists, at every level. Human administrators
moderate: they can lower any artifact's level and delete it, but they cannot
read another member's Private artifact.

## Why

With Dex and automatic admission, the installation's group is the whole company.
Under SCP-008, every draft that any person or agent published showed up in
everyone's lists. People want to publish work in progress and decide when, and
with whom, to share it. The link is the unit of sharing, as in common document
tools.

## Consequences

- **Wire values:**
  - The two existing values keep their names, so existing clients and stored
    idempotency records stay valid.
  - `private` is new.
  - The names `account_required` and `public_link` describe who can reach the
    artifact, not who sees it in lists.
- **Capabilities:** `artifact:publish:any` and `artifact:manage:any` no longer
  reach artifacts owned by other people.
- **Dispatch:** sending a Private artifact's threads to an agent is refused,
  because agents connect with service keys.
- **Lowering a level:**
  - A content session that was already issued can still serve its version for up
    to 15 minutes.
  - Revocation is deferred.
- **Out of scope for now:** a "Shared with me" list, and sharing with named
  people.
