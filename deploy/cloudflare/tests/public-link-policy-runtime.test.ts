import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {z} from "zod";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {describe, expect, it} from "vitest";

const apiToken = "cloudflare-public-link-test-api-token-0001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";
const variable = "ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED";

const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({uploadUrl: z.url()}).loose()).length(1),
}).loose();
const failureSchema = z.object({
  error: z.object({code: z.string()}).loose(),
}).loose();
const notReadySchema = z.object({error: z.string()}).loose();
const sessionSchema = z.object({
  installation: z.object({publicLinksEnabled: z.boolean()}).loose(),
}).loose();

describe("Cloudflare Worker", () => {
  it("Worker public-link configuration: an invalid value fails initialization, and false refuses Public and reports it", async () => {
    const invalidDirectory = await mkdtemp(join(tmpdir(), "artifact-server-public-links-invalid-"));
    const invalid = await startWorker(invalidDirectory, {[variable]: "yes"});
    try {
      const session = await invalid.fetch(`${origin}/api/v1/session`, {headers: authorization()});
      expect(session.status).toBe(503);
      expect(notReadySchema.parse(await session.json()).error).toBe("artifact_server_not_ready");
    } finally {
      await invalid.stop();
      await rm(invalidDirectory, {force: true, recursive: true});
    }

    const directory = await mkdtemp(join(tmpdir(), "artifact-server-public-links-off-"));
    const worker = await startWorker(directory, {[variable]: false});
    try {
      const upload = await stageFile(worker, "<h1>Configured off</h1>");
      const commit = (accessSetting: string) => worker.fetch(upload.commitUrl, {
        body: JSON.stringify({
          target: {accessSetting, kind: "new_artifact", name: "Configured off"},
        }),
        headers: {
          ...authorization(),
          "Content-Type": "application/json",
          "Idempotency-Key": `cloudflare-public-links-${accessSetting}`,
        },
        method: "POST",
      });
      const refused = await commit("public_link");
      expect(refused.status).toBe(409);
      expect(failureSchema.parse(await refused.json()).error.code).toBe("PUBLIC_LINKS_DISABLED");
      expect((await commit("private")).status).toBe(201);
      const session = await worker.fetch(`${origin}/api/v1/session`, {headers: authorization()});
      expect(session.status).toBe(200);
      expect(sessionSchema.parse(await session.json()).installation.publicLinksEnabled).toBe(false);
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);
});

function authorization() {
  return {Authorization: `Bearer ${apiToken}`};
}

async function stageFile(worker: Unstable_DevWorker, source: string) {
  const bytes = new TextEncoder().encode(source);
  const response = await worker.fetch(`${origin}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: {...authorization(), "Content-Type": "application/json"},
    method: "POST",
  });
  expect(response.status).toBe(201);
  const plan = uploadPlanSchema.parse(await response.json());
  const uploaded = await Promise.all(plan.files.map((file) => worker.fetch(file.uploadUrl, {
    body: bytes,
    headers: authorization(),
    method: "PUT",
  })));
  expect(uploaded.map(({status}) => status)).toEqual([200]);
  return plan;
}

function startWorker(
  persistenceDirectory: string,
  variables: Record<string, string | boolean>,
): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    config: "wrangler.test.jsonc",
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-test-r2",
    }],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-public-link-test",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-public-link-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
      ...variables,
    },
  });
}
