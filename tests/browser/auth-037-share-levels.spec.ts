import {expect, test} from "@playwright/test";
import type {Page} from "@playwright/test";

import {publishNew, type PublishResponse} from "../support/publishing.js";
import {startTeamFixture, stopTeamFixture, type TeamFixture} from "./team-fixture.js";

const loweringWarning =
  "Content sessions already issued keep serving their version for up to 15 minutes.";

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
  test("AUTH-037-B: the owner moves between Private, Signed-in and Public, confirming in place before Public", async ({browser}) => {
    const fixture = await startTeamFixture(browser);
    try {
      const published = await publishAsAda(fixture, "Ada's plan", "private");
      const page = fixture.ada;
      let {access, share} = await openShare(page, fixture, published);
      await expect(access).toHaveValue("private");
      await expect(access).toBeEnabled();
      await expect(access.locator("option")).toHaveText([
        "Private — Only you",
        "Signed-in — Anyone signed in with the link",
        "Public — Anyone with the link, no sign-in",
      ]);
      await expect(share.getByText("Only you can open this link.", {exact: true}))
        .toBeVisible();

      await access.selectOption("account_required");
      await expect(share.getByText(
        "Anyone signed in can open this link.",
        {exact: true},
      )).toBeVisible();
      await expect(access).toBeEnabled();
      await page.reload();
      ({access, share} = await openShare(page, fixture, published));
      await expect(access).toHaveValue("account_required");

      const confirmation =
        "Anyone with the link, including people who are not signed in, can open the latest version.";
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
      await expect(reader.access).toHaveText("Shared with anyone signed in");
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
