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
const organizationName = "ACKstorm";
const loweringWarning =
  "Content sessions already issued keep serving their version for up to 15 minutes.";

/** One OIDC installation with two signed-in members: Ada owns, Bob reads. */
interface TeamFixture {
  readonly ada: Page;
  readonly adaKey: string;
  readonly bob: Page;
  readonly contexts: readonly BrowserContext[];
  readonly installation: TestInstallation;
  readonly oidc: RunningStubOidcProvider;
  readonly server: RunningTestServer;
}

async function startTeamFixture(browser: Browser): Promise<TeamFixture> {
  const installation = await createTestInstallation();
  const oidc = await startStubOidcProvider({
    clientId: "artifact-server-auth-037",
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
  });
  const administrator = await signInWithStubOidc(
    server.baseUrl,
    oidc,
    "administrator@example.test",
    "auth-037-administrator",
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
  const adaContext = await signedInContext(browser, server, oidc, "ada");
  const bobContext = await signedInContext(browser, server, oidc, "bob");
  return {
    ada: await adaContext.newPage(),
    adaKey,
    bob: await bobContext.newPage(),
    contexts: [adaContext, bobContext],
    installation,
    oidc,
    server,
  };
}

async function signedInContext(
  browser: Browser,
  server: RunningTestServer,
  oidc: RunningStubOidcProvider,
  name: string,
): Promise<BrowserContext> {
  const cookies = await signInWithStubOidc(
    server.baseUrl,
    oidc,
    `${name}@example.test`,
    `auth-037-${name}`,
  );
  const context = await browser.newContext();
  await context.addCookies(cookies.header.split("; ").map((pair) => ({
    name: pair.slice(0, pair.indexOf("=")),
    url: server.baseUrl,
    value: pair.slice(pair.indexOf("=") + 1),
  })));
  return context;
}

async function stopTeamFixture(fixture: TeamFixture): Promise<void> {
  await Promise.all(fixture.contexts.map((context) => context.close()));
  await fixture.server.stop();
  await fixture.oidc.stop();
  await removeTestInstallation(fixture.installation);
}

async function publishAsAda(
  fixture: TeamFixture,
  name: string,
  accessSetting: "private" | "account_required",
): Promise<PublishResponse> {
  const published = await publishNew(
    fixture.server,
    {...fixture.installation, apiToken: fixture.adaKey},
    {
      accessSetting,
      content: `<!doctype html><title>${name}</title><h1>${name}</h1>`,
      idempotencyKey: `auth-037-${accessSetting}`,
      name,
      projectId: "prj_default",
    },
  );
  expect(published.response.status).toBe(201);
  return published.body;
}

async function openShare(page: Page, fixture: TeamFixture, published: PublishResponse) {
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

test.describe("AUTH-037 share levels", () => {
  test("AUTH-037-B: the owner moves between Private, Organization and Public, confirming in place before Public", async ({browser}) => {
    const fixture = await startTeamFixture(browser);
    try {
      const published = await publishAsAda(fixture, "Ada's plan", "private");
      const page = fixture.ada;
      let {access, share} = await openShare(page, fixture, published);
      await expect(access).toHaveValue("private");
      await expect(access).toBeEnabled();
      await expect(access.locator("option")).toHaveText([
        "Private — Only you",
        `Organization — Anyone signed in to ${organizationName} with the link`,
        "Public — Anyone with the link, no sign-in",
      ]);
      await expect(share.getByText("Only you can open this link.", {exact: true}))
        .toBeVisible();

      await access.selectOption("account_required");
      await expect(share.getByText(
        `Anyone signed in to ${organizationName} can open this link.`,
        {exact: true},
      )).toBeVisible();
      await expect(access).toBeEnabled();
      await page.reload();
      ({access, share} = await openShare(page, fixture, published));
      await expect(access).toHaveValue("account_required");

      const confirmation =
        `Anyone with the link, including people outside ${organizationName}, can open the latest version.`;
      await access.selectOption("public_link");
      await expect(share.getByText(confirmation, {exact: true})).toBeVisible();
      await share.getByRole("button", {name: "Cancel"}).click();
      await expect(share.getByText(confirmation, {exact: true})).toHaveCount(0);
      await expect(access).toHaveValue("account_required");

      await access.selectOption("public_link");
      await share.getByRole("button", {name: "Confirm"}).click();
      await expect(share.getByText(confirmation, {exact: true})).toHaveCount(0);
      await expect(access).toHaveValue("public_link");
      await expect(share.locator("h3")).toHaveText([
        "General access",
        "Public link",
        "Review and comment",
        "Other links",
        "Review with an AI agent",
      ]);
      await expect(share.locator(".as-share-link").first().locator("code"))
        .toHaveText(published.links.artifact);
      await expect(share.getByText("For signed-in members.", {exact: true})).toBeVisible();
      await expect(page.locator(".as-inspector-row").filter({hasText: "access"})
        .getByText("Public", {exact: true})).toBeVisible();

      await access.selectOption("private");
      await expect(share.getByText(loweringWarning)).toBeVisible();
      await expect(access).toHaveValue("private");
      await expect(share.getByText("Only you can open this link.", {exact: true}))
        .toBeVisible();
      await expect(share.locator("h3")).not.toContainText(["Public link"]);
    } finally {
      await stopTeamFixture(fixture);
    }
  });

  test("AUTH-037-F: another member sees the selector disabled, and a failed save returns to the saved level with the server's message", async ({browser}) => {
    const fixture = await startTeamFixture(browser);
    try {
      const published = await publishAsAda(fixture, "Ada's shared plan", "account_required");

      const reader = await openShare(fixture.bob, fixture, published);
      await expect(reader.access).toBeDisabled();
      await expect(reader.access).toHaveText(`Shared with ${organizationName}`);
      await expect(fixture.bob.getByRole("button", {name: "Edit tags"})).toHaveCount(0);

      const failure = "The access change could not be stored.";
      await fixture.ada.route("**/api/v1/artifacts/*/access?*", (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({
            json: {error: {code: "INTERNAL_ERROR", message: failure}},
            status: 500,
          })
          : route.fallback());
      const owner = await openShare(fixture.ada, fixture, published);
      await owner.access.selectOption("private");
      await expect(owner.share.getByRole("alert")).toHaveText(failure);
      await expect(owner.access).toHaveValue("account_required");
      await expect(owner.access).toBeEnabled();
    } finally {
      await stopTeamFixture(fixture);
    }
  });
});
