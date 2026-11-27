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

    const started = performance.now();
    const pathological = await commitSite([
      textFile("index.html", "<a ".repeat(349_525), "text/html"),
      textFile("notes.md", "[".repeat(1_048_576), "text/markdown"),
    ], "pub-016-f-commit-pathological");
    expect(pathological.warnings).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);

    const relStarted = performance.now();
    const unclosedRel = await commitSite([
      textFile("index.html", `<link rel="${"stylesheet ".repeat(95_325)}>`, "text/html"),
    ], "pub-016-f-commit-unclosed-rel");
    expect(unclosedRel.warnings).toEqual([]);
    expect(performance.now() - relStarted).toBeLessThan(2_000);
  });
});
