import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const revalidated = "no-cache";
const immutable = "public, max-age=31536000, immutable";
const runtimeFiles = [
  ["embed.js", "document.documentElement.dataset.embedRuntime = \"loaded\";\n", revalidated],
  ["table.js", "export {};\n", revalidated],
  ["chunks/B2J2w5EN.js", "export const shared = 1;\n", immutable],
] as const;
const leaseSchema = z.object({baseUrl: z.url()}).loose();
const errorSchema = z.object({error: z.object({code: z.string()}).loose()}).loose();
const encoder = new TextEncoder();
const site: readonly TestSiteFile[] = [
  {bytes: encoder.encode("<!doctype html><h1>Runtime</h1>\n"), mediaType: "text/html; charset=utf-8", path: "index.html"},
];

describe("embed runtime assets", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let webRoot: string;

  beforeEach(async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), "emb-001-web-"));
    await Promise.all(runtimeFiles.map(async ([file, text]) => {
      const target = path.join(webRoot, "embed", file);
      await mkdir(path.dirname(target), {recursive: true});
      await writeFile(target, text);
    }));
    installation = await createTestInstallation();
    server = await startTestServer(installation, {webAssetsRoot: webRoot});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(webRoot, {force: true, recursive: true});
  });

  async function publishWithLease(idempotencyKey: string): Promise<{published: PublishResponse; leaseBaseUrl: string}> {
    const upload = await createStagedUpload(server, installation, "index.html", site);
    expect((await uploadEveryStagedFile(installation, upload.body, site)).every((response) => response.ok)).toBe(true);
    const published = (await commitStagedUpload(installation, upload.body, idempotencyKey, {
      accessSetting: "private",
      kind: "new_artifact",
      name: "Runtime host",
    })).body;
    const lease = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/preview-leases?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(lease.status).toBe(201);
    return {leaseBaseUrl: leaseSchema.parse(await lease.json()).baseUrl, published};
  }

  test("EMB-001-B: version and preview-lease hosts serve the embed runtime under /.artifactserver/ with CORS, nosniff, revalidated entries, and immutable chunks", async () => {
    const {leaseBaseUrl, published} = await publishWithLease("emb-001-b-publish-site");
    const hosts = [published.links.version, leaseBaseUrl];
    const served = await Promise.all(hosts.flatMap((host) => runtimeFiles.map(async ([file, text, caching]) => {
      const response = await fetchVersion(server, new URL(`/.artifactserver/${file}`, host).toString());
      return {
        actual: [response.status, await response.text(), response.headers.get("content-type"), response.headers.get("access-control-allow-origin"), response.headers.get("cross-origin-resource-policy"), response.headers.get("x-content-type-options"), response.headers.get("cache-control")],
        expected: [200, text, "text/javascript; charset=utf-8", "*", "cross-origin", "nosniff", caching],
        label: `${host} ${file}`,
      };
    })));
    expect(served.map(({actual, label}) => [label, actual])).toEqual(served.map(({expected, label}) => [label, expected]));
    const revalidations = await Promise.all(hosts.map(async (host) => {
      const script = new URL("/.artifactserver/embed.js", host).toString();
      const head = await fetchVersion(server, script, "HEAD");
      const etag = head.headers.get("etag") ?? "";
      return [head.status, etag === "", (await fetchVersion(server, script, "GET", {"If-None-Match": etag})).status];
    }));
    expect(revalidations).toEqual(hosts.map(() => [200, false, 304]));
  });

  test("EMB-001-F: the reserved path serves only runtime files, nothing on live hosts, and no manifest can claim it", async () => {
    const {leaseBaseUrl, published} = await publishWithLease("emb-001-f-publish-site");
    const liveHost = `http://live-emb001fixture0001.localhost:${server.port}/`;
    const probes = [
      ...[published.links.version, leaseBaseUrl].flatMap((host) => [
        "/.artifactserver/index.html",
        "/.artifactserver/missing.js",
        "/.artifactserver/",
        "/.artifactserver/chunks/..%2fembed.js",
      ].map((probe) => new URL(probe, host).toString())),
      ...runtimeFiles.map(([file]) => new URL(`/.artifactserver/${file}`, liveHost).toString()),
    ];
    const statuses = await Promise.all(probes.map(async (probe) => [probe, (await fetchVersion(server, probe)).status]));
    expect(statuses).toEqual(probes.map((probe) => [probe, 404]));
    const writes = await Promise.all([published.links.version, leaseBaseUrl].map(async (host) => {
      const write = await fetchVersion(server, new URL("/.artifactserver/embed.js", host).toString(), "POST");
      return [write.status, write.headers.get("allow")];
    }));
    expect(writes).toEqual([[405, "GET, HEAD"], [405, "GET, HEAD"]]);
    const claimed = [
      ...site,
      {bytes: encoder.encode("alert(1);\n"), mediaType: "text/javascript", path: ".artifactserver/embed.js"},
    ];
    const response = await fetch(`${server.baseUrl}/api/v1/uploads`, {
      body: JSON.stringify({
        entryPath: "index.html",
        files: claimed.map((file) => ({
          mediaType: file.mediaType,
          path: file.path,
          sha256: "0".repeat(64),
          size: file.bytes.byteLength,
        })),
        routingMode: "static",
      }),
      headers: {Authorization: `Bearer ${installation.apiToken}`, "Content-Type": "application/json"},
      method: "POST",
    });
    expect(response.status).toBe(422);
    expect(errorSchema.parse(await response.json()).error.code).toBe("INVALID_MANIFEST_PATH");
  });
});
