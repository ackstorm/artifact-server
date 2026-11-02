import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {admitMember, callMcp, issueApiKey} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  type RunningStubOidcProvider,
  signInWithStubOidc,
  startStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const administratorEmail = "administrator@example.test";
const clientSecret = "stub-oidc-client-secret-with-entropy";
const projectId = "prj_default";
const memberKeyCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
  "content-session:issue",
];

const pageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string(), name: z.string()}).loose(),
    pinned: z.boolean(),
  })),
  nextCursor: z.string().nullable(),
});

interface Cookies {
  readonly csrf: string;
  readonly header: string;
}

describe("catalog pins and filters", () => {
  let installation: TestInstallation;
  let oidc: RunningStubOidcProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    oidc = await startStubOidcProvider({
      clientId: "artifact-server-art-014",
      clientSecret,
    });
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: createOidcIdentityProvider({
        applicationOrigin,
        clientId: oidc.clientId,
        clientSecret: Redacted.make(clientSecret, {label: "oidc-client-secret"}),
        issuer: oidc.issuer,
        scopes: "openid email profile",
      }),
      port,
    });
  });

  afterEach(async () => {
    await server.stop();
    await oidc.stop();
    await removeTestInstallation(installation);
  });

  test("ART-014-F: pins are per principal and need read authority, pages hold across the pinned boundary, and unknown cursors and levels are refused", async () => {
    const administrator = await signIn(administratorEmail, "administrator");
    const adaId = await admitMember(server, administrator, "Ada", "ada@example.test");
    await admitMember(server, administrator, "Bob", "bob@example.test");
    const ada = await signIn("ada@example.test", "ada");
    const bob = await signIn("bob@example.test", "bob");
    const adaKey = await issueApiKey(
      server, administrator, memberKeyCapabilities, "Ada's agent", adaId,
    );

    const ids = new Map<string, string>();
    for (const name of ["A1", "A2", "A3", "A4"]) {
      // eslint-disable-next-line no-await-in-loop
      const published = await publishNew(server, {...installation, apiToken: adaKey}, {
        accessSetting: name === "A2" ? "account_required" : "private",
        content: `<!doctype html><title>${name}</title>`,
        idempotencyKey: `art-014-publish-${name}`,
        name,
        projectId,
      });
      ids.set(name, published.body.artifact.id);
    }
    const idOf = (name: string) => ids.get(name) ?? "";
    const pinPath = (name: string) => `/api/v1/artifacts/${idOf(name)}/pin`;

    expect((await mutate("PUT", pinPath("A1"), ada)).status).toBe(204);
    expect((await mutate("PUT", pinPath("A3"), ada)).status).toBe(204);
    expect((await mutate("PUT", pinPath("A3"), ada)).status).toBe(204);

    const pinnedFirst = ["A3", "A1", "A4", "A2"];
    expect(await names(ada, "")).toEqual(pinnedFirst);
    expect((await list(ada, "")).artifacts.map(({pinned}) => pinned))
      .toEqual([true, true, false, false]);
    expect(await walk(ada, "sort=newest&limit=1")).toEqual(pinnedFirst);
    expect(await walk(ada, "sort=comments&limit=1")).toEqual(pinnedFirst);

    expect(await names(ada, "pinned=only")).toEqual(["A3", "A1"]);
    expect(await names(ada, "access=account_required")).toEqual(["A2"]);
    expect(await names(ada, "access=private&access=account_required")).toHaveLength(4);
    expect((await get(ada, "/api/v1/artifacts?access=secret")).status).toBe(422);

    expect((await mutate("PUT", pinPath("A1"), bob)).status).toBe(404);
    expect((await mutate("PUT", pinPath("A2"), bob)).status).toBe(204);
    expect(await names(bob, "")).toEqual([]);
    const adaView = (await list(ada, "")).artifacts;
    expect(adaView.find(({artifact}) => artifact.name === "A2")?.pinned).toBe(false);

    expect((await mutate("DELETE", pinPath("A1"), ada)).status).toBe(204);
    expect((await mutate("DELETE", pinPath("A1"), ada)).status).toBe(204);
    expect(await names(ada, "pinned=only")).toEqual(["A3"]);

    const withoutCsrf = await fetch(`${server.baseUrl}${pinPath("A1")}`, {
      headers: new Headers({
        Cookie: ada.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      }),
      method: "PUT",
    });
    expect(withoutCsrf.status).toBe(403);
    expect((await fetch(`${server.baseUrl}${pinPath("A1")}`, {method: "PUT"})).status).toBe(401);

    const withoutGroup = Buffer.from(JSON.stringify({
      createdAt: "2026-11-02T00:00:00.000Z",
      id: idOf("A1"),
    })).toString("base64url");
    const staleCursor = await get(ada, `/api/v1/artifacts?cursor=${withoutGroup}`);
    expect(staleCursor.status).toBe(422);
    expect(await staleCursor.text()).toContain("INVALID_INPUT");
    const newestCursor = (await list(ada, "sort=newest&limit=1")).nextCursor ?? "";
    expect((await get(ada, `/api/v1/artifacts?sort=comments&cursor=${newestCursor}`)).status)
      .toBe(422);

    await mutate("PUT", pinPath("A1"), ada);
    const mcpNames: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const reply = await callMcp(server, adaKey, "tools/call", "artifact_list", {
        arguments: {cursor, limit: 1},
        name: "artifact_list",
      });
      const body = z.object({
        artifacts: z.array(z.object({name: z.string()})),
        nextCursor: z.string().nullable(),
      }).parse(reply.result?.structuredContent);
      mcpNames.push(...body.artifacts.map(({name}) => name));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(mcpNames).toEqual(["A3", "A1", "A4", "A2"]);
  });

  function signIn(email: string, subject: string): Promise<Cookies> {
    return signInWithStubOidc(server.baseUrl, oidc, email, `art-014-${subject}`);
  }

  function get(cookies: Cookies, pathname: string): Promise<Response> {
    return fetch(`${server.baseUrl}${pathname}`, {headers: {Cookie: cookies.header}});
  }

  function mutate(method: "DELETE" | "PUT", pathname: string, cookies: Cookies): Promise<Response> {
    return fetch(`${server.baseUrl}${pathname}`, {
      headers: new Headers({
        Cookie: cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": cookies.csrf,
      }),
      method,
    });
  }

  async function list(cookies: Cookies, query: string) {
    const response = await get(cookies, `/api/v1/artifacts?${query}`);
    expect(response.status).toBe(200);
    return pageSchema.parse(JSON.parse(await response.text()));
  }

  async function names(cookies: Cookies, query: string): Promise<string[]> {
    return (await list(cookies, query)).artifacts.map(({artifact}) => artifact.name);
  }

  async function walk(cookies: Cookies, query: string): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await list(cookies, cursor === null ? query : `${query}&cursor=${cursor}`);
      seen.push(...result.artifacts.map(({artifact}) => artifact.name));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    return seen;
  }
});
