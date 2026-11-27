import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {ApiClient, callMcp, mcpFailed, type McpReply} from "../support/agent-dispatch.js";
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const pageSchema = z.object({
  items: z.array(z.object({id: z.string(), target: z.object({embed: z.json().nullable()}).loose()}).loose()),
}).loose();
const detailsSchema = z.object({thread: z.object({target: z.object({embed: z.json().nullable()}).loose()}).loose()}).loose();
const createdSchema = z.object({thread: z.object({id: z.string()}).loose()}).loose();
type ToolArguments = NonNullable<Parameters<typeof callMcp>[4]["arguments"]>;

const encoder = new TextEncoder();
const file = (path: string, text: string, mediaType: string): TestSiteFile =>
  ({bytes: encoder.encode(text), mediaType, path});
const anchorWith = (tag: string, annotate: string) => ({
  elementContext: {attrs: [["data-annotate", annotate]], tag},
  htmlAnchor: {selector: `${tag}[data-annotate="${annotate}"]`, tagName: tag},
  originalText: "",
});

describe("agent surface for embedded tables and diagrams", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    const files = [
      file("index.html", "<!doctype html><as-embed src=\"data/sales.csv\"></as-embed><script src=\"/.artifactserver/embed.js\"></script>", "text/html; charset=utf-8"),
      file("data/sales.csv", "Region,Q1\nNorth,1\n", "text/csv; charset=utf-8"),
      file("flow.mmd", "flowchart LR\n  a --> b\n", "text/plain; charset=utf-8"),
    ];
    const upload = await createStagedUpload(server, installation, "index.html", files);
    await uploadEveryStagedFile(installation, upload.body, files);
    published = (await commitStagedUpload(installation, upload.body, "emb-007-publish-site", {
      accessSetting: "private",
      kind: "new_artifact",
      name: "Agent embeds",
    })).body;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function openThread(path: string | null, anchor: ToolArguments[string], idempotencyKey: string): Promise<string> {
    const payload = path === null ? {anchor, body: idempotencyKey} : {anchor, body: idempotencyKey, path};
    const response = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments?projectId=${published.artifact.projectId}`,
      {body: JSON.stringify(payload), idempotencyKey, method: "POST"},
    );
    expect(response.status).toBe(201);
    return createdSchema.parse(await response.json()).thread.id;
  }

  async function callTool(name: string, toolArguments: ToolArguments) {
    const reply: McpReply = await callMcp(server, installation.apiToken, "tools/call", name, {arguments: toolArguments, name});
    expect(mcpFailed(reply)).toBe(false);
    return reply.result?.structuredContent;
  }

  async function embeds(): Promise<ReadonlyMap<string, unknown>> {
    const page = pageSchema.parse(await callTool("comment_list", {artifactId: published.artifact.id}));
    return new Map(page.items.map((item) => [item.id, item.target.embed]));
  }

  test("EMB-007-B: comment targets name the embedded table cell or diagram element", async () => {
    const cell = await openThread("data/sales.csv", anchorWith("td", "data/sales.csv#B2"), "emb-007-b-thread-cell");
    const element = await openThread("flow.mmd", anchorWith("g", "flow.mmd#flowchart-a-0"), "emb-007-b-thread-node");
    const diagram = await openThread("flow.mmd", anchorWith("svg", "flow.mmd#"), "emb-007-b-thread-diagram");
    const listed = await embeds();
    expect(listed.get(cell)).toEqual({cell: "B2", src: "data/sales.csv"});
    expect(listed.get(element)).toEqual({element: "flowchart-a-0", src: "flow.mmd"});
    expect(listed.get(diagram)).toEqual({src: "flow.mmd"});
    expect(detailsSchema.parse(await callTool("comment_get", {artifactId: published.artifact.id, threadId: cell})).thread.target.embed)
      .toEqual({cell: "B2", src: "data/sales.csv"});

    const edited = z.object({version: z.object({id: z.string()}).loose()}).loose().parse(await callTool("artifact_edit", {
      artifactId: published.artifact.id,
      expectedCurrentVersionId: published.version.id,
      idempotencyKey: "emb-007-b-edit-diagram",
      operations: [{kind: "write", path: "steps.mmd", text: "flowchart TD\n  a --> b\n"}],
    }));
    const read = z.object({mediaType: z.string()}).loose().parse(await callTool("artifact_read_file", {
      artifactId: published.artifact.id,
      path: "steps.mmd",
      versionId: edited.version.id,
    }));
    expect(read.mediaType).toBe("text/plain; charset=utf-8");
  });

  test("EMB-007-F: routing values naming another path, malformed or without a cell, or on a pathless thread give no embed", async () => {
    const forged = await openThread("index.html", anchorWith("p", "data/sales.csv#B2"), "emb-007-f-thread-forged");
    const malformed = await openThread("data/sales.csv", anchorWith("td", "data/sales.csv#%E0%A4%A"), "emb-007-f-thread-bad-escape");
    const bare = await openThread("data/sales.csv", anchorWith("td", "data/sales.csv"), "emb-007-f-thread-no-separator");
    const notACell = await openThread("data/sales.csv", anchorWith("td", "data/sales.csv#not-a-cell"), "emb-007-f-thread-not-a-cell");
    const pathless = await openThread(null, anchorWith("td", "data/sales.csv#B2"), "emb-007-f-thread-pathless");
    const listed = await embeds();
    for (const threadId of [forged, malformed, bare, notACell, pathless]) {
      expect(listed.has(threadId)).toBe(true);
      expect(listed.get(threadId)).toBeNull();
    }
  });
});
