import {Redacted} from "effect";
import type {Browser, BrowserContext, Page} from "@playwright/test";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {admitMember, issueApiKey} from "../support/agent-dispatch.js";
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

const clientSecret = "stub-oidc-client-secret-with-entropy";

/** One OIDC installation with two signed-in members: Ada owns, Bob reads. */
export interface TeamFixture {
  readonly ada: Page;
  readonly adaCookies: {readonly csrf: string; readonly header: string};
  readonly adaKey: string;
  readonly bob: Page;
  /** An API key for Carol, a third member, when the fixture was started with her. */
  readonly carolKey: string | null;
  readonly contexts: readonly BrowserContext[];
  readonly installation: TestInstallation;
  readonly oidc: RunningStubOidcProvider;
  readonly server: RunningTestServer;
}

export async function startTeamFixture(
  browser: Browser,
  options: {readonly withCarol?: boolean} = {},
): Promise<TeamFixture> {
  const installation = await createTestInstallation();
  const oidc = await startStubOidcProvider({
    clientId: "artifact-server-team-fixture",
    clientSecret,
  });
  const port = await reserveLoopbackPort();
  const applicationOrigin = `http://127.0.0.1:${port}`;
  const server = await startTestServer(installation, {
    applicationOrigin,
    bootstrapAdministratorEmail: "administrator@example.test",
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
    interactiveIdentityProvider: createOidcIdentityProvider({
      applicationOrigin,
      clientId: oidc.clientId,
      clientSecret: Redacted.make(clientSecret, {label: "oidc-client-secret"}),
      issuer: oidc.issuer,
      scopes: "openid email profile",
    }),
    organizationName: "myOrg",
    port,
  });
  const administrator = await signInWithStubOidc(
    server.baseUrl,
    oidc,
    "administrator@example.test",
    "team-fixture-administrator",
  );
  const adaId = await admitMember(server, administrator, "Ada", "ada@example.test");
  await admitMember(server, administrator, "Bob", "bob@example.test");
  const adaKey = await issueApiKey(
    server,
    administrator,
    ["artifact:create", "artifact:read"],
    "Ada's agent",
    adaId,
  );
  const carolKey = options.withCarol === true
    ? await issueApiKey(
      server,
      administrator,
      ["artifact:create", "artifact:read"],
      "Carol's agent",
      await admitMember(server, administrator, "Carol", "carol@example.test"),
    )
    : null;
  const adaCookies = await signInWithStubOidc(
    server.baseUrl,
    oidc,
    "ada@example.test",
    "team-fixture-ada",
  );
  const adaContext = await signedInContext(browser, server, adaCookies);
  const bobContext = await signedInContext(
    browser,
    server,
    await signInWithStubOidc(server.baseUrl, oidc, "bob@example.test", "team-fixture-bob"),
  );
  return {
    ada: await adaContext.newPage(),
    adaCookies,
    adaKey,
    bob: await bobContext.newPage(),
    carolKey,
    contexts: [adaContext, bobContext],
    installation,
    oidc,
    server,
  };
}

async function signedInContext(
  browser: Browser,
  server: RunningTestServer,
  cookies: {readonly header: string},
): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies(cookies.header.split("; ").map((pair) => ({
    name: pair.slice(0, pair.indexOf("=")),
    url: server.baseUrl,
    value: pair.slice(pair.indexOf("=") + 1),
  })));
  return context;
}

export async function stopTeamFixture(fixture: TeamFixture): Promise<void> {
  await Promise.all(fixture.contexts.map((context) => context.close()));
  await fixture.server.stop();
  await fixture.oidc.stop();
  await removeTestInstallation(fixture.installation);
}
