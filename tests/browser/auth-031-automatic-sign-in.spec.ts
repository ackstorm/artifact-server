import {expect, type Page, test} from "@playwright/test";

import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const deepLink = "/review?project=prj_default&artifact=art_example&view=focus";

async function presentPrivateTeamWithoutSession(page: Page): Promise<string[]> {
  const loginRequests: string[] = [];
  await page.route("**/auth/context", (route) => route.fulfill({
    json: {accessMode: "private_team", login: {kind: "oidc"}},
  }));
  await page.route("**/api/v1/session", (route) => route.fulfill({
    json: {error: {code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue."}},
    status: 401,
  }));
  await page.route("**/auth/login?*", (route) => {
    loginRequests.push(route.request().url());
    return route.fulfill({
      body: "<!doctype html><title>Identity provider</title><h1>Identity provider</h1>",
      contentType: "text/html",
    });
  });
  return loginRequests;
}

test.describe("automatic sign-in", () => {
  test("AUTH-031-B AUTH-031-F: a page opened without a session signs in once per tab", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const localLoginRequests: string[] = [];
      await fixture.page.route("**/auth/login?*", (route) => {
        localLoginRequests.push(route.request().url());
        return route.abort();
      });
      await localLogin(fixture);
      expect(localLoginRequests).toEqual([]);
      await fixture.page.unrouteAll();

      const loginRequests = await presentPrivateTeamWithoutSession(fixture.page);
      await fixture.context.clearCookies();
      await fixture.page.evaluate(() => sessionStorage.clear());

      await fixture.page.goto(`${fixture.server.baseUrl}${deepLink}`);
      await expect(fixture.page.getByRole("heading", {name: "Identity provider"})).toBeVisible();
      expect(loginRequests).toHaveLength(1);
      expect(new URL(loginRequests[0] ?? "").searchParams.get("returnTo")).toBe(deepLink);

      await fixture.page.goto(`${fixture.server.baseUrl}${deepLink}`);
      await expect(fixture.page.getByRole("heading", {name: "Sign in required"})).toBeVisible();
      await expect(fixture.page.getByRole("link", {name: "Sign in"}))
        .toHaveAttribute("href", `/auth/login?returnTo=${encodeURIComponent(deepLink)}`);
      expect(loginRequests).toHaveLength(1);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
