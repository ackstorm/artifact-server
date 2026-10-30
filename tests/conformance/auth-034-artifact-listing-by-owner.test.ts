import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {admitMember, issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const keyCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
];

const listSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({name: z.string()}).loose()}).loose()),
});
const mcpListSchema = z.object({
  result: z.object({
    structuredContent: z.object({artifacts: z.array(z.object({name: z.string()}).loose())}),
  }).loose(),
}).loose();

function bearer(token: string) {
  return {Authorization: `Bearer ${token}`};
}

describe("artifact listing by owner", () => {
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

  test("AUTH-034-B: lists return the reader's own artifacts, and an administrator's also contain service-owned ones", async () => {
    const {adaKey, administratorKey, bobKey, serviceKey, cookies} = await setUp();
    await publish(adaKey, "Ada private", "private");
    await publish(adaKey, "Ada organization", "account_required");
    await publish(adaKey, "Ada public", "public_link");
    await publish(bobKey, "Bob private", "private");
    await publish(administratorKey, "Administrator own", "private");
    await publish(serviceKey, "Service report", "public_link");

    const adaNames = ["Ada organization", "Ada private", "Ada public"];
    expect(await listNames(bearer(adaKey))).toEqual(adaNames);
    expect(await listNames(bearer(adaKey), "?search=Ada")).toEqual(adaNames);
    expect(await mcpListNames(adaKey)).toEqual(adaNames);
    expect(await listNames(bearer(bobKey))).toEqual(["Bob private"]);
    expect(await listNames({Cookie: cookies.header})).toEqual(["Administrator own", "Service report"]);
  });

  test("AUTH-034-F: another member's Organization and Public artifacts never appear in lists or search results", async () => {
    const {adaKey, bobKey, cookies} = await setUp();
    const organization = await publish(adaKey, "Ada quarterly plan", "account_required");
    await publish(adaKey, "Ada public notes", "public_link");
    const tagged = await fetch(`${server.baseUrl}/api/v1/artifacts/${organization.artifact.id}/tags`, {
      body: JSON.stringify({
        expectedCurrentVersionId: organization.version.id,
        tags: ["ada-only"],
      }),
      headers: {
        Authorization: `Bearer ${adaKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "auth-034-ada-tag",
      },
      method: "PATCH",
    });
    expect(tagged.status).toBe(200);
    expect(await listNames(bearer(adaKey), "?tag=ada-only")).toEqual(["Ada quarterly plan"]);

    expect(await listNames(bearer(bobKey), "?search=quarterly")).toEqual([]);
    expect(await listNames(bearer(bobKey), "?search=Ada")).toEqual([]);
    expect(await listNames(bearer(bobKey), "?tag=ada-only")).toEqual([]);
    expect(await listNames(bearer(bobKey), "?sort=comments")).toEqual([]);
    expect(await mcpListNames(bobKey, "ada-only")).toEqual([]);
    expect(await mcpListNames(bobKey)).toEqual([]);
    expect(await listNames({Cookie: cookies.header})).toEqual([]);
  });

  async function setUp() {
    const cookies = await signInAdministrator(server, installation);
    const session = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    const administratorId = z.object({principal: z.object({id: z.string()})})
      .parse(await session.json()).principal.id;
    const [adaId, bobId] = [
      await admitMember(server, cookies, "Ada", "ada@example.test"),
      await admitMember(server, cookies, "Bob", "bob@example.test"),
    ];
    return {
      adaKey: await issueApiKey(server, cookies, keyCapabilities, "Ada's agent", adaId),
      administratorKey: await issueApiKey(
        server,
        cookies,
        keyCapabilities,
        "Administrator's agent",
        administratorId,
      ),
      bobKey: await issueApiKey(server, cookies, keyCapabilities, "Bob's agent", bobId),
      cookies,
      serviceKey: await issueApiKey(server, cookies, keyCapabilities, "Release bot"),
    };
  }

  async function publish(
    token: string,
    name: string,
    accessSetting: "private" | "account_required" | "public_link",
  ) {
    const {body} = await publishNew(server, {...installation, apiToken: token}, {
      accessSetting,
      content: `<!doctype html><title>${name}</title>`,
      idempotencyKey: `auth-034-${name}`,
      name,
    });
    return body;
  }

  async function listNames(
    headers: Readonly<Record<string, string>>,
    query = "",
  ): Promise<string[]> {
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts${query}`, {headers});
    expect(response.status).toBe(200);
    return listSchema.parse(await response.json()).artifacts
      .map(({artifact}) => artifact.name).toSorted();
  }

  async function mcpListNames(token: string, tag?: string): Promise<string[]> {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: tag === undefined ? {} : {tag},
          name: "artifact_list",
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "artifact_list",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    return mcpListSchema.parse(await response.json()).result.structuredContent.artifacts
      .map(({name}) => name).toSorted();
  }
});
