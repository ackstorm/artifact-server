# Agent Edit Tools (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents change an artifact's text files without re-uploading it, skip re-uploading bytes an artifact already stores, see non-fatal publication warnings, and receive comment feedback that names the quoted text and the page element it is about.

**Architecture:** An edit is a publish: `PublishArtifactService.editArtifact` applies ordered text operations to the current version's manifest in memory, stores only the new blobs, and commits through the existing one-transaction `commitVersion` with a `saved_version` source (no staging, no migration). Upload plans may name a base artifact whose stored blobs are copied into staging server-side. A bounded regex scanner reports missing references and CSP-blocked hosts after commits and edits. The review frame persists Plannotator's `elementContext` through `buildPersistedHtmlAnchor`, and the MCP adapter derives a per-thread `target` from recognizable anchors for `comment_list` and the `dispatch_inbox` bundle.

**Tech Stack:** TypeScript 7, Effect 4 (`Effect.fn`, `Schema.TaggedError`), zod 4 at the MCP/HTTP wire, Hono, `@modelcontextprotocol/server`, SQLite and Postgres repositories, React review frame with `@plannotator/ui` 0.66, Vitest and Playwright.

## Resolved questions

1. **Breadth of `target` (Task 5).** `target` appears in MCP `comment_list` items and in MCP `comment_get` (update the CMT-012 parity test for both). The HTTP thread projection does not get it.
2. **Native bridges (Task 5).** Accepted: the Pi, OpenCode and Claude channel integrations keep rendering with `@plannotator/agent-bridge` and show no element lines.
3. **CLI blob reuse (Task 2).** CLI `publish --artifact <id>` passes that artifact as `baseArtifactId` when it creates the upload, so a new version uploads only files the artifact does not already store. Cover it in the PUB-015 test (or the existing CLI publish test) by asserting that a re-publish of unchanged files performs no file PUT.

## Decisions taken within scope (override if wrong)

- **Action history:** an edit records the existing `publish` action kind through `commitVersion`. No migration. EDT-001 is rewritten without "marked as an edit". SQLite `actions.action` has no CHECK, but Postgres `actions_action_check` would need a migration for a new kind, and nothing reads the distinction.
- **Blob reuse:** at upload creation, the server copies each reused blob into its staging slot and marks it uploaded, so commit stays one unchanged path. Cost: one server-side copy per reused file at create time. The alternative, a per-file "stored" flag, needs SQLite and Postgres migrations.
- **HTTP edit route:** `POST /api/v1/artifacts/:artifactId/edits?projectId=…`, with an `Idempotency-Key` header and body `{expectedCurrentVersionId, operations}`. This follows the sibling `POST /api/v1/artifacts/:artifactId/capture`, not the `/projects/:projectId/...` path sketched in `local-workspace-spec.md` §6, which the plan rewrites.
- **Operation discriminator:** `kind` (mirrors `artifact_commit_upload`'s `target.kind`).
- **`write`** accepts only inline text media types (explicit or inferred). An unknown extension infers `application/octet-stream` and is refused with a hint to pass `mediaType`. **`rename`** keeps the file's bytes and media type. If it renames the entry file, the entry path follows it.
- **Bounds:** the 256 KiB per call counts the UTF-8 bytes of every `oldText`, `newText`, and `text`. An edited or written file is at most 1 MiB (`maximumInlineTextFileBytes`, the `artifact_read_file` bound).
- **Change list:** `changes` is the manifest comparison of base and result (`added`, `modified`, `removed`, `renamed`), via the existing `compareManifests`. It is not a log of operations.
- **Warnings:** cap of 50 warnings and 4 MiB of HTML and Markdown scanned. `<a href>` is not checked for `missing_reference` on `spa` routing, because the SPA fallback serves every path. The root path `/` resolves to the entry file, and a path ending in `/` resolves to `index.html`.
- **Ledger:** new IDs PUB-015 (blob reuse), PUB-016 (warnings), CMT-023 (element context), and MCP-022 (agent feedback). AGENTS.md requires `-B`/`-F` IDs for every feature, so Tasks 2, 4, and 5 get one each.

## Where scope meets limits in the code or spec

- **Fonts cannot be blocked.** The Review frame CSP has `font-src * data:`, so `blocked_host` fires for scripts (`<script src>`) and stylesheets (`<link rel=stylesheet href>`) only.
- **Content-host URLs.** The application layer does not know the content domain, so an absolute script URL on the content domain is reported as `blocked_host`. Artifacts do not hardcode version hosts. The limit is marked with `ponytail:`.
- **BRP-002 byte pin.** The server renderer is a byte-for-byte mirror of `@plannotator/agent-bridge`. The pin still holds for items without element context, which is what BRP-002-B exercises. Items with element context render extra lines the package does not render. Task 5 updates the mirror's doc comment and the BRP-002 `proof_gap`.
- **`local-workspace-spec.md` §6** describes a browser editor that uploads through staging. The approved rewrite replaces it with the agent edit commit. No browser editor UI is built here; one would call the same HTTP route.
- **Postgres** paths (`commitVersion` with a `saved_version` source, and `listArtifactBlobs`) cannot run through `dk.sh`, which has no Docker socket. CI's Full tier (`pnpm test:external-storage-runtime`) covers them. EDT-001 and PUB-015 are therefore marked `implementing` with a `proof_gap`.

## Global Constraints

- Read `node_modules/effect/AGENTS.md` before writing Effect code. Use `Effect.fn("Name.op")` for service operations and `Effect.fnUntraced` for helpers. Errors are `Schema.TaggedError`. Use `DateTime` from `dependencies.clock`, never `Date.now()`.
- MCP and HTTP wire schemas use zod, following the existing files. Application code never imports zod.
- Lint (`pnpm lint`, anti-slop):
  - no `typeof`, and no `unknown`-typed parameters except ones named `cause`;
  - no conditional empty-object spread (`...(x ? {a} : {})`), no "shape" in any symbol name, and no underscore-prefixed identifiers except `_tag`;
  - every `as` assertion needs a `SAFETY:` comment (prefer none), no `!` non-null assertions, no regex with control characters.
- Tests: no module mocks. Use real servers (`startTestServer`), temporary installations, real HTTP and MCP. Each test title carries its requirement IDs. Each `-B` and `-F` ID is claimed by exactly one test. Write one compact `-B` test and one `-F` test per task.
- Comments and docs state the present only: no history, no "new/now/removed", no task or phase labels. Mark deliberate shortcuts with `ponytail:` naming the ceiling.
- No new dependencies. No database migration.
- Never let an untrusted value pick a storage location. Edit paths pass `parseManifestPath`/`createManifest`. Blob keys are SHA-256 digests the server computed or matched against the caller's own artifact.
- Bounds: `maximumEditTextBytes = 262_144` (256 KiB per call), `maximumInlineTextFileBytes = 1_048_576` (1 MiB per file), `maximumCommentAnchorBytes = 16_384`, `maximumPublicationWarnings = 50`, `maximumWarningScanBytes = 4_194_304`.
- Gates run through the wrapper, foreground, every command under `timeout`, with output redirected to a log. Never pipe a gate into `tail` or `grep` and trust the exit code:
  ```bash
  DK=/tmp/claude-1000/-home-coder-workspace-local-artifact-server/c8f2e448-a7f1-4ca5-9f11-c3b6f1dfec3f/scratchpad/dk.sh
  LOG=/tmp/claude-1000/-home-coder-workspace-local-artifact-server/c8f2e448-a7f1-4ca5-9f11-c3b6f1dfec3f/scratchpad/gate.log
  timeout 900 "${DK}" "pnpm exec vitest run <files>" > "${LOG}" 2>&1; echo "EXIT=$?"
  grep -m 20 -E -C 3 "FAIL|Error|✗" "${LOG}"
  ```
  - Typecheck: `"${DK}" "pnpm exec tsc -p tsconfig.json --noEmit"`. The web app uses `"${DK}" "pnpm --filter @artifact-server/web typecheck"`.
  - Lint: `"${DK}" "pnpm lint"`.
  - Ledger, run from the repo root: `timeout 300 docker run --rm -v "${PWD}":/w:ro -w /w ruby:3.3-alpine sh -c "ruby scripts/validate-conformance.rb project/spec/conformance.yml && ruby scripts/check-conformance-test-ids.rb"`.
  - Browser tests: `"${DK}" "pnpm build && pnpm exec playwright test <spec>"`.
  - Never run `pnpm verify:iteration` locally.
- Implementers do not commit. Each task ends with "report to controller for commit", and the controller commits.
- Execute the tasks in order 1 → 2 → 3 → 4 → 5. Every task edits `project/spec/conformance.yml`, and Tasks 1–3 and 5 all edit `src/mcp/artifact-mcp-server.ts`. Task 3 depends on Tasks 1 and 2. Tasks 4 and 5 depend on nothing else in this plan.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/manifest/media-types.ts` (create) | Extension→media type map, `mediaTypeForPath`, `isInlineTextMediaType` (the one inline-text rule) | 1 |
| `src/client/file-publication-client.ts` | Drop the map, import `mediaTypeForPath` | 1 |
| `src/local/create-local-runtime.ts`, `tests/client/file-publication-client.test.ts` | Import `mediaTypeForPath` from its new module | 1 |
| `src/core/publishing-limits.ts` | `maximumEditTextBytes`, `maximumInlineTextFileBytes` (1); `maximumPublicationWarnings`, `maximumWarningScanBytes` (3) | 1, 3 |
| `src/core/errors.ts`, `src/http/artifact-http-failure.ts` | `InvalidEdit` → `INVALID_INPUT` 422 (1); `"listArtifactBlobs"` repository operation (2) | 1, 2 |
| `src/core/ports.ts` | `CommitArtifactVersion.source: PublicationSource` (1); `StagedUploadRepository.listArtifactBlobs` (2) | 1, 2 |
| `src/storage/sqlite-artifact-repository.ts`, `src/storage/postgres-artifact-repository.ts` | Version commit skips staging for `saved_version` (1); `listArtifactBlobs` (2) | 1, 2 |
| `src/application/edit-operations.ts` (create) | Pure-ish application of ordered edit operations to a manifest | 1 |
| `src/application/publish-artifact.ts` | `editArtifact` (1); `publicationWarnings` (3) | 1, 3 |
| `src/local/create-local-application-layer.ts` | Wire `blobs.readBytes` (1), staged `blobs.open` and `listArtifactBlobs` (2) | 1, 2 |
| `src/http/artifact-edit-request.ts` (create) | `editOperationsSchema`, the one zod schema both adapters accept | 1 |
| `src/mcp/artifact-mcp-server.ts` | `artifact_edit` (1), `baseArtifactId`/`alreadyStored` (2), `warnings` (3), `comment_list` `target` and bundle element (5) | 1, 2, 3, 5 |
| `src/http/create-http-app.ts` | `POST …/edits` (1), upload `baseArtifactId` (2), commit `warnings` (3), CSP from the shared module (3) | 1, 2, 3 |
| `src/application/staged-upload.ts` | Base-artifact blob reuse (2); commit returns warnings (3) | 2, 3 |
| `src/core/review-frame-sources.ts` (create) | Review frame CDN allowlist and `reviewFrameAllows` | 3 |
| `src/application/publication-warnings.ts` (create) | Bounded HTML/Markdown reference scanner | 3 |
| `apps/web/src/review-frame/plannotator/components/html-viewer.d.ts` | Declare `HtmlElementContext`, `elementContext`, `buildPersistedHtmlAnchor` | 4 |
| `apps/web/src/review-frame/protocol.ts`, `review-frame.tsx` | Persist `elementContext` through the package helper | 4 |
| `src/mcp/comment-target.ts` (create) | Derive `{quote, element}` from an anchor | 5 |
| `src/mcp/dispatch-bundle-message.ts` | Element lines in bundle items | 5 |
| Specs and docs | `project/spec/{conformance.yml, local-workspace-spec.md, artifact-server-mcp-baseline.md, artifact-comments-spec.md}`, `docs/{mcp.md, agent-bridge-protocol.md}`, `skills/artifact-server/{SKILL.md, references/artifact-operations.md}` | all |

Tests created: `tests/conformance/edt-001-edit-commit.test.ts` (1), `tests/conformance/pub-015-upload-blob-reuse.test.ts` (2), `tests/conformance/pub-016-publication-warnings.test.ts` (3), `tests/browser/cmt-023-element-context.spec.ts` (4), `tests/conformance/mcp-022-agent-feedback.test.ts` (5). Tests modified: `tests/conformance/mcp-modern-http.test.ts` (1), `tests/conformance/cmt-012-comment-surface-parity.test.ts` (5).

---

### Task 1: Edit commit (`artifact_edit` and `POST /api/v1/artifacts/:artifactId/edits`)

Estimated production lines: ~380.

**Files:**
- Create: `src/manifest/media-types.ts`, `src/application/edit-operations.ts`, `src/http/artifact-edit-request.ts`, `tests/conformance/edt-001-edit-commit.test.ts`
- Modify: `src/client/file-publication-client.ts:33-70,399-403`, `src/local/create-local-runtime.ts:44`, `tests/client/file-publication-client.test.ts:24`, `src/core/publishing-limits.ts`, `src/core/errors.ts`, `src/http/artifact-http-failure.ts`, `src/core/ports.ts:104-141`, `src/storage/sqlite-artifact-repository.ts:615-724`, `src/storage/postgres-artifact-repository.ts:545-611`, `src/application/publish-artifact.ts`, `src/local/create-local-application-layer.ts` (publish blobs, `readBlobBytes`), `src/mcp/artifact-mcp-server.ts` (constants, `inlineText`, new tool after `artifact_commit_upload`, `capabilities`, `agentInstructions`), `src/http/create-http-app.ts` (new route after the commit route), `tests/conformance/mcp-modern-http.test.ts:192-223`
- Docs/spec: `project/spec/conformance.yml` (EDT-001..003, MCP-006, PUB-002, `updated`), `project/spec/local-workspace-spec.md` (§2, §6, §11, §12, §13), `project/spec/artifact-server-mcp-baseline.md` (tools table, inline paragraph), `docs/mcp.md`, `skills/artifact-server/references/artifact-operations.md`, `skills/artifact-server/SKILL.md`

**Interfaces:**
- Consumes: `ArtifactManagementService.getVersionDetails`, `AuthorizationService.requireVersionPublication`/`requireArtifactControl`, `PublishArtifactRepository.commitVersion`/`findIdempotentPublication`, `parseManifest`, `compareManifests`.
- Produces (used by Tasks 3 and 5):
  - `src/manifest/media-types.ts`: `mediaTypeForPath(filePath: string): string`, `isInlineTextMediaType(mediaType: string): boolean`
  - `src/core/publishing-limits.ts`: `maximumEditTextBytes`, `maximumInlineTextFileBytes`
  - `src/core/errors.ts`: `class InvalidEdit` (`{message}`) → `INVALID_INPUT` / 422
  - `src/application/edit-operations.ts`: `type EditOperation`, `applyEditOperations(base: CanonicalManifest, operations: readonly EditOperation[], readBytes: (blob: StoredBlob) => Effect<Uint8Array, BlobStorageFailure>): Effect<AppliedEdit, InvalidEdit | BlobStorageFailure>`
  - `src/application/publish-artifact.ts`: `PublishBlobStorage.readBytes(blob: StoredBlob)`, `EditArtifactCommand`, `EditedFileChange {change: "added"|"modified"|"removed"|"renamed"; from: string|null; path: string; size: number}`, `ArtifactEdit {changes; published: PublishedVersion}`, `PublishArtifactService.editArtifact(command): Effect<ArtifactEdit, PublishArtifactFailure | InvalidEdit>`
  - `src/http/artifact-edit-request.ts`: `editOperationsSchema`
  - MCP tool `artifact_edit` output `{artifact, changes, links, replayed, version}`. HTTP 201 (200 on replay) returns the same fields.

- [ ] **Step 1: Write the failing conformance test**

Create `tests/conformance/edt-001-edit-commit.test.ts`:

```ts
import {createHash} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  callMcp,
  mcpFailed,
  mcpToolErrorCode,
  type McpReply,
} from "../support/agent-dispatch.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  readHeaders,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const editResultSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), id: z.string()}).loose(),
  changes: z.array(z.object({
    change: z.enum(["added", "modified", "removed", "renamed"]),
    from: z.string().nullable(),
    path: z.string(),
    size: z.number().int().nonnegative(),
  }).strict()),
  links: z.object({artifact: z.url(), review: z.url(), version: z.url()}).strict(),
  replayed: z.boolean(),
  version: z.object({id: z.string(), number: z.number().int().positive()}).loose(),
}).loose();
const readResultSchema = z.object({mediaType: z.string(), sha256: z.string()}).loose();
const versionListSchema = z.object({
  versions: z.array(z.object({id: z.string()}).loose()),
}).loose();
const actionPageSchema = z.object({
  actions: z.array(z.object({action: z.string(), versionId: z.string()}).loose()),
}).loose();

type ToolArguments = NonNullable<Parameters<typeof callMcp>[4]["arguments"]>;

const encoder = new TextEncoder();
const byteOrderMark = Uint8Array.of(0xef, 0xbb, 0xbf);
const largeText = `${"a".repeat(1_048_570)}\nEND\n`;

function joined(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const siteFiles: readonly TestSiteFile[] = [
  {bytes: encoder.encode("<!doctype html><h1>Title</h1>\n"), mediaType: "text/html; charset=utf-8", path: "index.html"},
  {bytes: joined(byteOrderMark, encoder.encode("# Notes\r\nFirst line\r\nSecond line\r\n")), mediaType: "text/markdown; charset=utf-8", path: "notes.md"},
  {bytes: encoder.encode("one\ntwo\nthree\n"), mediaType: "text/plain; charset=utf-8", path: "plain.txt"},
  {bytes: encoder.encode("{\"title\":\"Old\"}\n"), mediaType: "application/json", path: "data.json"},
  {bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x00, 0xff), mediaType: "image/png", path: "logo.png"},
  {bytes: Uint8Array.of(0xff, 0xfe, 0x41), mediaType: "text/plain", path: "broken.txt"},
  {bytes: encoder.encode("remove me\n"), mediaType: "text/plain", path: "old.txt"},
  {bytes: encoder.encode(largeText), mediaType: "text/plain", path: "large.txt"},
];

function siteBytes(path: string): Uint8Array {
  const file = siteFiles.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`The fixture has no ${path}.`);
  return file.bytes;
}

describe("edit commits", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publishSite(idempotencyKey: string): Promise<PublishResponse> {
    const upload = await createStagedUpload(server, installation, "index.html", siteFiles);
    const uploads = await uploadEveryStagedFile(installation, upload.body, siteFiles);
    expect(uploads.every((response) => response.ok)).toBe(true);
    return (await commitStagedUpload(installation, upload.body, idempotencyKey, {
      accessSetting: "private",
      kind: "new_artifact",
      name: "Edit fixture",
    })).body;
  }

  function callTool(name: string, toolArguments: ToolArguments): Promise<McpReply> {
    return callMcp(server, installation.apiToken, "tools/call", name, {
      arguments: toolArguments,
      name,
    });
  }

  function editResult(reply: McpReply) {
    expect(mcpFailed(reply)).toBe(false);
    return editResultSchema.parse(reply.result?.structuredContent);
  }

  async function fileDigest(artifactId: string, versionId: string, path: string) {
    const reply = await callTool("artifact_read_file", {artifactId, path, versionId});
    expect(mcpFailed(reply)).toBe(false);
    return readResultSchema.parse(reply.result?.structuredContent);
  }

  function editsUrl(published: PublishResponse): string {
    return `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/edits?projectId=${published.artifact.projectId}`;
  }

  test("EDT-001-B EDT-002-B EDT-003-B: an edit commit applies ordered text operations as a new version, keeps every untouched byte, records a publish action, and replays", async () => {
    const published = await publishSite("edt-b-publish-site");
    const artifactId = published.artifact.id;
    const base = published.version.id;
    const editArguments = {
      artifactId,
      expectedCurrentVersionId: base,
      idempotencyKey: "edt-b-first-edit-001",
      operations: [
        {edits: [{newText: "Changed line", oldText: "First line"}], kind: "replace", path: "notes.md"},
        {edits: [{newText: "TWO", oldText: "two"}], kind: "replace", path: "plain.txt"},
        {edits: [{newText: "\"New\"", oldText: "\"Old\""}], kind: "replace", path: "data.json"},
        {kind: "write", path: "docs/guide.md", text: "# Guide\n"},
        {from: "logo.png", kind: "rename", to: "img/logo.png"},
        {kind: "delete", path: "old.txt"},
      ],
    };
    const first = editResult(await callTool("artifact_edit", editArguments));
    const notes = joined(byteOrderMark, encoder.encode("# Notes\r\nChanged line\r\nSecond line\r\n"));
    const plain = encoder.encode("one\nTWO\nthree\n");
    const data = encoder.encode("{\"title\":\"New\"}\n");
    const guide = encoder.encode("# Guide\n");
    expect(first.replayed).toBe(false);
    expect(first.version.number).toBe(2);
    expect(first.artifact.currentVersionId).toBe(first.version.id);
    expect([...first.changes].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      {change: "modified", from: null, path: "data.json", size: data.byteLength},
      {change: "added", from: null, path: "docs/guide.md", size: guide.byteLength},
      {change: "renamed", from: "logo.png", path: "img/logo.png", size: 6},
      {change: "modified", from: null, path: "notes.md", size: notes.byteLength},
      {change: "removed", from: null, path: "old.txt", size: siteBytes("old.txt").byteLength},
      {change: "modified", from: null, path: "plain.txt", size: plain.byteLength},
    ]);

    const edited = first.version.id;
    expect((await fileDigest(artifactId, edited, "notes.md")).sha256).toBe(sha256(notes));
    expect((await fileDigest(artifactId, edited, "plain.txt")).sha256).toBe(sha256(plain));
    expect((await fileDigest(artifactId, edited, "data.json")).sha256).toBe(sha256(data));
    expect(await fileDigest(artifactId, edited, "docs/guide.md"))
      .toMatchObject({mediaType: "text/markdown; charset=utf-8", sha256: sha256(guide)});
    expect((await fileDigest(artifactId, edited, "img/logo.png")).sha256)
      .toBe(sha256(siteBytes("logo.png")));
    expect((await fileDigest(artifactId, edited, "index.html")).sha256)
      .toBe(sha256(siteBytes("index.html")));
    expect((await fileDigest(artifactId, base, "notes.md")).sha256)
      .toBe(sha256(siteBytes("notes.md")));
    expect(mcpToolErrorCode(await callTool("artifact_read_file", {
      artifactId,
      path: "old.txt",
      versionId: edited,
    }))).toBe("VERSION_NOT_FOUND");

    const replay = editResult(await callTool("artifact_edit", editArguments));
    expect(replay.replayed).toBe(true);
    expect(replay.version.id).toBe(edited);
    expect(replay.changes).toEqual(first.changes);

    const overHttp = await fetch(editsUrl(published), {
      body: JSON.stringify({
        expectedCurrentVersionId: edited,
        operations: [{
          edits: [{newText: "<h1>New title</h1>", oldText: "<h1>Title</h1>"}],
          kind: "replace",
          path: "index.html",
        }],
      }),
      headers: apiHeaders(installation, "edt-b-http-edit-0001"),
      method: "POST",
    });
    expect(overHttp.status).toBe(201);
    const third = editResultSchema.parse(await overHttp.json());
    const page = encoder.encode("<!doctype html><h1>New title</h1>\n");
    expect(third.version.number).toBe(3);
    expect(third.changes).toEqual([
      {change: "modified", from: null, path: "index.html", size: page.byteLength},
    ]);
    expect((await fileDigest(artifactId, third.version.id, "index.html")).sha256)
      .toBe(sha256(page));

    const actions = actionPageSchema.parse(await (await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/actions?projectId=${published.artifact.projectId}`,
      {headers: readHeaders(installation)},
    )).json());
    expect(actions.actions
      .filter((action) => action.action === "publish")
      .map((action) => action.versionId))
      .toEqual(expect.arrayContaining([base, edited, third.version.id]));
  });

  test("EDT-001-F EDT-002-F EDT-003-F: refused edits create no version and leave every stored byte unchanged", async () => {
    const published = await publishSite("edt-f-publish-site");
    const artifactId = published.artifact.id;
    const base = published.version.id;
    const refusals = [
      {code: "INVALID_INPUT", message: /occurs 0 times in notes\.md/u, operations: [{edits: [{newText: "x", oldText: "absent text"}], kind: "replace", path: "notes.md"}]},
      {code: "INVALID_INPUT", message: /occurs 2 times in notes\.md/u, operations: [{edits: [{newText: "x", oldText: "line"}], kind: "replace", path: "notes.md"}]},
      {code: "INVALID_INPUT", message: /missing\.txt is not a file of this version/u, operations: [{kind: "delete", path: "missing.txt"}]},
      {code: "INVALID_INPUT", message: /data\.json already exists/u, operations: [{from: "plain.txt", kind: "rename", to: "data.json"}]},
      {code: "INVALID_MANIFEST_PATH", message: /escape\.html/u, operations: [{kind: "write", path: "../escape.html", text: "x"}]},
      {code: "INVALID_INPUT", message: /entry file/u, operations: [{kind: "delete", path: "index.html"}]},
      {code: "INVALID_INPUT", message: /image\/png/u, operations: [{edits: [{newText: "x", oldText: "PNG"}], kind: "replace", path: "logo.png"}]},
      {code: "INVALID_INPUT", message: /broken\.txt is not valid UTF-8/u, operations: [{edits: [{newText: "B", oldText: "A"}], kind: "replace", path: "broken.txt"}]},
      {code: "INVALID_INPUT", message: /large\.txt would be 1048584 bytes/u, operations: [{edits: [{newText: "END-EXTENDED", oldText: "END"}], kind: "replace", path: "large.txt"}]},
      {code: "INVALID_INPUT", message: /at most 262144/u, operations: [{kind: "write", path: "a.txt", text: "x".repeat(150_000)}, {kind: "write", path: "b.txt", text: "y".repeat(150_000)}]},
      {code: "INVALID_INPUT", message: /absent\.txt/u, operations: [{kind: "write", path: "kept.txt", text: "kept\n"}, {kind: "delete", path: "absent.txt"}]},
    ];
    await Promise.all(refusals.map(async (refusal, index) => {
      const reply = await callTool("artifact_edit", {
        artifactId,
        expectedCurrentVersionId: base,
        idempotencyKey: `edt-f-refusal-${String(index).padStart(4, "0")}`,
        operations: refusal.operations,
      });
      expect(mcpToolErrorCode(reply)).toBe(refusal.code);
      expect(JSON.stringify(reply.result?.structuredContent)).toMatch(refusal.message);
    }));
    expect(mcpFailed(await callTool("artifact_edit", {
      artifactId,
      expectedCurrentVersionId: base,
      idempotencyKey: "edt-f-base64-field01",
      operations: [{contentBase64: "AAAA", kind: "write", path: "blob.bin", text: ""}],
    }))).toBe(true);

    const moved = editResult(await callTool("artifact_edit", {
      artifactId,
      expectedCurrentVersionId: base,
      idempotencyKey: "edt-f-move-current01",
      operations: [{kind: "write", path: "moved.txt", text: "moved\n"}],
    }));
    const stale = await callTool("artifact_edit", {
      artifactId,
      expectedCurrentVersionId: base,
      idempotencyKey: "edt-f-stale-mcp-0001",
      operations: [{kind: "write", path: "late.txt", text: "late\n"}],
    });
    expect(mcpToolErrorCode(stale)).toBe("PUBLISH_CONFLICT");
    expect(JSON.stringify(stale.result?.structuredContent)).toContain(moved.version.id);
    const staleOverHttp = await fetch(editsUrl(published), {
      body: JSON.stringify({
        expectedCurrentVersionId: base,
        operations: [{kind: "write", path: "late.txt", text: "late\n"}],
      }),
      headers: apiHeaders(installation, "edt-f-stale-http-001"),
      method: "POST",
    });
    expect(staleOverHttp.status).toBe(409);
    expect(await staleOverHttp.json()).toMatchObject({
      error: {code: "PUBLISH_CONFLICT", message: expect.stringContaining(moved.version.id)},
    });
    expect(mcpToolErrorCode(await callTool("artifact_edit", {
      artifactId,
      expectedCurrentVersionId: base,
      idempotencyKey: "edt-f-move-current01",
      operations: [{kind: "write", path: "other.txt", text: "other\n"}],
    }))).toBe("IDEMPOTENCY_CONFLICT");

    const versions = versionListSchema.parse(
      (await callTool("artifact_version_list", {artifactId})).result?.structuredContent,
    );
    expect(versions.versions.map((version) => version.id)).toEqual([moved.version.id, base]);
    await Promise.all(siteFiles.map(async (file) => {
      expect((await fileDigest(artifactId, base, file.path)).sha256).toBe(sha256(file.bytes));
    }));
  });
});
```

Also update the exact tool list in `tests/conformance/mcp-modern-http.test.ts`: insert `"artifact_edit",` directly after `"artifact_commit_upload",` in the `expect(tools.map(...)).toEqual([...])` array.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 900 "${DK}" "pnpm exec vitest run tests/conformance/edt-001-edit-commit.test.ts tests/conformance/mcp-modern-http.test.ts" > "${LOG}" 2>&1; echo "EXIT=$?"`
Expected: EXIT≠0. `artifact_edit` is an unknown tool, so the EDT tests fail, and the tool list no longer matches.

- [ ] **Step 3: Move the media-type map and share the inline-text rule**

Create `src/manifest/media-types.ts`, moving the `mediaTypesByExtension` map verbatim from `src/client/file-publication-client.ts:33-70` and `mediaTypeForPath` from lines 399-403:

```ts
import path from "node:path";

const mediaTypesByExtension = new Map<string, string>([
  [".aac", "audio/aac"],
  [".avif", "image/avif"],
  [".avi", "video/x-msvideo"],
  [".bin", "application/octet-stream"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".gif", "image/gif"],
  [".gz", "application/gzip"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".ogv", "video/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tar", "application/x-tar"],
  [".text", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
  [".zip", "application/zip"],
]);

/** Media type essences whose UTF-8 bytes are read and edited inline as text. */
const inlineTextMediaType =
  /^(text\/|application\/(json|xml|javascript|ecmascript)$|image\/svg\+xml$)|\+(json|xml)$/u;

/** Infer a deterministic browser media type from one file name. */
export function mediaTypeForPath(filePath: string): string {
  return mediaTypesByExtension.get(path.extname(filePath).toLowerCase())
    ?? "application/octet-stream";
}

/** Whether a declared media type is one whose bytes are handled inline as text. */
export function isInlineTextMediaType(mediaType: string): boolean {
  return inlineTextMediaType.test(
    mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "",
  );
}
```

In `src/client/file-publication-client.ts`, delete the map and the `mediaTypeForPath` function, and add `import {mediaTypeForPath} from "../manifest/media-types.js";`. Its line-571 call is unchanged. In `src/local/create-local-runtime.ts:44` and `tests/client/file-publication-client.test.ts`, import `mediaTypeForPath` from `../manifest/media-types.js` / `../../src/manifest/media-types.js` instead of the client module. In the test, remove it from the client import list.

Append to `src/core/publishing-limits.ts`:

```ts
/** Largest text file artifact_read_file returns inline and an edit commit writes. */
export const maximumInlineTextFileBytes = 1_024 * 1_024;

/** Most UTF-8 bytes of oldText, newText, and text one edit commit carries. */
export const maximumEditTextBytes = 256 * 1_024;
```

In `src/mcp/artifact-mcp-server.ts`, delete `const maximumInlineFileBytes` (line 102) and `inlineTextMediaType` (lines 103-105). Import `maximumEditTextBytes` and `maximumInlineTextFileBytes` from `../core/publishing-limits.js` and `isInlineTextMediaType` from `../manifest/media-types.js`. Change the guard in `inlineText` to:

```ts
  if (entry.size > maximumInlineTextFileBytes || !isInlineTextMediaType(entry.mediaType)) {
    return null;
  }
```

and delete the now-unused `essence` line above it.

- [ ] **Step 4: Add the `InvalidEdit` error**

In `src/core/errors.ts`, after `InvalidManifestPath`:

```ts
/** An edit commit's operations cannot apply to its base version. */
export class InvalidEdit extends Schema.TaggedError<InvalidEdit>()(
  "InvalidEdit",
  messageField,
) {}
```

Add `InvalidEdit,` to `artifactServerFailureSchema` after `InvalidManifestPath,`. In `src/http/artifact-http-failure.ts`, add `case "InvalidEdit":` to the case group that returns `errorCodes.invalidInput` with status 422 (beside `case "UploadedFileMismatch":`).

- [ ] **Step 5: Let a version commit take an already-stored source**

In `src/core/ports.ts`:

```ts
/** A publication whose every blob is already stored: a duplicated version or an edit commit. */
export interface SavedVersionSource {
  readonly kind: "saved_version";
}
```

and in `CommitArtifactVersion` change `readonly source: StagedUploadSource;` to `readonly source: PublicationSource;`.

In `src/storage/sqlite-artifact-repository.ts` `#applyVersionCommit`, guard both staging calls:

```ts
    if (command.source.kind === "staged_upload") {
      this.#assertStagedUploadReady(
        command.source,
        command.manifest.digest,
        command.createdAt,
      );
    }
```

```ts
    if (command.source.kind === "staged_upload") {
      this.#sealStagedUpload(command.source, command.versionId);
    }
```

In `src/storage/postgres-artifact-repository.ts` `commitVersion`, apply the same guards:

```ts
        if (command.source.kind === "staged_upload") {
          yield* this.#assertStagedUploadReady(
            command.source,
            command.manifest.digest,
            command.createdAt,
          );
        }
```

```ts
        if (command.source.kind === "staged_upload") {
          yield* this.#sealStagedUpload(command.source, command.versionId);
        }
```

- [ ] **Step 6: Write the edit operations module**

Create `src/application/edit-operations.ts`:

```ts
import {createHash} from "node:crypto";

import {Effect} from "effect";

import {type BlobStorageFailure, InvalidEdit} from "../core/errors.js";
import type {CanonicalManifest, ManifestEntry} from "../core/model.js";
import type {StoredBlob} from "../core/ports.js";
import {
  maximumEditTextBytes,
  maximumInlineTextFileBytes,
} from "../core/publishing-limits.js";
import type {
  DeclaredManifestFile,
  ManifestInput,
} from "../manifest/create-manifest.js";
import {
  isInlineTextMediaType,
  mediaTypeForPath,
} from "../manifest/media-types.js";

/** One text replacement; `oldText` must occur exactly once at that point. */
export interface TextReplacement {
  readonly newText: string;
  readonly oldText: string;
}

/** One step of an edit commit, applied in order to the base version's files. */
export type EditOperation =
  | {
    readonly edits: readonly TextReplacement[];
    readonly kind: "replace";
    readonly path: string;
  }
  | {
    readonly kind: "write";
    readonly mediaType?: string | undefined;
    readonly path: string;
    readonly text: string;
  }
  | {readonly kind: "delete"; readonly path: string}
  | {readonly from: string; readonly kind: "rename"; readonly to: string};

/** Bytes an edit produced; they are stored before the version commits. */
export interface EditedBlob extends StoredBlob {
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** The manifest input and the new bytes one edit derives from its base. */
export interface AppliedEdit {
  readonly blobs: readonly EditedBlob[];
  readonly manifest: ManifestInput;
}

interface WorkingFile {
  /** Bytes written by this edit; null while the file keeps its stored blob. */
  readonly bytes: Uint8Array<ArrayBuffer> | null;
  readonly file: DeclaredManifestFile;
}

type BlobReader = (
  blob: StoredBlob,
) => Effect.Effect<Uint8Array, BlobStorageFailure>;

/** Apply edit operations in order to a base manifest, all or nothing. */
export const applyEditOperations = Effect.fnUntraced(function*(
  base: CanonicalManifest,
  operations: readonly EditOperation[],
  readBytes: BlobReader,
): Effect.fn.Return<AppliedEdit, InvalidEdit | BlobStorageFailure> {
  const textBytes = operations.reduce(
    (total, operation) => total + inlineTextBytes(operation),
    0,
  );
  if (textBytes > maximumEditTextBytes) {
    return yield* new InvalidEdit({
      message:
        `The edit carries ${textBytes} bytes of text; one edit carries at most ${maximumEditTextBytes}. Publish whole files through artifact_create_upload.`,
    });
  }
  const files = new Map<string, WorkingFile>(
    base.entries.map((entry) => [entry.path, {bytes: null, file: declared(entry)}]),
  );
  let entryPath = base.entryPath;
  for (const operation of operations) {
    switch (operation.kind) {
      case "replace": {
        const current = yield* existing(files, operation.path);
        let text = yield* decodedText(current, readBytes);
        for (const edit of operation.edits) {
          const count = occurrences(text, edit.oldText);
          if (count !== 1) {
            return yield* new InvalidEdit({
              message:
                `oldText occurs ${count} times in ${operation.path}; it must occur exactly once. Include more surrounding text.`,
            });
          }
          const at = text.indexOf(edit.oldText);
          text = `${text.slice(0, at)}${edit.newText}${text.slice(at + edit.oldText.length)}`;
        }
        files.set(
          operation.path,
          yield* textFile(operation.path, current.file.mediaType, text),
        );
        break;
      }
      case "write":
        files.set(
          operation.path,
          yield* textFile(
            operation.path,
            operation.mediaType ?? mediaTypeForPath(operation.path),
            operation.text,
          ),
        );
        break;
      case "delete":
        yield* existing(files, operation.path);
        files.delete(operation.path);
        break;
      case "rename": {
        const moved = yield* existing(files, operation.from);
        if (files.has(operation.to)) {
          return yield* new InvalidEdit({
            message: `${operation.to} already exists; delete it first or choose another path.`,
          });
        }
        files.delete(operation.from);
        files.set(operation.to, {...moved, file: {...moved.file, path: operation.to}});
        if (entryPath === operation.from) entryPath = operation.to;
        break;
      }
    }
  }
  const working = [...files.values()];
  return {
    blobs: working.flatMap(({bytes, file}) =>
      bytes === null ? [] : [{bytes, sha256: file.sha256, size: file.size}]
    ),
    manifest: {
      entryPath,
      files: working.map(({file}) => file),
      routingMode: base.routingMode,
    },
  };
});

function declared(entry: ManifestEntry): DeclaredManifestFile {
  return {
    mediaType: entry.mediaType,
    path: entry.path,
    sha256: entry.sha256,
    size: entry.size,
  };
}

function existing(
  files: ReadonlyMap<string, WorkingFile>,
  path: string,
): Effect.Effect<WorkingFile, InvalidEdit> {
  const found = files.get(path);
  return found === undefined
    ? new InvalidEdit({message: `${path} is not a file of this version.`})
    : Effect.succeed(found);
}

const decodedText = Effect.fnUntraced(function*(
  current: WorkingFile,
  readBytes: BlobReader,
): Effect.fn.Return<string, InvalidEdit | BlobStorageFailure> {
  const {file} = current;
  if (
    !isInlineTextMediaType(file.mediaType) ||
    file.size > maximumInlineTextFileBytes
  ) {
    return yield* new InvalidEdit({
      message:
        `${file.path} is ${file.mediaType} of ${file.size} bytes; replace edits only UTF-8 text files up to ${maximumInlineTextFileBytes} bytes.`,
    });
  }
  const bytes = current.bytes ?? (yield* readBytes(file));
  // ignoreBOM keeps a leading byte order mark in the text, so it re-encodes unchanged.
  return yield* Effect.try({
    try: () => new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes),
    catch: () => new InvalidEdit({message: `${file.path} is not valid UTF-8 text.`}),
  });
});

const textFile = Effect.fnUntraced(function*(
  path: string,
  mediaType: string,
  text: string,
): Effect.fn.Return<WorkingFile, InvalidEdit> {
  if (!isInlineTextMediaType(mediaType)) {
    return yield* new InvalidEdit({
      message:
        `${path} would be ${mediaType}; edits write only text media types. Pass a text mediaType.`,
    });
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maximumInlineTextFileBytes) {
    return yield* new InvalidEdit({
      message:
        `${path} would be ${bytes.byteLength} bytes; an edited file holds at most ${maximumInlineTextFileBytes}.`,
    });
  }
  return {
    bytes,
    file: {
      mediaType,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    },
  };
});

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}

function inlineTextBytes(operation: EditOperation): number {
  switch (operation.kind) {
    case "replace":
      return operation.edits.reduce(
        (total, edit) =>
          total + Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText),
        0,
      );
    case "write":
      return Buffer.byteLength(operation.text);
    default:
      return 0;
  }
}
```

- [ ] **Step 7: Add `editArtifact` to `PublishArtifactService`**

In `src/application/publish-artifact.ts`:

1. Imports: change `type PublishConflict` to the value import `PublishConflict`, and add `type InvalidEdit` to the `../core/errors.js` import. Change `import type {ManifestFailure} from "./parse-manifest.js";` to `import {type ManifestFailure, parseManifest} from "./parse-manifest.js";`. Add:

```ts
import {compareManifests} from "../comparison/compare-manifests.js";
import {applyEditOperations, type EditOperation} from "./edit-operations.js";
```

2. Extend the blob port:

```ts
/** Immutable blob capabilities required by publication. */
export interface PublishBlobStorage {
  put(write: BlobWrite): Effect.Effect<StoredBlob, BlobStorageFailure>;
  readBytes(blob: StoredBlob): Effect.Effect<Uint8Array, BlobStorageFailure>;
}
```

3. Add the command and result types after `DuplicateArtifactCommand`:

```ts
/** Input for an edit commit: ordered operations over the artifact's current version. */
export interface EditArtifactCommand {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly operations: readonly EditOperation[];
  readonly principal: Principal;
  readonly projectId: string | null;
}

/** One file an edit commit changed, from the base and new manifests. */
export interface EditedFileChange {
  readonly change: "added" | "modified" | "removed" | "renamed";
  readonly from: string | null;
  readonly path: string;
  readonly size: number;
}

/** A committed edit: the new version and how its files differ from the base. */
export interface ArtifactEdit {
  readonly changes: readonly EditedFileChange[];
  readonly published: PublishedVersion;
}
```

4. Add `readonly editArtifact: (command: EditArtifactCommand) => Effect.Effect<ArtifactEdit, PublishArtifactFailure | InvalidEdit>;` to `PublishArtifactOperations`.

5. Inside `makePublishArtifactService`, before `return PublishArtifactService.of(...)`:

```ts
  const editArtifact = Effect.fn("PublishArtifactService.editArtifact")(
    function*(
      command: EditArtifactCommand,
    ): Effect.fn.Return<ArtifactEdit, PublishArtifactFailure | InvalidEdit> {
      const base = yield* management.getVersionDetails({
        artifactId: command.artifactId,
        principal: command.principal,
        projectId: command.projectId,
        versionId: command.expectedCurrentVersionId,
      });
      yield* authorization.requireVersionPublication(command.principal);
      yield* authorization.requireArtifactControl(command.principal, base.artifact);
      const projectId = base.artifact.projectId;
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const inputDigest = createHash("sha256").update(JSON.stringify({
        artifactId: command.artifactId,
        edit: command.operations,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        principalId: command.principal.id,
        projectId,
      })).digest("hex");
      const replayed = yield* dependencies.repository.findIdempotentPublication(
        projectId,
        idempotencyKey,
        inputDigest,
      );
      if (
        replayed === null &&
        base.artifact.currentVersionId !== command.expectedCurrentVersionId
      ) {
        return yield* new PublishConflict({
          message: `The artifact moved to version ${base.artifact.currentVersionId}.`,
        });
      }
      const applied = yield* applyEditOperations(
        base.saved.manifest,
        command.operations,
        dependencies.blobs.readBytes,
      );
      const manifest = yield* parseManifest(applied.manifest);
      const changes = editedFileChanges(base.saved.manifest, manifest);
      if (replayed !== null) return {changes, published: replayed};
      yield* Effect.forEach(
        applied.blobs,
        (blob) => dependencies.blobs.put({
          body: new Blob([blob.bytes]).stream(),
          sha256: blob.sha256,
          size: blob.size,
        }),
        {discard: true},
      );
      const published = yield* dependencies.repository.commitVersion({
        artifactId: command.artifactId,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        contentToken: dependencies.ids.contentToken(),
        createdAt: DateTime.formatIso(yield* dependencies.clock.now),
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest,
        manifest,
        principalId: command.principal.id,
        projectId,
        source: {kind: "saved_version"},
        versionId: dependencies.ids.versionId(),
      });
      return {changes, published};
    },
  );
```

and add `editArtifact,` to the `PublishArtifactService.of({...})` object.

6. At module level, after `publicationSourcesByPath`:

```ts
function editedFileChanges(
  before: CanonicalManifest,
  after: CanonicalManifest,
): readonly EditedFileChange[] {
  const comparison = compareManifests(before, after);
  return [
    ...comparison.added.map((entry) => ({
      change: "added" as const, from: null, path: entry.path, size: entry.size,
    })),
    ...comparison.changed.map(({after: entry}) => ({
      change: "modified" as const, from: null, path: entry.path, size: entry.size,
    })),
    ...comparison.removed.map((entry) => ({
      change: "removed" as const, from: null, path: entry.path, size: entry.size,
    })),
    ...comparison.renamed.map(({from, to}) => ({
      change: "renamed" as const, from: from.path, path: to.path, size: to.size,
    })),
  ];
}
```

- [ ] **Step 8: Wire `readBytes`**

In `src/local/create-local-application-layer.ts`, change `readBlobBytes` to take a `StoredBlob` (add `type StoredBlob` to the `../core/ports.js` import; `ManifestEntry` callers stay valid):

```ts
async function readBlobBytes(
  blobs: BlobStore,
  blob: StoredBlob,
): Promise<Uint8Array> {
  const opened = await blobs.open(blob.sha256);
  if (opened.size !== blob.size) {
    await opened.body.cancel();
    throw new Error(
      `Stored blob ${blob.sha256} is ${opened.size} bytes but its manifest records ${blob.size}.`,
    );
  }
  const bytes = new Uint8Array(await new Response(opened.body).arrayBuffer());
  if (bytes.byteLength !== blob.size) {
    throw new Error(
      `Stored blob ${blob.sha256} yielded ${bytes.byteLength} bytes but its manifest records ${blob.size}.`,
    );
  }
  return bytes;
}
```

and add to `publishDependencies.blobs`, beside `put`:

```ts
      readBytes: (blob) =>
        Effect.tryPromise({
          try: () => readBlobBytes(adapters.blobs, blob),
          catch: (cause) => new BlobStorageFailure({cause, operation: "open"}),
        }),
```

If the linked-artifact layer's `blobs` type (`blobs: publishDependencies.blobs`) is a narrower interface, it accepts the extra member unchanged.

- [ ] **Step 9: One request schema, the MCP tool, and the HTTP route**

Create `src/http/artifact-edit-request.ts`:

```ts
import {z} from "zod";

const editPathSchema = z.string().min(1).max(1_024);

/** The ordered operations of one edit commit, as HTTP and MCP accept them. */
export const editOperationsSchema = z.array(z.discriminatedUnion("kind", [
  z.object({
    edits: z.array(z.object({
      newText: z.string(),
      oldText: z.string().min(1),
    }).strict()).min(1),
    kind: z.literal("replace"),
    path: editPathSchema,
  }).strict(),
  z.object({
    kind: z.literal("write"),
    mediaType: z.string().trim().min(1).max(200).optional(),
    path: editPathSchema,
    text: z.string(),
  }).strict(),
  z.object({kind: z.literal("delete"), path: editPathSchema}).strict(),
  z.object({
    from: editPathSchema,
    kind: z.literal("rename"),
    to: editPathSchema,
  }).strict(),
])).min(1);
```

In `src/mcp/artifact-mcp-server.ts`:
- import `PublishArtifactService` from `../application/publish-artifact.js` and `editOperationsSchema` from `../http/artifact-edit-request.js`;
- add, beside `publishedVersionSchema`:

```ts
const editedFileChangeSchema = z.object({
  change: z.enum(["added", "modified", "removed", "renamed"]),
  from: z.string().nullable(),
  path: z.string(),
  size: z.number().int().nonnegative(),
}).strict();
```

- register the tool **directly after** `artifact_commit_upload`:

```ts
  registerNudgedTool(
    "artifact_edit",
    {
      title: "Edit artifact text files",
      description:
        "Create a new immutable version from the artifact's current version by applying operations in order, all or nothing: replace (each oldText must occur exactly once in the file at that point), write (create or overwrite a text file; mediaType defaults from the extension), delete, and rename. Only UTF-8 files with text media types are edited, each at most 1 MiB, with at most 256 KiB of text per call; untouched files keep their stored bytes. Read files first with artifact_read_file and pass artifact_get's current version ID as expectedCurrentVersionId; a stale ID fails with PUBLISH_CONFLICT naming the current version. Publish new sites and binary files through artifact_create_upload. Returns links.review for the new version; give that URL to the user first.",
      inputSchema: z.object({
        artifactId: artifactIdSchema,
        expectedCurrentVersionId: expectedVersionSchema,
        idempotencyKey: idempotencyKeySchema,
        operations: editOperationsSchema,
        projectId: optionalProjectIdSchema,
      }).strict(),
      outputSchema: publishedVersionSchema.extend({
        changes: z.array(editedFileChangeSchema),
      }).strict(),
      annotations: idempotentWriteAnnotations,
    },
    async ({artifactId, expectedCurrentVersionId, idempotencyKey, operations, projectId}) =>
      toolResult(async () => {
        const edit = await runMcpApplicationEffect(
          dependencies,
          PublishArtifactService.use((publication) =>
            publication.editArtifact({
              artifactId,
              expectedCurrentVersionId,
              idempotencyKey,
              operations,
              principal: identity.principal,
              projectId,
            })
          ),
        );
        return {
          ...publishedVersionProjection(
            applicationUrl,
            dependencies.contentDomain,
            edit.published,
          ),
          changes: edit.changes,
        };
      }, editSummary),
  );
```

- add near `publicationSummary`:

```ts
function editSummary(edit: {
  readonly artifact: {readonly name: string};
  readonly changes: readonly {readonly change: string; readonly path: string}[];
  readonly links: {readonly review: string};
}): string {
  return [
    `Edited ${JSON.stringify(edit.artifact.name)}: ${edit.changes.map((change) => `${change.change} ${change.path}`).join(", ")}.`,
    `Review and comment: ${edit.links.review}`,
  ].join("\n");
}
```

- capabilities: add `edit: z.object({maximumFileBytes: z.number(), maximumTextBytes: z.number()}),` to the `artifact_capabilities` output schema (beside `comparison`), and `edit: {maximumFileBytes: maximumInlineTextFileBytes, maximumTextBytes: maximumEditTextBytes},` to `capabilities()` beside `comparison`. Change that tool's summary text to `"Artifact Server publishes actual files through an upload plan and edits existing text files with bounded text. It does not accept whole files or base64 content inline."`
- `agentInstructions`: replace the first line with `"Artifact Server stores actual files as immutable versions. MCP never carries whole files or base64; artifact_edit changes text files of a version already on the server with bounded text edits."`, and insert after the publishing line:

```ts
    "To change text files of an artifact already on the server, read them with artifact_read_file, then call artifact_edit with artifact_get's current version ID: replace needs each oldText to occur exactly once; write, delete, and rename cover the rest. Publish binaries and new sites through artifact_create_upload.",
```

In `src/http/create-http-app.ts`, import `editOperationsSchema` from `./artifact-edit-request.js`, add next to `commitUploadSchema`:

```ts
const editArtifactSchema = z.object({
  expectedCurrentVersionId: z.string().min(1).max(200),
  operations: editOperationsSchema,
}).strict();
```

and register directly after the `/api/v1/uploads/:uploadId/commit` route (`PublishArtifactService` is already imported for the duplicate route; add it if not):

```ts
  app.post(
    "/api/v1/artifacts/:artifactId/edits",
    boundedJsonBody,
    async (context) => {
      const body = editArtifactSchema.parse(await context.req.json());
      const edit = await runHttpApplicationEffect(
        context,
        dependencies,
        PublishArtifactService.use((publication) =>
          publication.editArtifact({
            artifactId: context.req.param("artifactId"),
            expectedCurrentVersionId: body.expectedCurrentVersionId,
            idempotencyKey: requiredIdempotencyKey(
              context.req.header("idempotency-key"),
            ),
            operations: body.operations,
            principal: context.get("principal"),
            projectId: requestedProjectId(context),
          })
        ),
      );
      return context.json(
        {
          ...publishResponse(
            responseApplicationUrl(context, dependencies),
            dependencies.contentDomain,
            edit.published,
          ),
          changes: edit.changes,
        },
        edit.published.replayed ? 200 : 201,
      );
    },
  );
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `timeout 900 "${DK}" "pnpm exec vitest run tests/conformance/edt-001-edit-commit.test.ts tests/conformance/mcp-modern-http.test.ts tests/conformance/mcp-021-read-file.test.ts tests/conformance/staged-upload-lifecycle.test.ts tests/conformance/art-015-duplicate.test.ts tests/client/file-publication-client.test.ts tests/conformance/lnk-004-source-capture.test.ts" > "${LOG}" 2>&1; echo "EXIT=$?"`
Expected: EXIT=0.

- [ ] **Step 11: Ledger and spec**

In `project/spec/conformance.yml`, set `updated: "2026-11-27"`. Replace the EDT-001..003 blocks with:

```yaml
  - id: EDT-001
    kind: behavior
    behavior: An edit commit creates a new immutable version from the artifact's current version by applying ordered replace, write, delete, and rename operations all or nothing; untouched entries keep their stored blobs, and the commit carries an idempotency key, a current-version compare-and-swap, and a publish action record.
    owner: publishing
    source: {file: local-workspace-spec.md, anchor: conformance-requirements-to-add}
    acceptance:
      behavior: {id: EDT-001-B, description: "Apply replace, write, rename, and delete operations to a multi-file version through MCP and HTTP and receive a new version whose untouched entries keep their digests, a per-file change list, a publish action record, and the original result on an exact retry."}
      failure: {id: EDT-001-F, description: "An operation naming an absent path, an oldText occurring zero or several times, a rename onto an existing path, an unsafe path, a deleted entry file, a reused idempotency key with different operations, or a failing later operation creates no version, and no stored version's bytes change."}
    deployments: *all
    status: implementing
    proof_gap: EDT-001-B and EDT-001-F run against the local SQLite server. The Postgres commit of an already-stored source is covered only by typecheck until the external-storage runtime suite exercises an edit.
    depends_on: [PUB-005, PUB-006, PUB-008, VER-001]

  - id: EDT-002
    kind: behavior
    behavior: An edit commit preserves the byte order mark and line endings of every byte it does not replace and resolves a stale expected current version as an explicit conflict that returns the actual current version.
    owner: publishing
    source: {file: local-workspace-spec.md, anchor: conformance-requirements-to-add}
    acceptance:
      behavior: {id: EDT-002-B, description: "Replace one line in files with and without a byte order mark and with CRLF and LF endings and verify every untouched byte is identical."}
      failure: {id: EDT-002-F, description: "An edit whose expected current version is stale returns the publish conflict shape naming the actual current version over MCP and HTTP and writes nothing; it never silently overwrites newer work."}
    deployments: *all
    status: verified
    depends_on: [EDT-001]

  - id: EDT-003
    kind: constraint
    behavior: Editing changes only UTF-8 entries with inline text media types, each at most 1 MiB, carries at most 256 KiB of inline text per call through the artifact_edit MCP tool or its HTTP route, and validates paths with the manifest path rules; whole-file and base64 publication stay on the upload plan.
    owner: publishing
    source: {file: local-workspace-spec.md, anchor: conformance-requirements-to-add}
    acceptance:
      behavior: {id: EDT-003-B, description: "Edit markdown, plain-text, and JSON entries and write a new markdown file through artifact_edit within the bounds and verify each committed entry's digest and inferred media type."}
      failure: {id: EDT-003-F, description: "A replace on a binary or invalid UTF-8 entry, an edited file over 1 MiB, more than 256 KiB of text in one call, and a write carrying an extra base64 field are rejected without creating a version."}
    deployments: *all
    status: verified
    depends_on: [EDT-001, MAN-002]
```

In MCP-006, set `behavior:` to `The initial MCP surface supports capabilities, list, get, open, upload creation, upload commit, edit, visibility, tags, version list, diff, restore, and delete. No tool accepts a local path, base64, or whole-file inline publication; artifact_edit carries only bounded text edits of existing text entries (EDT-003).` In PUB-002, set `behavior:` to `Public clients publish one actual file or finished directory through a file-upload transport. JSON and MCP schemas do not accept raw source strings or base64-wrapped file contents for publication; the one inline content accepted is an edit commit's bounded text (EDT-003).` Leave both acceptances and statuses unchanged.

In `project/spec/local-workspace-spec.md`:
- §2, change the `Edit commit` row's meaning to `A publish that creates a new version from the artifact's current version by applying ordered text operations (replace, write, delete, rename) to its manifest.`
- Replace the §6 bullets (keep the heading and the first paragraph's first sentence) with:

```markdown
An edit **is** a publish. There is no mutable write path; an edit commit produces a new immutable version from the artifact's current version.

- **Operations:** `replace` `{path, edits: [{oldText, newText}]}` (each `oldText` must occur exactly once in the file at that point; zero or several occurrences are refused with the count), `write` `{path, text, mediaType?}` (create or overwrite a text file; the media type defaults from the extension), `delete` `{path}`, and `rename` `{from, to}` (bytes and media type kept; the entry file follows a rename). They apply in order, all or nothing.
- **Scope and bounds:** only UTF-8 entries with inline text media types (the `artifact_read_file` rule) are replaced or written; an edited file holds at most 1 MiB; one call carries at most 256 KiB of text. Paths follow the manifest path rules.
- **Surfaces:** the MCP tool `artifact_edit`, and `POST /api/v1/artifacts/:artifactId/edits?projectId=…` with an `Idempotency-Key` header and `{expectedCurrentVersionId, operations}`. Bounded edit text is the one inline content MCP and HTTP accept; whole files and base64 stay on the upload plan.
- **Commit:** untouched entries keep their stored blobs; new bytes are stored as content-addressed blobs; the version, manifest, idempotency result, `publish` action record, and conditional current-version update commit in one transaction. An exact retry replays; the same key with different operations conflicts.
- **Conflict:** if the current version moved, the commit conflicts and returns the actual current version. It never silently overwrites.
- **Byte fidelity:** every byte outside the replaced text, including a UTF-8 byte order mark and CRLF or LF line endings, is preserved.
- **Result:** the new version, its review links, and the changed files (path, change, size).
```

- §11: change `**A WYSIWYG or multi-file editor.** One text entry per edit commit.` to `**A WYSIWYG editor.**` and delete the `**An MCP editing tool**` bullet.
- §12: replace the three EDT rows with `| EDT-001 | An edit commit applies ordered text operations to the current version as a new immutable version, with idempotency, compare-and-swap, and a publish action record. |`, `| EDT-002 | Untouched bytes, byte order marks, and line endings are preserved; stale edits conflict with the actual current version. |`, and `| EDT-003 | Editing is bounded to text media types, 1 MiB per file and 256 KiB of text per call, through artifact_edit and its HTTP route. |`.
- §13 item 2: `**Editing** (EDT): under a week; reuses the publish transaction and content-addressed blobs.`

In `project/spec/artifact-server-mcp-baseline.md`, add the row `| artifact_edit | Create a new immutable version from the current version by applying ordered replace, write, delete, and rename operations to text files, bounded to 256 KiB of text per call and 1 MiB per file. Return the exact-version review URL and the changed files. |` after the `artifact_commit_upload` row (use backticks around the tool name like its neighbours). Append to the paragraph that begins "Publishing always starts from an actual file": `The one inline content MCP accepts is an artifact_edit call's bounded text, which changes text files of a version already on the server.` (backtick the tool name).

- [ ] **Step 12: Docs and skill**

`docs/mcp.md`:
- In "Publish from an agent", change the first sentence to `MCP sends metadata, small results, and bounded text edits. Artifact files use the staged upload API.`
- In the Tool groups table, change the Publication row to `artifact_create_upload`, `artifact_commit_upload`, `artifact_edit`.
- Add, after "Use the publication result":

```markdown
## Edit text files of an artifact

`artifact_edit` creates a new version from the artifact's current version without uploading anything. It applies operations in order, all or nothing:

| Operation | Effect |
| --- | --- |
| `replace` `{path, edits: [{oldText, newText}]}` | Each `oldText` must occur exactly once in the file at that point. |
| `write` `{path, text, mediaType?}` | Creates or overwrites a text file. The media type defaults from the extension. |
| `delete` `{path}` | Removes a file. |
| `rename` `{from, to}` | Moves a file and keeps its bytes and media type. |

Only UTF-8 files with text media types are edited, each at most 1 MiB, with at most 256 KiB of text in one call. Untouched files keep their stored bytes, including byte order marks and line endings. Pass the current version ID as `expectedCurrentVersionId`; a stale ID fails with `PUBLISH_CONFLICT` naming the current version. The result carries the new version, its links, and `changes` (`path`, `change`, `size`).

HTTP clients call `POST /api/v1/artifacts/:artifactId/edits?projectId=…` with an `Idempotency-Key` header and `{expectedCurrentVersionId, operations}`.
```

`skills/artifact-server/references/artifact-operations.md`, under "MCP writes", add:

```markdown
- `artifact_edit`: change text files of an artifact already on the server without re-uploading it. Read each file with `artifact_read_file`, then send ordered `replace` (each `oldText` exactly once in the file), `write`, `delete`, and `rename` operations with the current version ID. At most 1 MiB per file and 256 KiB of text per call; publish binaries and new sites through the CLI or the upload tools. Give the user the returned `links.review`.
```

`skills/artifact-server/SKILL.md`, after the bullet "Never replace a real file with inline HTML…", add `- Use artifact_edit only for text changes to an artifact already on the server; files on the user's machine are published with the CLI.` (backtick the tool name).

- [ ] **Step 13: Gates**

```bash
timeout 900 "${DK}" "pnpm exec tsc -p tsconfig.json --noEmit" > "${LOG}" 2>&1; echo "EXIT=$?"
timeout 900 "${DK}" "pnpm lint" > "${LOG}" 2>&1; echo "EXIT=$?"
cd /home/coder/workspace/local/artifact-server && timeout 300 docker run --rm -v "${PWD}":/w:ro -w /w ruby:3.3-alpine sh -c "ruby scripts/validate-conformance.rb project/spec/conformance.yml && ruby scripts/check-conformance-test-ids.rb"; echo "EXIT=$?"
```
Expected: EXIT=0 for all three.

- [ ] **Step 14: Report to controller for commit**

Suggested message: `feat(edit): add artifact_edit text edit commits over MCP and HTTP`.

---

### Task 2: Blob reuse on upload (`baseArtifactId`)

Estimated production lines: ~120. Depends on Task 1 being merged (same files; no API dependency).

**Files:**
- Create: `tests/conformance/pub-015-upload-blob-reuse.test.ts`
- Modify: `src/core/ports.ts` (`StagedUploadRepository`), `src/core/errors.ts` (operation literal), `src/storage/sqlite-artifact-repository.ts`, `src/storage/postgres-artifact-repository.ts`, `src/application/staged-upload.ts`, `src/local/create-local-application-layer.ts` (`stagedDependencies`), `src/mcp/artifact-mcp-server.ts` (`artifact_create_upload`, `uploadPlan`, `agentInstructions`), `src/http/create-http-app.ts` (`createUploadSchema`, `POST /api/v1/uploads`)
- Docs/spec: `project/spec/conformance.yml` (PUB-015), `project/spec/artifact-server-mcp-baseline.md` (Direct upload flow step 1), `docs/mcp.md`, `skills/artifact-server/references/artifact-operations.md`

**Interfaces:**
- Consumes: `ArtifactManagementService.getArtifact`, `AuthorizationService.requireVersionPublication`/`requireArtifactControl`, `StagingStoragePort.put`, `StagedUploadRepositoryPort.markStagedFileUploaded`.
- Produces: `StagedUploadRepository.listArtifactBlobs(projectId: string, artifactId: string): Promise<readonly StoredBlob[]>`; `CreateStagedUploadCommand.baseArtifactId?: string | null`; `StagedUploadDependencies.blobs.open(blob: StoredBlob): Effect<ReadableStream<Uint8Array>, BlobStorageFailure>`; the upload plan (MCP and HTTP) gains `alreadyStored: {path: string; size: number}[]`, and its `files` lists only the files that still need a PUT.

- [ ] **Step 1: Write the failing conformance test**

Create `tests/conformance/pub-015-upload-blob-reuse.test.ts`:

```ts
import {createHash} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  callMcp,
  mcpFailed,
  mcpToolErrorCode,
  type McpReply,
} from "../support/agent-dispatch.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
  uploadStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const storedFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
}).strict();
const planSchema = z.object({
  alreadyStored: z.array(storedFileSchema),
  files: z.array(z.object({
    method: z.literal("PUT"),
    path: z.string(),
    size: z.number().int().nonnegative(),
    uploadUrl: z.url(),
  }).loose()),
  uploadId: z.string(),
}).loose();
const httpPlanSchema = z.object({
  alreadyStored: z.array(storedFileSchema),
  files: z.array(z.object({path: z.string()}).loose()),
}).loose();
const committedSchema = z.object({
  version: z.object({id: z.string(), number: z.number().int().positive()}).loose(),
}).loose();
const projectSchema = z.object({project: z.object({id: z.string()}).loose()}).loose();
const readResultSchema = z.object({sha256: z.string()}).loose();

type ToolArguments = NonNullable<Parameters<typeof callMcp>[4]["arguments"]>;

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function siteFile(path: string, content: string, mediaType: string): TestSiteFile {
  return {bytes: encoder.encode(content), mediaType, path};
}

function declared(file: TestSiteFile) {
  return {
    mediaType: file.mediaType,
    path: file.path,
    sha256: sha256(file.bytes),
    size: file.bytes.byteLength,
  };
}

const logo: TestSiteFile = {
  bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a),
  mediaType: "image/png",
  path: "logo.png",
};
const style = siteFile("style.css", "h1 { color: teal; }\n", "text/css");

describe("blob reuse on upload", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publishFiles(
    files: readonly TestSiteFile[],
    idempotencyKey: string,
    projectId?: string,
  ): Promise<PublishResponse> {
    const upload = await createStagedUpload(
      server,
      installation,
      files[0]?.path ?? "index.html",
      files,
      projectId,
    );
    const uploads = await uploadEveryStagedFile(installation, upload.body, files);
    expect(uploads.every((response) => response.ok)).toBe(true);
    return (await commitStagedUpload(installation, upload.body, idempotencyKey, {
      accessSetting: "private",
      kind: "new_artifact",
      name: "Blob reuse fixture",
    })).body;
  }

  function callTool(name: string, toolArguments: ToolArguments): Promise<McpReply> {
    return callMcp(server, installation.apiToken, "tools/call", name, {
      arguments: toolArguments,
      name,
    });
  }

  function structured(reply: McpReply) {
    expect(mcpFailed(reply)).toBe(false);
    return reply.result?.structuredContent;
  }

  test("PUB-015-B: an upload against a base artifact asks only for files the artifact does not store and commits all of them", async () => {
    const first = siteFile("index.html", "<h1>One</h1>", "text/html");
    const base = await publishFiles([first, logo, style], "pub-015-b-base-artifact");
    const page = siteFile("index.html", "<h1>Two</h1>", "text/html");
    const next = [page, logo, style];

    const plan = planSchema.parse(structured(await callTool("artifact_create_upload", {
      baseArtifactId: base.artifact.id,
      entryPath: "index.html",
      files: next.map(declared),
    })));
    expect(plan.files.map((file) => file.path)).toEqual(["index.html"]);
    expect(plan.alreadyStored).toEqual([
      {path: "logo.png", size: logo.bytes.byteLength},
      {path: "style.css", size: style.bytes.byteLength},
    ]);
    const planned = plan.files[0];
    if (planned === undefined) throw new Error("The plan asked for no upload.");
    expect((await uploadStagedFile(installation, planned, page.bytes)).status).toBe(200);
    const committed = committedSchema.parse(structured(await callTool("artifact_commit_upload", {
      idempotencyKey: "pub-015-b-commit-version",
      target: {
        artifactId: base.artifact.id,
        expectedCurrentVersionId: base.version.id,
        kind: "new_version",
      },
      uploadId: plan.uploadId,
    })));
    expect(committed.version.number).toBe(2);
    await Promise.all(next.map(async (file) => {
      expect(readResultSchema.parse(structured(await callTool("artifact_read_file", {
        artifactId: base.artifact.id,
        path: file.path,
        versionId: committed.version.id,
      }))).sha256).toBe(sha256(file.bytes));
    }));

    const overHttp = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        baseArtifactId: base.artifact.id,
        entryPath: "index.html",
        files: [first, logo].map(declared),
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(overHttp.status).toBe(201);
    const httpPlan = httpPlanSchema.parse(await overHttp.json());
    expect(httpPlan.files).toEqual([]);
    expect(httpPlan.alreadyStored.map((file) => file.path)).toEqual(["index.html", "logo.png"]);
  });

  test("PUB-015-F: a hash stored only by another artifact or project still needs its upload, and an unusable base artifact is refused without disclosure", async () => {
    const page = siteFile("index.html", "<h1>Base</h1>", "text/html");
    const base = await publishFiles([page], "pub-015-f-base-artifact");
    const secret = siteFile("secret.txt", "stored only by the other artifact\n", "text/plain");
    await publishFiles(
      [siteFile("index.html", "<h1>Other</h1>", "text/html"), secret],
      "pub-015-f-other-artifact",
    );

    const plan = planSchema.parse(structured(await callTool("artifact_create_upload", {
      baseArtifactId: base.artifact.id,
      entryPath: "index.html",
      files: [declared(page), declared(secret)],
    })));
    expect(plan.alreadyStored).toEqual([{path: "index.html", size: page.bytes.byteLength}]);
    expect(plan.files.map((file) => file.path)).toEqual(["secret.txt"]);
    expect(mcpToolErrorCode(await callTool("artifact_commit_upload", {
      idempotencyKey: "pub-015-f-premature-commit",
      target: {
        artifactId: base.artifact.id,
        expectedCurrentVersionId: base.version.id,
        kind: "new_version",
      },
      uploadId: plan.uploadId,
    }))).toBe("UPLOAD_INCOMPLETE");

    const resized = planSchema.parse(structured(await callTool("artifact_create_upload", {
      baseArtifactId: base.artifact.id,
      entryPath: "index.html",
      files: [{...declared(page), size: page.bytes.byteLength + 1}],
    })));
    expect(resized.alreadyStored).toEqual([]);
    expect(resized.files.map((file) => file.path)).toEqual(["index.html"]);

    expect(mcpToolErrorCode(await callTool("artifact_create_upload", {
      baseArtifactId: "art_unknown",
      entryPath: "index.html",
      files: [declared(page)],
    }))).toBe("ARTIFACT_NOT_FOUND");

    const other = projectSchema.parse(structured(await callTool("project_create", {
      name: "PUB-015 other project",
    })));
    const foreign = await publishFiles([secret], "pub-015-f-foreign-artifact", other.project.id);
    const crossProject = await callTool("artifact_create_upload", {
      baseArtifactId: foreign.artifact.id,
      entryPath: "secret.txt",
      files: [declared(secret)],
      projectId: base.artifact.projectId,
    });
    expect(mcpToolErrorCode(crossProject)).toBe("ARTIFACT_NOT_FOUND");
    expect(JSON.stringify(crossProject)).not.toContain("alreadyStored");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 900 "${DK}" "pnpm exec vitest run tests/conformance/pub-015-upload-blob-reuse.test.ts" > "${LOG}" 2>&1; echo "EXIT=$?"`
Expected: EXIT≠0. `baseArtifactId` is rejected as an unknown key, and `alreadyStored` is missing.

- [ ] **Step 3: Repository query**

In `src/core/ports.ts`, add to `StagedUploadRepository`:

```ts
  /** Every distinct stored blob any version of one artifact references. */
  listArtifactBlobs(
    projectId: string,
    artifactId: string,
  ): Promise<readonly StoredBlob[]>;
```

In `src/core/errors.ts`, add `"listArtifactBlobs",` to the `ArtifactRepositoryFailure` operation literals (after `"listArtifactActions",`).

In `src/storage/sqlite-artifact-repository.ts` (next to `versionContainsPath`; add `StoredBlob` to the `../core/ports.js` type import):

```ts
  listArtifactBlobs(
    projectId: string,
    artifactId: string,
  ): Promise<readonly StoredBlob[]> {
    return Promise.resolve().then(() =>
      z.array(z.object({
        sha256: z.string(),
        size: z.number().int().nonnegative(),
      })).parse(
        this.#database
          .prepare(
            `SELECT DISTINCT entry.sha256 AS sha256, entry.size AS size
             FROM manifest_entries entry
             INNER JOIN versions version ON version.id = entry.version_id
             WHERE version.project_id = ? AND version.artifact_id = ?`,
          )
          .all(projectId, artifactId),
      )
    );
  }
```

In `src/storage/postgres-artifact-repository.ts` (next to `versionContainsPath`; add `StoredBlob` to its `../core/ports.js` type import):

```ts
  async listArtifactBlobs(
    projectId: string,
    artifactId: string,
  ): Promise<readonly StoredBlob[]> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql`SELECT DISTINCT entry.sha256 AS sha256, entry.size AS size
        FROM manifest_entries entry
        INNER JOIN versions version
          ON version.installation_id = entry.installation_id
          AND version.id = entry.version_id
        WHERE version.installation_id = ${installationId}
          AND version.project_id = ${projectId}
          AND version.artifact_id = ${artifactId}`;
      return z.array(z.object({
        sha256: z.string(),
        size: nonnegativeIntegerSchema,
      })).parse(rows);
    }));
  }
```

- [ ] **Step 4: Service**

In `src/application/staged-upload.ts`:

1. Imports: add `type BlobStorageFailure` to the `../core/errors.js` import, `type StoredBlob` is already imported from ports, and add:

```ts
import {ArtifactManagementService} from "./artifact-management.js";
```

2. `CreateStagedUploadCommand` gains:

```ts
  /** An artifact the caller may publish to whose stored files need no upload. */
  readonly baseArtifactId?: string | null;
```

3. `StagedUploadRepositoryPort` gains:

```ts
  listArtifactBlobs(
    projectId: string,
    artifactId: string,
  ): Effect.Effect<readonly StoredBlob[], ArtifactRepositoryFailure>;
```

4. `StagedUploadDependencies` gains:

```ts
  /** Opens a stored blob that a base artifact already references. */
  readonly blobs: {
    readonly open: (
      blob: StoredBlob,
    ) => Effect.Effect<ReadableStream<Uint8Array>, BlobStorageFailure>;
  };
```

5. The layer: add `| ArtifactManagementService` to its requirement type, `const management = yield* ArtifactManagementService;` in the generator, and pass `management` as a new last argument of `makeStagedUploadService(dependencies, publish, authorization, projects, management)` (parameter `management: ArtifactManagementService["Service"]`).

6. Inside `makeStagedUploadService`, before `create`:

```ts
  const blobKey = (blob: StoredBlob): string => `${blob.sha256}:${blob.size}`;

  const reusableBlobKeys = Effect.fn("StagedUploadService.reusableBlobKeys")(
    function*(
      principal: Principal,
      projectId: string,
      artifactId: string,
    ): Effect.fn.Return<ReadonlySet<string>, StagedUploadFailure> {
      const base = yield* management.getArtifact({artifactId, principal, projectId});
      yield* authorization.requireVersionPublication(principal);
      yield* authorization.requireArtifactControl(principal, base.artifact);
      const stored = yield* dependencies.uploads.listArtifactBlobs(projectId, artifactId);
      return new Set(stored.map(blobKey));
    },
  );

  // ponytail: a reused blob is copied into its staging slot so commit keeps one path; costs one server-side copy per reused file at create time. A per-file stored flag (a migration) skips the copy if that latency matters.
  const stageReusedFiles = Effect.fn("StagedUploadService.stageReusedFiles")(
    function*(
      upload: StagedUpload,
      reusable: ReadonlySet<string>,
    ): Effect.fn.Return<StagedUpload, StagedUploadFailure> {
      let staged = upload;
      for (const file of upload.files.filter((candidate) => reusable.has(blobKey(candidate.entry)))) {
        yield* dependencies.staging.put({
          body: yield* dependencies.blobs.open(file.entry),
          sha256: file.entry.sha256,
          size: file.entry.size,
          storageToken: file.storageToken,
          uploadId: upload.id,
        });
        staged = yield* dependencies.uploads.markStagedFileUploaded(
          upload.projectId,
          upload.id,
          upload.principalId,
          file.storageToken,
          DateTime.formatIso(yield* dependencies.clock.now),
        );
      }
      return staged;
    },
  );
```

7. In `create`, after `const manifest = yield* parseManifest(...)` compute the reusable set, and stage the reused files after the insert:

```ts
      const reusable = command.baseArtifactId === undefined || command.baseArtifactId === null
        ? new Set<string>()
        : yield* reusableBlobKeys(command.principal, project.id, command.baseArtifactId);
      const created = yield* dependencies.clock.now;
      const upload = yield* dependencies.uploads.createStagedUpload({
        // the existing object literal, unchanged
      });
      return yield* stageReusedFiles(upload, reusable);
```

- [ ] **Step 5: Wiring**

In `src/local/create-local-application-layer.ts` `stagedDependencies`, add:

```ts
    blobs: {
      open: (blob) =>
        Effect.tryPromise({
          try: async () => (await adapters.blobs.open(blob.sha256)).body,
          catch: (cause) => new BlobStorageFailure({cause, operation: "open"}),
        }),
    },
```

and to `stagedDependencies.uploads`:

```ts
      listArtifactBlobs: (projectId, artifactId) =>
        Effect.tryPromise({
          try: () => adapters.repository.listArtifactBlobs(projectId, artifactId),
          catch: (cause) => repositoryFailure("listArtifactBlobs", cause),
        }),
```

`staging.put` verifies size and SHA-256 of the copied bytes. A mismatch surfaces as `UploadedFileMismatch`.

- [ ] **Step 6: Adapters**

MCP `artifact_create_upload`:
- input gains `baseArtifactId: artifactIdSchema.nullable().default(null),`;
- output gains `alreadyStored: z.array(z.object({path: z.string(), size: z.number().int().nonnegative()}).strict()),`;
- pass `baseArtifactId` into `uploads.createUploadWithGrant({...})`;
- append to its description: `When publishing a new version of an artifact you may publish to, pass it as baseArtifactId: declared files whose SHA-256 and size match a file in any of its versions come back in alreadyStored and need no PUT.`

In `uploadPlan(...)`, change `files:` to iterate `upload.files.filter((file) => file.uploadedAt === null)`, and add:

```ts
    alreadyStored: upload.files
      .filter((file) => file.uploadedAt !== null)
      .map((file) => ({path: file.entry.path, size: file.entry.size})),
```

In `agentInstructions`, append to the publishing line: ` When publishing a new version, pass baseArtifactId so files the artifact already stores need no upload.`

HTTP: `createUploadSchema` gains `baseArtifactId: z.string().min(1).max(200).optional(),`. `POST /api/v1/uploads` passes `baseArtifactId: body.baseArtifactId ?? null`. In its response, `files:` maps `upload.files.filter((file) => file.uploadedAt === null)`, plus the same `alreadyStored` projection as MCP.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `timeout 900 "${DK}" "pnpm exec vitest run tests/conformance/pub-015-upload-blob-reuse.test.ts tests/conformance/pub-014-upload-grant.test.ts tests/conformance/staged-upload-lifecycle.test.ts tests/conformance/mcp-modern-http.test.ts tests/conformance/publishing-security.test.ts tests/conformance/lnk-002-link-initial-capture.test.ts tests/cli" > "${LOG}" 2>&1; echo "EXIT=$?"`
Expected: EXIT=0.

- [ ] **Step 8: Ledger, spec, docs**

Insert after the PUB-014 block in `project/spec/conformance.yml`:

```yaml
  - id: PUB-015
    kind: behavior
    behavior: An upload plan created against a base artifact the caller may publish to reports each declared file whose SHA-256 and size match an entry in any version of that artifact as already stored, asks for no upload of it, and commits it; a match never comes from another artifact or project.
    owner: publishing
    source: {file: artifact-server-mcp-baseline.md, anchor: direct-upload-flow}
    acceptance:
      behavior: {id: PUB-015-B, description: "Create an upload over MCP and HTTP against a base artifact whose versions hold some declared files, upload only the rest, commit, and read back every digest."}
      failure: {id: PUB-015-F, description: "A file whose hash exists only in another artifact still needs its upload and blocks commit until uploaded, a size mismatch is not reused, and an unknown or other-project base artifact is refused as not found without revealing its files."}
    deployments: *all
    status: implementing
    proof_gap: PUB-015-B and PUB-015-F run against the local SQLite server. The Postgres blob query is covered only by typecheck, and refusal of a readable base artifact the caller does not control is enforced by the shared artifact-control check but not exercised by these tests.
    depends_on: [PUB-001, PUB-003, PUB-004]
```

In `project/spec/artifact-server-mcp-baseline.md` "Direct upload flow", append to step 1: ` With baseArtifactId, declared files whose SHA-256 and size match an entry in any version of that artifact are copied from its stored blobs and reported in alreadyStored; the caller must be allowed to publish to that artifact, and no other artifact's files are matched.` Backtick the field names.

In `docs/mcp.md`, after the `expectedCurrentVersionId` paragraph of "Publish from an agent", add: ``Pass `baseArtifactId` to `artifact_create_upload` when publishing a new version. Declared files whose SHA-256 and size match a file in any version of that artifact come back in `alreadyStored` and need no upload; `files` lists only the uploads still needed. The caller must be allowed to publish to the base artifact.``

In `skills/artifact-server/references/artifact-operations.md` "MCP file upload", add: ``When publishing a new version, pass the artifact as `baseArtifactId`; upload only the entries in `files`, because the ones in `alreadyStored` are already on the server.``

- [ ] **Step 9: Gates**

Run the Task 1 Step 13 commands: typecheck, lint, and the ledger validators. Expected: EXIT=0 for each.

- [ ] **Step 10: Report to controller for commit**

Suggested message: `feat(upload): reuse a base artifact's stored blobs in upload plans`.

---

### Task 3: Publication warnings

Estimated production lines: ~190. **Depends on Task 1** (`editArtifact` result, `PublishBlobStorage.readBytes`) **and Task 2** (both change `staged-upload.ts`).

**Files:**
- Create: `src/core/review-frame-sources.ts`, `src/application/publication-warnings.ts`, `tests/conformance/pub-016-publication-warnings.test.ts`
- Modify: `src/core/publishing-limits.ts`, `src/http/create-http-app.ts:4176-4213` (CSP lists, commit and edit responses), `src/application/publish-artifact.ts`, `src/application/staged-upload.ts` (`commitUpload`), `src/mcp/artifact-mcp-server.ts` (commit and edit outputs and summaries, `agentInstructions`)
- Docs/spec: `project/spec/conformance.yml` (PUB-016), `project/spec/artifact-server-mcp-baseline.md` (new "### Publication warnings"), `docs/mcp.md`, `skills/artifact-server/references/artifact-operations.md`

**Interfaces:**
- Consumes: `PublishBlobStorage.readBytes` and `ArtifactEdit` (Task 1), `StagedUpload.manifest`.
- Produces:
  - `src/core/review-frame-sources.ts`: `reviewFrameScriptSources`, `reviewFrameStyleSources`, `reviewFrameAllows(load: "script" | "stylesheet", url: URL): boolean`
  - `src/application/publication-warnings.ts`: `PublicationWarning {code: "blocked_host" | "missing_reference"; path: string; reference: string}`, `CommittedPublication extends PublishedVersion {warnings}`, `publicationWarnings(manifest, readBytes): Effect<readonly PublicationWarning[]>` (never fails)
  - `PublishArtifactService.publicationWarnings(manifest)`. `ArtifactEdit.warnings`. `StagedUploadService.commitUpload` returns `CommittedPublication`.
  - The MCP `artifact_commit_upload` and `artifact_edit` outputs, and the HTTP commit and edit responses, gain `warnings`.

- [ ] **Step 1: Write the failing conformance test**

Create `tests/conformance/pub-016-publication-warnings.test.ts`:

```ts
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {callMcp, mcpFailed, type McpReply} from "../support/agent-dispatch.js";
import {
  createStagedUpload,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const warningSchema = z.object({
  code: z.enum(["blocked_host", "missing_reference"]),
  path: z.string(),
  reference: z.string(),
}).strict();
const warnedSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  version: z.object({id: z.string()}).loose(),
  warnings: z.array(warningSchema),
}).loose();

type ToolArguments = NonNullable<Parameters<typeof callMcp>[4]["arguments"]>;

const encoder = new TextEncoder();
function textFile(path: string, content: string, mediaType: string): TestSiteFile {
  return {bytes: encoder.encode(content), mediaType, path};
}

const page = [
  "<!doctype html>",
  "<link rel=\"stylesheet\" href=\"style.css\">",
  "<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Inter\">",
  "<link rel=\"stylesheet\" href=\"https://styles.example/site.css\">",
  "<script src=\"https://cdn.jsdelivr.net/npm/chart.js@4\"></script>",
  "<script src=\"https://scripts.example/tracker.js\"></script>",
  "<script src=\"app.js\"></script>",
  "<a href=\"#top\">Top</a> <a href=\"guide.md?view=1#intro\">Guide</a>",
  "<a href=\"https://example.com/\">Out</a> <a href=\"mailto:team@example.com\">Mail</a>",
  "<img src=\"data:image/png;base64,AA==\"> <img src=\"img/missing.png\">",
].join("\n");
const guide =
  "# Guide\n\n![Logo](img/logo.png)\n\n[Home](index.html#top) and [site](https://example.com).\n";

describe("publication warnings", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function commitSite(files: readonly TestSiteFile[], idempotencyKey: string) {
    const upload = await createStagedUpload(server, installation, "index.html", files);
    const uploads = await uploadEveryStagedFile(installation, upload.body, files);
    expect(uploads.every((response) => response.ok)).toBe(true);
    const response = await fetch(upload.body.commitUrl, {
      body: JSON.stringify({
        target: {accessSetting: "private", kind: "new_artifact", name: "Warnings fixture"},
      }),
      headers: apiHeaders(installation, idempotencyKey),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return warnedSchema.parse(await response.json());
  }

  async function edit(toolArguments: ToolArguments) {
    const reply: McpReply = await callMcp(server, installation.apiToken, "tools/call", "artifact_edit", {
      arguments: toolArguments,
      name: "artifact_edit",
    });
    expect(mcpFailed(reply)).toBe(false);
    return warnedSchema.parse(reply.result?.structuredContent);
  }

  test("PUB-016-B: commits and edits report missing references and blocked hosts while ignoring fragments, queries, allowed CDNs, absolute links, data, and mailto", async () => {
    const committed = await commitSite([
      textFile("index.html", page, "text/html; charset=utf-8"),
      textFile("guide.md", guide, "text/markdown; charset=utf-8"),
      textFile("style.css", "h1 { color: teal; }\n", "text/css"),
    ], "pub-016-b-commit-site");
    const remaining = [
      {code: "missing_reference", path: "guide.md", reference: "img/logo.png"},
      {code: "blocked_host", path: "index.html", reference: "https://styles.example/site.css"},
      {code: "blocked_host", path: "index.html", reference: "https://scripts.example/tracker.js"},
    ];
    expect(committed.warnings).toEqual([
      ...remaining,
      {code: "missing_reference", path: "index.html", reference: "app.js"},
      {code: "missing_reference", path: "index.html", reference: "img/missing.png"},
    ]);

    const edited = await edit({
      artifactId: committed.artifact.id,
      expectedCurrentVersionId: committed.version.id,
      idempotencyKey: "pub-016-b-edit-adds-app",
      operations: [{kind: "write", path: "app.js", text: "console.log(1);\n"}],
    });
    expect(edited.warnings).toEqual([
      ...remaining,
      {code: "missing_reference", path: "index.html", reference: "img/missing.png"},
    ]);
  });

  test("PUB-016-F: warnings are capped and broken input never fails a publication", async () => {
    const broken = [
      "<a href=\"http://[bad\">Bad host</a> <a href=\"%E0%A4%A\">Bad escape</a>",
      ...[...Array(60).keys()].map((index) => `<img src="missing-${index}.png">`),
    ].join("\n");
    const committed = await commitSite([
      textFile("index.html", broken, "text/html"),
      {
        bytes: Uint8Array.of(0x3c, 0x61, 0x20, 0x68, 0x72, 0x65, 0x66, 0x3d, 0x22, 0xff, 0x22, 0x3e),
        mediaType: "text/html",
        path: "invalid.html",
      },
    ], "pub-016-f-commit-broken");
    expect(committed.warnings).toHaveLength(50);
    expect(committed.warnings.every((warning) => warning.code === "missing_reference")).toBe(true);
    expect(committed.warnings[0]).toEqual({
      code: "missing_reference",
      path: "index.html",
      reference: "missing-0.png",
    });

    const edited = await edit({
      artifactId: committed.artifact.id,
      expectedCurrentVersionId: committed.version.id,
      idempotencyKey: "pub-016-f-edit-adds-blocked",
      operations: [{
        kind: "write",
        path: "extra.html",
        text: "<script src=\"https://scripts.example/x.js\"></script>",
      }],
    });
    expect(edited.warnings).toHaveLength(50);
    expect(edited.warnings[0]).toEqual({
      code: "blocked_host",
      path: "extra.html",
      reference: "https://scripts.example/x.js",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 900 "${DK}" "pnpm exec vitest run tests/conformance/pub-016-publication-warnings.test.ts" > "${LOG}" 2>&1; echo "EXIT=$?"`
Expected: EXIT≠0, because `warnings` is missing from the responses.

- [ ] **Step 3: One source for the Review frame allowlist**

Create `src/core/review-frame-sources.ts`:

```ts
/**
 * Hosts the Review frame CSP allows beside the content hosts: the public CDNs
 * and Google Fonts stylesheets that claude.ai Artifacts allow, so pages written
 * for that platform render unchanged.
 */
export const reviewFrameScriptSources = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net/npm/",
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
  "https://code.jquery.com",
] as const;

export const reviewFrameStyleSources = ["https://fonts.googleapis.com"] as const;

/** Whether the Review frame CSP lets a page load a script or stylesheet from `url`. */
export function reviewFrameAllows(load: "script" | "stylesheet", url: URL): boolean {
  const sources = load === "script" ? reviewFrameScriptSources : reviewFrameStyleSources;
  return sources.some((source) => {
    const allowed = new URL(source);
    return url.protocol === allowed.protocol &&
      url.host === allowed.host &&
      url.pathname.startsWith(allowed.pathname);
  });
}
```

In `src/http/create-http-app.ts`, delete `reviewFrameScriptCdns` and `reviewFrameStyleCdns` together with their comment paragraph's last sentence (the CDN sentence now lives in the new module). Import `reviewFrameScriptSources` and `reviewFrameStyleSources` from `../core/review-frame-sources.js`, and build the directives with `${reviewFrameScriptSources.join(" ")}` and `${reviewFrameStyleSources.join(" ")}`.

- [ ] **Step 4: The analyzer**

Append to `src/core/publishing-limits.ts`:

```ts
/** Most publication warnings one commit or edit returns. */
export const maximumPublicationWarnings = 50;

/** Most HTML and Markdown bytes one publication's warning analysis reads. */
export const maximumWarningScanBytes = 4 * 1_024 * 1_024;
```

Create `src/application/publication-warnings.ts`:

```ts
import {Effect} from "effect";

import type {BlobStorageFailure} from "../core/errors.js";
import type {
  CanonicalManifest,
  ManifestEntry,
  PublishedVersion,
} from "../core/model.js";
import {
  maximumPublicationWarnings,
  maximumWarningScanBytes,
} from "../core/publishing-limits.js";
import {reviewFrameAllows} from "../core/review-frame-sources.js";

/** A non-fatal problem found in a published version's HTML or Markdown. */
export interface PublicationWarning {
  readonly code: "blocked_host" | "missing_reference";
  /** The manifest path of the file containing the reference. */
  readonly path: string;
  /** The reference as written. */
  readonly reference: string;
}

/** A committed publication with the warnings computed over its version. */
export interface CommittedPublication extends PublishedVersion {
  readonly warnings: readonly PublicationWarning[];
}

interface FoundReference {
  readonly loads: "script" | "stylesheet" | null;
  readonly navigation: boolean;
  readonly url: string;
}

// ponytail: regex attribute scanner, not an HTML parser. It also reads references in comments, <template>, and script text, stops an attribute list at the first ">", and skips srcset, CSS url(), and URLs built by JavaScript; adopt a parser if false or missed warnings matter.
const htmlTagPattern = /<(a|audio|iframe|img|link|script|source|video)\b([^>]*)>/giu;
const urlAttributePattern =
  /\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu;
const stylesheetRelPattern =
  /\srel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|stylesheet\b)/iu;
// ponytail: inline Markdown links and images only; reference-style definitions, raw HTML, and code spans are not told apart.
const markdownLinkPattern = /!?\[[^\]]*\]\(\s*<?([^\s<>)]+)>?/gu;
// ponytail: the content domain is unknown here, so an absolute script or stylesheet URL on a version host warns as blocked_host.
const artifactBase = new URL("https://artifact.invalid/");

type BlobReader = (
  entry: ManifestEntry,
) => Effect.Effect<Uint8Array, BlobStorageFailure>;

/** Warnings over one version's HTML and Markdown; analysis never fails a publication. */
export const publicationWarnings = Effect.fn("publicationWarnings")(
  function*(
    manifest: CanonicalManifest,
    readBytes: BlobReader,
  ): Effect.fn.Return<readonly PublicationWarning[], BlobStorageFailure> {
    const paths = new Set(manifest.entries.map((entry) => entry.path));
    const warnings: PublicationWarning[] = [];
    let budget = maximumWarningScanBytes;
    for (const entry of manifest.entries) {
      const format = scannedFormat(entry.mediaType);
      if (format === null || entry.size > budget) continue;
      budget -= entry.size;
      const text = new TextDecoder().decode(yield* readBytes(entry));
      const references = format === "html" ? htmlReferences(text) : markdownReferences(text);
      for (const reference of references) {
        const warning = referenceWarning(reference, entry.path, manifest, paths);
        if (warning !== null) warnings.push(warning);
        if (warnings.length === maximumPublicationWarnings) return warnings;
      }
    }
    return warnings;
  },
  Effect.catchCause(() => Effect.succeed<readonly PublicationWarning[]>([])),
);

function scannedFormat(mediaType: string): "html" | "markdown" | null {
  const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (essence === "text/html" || essence === "application/xhtml+xml") return "html";
  return essence === "text/markdown" ? "markdown" : null;
}

function htmlReferences(text: string): readonly FoundReference[] {
  return [...text.matchAll(htmlTagPattern)].flatMap(([, tagName = "", attributes = ""]) => {
    const tag = tagName.toLowerCase();
    return [...attributes.matchAll(urlAttributePattern)].map(
      ([, attribute = "", doubleQuoted, singleQuoted, bare]) => ({
        loads: loadKind(tag, attribute.toLowerCase(), attributes),
        navigation: tag === "a",
        url: (doubleQuoted ?? singleQuoted ?? bare ?? "").trim(),
      }),
    );
  });
}

function loadKind(
  tag: string,
  attribute: string,
  attributes: string,
): FoundReference["loads"] {
  if (tag === "script" && attribute === "src") return "script";
  if (tag === "link" && attribute === "href" && stylesheetRelPattern.test(attributes)) {
    return "stylesheet";
  }
  return null;
}

function markdownReferences(text: string): readonly FoundReference[] {
  return [...text.matchAll(markdownLinkPattern)].map(([, url = ""]) => ({
    loads: null,
    navigation: false,
    url,
  }));
}

function referenceWarning(
  reference: FoundReference,
  fromPath: string,
  manifest: CanonicalManifest,
  paths: ReadonlySet<string>,
): PublicationWarning | null {
  let url: URL;
  try {
    url = new URL(
      reference.url,
      new URL(fromPath.split("/").map(encodeURIComponent).join("/"), artifactBase),
    );
  } catch {
    return null;
  }
  if (url.origin === artifactBase.origin) {
    if (reference.navigation && manifest.routingMode === "spa") return null;
    const path = manifestPathOf(url, manifest.entryPath);
    return path === null || paths.has(path)
      ? null
      : {code: "missing_reference", path: fromPath, reference: reference.url};
  }
  if (
    reference.loads === null ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    reviewFrameAllows(reference.loads, url)
  ) {
    return null;
  }
  return {code: "blocked_host", path: fromPath, reference: reference.url};
}

function manifestPathOf(url: URL, entryPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
  if (path === "") return entryPath;
  return path.endsWith("/") ? `${path}index.html` : path;
}
```

- [ ] **Step 5: Hook warnings into commit and edit**

`src/application/publish-artifact.ts`:
- import `{type PublicationWarning, publicationWarnings} from "./publication-warnings.js"`;
- add `readonly warnings: readonly PublicationWarning[];` to `ArtifactEdit`;
- add `readonly publicationWarnings: (manifest: CanonicalManifest) => Effect.Effect<readonly PublicationWarning[]>;` to `PublishArtifactOperations`;
- in `makePublishArtifactService`, add:

```ts
  const warningsFor = (manifest: CanonicalManifest) =>
    publicationWarnings(manifest, dependencies.blobs.readBytes);
```

- in `editArtifact`, return `{changes, published: replayed, warnings: yield* warningsFor(manifest)}` for a replay, and `{changes, published, warnings: yield* warningsFor(manifest)}` after the commit;
- add `publicationWarnings: warningsFor,` to `PublishArtifactService.of({...})`.

`src/application/staged-upload.ts`:
- import `type CommittedPublication` from `./publication-warnings.js`;
- in `StagedUploadOperations`, change the return of `commitUpload` to `Effect.Effect<CommittedPublication, StagedUploadFailure>`, and change the `commitUpload` generator's `Effect.fn.Return` type the same way;
- replace the `switch (command.target.kind) {...}` and the trailing `Effect.die` with:

```ts
      const published = command.target.kind === "new_artifact"
        ? yield* expirePublicationAtDeadline(signal,
          publish.publishPreparedNew({
            accessSetting: command.target.accessSetting,
            files,
            idempotencyKey: command.idempotencyKey,
            manifest: upload.manifest,
            name: command.target.name,
            principal: command.principal,
            projectId: project.id,
            source,
            tags: command.target.tags ?? [],
          }))
        : yield* expirePublicationAtDeadline(signal,
          publish.publishPreparedVersion({
            artifactId: command.target.artifactId,
            expectedCurrentVersionId: command.target.expectedCurrentVersionId,
            files,
            idempotencyKey: command.idempotencyKey,
            manifest: upload.manifest,
            principal: command.principal,
            projectId: project.id,
            source,
          }));
      return {
        ...published,
        warnings: yield* publish.publicationWarnings(upload.manifest),
      };
```

`src/mcp/artifact-mcp-server.ts`:
- add:

```ts
const publicationWarningSchema = z.object({
  code: z.enum(["blocked_host", "missing_reference"]),
  path: z.string(),
  reference: z.string(),
}).strict();
```

- `artifact_commit_upload`: `outputSchema: publishedVersionSchema.extend({warnings: z.array(publicationWarningSchema)}).strict(),`. Return `{...publishedVersionProjection(applicationUrl, dependencies.contentDomain, published), warnings: published.warnings}`. The summary becomes `(published) => publicationSummary(published) + warningSummary(published.warnings)`.
- `artifact_edit`: output gains `warnings: z.array(publicationWarningSchema),`, the result gains `warnings: edit.warnings`, and the summary becomes `(edit) => editSummary(edit) + warningSummary(edit.warnings)`.
- add:

```ts
function warningSummary(
  warnings: readonly {
    readonly code: string;
    readonly path: string;
    readonly reference: string;
  }[],
): string {
  return warnings.length === 0
    ? ""
    : [
      "",
      `Warnings (${warnings.length}):`,
      ...warnings.map((warning) => `- ${warning.code} in ${warning.path}: ${warning.reference}`),
    ].join("\n");
}
```

- `agentInstructions`, after the `artifact_edit` line:

```ts
    "Commit and edit results may carry warnings: missing_reference is a relative link or image that names no file in the version, and blocked_host is a script or stylesheet host the Review frame blocks. They never fail a publication; fix them in a new version when they matter.",
```

`src/http/create-http-app.ts`: the commit route returns `{...publishResponse(...), warnings: result.warnings}`. The edit route returns `{...publishResponse(...), changes: edit.changes, warnings: edit.warnings}`.

The MCP commit text stays exactly the three-line `publicationSummary` when there are no warnings, which `mcp-modern-http.test.ts` asserts.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `timeout 900 "${DK}" "pnpm exec vitest run tests/conformance/pub-016-publication-warnings.test.ts tests/conformance/edt-001-edit-commit.test.ts tests/conformance/mcp-modern-http.test.ts tests/conformance/staged-upload-lifecycle.test.ts tests/conformance/pub-014-upload-grant.test.ts tests/cli" > "${LOG}" 2>&1; echo "EXIT=$?"`
Expected: EXIT=0. `tests/browser/review-sandbox.spec.ts` covers the CSP in the final gate.

- [ ] **Step 7: Ledger, spec, docs**

Insert after PUB-015:

```yaml
  - id: PUB-016
    kind: behavior
    behavior: Upload commits and edit commits return non-fatal publication warnings for relative HTML and Markdown references that name no manifest path and for absolute script or stylesheet URLs the Review frame policy blocks; analysis is bounded in warnings and bytes read and never fails a publication.
    owner: publishing
    source: {file: artifact-server-mcp-baseline.md, anchor: publication-warnings}
    acceptance:
      behavior: {id: PUB-016-B, description: "Publish a site with a missing script, a missing Markdown image, and blocked script and stylesheet hosts beside allowed CDN, fragment, query, absolute, data, and mailto references, and receive exactly the missing and blocked warnings from the commit and from an edit."}
      failure: {id: PUB-016-F, description: "A publication with more broken references than the cap, invalid UTF-8, and malformed URLs still commits and an edit still commits, each with at most the capped warnings."}
    deployments: *all
    status: verified
    depends_on: [PUB-005, EDT-001]
```

In `project/spec/artifact-server-mcp-baseline.md`, after the "Direct upload flow" list, add:

```markdown
### Publication warnings

`artifact_commit_upload`, `artifact_edit`, and their HTTP routes return `warnings` computed over the resulting version, never failures. `missing_reference` names a relative `src` or `href` (script, link, img, source, video, audio, iframe, a) in an HTML file, or a Markdown link or image, that resolves to no manifest path; fragments, queries, absolute URLs, `data:`, and `mailto:` are ignored. `blocked_host` names an absolute script or stylesheet URL whose host the Review frame CSP does not allow; fonts load from any host. At most 50 warnings are returned and at most 4 MiB of HTML and Markdown is read.
```

In `docs/mcp.md`, after "Use the publication result", add:

```markdown
## Publication warnings

Upload commits and edits return `warnings`, which never fail a publication. `missing_reference` names a relative link or image in an HTML or Markdown file that matches no file in the version. `blocked_host` names a script or stylesheet URL whose host the Review frame does not allow. At most 50 warnings are returned, from at most 4 MiB of HTML and Markdown.
```

In `skills/artifact-server/references/artifact-operations.md` "Final result", add: ``Report any `warnings` from the result in one line each; offer to fix them with a new version.``

- [ ] **Step 8: Gates**

Run the Task 1 Step 13 commands. Expected: EXIT=0 for each.

- [ ] **Step 9: Report to controller for commit**

Suggested message: `feat(publish): return publication warnings for missing and blocked references`.

---

### Task 4: Element context in comment anchors

Estimated production lines: ~70 (most of it type declarations). No dependency on Tasks 1–3.

**Files:**
- Create: `tests/browser/cmt-023-element-context.spec.ts`
- Modify: `apps/web/src/review-frame/plannotator/components/html-viewer.d.ts`, `apps/web/src/review-frame/protocol.ts`, `apps/web/src/review-frame/review-frame.tsx`
- Docs/spec: `project/spec/conformance.yml` (CMT-023), `project/spec/artifact-comments-spec.md` (§3 anchor paragraph)

**Interfaces:**
- Consumes: `buildPersistedHtmlAnchor` from `@plannotator/ui/components/html-viewer` (re-exported from `@plannotator/core/html-anchor` 0.25.34). The viewer's `Annotation.elementContext`.
- Produces: stored anchors of the form `{originalText, htmlAnchor: HtmlElementAnchor | null, htmlAdditionalTargets?, elementContext?}`, which Task 5 reads. `reviewAnchorFrom(persisted: PersistedHtmlAnchor): ReviewAnchor`.

- [ ] **Step 1: Write the failing browser test**

Create `tests/browser/cmt-023-element-context.spec.ts`:

```ts
import {expect, test} from "@playwright/test";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {listThreadsOverApi} from "./comment-api.js";

const storedAnchorSchema = z.object({
  elementContext: z.object({
    classes: z.array(z.string()).optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    tag: z.string(),
    text: z.string().optional(),
  }).loose(),
  htmlAnchor: z.object({selector: z.string()}).loose(),
  originalText: z.string(),
}).loose();

const page = `<!doctype html><html><body><main><h2>Draft</h2>
<button id="save" class="btn primary" type="button">Save draft</button>
<button id="huge" type="button" aria-label="${"A".repeat(5_000)}">${"word ".repeat(5_000)}</button>
</main></body></html>`;

async function commentOn(
  fixture: BrowserFixture,
  idempotencyKey: string,
  selector: string,
  body: string,
) {
  const published = await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: page,
    idempotencyKey,
    name: "Element context",
  });
  await localLogin(fixture);
  await fixture.page.goto(
    `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}&mode=comment`,
  );
  const review = fixture.page.frameLocator(".as-artifact-frame");
  const preview = review.frameLocator("iframe");
  await preview.locator(selector).hover();
  await preview.locator(selector).click();
  const composer = review.getByPlaceholder("Add a comment...");
  await expect(composer).toBeVisible();
  await composer.fill(body);
  await review.getByRole("button", {name: "Save"}).click();
  await expect(fixture.page.getByRole("article").filter({hasText: body})).toBeVisible();
  const [thread] = await listThreadsOverApi(fixture, published.body.artifact.id);
  return thread?.anchor;
}

test.describe("element context in comment anchors", () => {
  test("CMT-023-B: a pinpoint comment stores the element's context inside its anchor", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const anchor = storedAnchorSchema.parse(
        await commentOn(fixture, "cmt-023-element-context-b", "#save", "Rename this button."),
      );
      expect(anchor.elementContext).toMatchObject({
        classes: ["btn", "primary"],
        id: "save",
        tag: "button",
      });
      expect(anchor.elementContext.path).toContain("button#save");
      expect(anchor.htmlAnchor.selector).toContain("save");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-023-F: page-controlled element context stays bounded inside the 16 KiB anchor", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const stored = await commentOn(fixture, "cmt-023-element-context-f", "#huge", "Shorten this label.");
      expect(new TextEncoder().encode(JSON.stringify(stored)).byteLength)
        .toBeLessThanOrEqual(16_384);
      const anchor = storedAnchorSchema.parse(stored);
      expect(anchor.elementContext.tag).toBe("button");
      expect(anchor.elementContext.name?.length ?? 0).toBeLessThanOrEqual(120);
      expect(anchor.elementContext.text?.length ?? 0).toBeLessThanOrEqual(300);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
```


- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 1500 "${DK}" "pnpm build && pnpm exec playwright test tests/browser/cmt-023-element-context.spec.ts" > "${LOG}" 2>&1; echo "EXIT=$?"`
Expected: EXIT≠0. The frame message schema strips `elementContext`, so the stored anchor has none.

- [ ] **Step 3: Declare the package surface**

In `apps/web/src/review-frame/plannotator/components/html-viewer.d.ts`, add to the "Mirrors" header list `components/html-viewer/index.ts:25 (buildPersistedHtmlAnchor) and @plannotator/core@0.25.34 html-anchor.ts:66-100, 426-571`, and add:

```ts
/** Bounded agent-facing description of a pinpointed element (types.ts:179-230). */
export interface HtmlElementContext {
  tag: string;
  id?: string | undefined;
  classes?: string[] | undefined;
  path?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  attrs?: Array<[string, string]> | undefined;
  text?: string | undefined;
  outline?: string | undefined;
  children?: number | undefined;
  rect?: {x: number; y: number; w: number; h: number; vw: number; vh: number} | undefined;
  landmark?: string | undefined;
  heading?: string | undefined;
  component?: string | undefined;
  page?: {url: string; title?: string | undefined} | undefined;
  sourceName?: string | undefined;
}

/** The anchor record a host persists for one raw-HTML comment. */
export interface PersistedHtmlAnchor {
  originalText: string;
  htmlAnchor?: HtmlElementAnchor | undefined;
  htmlAdditionalTargets?: HtmlAnnotationTarget[] | undefined;
  elementContext?: HtmlElementContext | undefined;
}

/** Validate and bound one composed comment's anchor for persistence. */
export declare function buildPersistedHtmlAnchor(
  source: {
    originalText: string;
    htmlAnchor?: HtmlElementAnchor | null | undefined;
    htmlAdditionalTargets?: readonly HtmlAnnotationTarget[] | null | undefined;
    elementContext?: HtmlElementContext | null | undefined;
  },
  options?: {maxBytes?: number | undefined; maxTargets?: number | undefined},
): {
  anchor: PersistedHtmlAnchor;
  droppedTargets: number;
  capDroppedTargets: number;
  sizeDroppedTargets: number;
};
```

Also add `context?: HtmlElementContext | undefined;` to `HtmlAnnotationTarget` and `elementContext?: HtmlElementContext | undefined;` to `Annotation`.

- [ ] **Step 4: Protocol schema and conversion**

In `apps/web/src/review-frame/protocol.ts`, change the type import to `import type {PersistedHtmlAnchor} from "@plannotator/ui/components/html-viewer";`. Add before `htmlAnnotationTargetSchema`:

```ts
/** Caps mirror @plannotator/core's parseHtmlElementContext (html-anchor.ts:143-162). */
const htmlElementContextSchema = z.object({
  attrs: z.array(z.tuple([z.string().max(40), z.string().max(120)])).max(10).optional(),
  children: z.number().int().nonnegative().optional(),
  classes: z.array(z.string().max(48)).max(9).optional(),
  component: z.string().max(100).optional(),
  heading: z.string().max(130).optional(),
  id: z.string().max(100).optional(),
  landmark: z.string().max(80).optional(),
  name: z.string().max(120).optional(),
  outline: z.string().max(600).optional(),
  page: z.object({title: z.string().max(200).optional(), url: z.string().max(2_048)}).optional(),
  path: z.string().max(512).optional(),
  rect: z.object({
    h: z.number(), vh: z.number(), vw: z.number(), w: z.number(), x: z.number(), y: z.number(),
  }).optional(),
  role: z.string().max(32).optional(),
  sourceName: z.string().max(80).optional(),
  tag: z.string().min(1).max(32),
  text: z.string().max(300).optional(),
});
```

Add `context: htmlElementContextSchema.optional().catch(undefined),` to `htmlAnnotationTargetSchema`, and `elementContext: htmlElementContextSchema.optional().catch(undefined),` to `reviewAnchorSchema`. A malformed context is dropped without losing the anchor's marker. Update the `reviewAnchorSchema` doc comment's opening to: `The anchor this client stores on a comment thread: the package's persisted anchor with htmlAnchor null when absent.` Replace `reviewAnchorFrom` with:

```ts
/** The anchor stored on a thread from the package's bounded persisted anchor. */
export function reviewAnchorFrom(persisted: PersistedHtmlAnchor): ReviewAnchor {
  return {...persisted, htmlAnchor: persisted.htmlAnchor ?? null};
}
```

In `apps/web/src/review-frame/review-frame.tsx`, import `buildPersistedHtmlAnchor` from `@plannotator/ui/components/html-viewer`, and add above `ReviewFrame`:

```ts
/** The server's 16 KiB anchor cap, less room for the `htmlAnchor: null` a stored anchor carries. */
const storedAnchorBytes = 16_384 - 32;
```

and in `handleAdd`, change the `anchor:` line to:

```ts
      anchor: reviewAnchorFrom(
        buildPersistedHtmlAnchor(annotation, {maxBytes: storedAnchorBytes}).anchor,
      ),
```

`protocol.ts` keeps type-only imports from the package. The host bundle (`review-preview.tsx` and `review-comments.tsx` import `protocol.ts`) gains no viewer code.

- [ ] **Step 5: Run the test to verify it passes**

Run: `timeout 1500 "${DK}" "pnpm build && pnpm exec playwright test tests/browser/cmt-023-element-context.spec.ts tests/browser/frontend-mvp.spec.ts tests/browser/review-fragment-anchors.spec.ts tests/browser/drf-001-draft-durability.spec.ts" > "${LOG}" 2>&1; echo "EXIT=$?"`
Expected: EXIT=0.

- [ ] **Step 6: Ledger and spec**

Insert after CMT-022:

```yaml
  - id: CMT-023
    kind: behavior
    behavior: A pinpoint comment on an HTML element stores the review bridge's bounded element context (tag, id, classes, path, role, name, outline, box) inside its opaque anchor through the package's persisted-anchor helper, within the 16 KiB anchor cap; the server does not interpret it.
    owner: artifact-comments
    source: {file: artifact-comments-spec.md, anchor: 3-model}
    acceptance:
      behavior: {id: CMT-023-B, description: "Pinpoint an element in Comment mode and read back an anchor carrying its tag, id, classes, path, and selector."}
      failure: {id: CMT-023-F, description: "An element with oversized page-controlled attributes and text saves a comment whose anchor stays within 16 KiB and whose context fields stay within their caps."}
    deployments: *all
    status: verified
    proof_gap: Local Chromium production-build evidence only; Firefox, WebKit, and team-deployment evidence is unrecorded.
    depends_on: [CMT-003, CMT-014]
```

In `project/spec/artifact-comments-spec.md` §3, append to the paragraph beginning "Anchor rule, copied from Workspaces": `The review frame stores a pinpoint comment's anchor through @plannotator/ui's buildPersistedHtmlAnchor: originalText, htmlAnchor, htmlAdditionalTargets, and elementContext, the bridge's bounded description of the element (tag, id, classes, path, role, name, outline, box), all within the 16 KiB cap. The server stores it without interpreting it.` Backtick the identifiers.

- [ ] **Step 7: Gates**

```bash
timeout 900 "${DK}" "pnpm --filter @artifact-server/web typecheck" > "${LOG}" 2>&1; echo "EXIT=$?"
timeout 900 "${DK}" "pnpm lint" > "${LOG}" 2>&1; echo "EXIT=$?"
```
Then run the ledger validators (Task 1 Step 13). Expected: EXIT=0 for each.

- [ ] **Step 8: Report to controller for commit**

Suggested message: `feat(review): persist Plannotator element context in comment anchors`.

---

### Task 5: Agent-ready feedback in `comment_list` and `dispatch_inbox`

Estimated production lines: ~110. No code dependency on Tasks 1–4. It reads the anchor shape Task 4 stores, and the tests write that shape directly.

The existing bundle format (`docs/agent-bridge-protocol.md` "Bundle rendering contract", `src/mcp/dispatch-bundle-message.ts`) is extended. No second format is created.

**Files:**
- Create: `src/mcp/comment-target.ts`, `tests/conformance/mcp-022-agent-feedback.test.ts`
- Modify: `src/mcp/dispatch-bundle-message.ts`, `src/mcp/artifact-mcp-server.ts` (`mailboxAnchorSchema` removed, `assembleMailboxBundle`, `comment_list`, `agentInstructions`), `tests/conformance/cmt-012-comment-surface-parity.test.ts:67-70,201-202`
- Docs/spec: `project/spec/conformance.yml` (MCP-022, BRP-002 `proof_gap`), `project/spec/artifact-server-mcp-baseline.md` (`comment_list` row), `docs/agent-bridge-protocol.md`, `docs/mcp.md`, `skills/artifact-server/references/artifact-operations.md`

**Interfaces:**
- Consumes: `CommentThreadRecord.anchor` (opaque). `sanitizeBundleText`.
- Produces: `commentTarget(thread: CommentThreadRecord): CommentTarget`, `CommentTarget = {element: CommentElement | null; quote: string | null}`, and `commentTargetSchema` and `CommentElement` in `src/mcp/comment-target.ts`. `BundleItem.element: CommentElement | null`. `comment_list` items gain `target`.

- [ ] **Step 1: Write the failing conformance test**

Create `tests/conformance/mcp-022-agent-feedback.test.ts`:

```ts
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ApiClient,
  callMcp,
  dispatchCreationSchema,
  mcpFailed,
  type McpReply,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const targetSchema = z.object({
  element: z.json().nullable(),
  quote: z.string().nullable(),
}).strict();
const pageSchema = z.object({
  items: z.array(z.object({id: z.string(), target: targetSchema}).loose()),
}).loose();
const inboxSchema = z.object({
  agent: z.object({id: z.string()}).loose(),
  claimed: z.object({message: z.string()}).loose().nullable(),
}).loose();
const threadCreationSchema = z.object({thread: z.object({id: z.string()}).loose()}).loose();

type ToolArguments = NonNullable<Parameters<typeof callMcp>[4]["arguments"]>;

const saveAnchor = {
  elementContext: {
    classes: ["btn", "primary"],
    heading: "h2 \"Draft\"",
    id: "save",
    landmark: "main",
    name: "Save draft",
    page: {url: "/drafts"},
    path: "body > main > button#save",
    tag: "button",
    text: "Save draft",
  },
  htmlAnchor: {selector: "#save", tagName: "button"},
  originalText: "Save draft",
};

describe("agent-ready comment feedback", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><main><button id=\"save\">Save draft</button></main>",
      idempotencyKey: "mcp-feedback-publish-artifact",
      name: "Agent feedback",
    })).body;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function openThread(
    anchor: ToolArguments[string] | null,
    body: string,
    idempotencyKey: string,
  ): Promise<string> {
    const payload = anchor === null
      ? {body, path: "index.html"}
      : {anchor, body, path: "index.html"};
    const response = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments?projectId=${published.artifact.projectId}`,
      {body: JSON.stringify(payload), idempotencyKey, method: "POST"},
    );
    expect(response.status).toBe(201);
    return threadCreationSchema.parse(await response.json()).thread.id;
  }

  async function callTool(name: string, toolArguments: ToolArguments) {
    const reply: McpReply = await callMcp(server, installation.apiToken, "tools/call", name, {
      arguments: toolArguments,
      name,
    });
    expect(mcpFailed(reply)).toBe(false);
    return reply.result?.structuredContent;
  }

  async function claimBundle(threadIds: readonly string[], idempotencyKey: string) {
    const listed = inboxSchema.parse(await callTool("dispatch_inbox", {
      agentName: "Feedback agent",
      operation: "list",
    }));
    const response = await client.sendDispatch({
      agentId: listed.agent.id,
      idempotencyKey,
      projectId: published.artifact.projectId,
      threadIds: [...threadIds],
    });
    expect(response.status).toBe(201);
    dispatchCreationSchema.parse(await response.json());
    const claimed = inboxSchema.parse(await callTool("dispatch_inbox", {
      agentName: "Feedback agent",
      operation: "claim",
    }));
    return claimed.claimed?.message ?? "";
  }

  async function targets() {
    const page = pageSchema.parse(await callTool("comment_list", {
      artifactId: published.artifact.id,
    }));
    return new Map(page.items.map((item) => [item.id, item.target]));
  }

  test("MCP-022-B: comment_list and a claimed dispatch give the agent the quoted text and the anchored element", async () => {
    const threadId = await openThread(saveAnchor, "Rename the save button.", "mcp-022-b-thread-save");
    expect((await targets()).get(threadId)).toEqual({
      element: {
        classes: ["btn", "primary"],
        heading: "h2 \"Draft\"",
        id: "save",
        landmark: "main",
        name: "Save draft",
        path: "body > main > button#save",
        selector: "#save",
        tag: "button",
        text: "Save draft",
      },
      quote: "Save draft",
    });
    const message = await claimBundle([threadId], "mcp-022-b-dispatch-save");
    expect(message).toContain("1. [Agent feedback · version 1 · index.html] \"Save draft\"");
    expect(message).toContain("   Element: <button#save.btn.primary> \"Save draft\"");
    expect(message).toContain("   Selector: #save");
    expect(message).toContain("   Path: body > main > button#save");
    expect(message).toContain("   Near: main · heading h2 \"Draft\"");
  });

  test("MCP-022-F: unrecognized and hostile anchors yield no element or sanitized element lines and never block listing or dispatch", async () => {
    const pageNote = await openThread({kind: "page"}, "Whole file note.", "mcp-022-f-thread-page");
    const malformed = await openThread(
      {elementContext: {id: "x", tag: 42}, originalText: "Plain quote"},
      "Malformed context.",
      "mcp-022-f-thread-malformed",
    );
    const hostile = await openThread(
      {elementContext: {name: "Sa‮ve", path: "body >​ main", tag: "div"}, originalText: "q"},
      "Hostile context.",
      "mcp-022-f-thread-hostile",
    );
    const bare = await openThread(null, "No anchor at all.", "mcp-022-f-thread-bare");
    const listed = await targets();
    expect(listed.get(pageNote)).toEqual({element: null, quote: null});
    expect(listed.get(malformed)).toEqual({element: null, quote: "Plain quote"});
    expect(listed.get(hostile)).toEqual({
      element: {name: "Sa‮ve", path: "body >​ main", tag: "div"},
      quote: "q",
    });
    expect(listed.get(bare)).toEqual({element: null, quote: null});

    const message = await claimBundle([pageNote, malformed, hostile, bare], "mcp-022-f-dispatch-all");
    expect(message.match(/Element: /gu)).toHaveLength(1);
    expect(message).toContain("   Element: <div> \"Save\"");
    expect(message).toContain("   Path: body > main");
    expect(message).not.toMatch(/[‪-‮⁦-⁩​-‏⁠﻿]/u);
  });
});
```

In `tests/conformance/cmt-012-comment-surface-parity.test.ts`:
- change `mcpThreadPageSchema`'s items to `z.array(commentThreadSchema.extend({target: z.object({element: z.json().nullable(), quote: z.string().nullable()}).strict()}))`;
- change the parity assertion to `expect(mcpAfterMutations.items.map((thread) => ({...thread, target: undefined}))).toEqual(httpAfterMutations.items.map(withoutLinks));`, because `toEqual` ignores `undefined` properties.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 900 "${DK}" "pnpm exec vitest run tests/conformance/mcp-022-agent-feedback.test.ts tests/conformance/cmt-012-comment-surface-parity.test.ts" > "${LOG}" 2>&1; echo "EXIT=$?"`
Expected: EXIT≠0, because `target` is missing from `comment_list` items.

- [ ] **Step 3: Derive the target**

Create `src/mcp/comment-target.ts`:

```ts
import {z} from "zod";

import type {CommentThreadRecord} from "../core/model.js";

const elementContextSchema = z.object({
  attrs: z.array(z.tuple([z.string(), z.string()])).optional(),
  classes: z.array(z.string()).optional(),
  component: z.string().optional(),
  heading: z.string().optional(),
  id: z.string().optional(),
  landmark: z.string().optional(),
  name: z.string().optional(),
  outline: z.string().optional(),
  path: z.string().optional(),
  rect: z.object({
    h: z.number(), vh: z.number(), vw: z.number(), w: z.number(), x: z.number(), y: z.number(),
  }).optional(),
  role: z.string().optional(),
  tag: z.string().min(1),
  text: z.string().optional(),
});

/** The page element a thread's anchor names, as the review bridge described it. */
export const commentElementSchema = elementContextSchema
  .extend({selector: z.string().optional()})
  .strict();

/** One recognized element of a comment anchor. */
export type CommentElement = z.infer<typeof commentElementSchema>;

/** What a thread asks to change, when its anchor is recognizable. */
export const commentTargetSchema = z.object({
  element: commentElementSchema.nullable(),
  quote: z.string().nullable(),
}).strict();

/** A thread's quoted text and element, each null when the anchor lacks it. */
export type CommentTarget = z.infer<typeof commentTargetSchema>;

const recognizedAnchorSchema = z.object({
  elementContext: elementContextSchema.optional().catch(undefined),
  htmlAnchor: z.object({selector: z.string()}).nullable().optional().catch(null),
  originalText: z.string().optional().catch(undefined),
});

/** Derive a thread's target from its opaque anchor, ignoring what is not recognized. */
export function commentTarget(thread: CommentThreadRecord): CommentTarget {
  const anchor = recognizedAnchorSchema.safeParse(thread.anchor);
  if (!anchor.success) return {element: null, quote: null};
  const {elementContext, htmlAnchor, originalText} = anchor.data;
  const quote = originalText ?? null;
  if (elementContext === undefined) return {element: null, quote};
  const selector = htmlAnchor?.selector;
  return {
    element: selector === undefined ? elementContext : {...elementContext, selector},
    quote,
  };
}
```

- [ ] **Step 4: Render element lines in the bundle**

In `src/mcp/dispatch-bundle-message.ts`:
- Replace the module comment's last sentence with: `So the mailbox tier carries this mirror, and BRP-002-B pins the two renders byte-for-byte against the same bundle. Items whose anchor carries element context add element lines the package does not render.`
- Add `import type {CommentElement} from "./comment-target.js";`.
- Add to `BundleItem`, between `body` and `path`:

```ts
  /** The element the thread's anchor names, rendered as indented element lines. */
  readonly element: CommentElement | null;
```

- Replace `quotedSelectionFragment` with:

```ts
function boundedText(text: string): string {
  const collapsed = sanitizeBundleText(text).replace(/\s+/gu, " ").trim();
  return collapsed.length <= maximumQuotedSelectionCharacters
    ? collapsed
    : `${collapsed.slice(0, maximumQuotedSelectionCharacters - 1)}…`;
}

function quotedSelectionFragment(selection: string): string {
  return `"${boundedText(selection)}"`;
}

/** Identity and location lines for an element, each sanitized and bounded. */
function elementLines(element: CommentElement): readonly string[] {
  const id = element.id === undefined ? "" : `#${element.id}`;
  const classes = (element.classes ?? []).map((name) => `.${name}`).join("");
  const name = element.name === undefined ? "" : ` ${quotedSelectionFragment(element.name)}`;
  const lines = [`Element: ${boundedText(`<${element.tag}${id}${classes}>`)}${name}`];
  if (element.selector !== undefined) lines.push(`Selector: ${boundedText(element.selector)}`);
  if (element.path !== undefined) lines.push(`Path: ${boundedText(element.path)}`);
  const near = [
    element.landmark,
    element.heading === undefined ? undefined : `heading ${element.heading}`,
  ].filter((part) => part !== undefined);
  if (near.length > 0) lines.push(`Near: ${boundedText(near.join(" · "))}`);
  return lines;
}
```

- In `renderBundleMessage`, right after `lines.push(\`${index + 1}. ${place}${quoted}\`);`, add:

```ts
    for (const elementLine of item.element === null ? [] : elementLines(item.element)) {
      lines.push(`   ${elementLine}`);
    }
```

- [ ] **Step 5: MCP adapter**

In `src/mcp/artifact-mcp-server.ts`:
- import `{commentTarget, commentTargetSchema}` from `./comment-target.js`;
- delete `mailboxAnchorSchema`;
- in `assembleMailboxBundle`, build items as:

```ts
    const items: BundleItem[] = readable.map((thread) => {
      const view = artifactViews.get(thread.artifactId);
      const target = commentTarget(thread);
      return {
        artifactName: view?.name ?? thread.artifactId,
        body: thread.body,
        element: target.element,
        path: thread.path,
        quotedSelection: target.quote,
        threadId: thread.id,
        versionNumber: view?.versionNumbers.get(thread.versionId) ?? 0,
      };
    });
```

- `comment_list`:
  - output `items: z.array(commentThreadSchema.extend({target: commentTargetSchema}).strict()),`;
  - mapping `items: page.items.map((thread) => ({...commentThreadProjection(thread), target: commentTarget(thread)})),`;
  - append to its description: ` Each thread carries target: the quoted text and, for a comment on a page element, that element's tag, id, classes, selector, and path, when its anchor has them.`
- `agentInstructions`, after the `comment_list hides threads…` line:

```ts
    "comment_list gives each thread a target: quote is the text the reviewer selected and element names the page element (tag, id, classes, selector, path, nearby landmark and heading) a pinpoint comment is about; dispatch_inbox bundles print the same element lines. Use them to find what to change.",
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `timeout 900 "${DK}" "pnpm exec vitest run tests/conformance/mcp-022-agent-feedback.test.ts tests/conformance/cmt-012-comment-surface-parity.test.ts tests/conformance/brp-002-mailbox-inbox.test.ts tests/conformance/dsp-004-dispatched-thread-visibility.test.ts tests/conformance/dsp-011-bridge-bundle-render.test.ts tests/conformance/ndg-001-queued-work-nudge.test.ts tests/conformance/cmt-003-anchor-opacity.test.ts" > "${LOG}" 2>&1; echo "EXIT=$?"`
Expected: EXIT=0. BRP-002-B still matches the package render byte-for-byte: its threads carry no element context.

- [ ] **Step 7: Ledger, spec, docs**

Insert after MCP-021:

```yaml
  - id: MCP-022
    kind: behavior
    behavior: comment_list gives each thread a target derived from its anchor, the quoted text and the element context when the anchor carries them, and dispatch_inbox renders the same element as sanitized lines in each bundle item; unrecognized anchors yield no target and stay opaque to the server.
    owner: mcp
    source: {file: artifact-server-mcp-baseline.md, anchor: mcp-tools-and-resources}
    acceptance:
      behavior: {id: MCP-022-B, description: "List a thread whose anchor carries quoted text, a selector, and element context and receive that target; claim a dispatch of it and read the element, selector, path, and nearby lines in the rendered bundle."}
      failure: {id: MCP-022-F, description: "Whole-file, malformed, missing, and hostile anchors produce a null element or quote, bidirectional and invisible characters are stripped from rendered element lines, and every thread still lists and dispatches."}
    deployments: *all
    status: verified
    depends_on: [CMT-003, BRP-002]
```

In BRP-002, replace `proof_gap:` with: `The render mirror in src/mcp is pinned byte-for-byte against the package render for items without element context; element lines (MCP-022) are rendered only by the server mirror, because the package renders none. Drift in the shared part fails the test; the duplication itself is accepted and documented.`

In `project/spec/artifact-server-mcp-baseline.md`, append to the `comment_list` row: ` Each listed thread carries target (quote and element) derived from its anchor when recognizable.` Backtick the field names.

In `docs/agent-bridge-protocol.md` "Bundle rendering contract", change the template's item to:

```text
1. [{artifact name} · version {number} · {path}] "{quoted selection, when the anchor has one}"
   Element: <{tag}#{id}.{class}…> "{accessible name}"   (when the anchor carries element context)
   Selector: {selector}
   Path: {element path}
   Near: {landmark} · heading {heading}
   {thread body}
   (thread {threadId})
```

and add the rule: ``- Element lines appear only when the thread's anchor carries element context, and each line only when its field is present. Each value is sanitized, whitespace-collapsed, and bounded to 300 characters like a quoted selection. The `@plannotator/agent-bridge` renderer used by the Pi, OpenCode, and Claude channel bridges renders no element lines; the server's mailbox renderer does.``

In `docs/mcp.md`, after the `voice_say` paragraph, add: ``Each `comment_list` thread carries `target`: `quote`, the text the reviewer selected, and `element`, the page element a pinpoint comment names (tag, id, classes, selector, path, and nearby landmark and heading), when the anchor has them. `dispatch_inbox` prints the same element lines in each bundle item.``

In `skills/artifact-server/references/artifact-operations.md`, under "MCP reads", add: ``- `comment_list`: each thread's `target` gives the quoted text and the page element (selector, path, tag, id, classes) to change.``

- [ ] **Step 8: Gates**

Run the Task 1 Step 13 commands. Expected: EXIT=0 for each.

- [ ] **Step 9: Report to controller for commit**

Suggested message: `feat(mcp): give agents comment targets with element context`.

---

## Final gates (controller, once, after all tasks)

Each runs with its inputs unchanged since the last run. Use `git diff` to skip any whose inputs did not change.

```bash
timeout 1800 "${DK}" "pnpm test" > "${LOG}" 2>&1; echo "EXIT=$?"
timeout 900 "${DK}" "pnpm smoke" > "${LOG}" 2>&1; echo "EXIT=$?"
timeout 900 "${DK}" "pnpm typecheck" > "${LOG}" 2>&1; echo "EXIT=$?"
timeout 900 "${DK}" "pnpm lint" > "${LOG}" 2>&1; echo "EXIT=$?"
timeout 2400 "${DK}" "pnpm build && pnpm exec playwright test tests/browser/cmt-023-element-context.spec.ts tests/browser/review-sandbox.spec.ts tests/browser/frontend-mvp.spec.ts" > "${LOG}" 2>&1; echo "EXIT=$?"
cd /home/coder/workspace/local/artifact-server && timeout 300 docker run --rm -v "${PWD}":/w:ro -w /w ruby:3.3-alpine sh -c "ruby scripts/validate-conformance.rb project/spec/conformance.yml && ruby scripts/check-conformance-test-ids.rb"; echo "EXIT=$?"
```

On failure: `grep -m 20 -E -C 3 "FAIL|Error|✗" "${LOG}"`. Postgres paths (`pnpm test:external-storage-runtime`) run in CI's Full tier. One code review covers the whole branch at the end.

## Self-review

- **Scope coverage:**
  - Edit tool with all four operations, compare-and-swap, idempotency, bounds, BOM and line endings, blob reuse, change list, and HTTP route: Task 1.
  - Spec rewrite of EDT-001..003, MCP-006, and PUB-002, and the action-kind decision: Task 1.
  - Upload reuse with hostile proof: Task 2.
  - Warnings on commit (`new_artifact` and `new_version`) and edit, the shared CSP module, caps, and the regex `ponytail:` ceiling: Task 3.
  - `elementContext` through `buildPersistedHtmlAnchor`: Task 4.
  - Agent feedback through the existing bundle format, with one derivation function shared by both tools: Task 5.
- **Placeholder scan:** none.
- **Type consistency:**
  - `EditOperation`, `ArtifactEdit` (gains `warnings` in Task 3), `EditedFileChange`, `PublicationWarning`, `CommittedPublication`, `CommentTarget`, `CommentElement`, and `BundleItem.element` are each defined once and used under the same names.
  - `PublishBlobStorage.readBytes(blob: StoredBlob)` is used by `applyEditOperations` (`BlobReader` over `StoredBlob`) and `publicationWarnings` (`ManifestEntry`, a subtype).
  - `StagedUploadDependencies.blobs.open` (Task 2) and `PublishBlobStorage.readBytes` (Task 1) are distinct ports on distinct services.
