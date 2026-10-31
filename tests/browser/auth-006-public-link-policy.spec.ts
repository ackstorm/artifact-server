import {Redacted} from "effect";
import {expect, test, type Browser, type BrowserContext, type Page} from "@playwright/test";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {admitMember, issueApiKey} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
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
const organizationName = "myOrg";
const offLabel = "Public — Turned off by an administrator";
const offNote = "Public links are turned off by an administrator.";
const configurationNote =
  "Set by the server configuration. Change ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED to change it.";

/** One OIDC installation with a signed-in administrator and Ada, who owns the artifacts. */
interface PolicyFixture {
  readonly ada: Page;
  readonly adaKey: string;
  readonly administrator: Page;
  readonly contexts: readonly BrowserContext[];
  readonly installation: TestInstallation;
  readonly oidc: RunningStubOidcProvider;
  readonly server: RunningTestServer;
}

async function startPolicyFixture(
  browser: Browser,
  options: {readonly publicLinksEnabled?: boolean} = {},
): Promise<PolicyFixture> {
  const installation = await createTestInstallation();
  const oidc = await startStubOidcProvider({
    clientId: "artifact-server-auth-006",
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
    organizationName,
    port,
    ...options,
  });
  const administratorCookies = await signInWithStubOidc(
    server.baseUrl,
    oidc,
    "administrator@example.test",
    "auth-006-administrator",
  );
  const adaId = await admitMember(server, administratorCookies, "Ada", "ada@example.test");
  const adaKey = await issueApiKey(
    server,
    administratorCookies,
    ["artifact:create", "artifact:read"],
    "Ada's agent",
    adaId,
  );
  const administratorContext = await browserContext(
    browser,
    server,
    administratorCookies.header,
  );
  const adaCookies = await signInWithStubOidc(
    server.baseUrl,
    oidc,
    "ada@example.test",
    "auth-006-ada",
  );
  const adaContext = await browserContext(browser, server, adaCookies.header);
  return {
    ada: await adaContext.newPage(),
    adaKey,
    administrator: await administratorContext.newPage(),
    contexts: [administratorContext, adaContext],
    installation,
    oidc,
    server,
  };
}

async function browserContext(
  browser: Browser,
  server: RunningTestServer,
  cookieHeader: string,
): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies(cookieHeader.split("; ").map((pair) => ({
    name: pair.slice(0, pair.indexOf("=")),
    url: server.baseUrl,
    value: pair.slice(pair.indexOf("=") + 1),
  })));
  return context;
}

async function stopPolicyFixture(fixture: PolicyFixture): Promise<void> {
  await Promise.all(fixture.contexts.map((context) => context.close()));
  await fixture.server.stop();
  await fixture.oidc.stop();
  await removeTestInstallation(fixture.installation);
}

async function publishAsAda(
  fixture: PolicyFixture,
  name: string,
  accessSetting: "private" | "public_link",
): Promise<PublishResponse> {
  const published = await publishNew(
    fixture.server,
    {...fixture.installation, apiToken: fixture.adaKey},
    {
      accessSetting,
      content: `<!doctype html><title>${name}</title><h1>${name}</h1>`,
      idempotencyKey: `auth-006-${accessSetting}`,
      name,
      projectId: "prj_default",
    },
  );
  expect(published.response.status).toBe(201);
  return published.body;
}

async function openShare(page: Page, fixture: PolicyFixture, published: PublishResponse) {
  await page.goto(`${fixture.server.baseUrl}/review?${new URLSearchParams({
    artifact: published.artifact.id,
    project: published.artifact.projectId,
    version: published.version.id,
  })}`);
  await page.locator(".as-preview-header__actions")
    .getByRole("button", {exact: true, name: "Share"})
    .click();
  const share = page.locator(".as-share-popover[data-open]");
  await expect(share.getByRole("heading", {name: published.artifact.name})).toBeVisible();
  return {access: share.getByRole("combobox", {name: "General access"}), share};
}

async function openSwitch(fixture: PolicyFixture) {
  await fixture.administrator.goto(`${fixture.server.baseUrl}/review/settings/public-links`);
  const section = fixture.administrator.getByRole("region", {
    name: "Public links for this installation",
  });
  await expect(section).toBeVisible();
  return section;
}

async function anonymousLatest(published: PublishResponse): Promise<number> {
  return (await fetch(published.links.artifact, {redirect: "manual"})).status;
}

async function anonymousOrigin(
  fixture: PolicyFixture,
  published: PublishResponse,
): Promise<number> {
  return (await fetchVersion(fixture.server, published.links.version)).status;
}

test.describe("AUTH-006 public-link policy", () => {
  test("AUTH-006-B: an administrator turns public links off in place, Public artifacts stop opening without sign-in and keep their level, and turning them back on restores them", async ({browser}) => {
    const fixture = await startPolicyFixture(browser);
    try {
      const publicPlan = await publishAsAda(fixture, "Ada's public plan", "public_link");
      const draft = await publishAsAda(fixture, "Ada's draft", "private");
      expect(await anonymousLatest(publicPlan)).toBe(302);

      const section = await openSwitch(fixture);
      await expect(section.getByRole("status").getByText("On.", {exact: true})).toBeVisible();
      await section.getByRole("button", {name: "Turn off public links"}).click();
      const turnOff = section.getByRole("group", {name: "Confirm turning off public links"});
      await expect(turnOff).toContainText("1 artifact is Public now.");
      await expect(turnOff).toContainText("It keeps its Public setting");
      await expect(turnOff).toContainText(
        `people signed in to ${organizationName} with the link can still open it`,
      );
      await expect(turnOff).toContainText("cannot be recalled");

      await turnOff.getByRole("button", {name: "Cancel"}).click();
      await expect(turnOff).toHaveCount(0);
      expect(await anonymousLatest(publicPlan)).toBe(302);

      await section.getByRole("button", {name: "Turn off public links"}).click();
      await turnOff.getByRole("button", {name: "Turn off public links"}).click();
      await expect(section.getByRole("status").getByText("Off.", {exact: true})).toBeVisible();
      await expect(fixture.administrator.getByText("Public links are off.")).toBeVisible();
      expect(await anonymousLatest(publicPlan)).toBe(401);
      expect(await anonymousOrigin(fixture, publicPlan)).toBe(401);

      const toRaise = await openShare(fixture.ada, fixture, draft);
      await expect(toRaise.access.locator("option", {hasText: offLabel})).toBeDisabled();
      await expect(toRaise.share.getByText(offNote, {exact: true})).toBeVisible();
      await toRaise.access.selectOption("account_required");
      await expect(toRaise.share.getByText(
        `Anyone signed in to ${organizationName} can open this link.`,
        {exact: true},
      )).toBeVisible();
      await expect(toRaise.access).toHaveValue("account_required");

      const stored = await openShare(fixture.ada, fixture, publicPlan);
      await expect(stored.access).toHaveValue("public_link");
      await expect(stored.share).toContainText(
        `Only people signed in to ${organizationName} with the link can open it`,
      );
      await expect(stored.share.getByRole("heading", {exact: true, name: "Public link"}))
        .toHaveCount(0);
      await expect(stored.share.getByText(
        `Anyone signed in to ${organizationName} can open this link.`,
        {exact: true},
      )).toBeVisible();
      await expect(stored.access.locator('option[value="account_required"]')).toBeEnabled();
      await expect(stored.access.locator('option[value="private"]')).toBeEnabled();

      await section.getByRole("button", {name: "Turn on public links"}).click();
      const turnOn = section.getByRole("group", {name: "Confirm turning on public links"});
      await expect(turnOn).toContainText(
        "1 artifact keeps its Public setting and opens without sign-in again",
      );
      await turnOn.getByRole("button", {name: "Turn on public links"}).click();
      await expect(section.getByRole("status").getByText("On.", {exact: true})).toBeVisible();
      expect(await anonymousLatest(publicPlan)).toBe(302);
      expect(await anonymousOrigin(fixture, publicPlan)).toBe(200);
    } finally {
      await stopPolicyFixture(fixture);
    }
  });

  test("public-link policy: a configured policy shows the Settings switch disabled with the configuration note", async ({browser}) => {
    const fixture = await startPolicyFixture(browser, {publicLinksEnabled: false});
    try {
      const draft = await publishAsAda(fixture, "Ada's locked draft", "private");

      const section = await openSwitch(fixture);
      await expect(section.getByRole("status").getByText("Off.", {exact: true})).toBeVisible();
      const turnOn = section.getByRole("button", {name: "Turn on public links"});
      await expect(turnOn).toBeDisabled();
      await turnOn.click({force: true});
      await expect(section.getByRole("group")).toHaveCount(0);
      await expect(section.getByText(configurationNote, {exact: true})).toBeVisible();

      const {access} = await openShare(fixture.ada, fixture, draft);
      await expect(access.locator("option", {hasText: offLabel})).toBeDisabled();
    } finally {
      await stopPolicyFixture(fixture);
    }
  });
});
