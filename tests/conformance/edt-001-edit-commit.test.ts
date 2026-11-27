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

function mcpErrorText(reply: McpReply): string {
  return z.object({content: z.array(z.object({text: z.string()}).loose())}).loose()
    .parse(reply.result).content.map((part) => part.text).join("\n");
}

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
    expect(first.changes.toSorted((left, right) => left.path.localeCompare(right.path))).toEqual([
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
      {code: "INVALID_INPUT", message: /occurs more than once in notes\.md/u, operations: [{edits: [{newText: "x", oldText: "line"}], kind: "replace", path: "notes.md"}]},
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

    const tooManyOperations = await callTool("artifact_edit", {
      artifactId,
      expectedCurrentVersionId: moved.version.id,
      idempotencyKey: "edt-f-operations-cap",
      operations: [...Array(201).keys()].map((index) => ({kind: "write", path: `n${index}.txt`, text: ""})),
    });
    expect(mcpFailed(tooManyOperations)).toBe(true);
    expect(mcpErrorText(tooManyOperations)).toMatch(/operations: .*<=200 items/u);
    const tooManyEdits = await callTool("artifact_edit", {
      artifactId,
      expectedCurrentVersionId: moved.version.id,
      idempotencyKey: "edt-f-edits-cap-0001",
      operations: [{
        edits: [...Array(101).keys()].map(() => ({newText: "x", oldText: "one"})),
        kind: "replace",
        path: "plain.txt",
      }],
    });
    expect(mcpFailed(tooManyEdits)).toBe(true);
    expect(mcpErrorText(tooManyEdits)).toMatch(/edits: .*<=100 items/u);
    const afterCaps = versionListSchema.parse(
      (await callTool("artifact_version_list", {artifactId})).result?.structuredContent,
    );
    expect(afterCaps.versions.map((version) => version.id)).toEqual([moved.version.id, base]);

    const crowded = await publishSite("edt-f-crowded-publish");
    const current = await [...Array(49).keys()].reduce(async (previous, batch) => {
      const expectedCurrentVersionId = await previous;
      return editResult(await callTool("artifact_edit", {
        artifactId: crowded.artifact.id,
        expectedCurrentVersionId,
        idempotencyKey: `edt-f-crowd-batch-${String(batch).padStart(4, "0")}`,
        operations: [...Array(200).keys()].map((index) => ({kind: "write", path: `f${batch}/${index}.txt`, text: ""})),
      })).version.id;
    }, Promise.resolve(crowded.version.id));
    const overCount = await callTool("artifact_edit", {
      artifactId: crowded.artifact.id,
      expectedCurrentVersionId: current,
      idempotencyKey: "edt-f-crowd-overflow1",
      operations: [...Array(200).keys()].map((index) => ({kind: "write", path: `over/${index}.txt`, text: ""})),
    });
    expect(mcpToolErrorCode(overCount)).toBe("INVALID_INPUT");
    expect(JSON.stringify(overCount.result?.structuredContent)).toMatch(/at most 10000/u);
  }, 120_000);
});
