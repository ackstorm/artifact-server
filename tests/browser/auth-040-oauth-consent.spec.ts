import {expect, test} from "@playwright/test";

import {localLogin, type BrowserFixture} from "./browser-fixture.js";
import {
  authorizationUrl,
  oauthPkce,
  oauthRedirectUri,
  registerOAuthClient,
  startOAuthServer,
} from "../support/oauth-client.js";
import {createTestInstallation, removeTestInstallation} from "../support/runtime-harness.js";

test.describe("OAuth consent", () => {
  test("a browser approval redirects to the loopback callback with a code and the state", async ({browser}) => {
    const installation = await createTestInstallation();
    const server = await startOAuthServer(installation);
    const context = await browser.newContext();
    const page = await context.newPage();
    const fixture: BrowserFixture = {context, installation, page, server};
    try {
      await localLogin(fixture);
      const clientId = await registerOAuthClient(server);
      const {challenge} = oauthPkce();
      const callback = page.waitForRequest(`${oauthRedirectUri}?**`);
      await page.goto(authorizationUrl(server, clientId, challenge, {
        scope: "artifactserver",
        state: "browser-state",
      }));
      await page.getByRole("button", {name: "Approve"}).click();
      const reached = new URL((await callback).url());
      expect(reached.searchParams.get("state")).toBe("browser-state");
      expect(reached.searchParams.get("code")).toMatch(/^as_orc_/u);
    } finally {
      await context.close();
      await server.stop();
      await removeTestInstallation(installation);
    }
  });
});
