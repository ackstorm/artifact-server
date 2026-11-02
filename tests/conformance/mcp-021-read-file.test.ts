import {createHash} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {callMcp, mcpFailed, mcpToolErrorCode, type McpReply} from "../support/agent-dispatch.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const readResultSchema = z.object({
  artifactId: z.string(),
  content: z.string().optional(),
  downloadExpiresAt: z.string().optional(),
  downloadUrl: z.url().optional(),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
  versionId: z.string(),
}).strict();

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

describe("artifact_read_file", () => {
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

  function readFile(
    parameters: Readonly<Record<string, string>>,
  ): Promise<McpReply> {
    return callMcp(server, installation.apiToken, "tools/call", "artifact_read_file", {
      arguments: parameters,
      name: "artifact_read_file",
    });
  }

  function parsed(reply: McpReply) {
    expect(mcpFailed(reply)).toBe(false);
    return readResultSchema.parse(reply.result?.structuredContent);
  }

  test("MCP-021-B: text comes back inline from the exact version and other files come back as a credential-free download URL", async () => {
    const page = "<!doctype html><title>Version one</title>";
    const first = await publishNew(server, installation, {
      accessSetting: "private",
      content: page,
      idempotencyKey: "mcp-021-read-file-v1",
    });
    const artifactId = first.body.artifact.id;
    await publishVersion(server, installation, {
      artifactId,
      content: "<!doctype html><title>Version two</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "mcp-021-read-file-v2",
    });

    const current = parsed(await readFile({artifactId}));
    expect(current.path).toBe("index.html");
    expect(current.content).toContain("Version two");
    expect(current.downloadUrl).toBeUndefined();

    const exact = parsed(await readFile({artifactId, versionId: first.body.version.id}));
    expect(exact).toStrictEqual({
      artifactId,
      content: page,
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
      sha256: sha256(page),
      size: page.length,
      versionId: first.body.version.id,
    });

    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
    const drawing = await publishNew(server, installation, {
      accessSetting: "private",
      content: svg,
      idempotencyKey: "mcp-021-read-file-svg",
      mediaType: "image/svg+xml",
      path: "chart.svg",
    });
    expect(parsed(await readFile({artifactId: drawing.body.artifact.id})).content).toBe(svg);

    const binary = "\u0000PNG not really";
    const image = await publishNew(server, installation, {
      accessSetting: "private",
      content: binary,
      idempotencyKey: "mcp-021-read-file-binary",
      mediaType: "image/png",
      path: "chart.png",
    });
    const download = parsed(await readFile({artifactId: image.body.artifact.id}));
    expect(download.content).toBeUndefined();
    expect(download.sha256).toBe(sha256(binary));
    if (download.downloadUrl === undefined || download.downloadExpiresAt === undefined) {
      throw new Error("artifact_read_file returned no download URL for a binary file.");
    }
    expect(new URL(download.downloadUrl).pathname).toBe("/chart.png");
    expect(Date.parse(download.downloadExpiresAt)).toBeGreaterThan(Date.now());

    await server.stop();
    server = await startTestServer(installation);
    const fetched = await fetchVersion(server, download.downloadUrl);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("set-cookie")).toBeNull();
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetched.headers.get("cache-control")).toBe("private, no-store");
    expect(sha256(await fetched.text())).toBe(download.sha256);
  });

  test("MCP-021-F: a missing file, an unknown version or artifact, and a caller without read access get no bytes and no URL", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "private",
      content: "<!doctype html><title>Private</title>",
      idempotencyKey: "mcp-021-read-file-private",
    });
    const artifactId = published.body.artifact.id;

    for (const reply of [
      await readFile({artifactId, path: "../index.html"}),
      await readFile({artifactId, path: "missing.css"}),
      await readFile({artifactId, versionId: "ver_unknown"}),
      await readFile({artifactId: "art_unknown"}),
    ]) {
      expect(mcpFailed(reply)).toBe(true);
      expect(mcpToolErrorCode(reply)).toMatch(/NOT_FOUND$/u);
      expect(JSON.stringify(reply)).not.toContain("<title>Private</title>");
    }

    const anonymous = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {arguments: {artifactId}, name: "artifact_read_file"},
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(anonymous.status).toBe(401);
  });
});
