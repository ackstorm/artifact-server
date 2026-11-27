import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {callMcp, mcpFailed} from "../support/agent-dispatch.js";
import {createStagedUpload, type TestSiteFile, uploadEveryStagedFile} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const warningSchema = z.object({
  code: z.enum(["blocked_host", "diagram_refused", "embed_runtime_missing", "missing_reference"]),
  path: z.string(),
  reference: z.string(),
}).strict();
const warnedSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  version: z.object({id: z.string()}).loose(),
  warnings: z.array(warningSchema),
}).loose();
type Warning = z.infer<typeof warningSchema>;

const encoder = new TextEncoder();
const file = (path: string, text: string, mediaType: string): TestSiteFile =>
  ({bytes: encoder.encode(text), mediaType, path});
const sorted = (warnings: readonly Warning[]) =>
  warnings.toSorted((left, right) =>
    left.path.localeCompare(right.path) || left.reference.localeCompare(right.reference));

const page = [
  "<!doctype html><main>",
  "<as-embed src=\"data/sales.csv\" title=\"Sales\"></as-embed>",
  "<as-embed src=\"data/missing.csv\"></as-embed>",
  "<script src=\"/.artifactserver/embed.js\"></script>",
  "</main>",
].join("\n");
const refusedConstruct = (construct: string) =>
  `Diagram configuration and interactive styling are disabled in preview: ${construct}.`;
const notes = [
  "# Notes",
  "",
  "```mermaid",
  "flowchart LR",
  "  a --> b",
  "  style a fill:#f00",
  "```",
  "",
  "````js",
  "```mermaid",
  "click a call alert(1)",
  "````",
].join("\n");

describe("embed publication warnings", () => {
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
    expect((await uploadEveryStagedFile(installation, upload.body, files)).every((response) => response.ok)).toBe(true);
    const response = await fetch(upload.body.commitUrl, {
      body: JSON.stringify({target: {accessSetting: "private", kind: "new_artifact", name: "Embed warnings"}}),
      headers: apiHeaders(installation, idempotencyKey),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return warnedSchema.parse(await response.json());
  }

  test("EMB-003-B: commits and edits warn on refused diagrams, missing embeds, and pages without the runtime, never on the runtime path", async () => {
    const committed = await commitSite([
      file("index.html", page, "text/html; charset=utf-8"),
      file("extra.html", "<!doctype html><as-embed src=\"flow.mmd\"></as-embed>", "text/html; charset=utf-8"),
      file("flow.mmd", "flowchart LR\n  a --> b\n", "text/plain; charset=utf-8"),
      file("refused.mmd", "flowchart LR\n  a --> b\n  click a call alert(1)\n", "text/plain; charset=utf-8"),
      file("notes.md", notes, "text/markdown; charset=utf-8"),
      file("data/sales.csv", "Region,Q1\nNorth,120\n", "text/csv"),
    ], "emb-003-b-commit-site");
    expect(sorted(committed.warnings)).toEqual([
      {code: "embed_runtime_missing", path: "extra.html", reference: "/.artifactserver/embed.js"},
      {code: "missing_reference", path: "index.html", reference: "data/missing.csv"},
      {code: "diagram_refused", path: "notes.md", reference: `line 3: ${refusedConstruct("style")}`},
      {code: "diagram_refused", path: "refused.mmd", reference: refusedConstruct("click")},
    ]);

    const reply = await callMcp(server, installation.apiToken, "tools/call", "artifact_edit", {
      arguments: {
        artifactId: committed.artifact.id,
        expectedCurrentVersionId: committed.version.id,
        idempotencyKey: "emb-003-b-edit-adds-runtime",
        operations: [
          {kind: "write", path: "extra.html", text: "<!doctype html><as-embed src=\"flow.mmd\"></as-embed><script src=\"/.artifactserver/embed.js\"></script>"},
        ],
      },
      name: "artifact_edit",
    });
    expect(mcpFailed(reply)).toBe(false);
    expect(sorted(warnedSchema.parse(reply.result?.structuredContent).warnings)).toEqual([
      {code: "missing_reference", path: "index.html", reference: "data/missing.csv"},
      {code: "diagram_refused", path: "notes.md", reference: `line 3: ${refusedConstruct("style")}`},
      {code: "diagram_refused", path: "refused.mmd", reference: refusedConstruct("click")},
    ]);
  });

  test("EMB-003-F: refusal-heavy and scanner-hostile files still commit with capped warnings in bounded time", async () => {
    const started = performance.now();
    const refusedFences = "```mermaid\nclick a call alert(1)\n```\n".repeat(60);
    const capped = await commitSite([
      file("index.html", "<!doctype html><h1>Refusals</h1>", "text/html"),
      file("refusals.md", refusedFences, "text/markdown"),
    ], "emb-003-f-commit-refusals");
    expect(capped.warnings).toHaveLength(50);
    expect(capped.warnings.every((warning) => warning.code === "diagram_refused")).toBe(true);

    // Each source repeats what a backtracking scanner would rescan from every position.
    const fences = `${"```mermaid\n  a --> b\n```\n".repeat(10_000)}\`\`\`mermaid\nclassDef x fill:#f00\n\`\`\`\n${"`".repeat(500_000)}\u2028`;
    const scanned = await commitSite([
      file("index.html", "<!doctype html><h1>Scanners</h1>", "text/html"),
      file("newlines.mmd", `${"\n".repeat(19_999)}x`, "text/plain"),
      file("semicolons.mmd", `${"; \n".repeat(6_666)}x`, "text/plain"),
      file("percent.mmd", `%%${" ".repeat(19_990)}x`, "text/plain"),
      file("fences.md", fences, "text/markdown"),
    ], "emb-003-f-commit-scanners");
    expect(scanned.warnings).toEqual([
      {code: "diagram_refused", path: "fences.md", reference: `line 30001: ${refusedConstruct("classDef")}`},
    ]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
