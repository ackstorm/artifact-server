import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {admitMember, ApiClient, issueApiKey} from "../support/agent-dispatch.js";
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

const principalsSchema = z.object({principals: z.record(z.string(), z.string())});

interface Cookies {
  readonly csrf: string;
  readonly header: string;
}

describe("attribution names in artifact responses", () => {
  let installation: TestInstallation;
  let oidc: RunningStubOidcProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    oidc = await startStubOidcProvider({
      clientId: "artifact-server-art-013",
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

  test("ART-013-F: responses name only principals recorded on artifacts the reader can read, and never their emails", async () => {
    const administrator = await signIn(administratorEmail, "administrator");
    const adaId = await admitMember(server, administrator, "Ada", "ada@example.test");
    const bobId = await admitMember(server, administrator, "Bob", "bob@example.test");
    const bob = await signIn("bob@example.test", "bob");
    const [adaKey, bobKey, serviceKey] = await Promise.all([
      issueApiKey(server, administrator, memberKeyCapabilities, "Ada's agent", adaId),
      issueApiKey(server, administrator, memberKeyCapabilities, "Bob's agent", bobId),
      issueApiKey(server, administrator, ["artifact:create", "artifact:read"], "CI deploy"),
    ]);

    const publish = (token: string, name: string, accessSetting: "account_required" | "private") =>
      publishNew(server, {...installation, apiToken: token}, {
        accessSetting,
        content: `<!doctype html><title>${name}</title>`,
        idempotencyKey: `art-013-publish-${name}`,
        name,
        projectId,
      });
    const shared = await publish(adaKey, "shared", "account_required");
    const hidden = await publish(adaKey, "hidden", "private");
    const service = await publish(serviceKey, "service", "account_required");
    await new ApiClient(server, bobKey).openThread(shared.body, "Bob was here.", "art-013-bob-thread");
    const sharedId = shared.body.artifact.id;
    const hiddenId = hidden.body.artifact.id;

    const named = async (cookies: Cookies, pathname: string) => {
      const response = await get(cookies, pathname);
      expect(response.status).toBe(200);
      return principalsSchema.parse(JSON.parse(await response.text())).principals;
    };

    const ada = {[adaId]: "Ada"};
    expect(await named(bob, `/api/v1/artifacts/${sharedId}`)).toEqual(ada);
    expect(await named(bob, `/api/v1/artifacts/${sharedId}/versions`)).toEqual(ada);
    expect(await named(bob, `/api/v1/artifacts/${sharedId}/actions`))
      .toEqual({...ada, [bobId]: "Bob"});
    const bobList = await named(bob, "/api/v1/artifacts");
    expect(Object.keys(bobList).every((id) => id === bobId)).toBe(true);

    const hiddenReads = await Promise.all(["", "/versions", "/actions"].map(async (suffix) => {
      const response = await get(bob, `/api/v1/artifacts/${hiddenId}${suffix}`);
      return {body: JSON.parse(await response.text()), status: response.status};
    }));
    expect(hiddenReads.map(({status}) => status)).toEqual([404, 404, 404]);
    for (const {body} of hiddenReads) expect(body).not.toHaveProperty("principals");

    const serviceOwner = z.object({artifact: z.object({ownerPrincipalId: z.string()})});
    const serviceDetails = await get(bob, `/api/v1/artifacts/${service.body.artifact.id}`);
    const servicePrincipalId = serviceOwner.parse(JSON.parse(await serviceDetails.text()))
      .artifact.ownerPrincipalId;
    expect(servicePrincipalId).toMatch(/^service:/);
    expect(await named(bob, `/api/v1/artifacts/${service.body.artifact.id}`))
      .toEqual({[servicePrincipalId]: "CI deploy"});
    expect(await named(administrator, "/api/v1/artifacts"))
      .toEqual({[servicePrincipalId]: "CI deploy"});

    const bodies = await Promise.all([
      `/api/v1/artifacts/${sharedId}`,
      `/api/v1/artifacts/${sharedId}/versions`,
      `/api/v1/artifacts/${sharedId}/actions`,
      "/api/v1/artifacts",
    ].map(async (pathname) => (await get(bob, pathname)).text()));
    for (const body of bodies) expect(body).not.toMatch(/@example\.test/);

    expect((await get(bob, "/api/v1/members")).status).toBe(403);
    expect((await fetch(`${server.baseUrl}/api/v1/artifacts`)).status).toBe(401);
  });

  function signIn(email: string, subject: string): Promise<Cookies> {
    return signInWithStubOidc(server.baseUrl, oidc, email, `art-013-${subject}`);
  }

  function get(cookies: Cookies, pathname: string): Promise<Response> {
    return fetch(`${server.baseUrl}${pathname}`, {headers: {Cookie: cookies.header}});
  }
});
