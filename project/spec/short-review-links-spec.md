# Short Review links

**Status:** Implementing; local evidence only.
**Owner:** Web application
**Companion documents:** [Product specification](./artifact-server-product-spec.html), [Conformance ledger](./conformance.yml)

## Outcome

A Review link fits in a chat message. `/a/<artifact code>` opens an artifact in Review on its latest version; `/a/<artifact code>?v=<version code>` opens one exact version.

## Codes

A code is the UUID part of an `art_` or `ver_` identity, read as a 128-bit number and written in base62 (`0-9`, `A-Z`, `a-z`), left-padded to exactly 22 characters. The mapping is reversible, so a code needs no storage and never goes out of sync with its identity. A code that is not 22 base62 characters, or whose value is 2^128 or more, is not a code.

## Redirect

`GET /a/:code` decodes the artifact code and, when present, the `v` version code, then answers `308` to `/review?artifact=<id>[&version=<id>]&view=focus`. Every other query parameter, such as `path` or `mode`, passes through. A code that does not decode answers the standard `404` with no redirect. Decoding grants nothing: Review applies normal authentication and authorization to the decoded identities.

## Links

Every Review link the server returns is short: publication results, version links, MCP `artifact_open` `reviewUrl`, and the browser's copy actions name one exact version with `v`. Artifact details over HTTP and MCP `artifact_get` also return `links.review` for the latest version.

## Project resolution

An artifact read without a project resolves the artifact's own project, then applies the normal project and artifact read checks. An unknown artifact answers `ARTIFACT_NOT_FOUND`. When Review opens with an artifact but no project, it reads the artifact by ID, writes its project into the address bar, and selects the current version unless the link named one.

## Conformance

| ID | Contract |
| --- | --- |
| `SHL-001` | Short codes, the redirect, short links on every surface, and artifact reads without a project. |
| `SHL-002` | Review opens a short link on the right project and version, and shows the unavailable state for an artifact the reader cannot see. |
