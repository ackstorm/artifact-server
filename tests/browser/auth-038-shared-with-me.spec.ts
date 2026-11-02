import {expect, test} from "@playwright/test";
import type {Page} from "@playwright/test";

import {publishNew, type PublishResponse} from "../support/publishing.js";
import {startTeamFixture, stopTeamFixture, type TeamFixture} from "./team-fixture.js";

const organizationName = "myOrg";
const listingLabel = `List it in ${organizationName}'s Shared with me`;

async function publishAs(
  fixture: TeamFixture,
  apiToken: string,
  name: string,
): Promise<PublishResponse> {
  const published = await publishNew(
    fixture.server,
    {...fixture.installation, apiToken},
    {
      accessSetting: "account_required",
      content: `<!doctype html><title>${name}</title><h1>${name}</h1>`,
      idempotencyKey: `auth-038-shared-${name}`,
      name,
      projectId: "prj_default",
    },
  );
  expect(published.response.status).toBe(201);
  return published.body;
}

function reviewUrl(fixture: TeamFixture, published: PublishResponse): string {
  return `${fixture.server.baseUrl}/review?${new URLSearchParams({
    artifact: published.artifact.id,
    project: published.artifact.projectId,
    version: published.version.id,
  })}`;
}

async function openShare(page: Page, fixture: TeamFixture, published: PublishResponse) {
  await page.goto(reviewUrl(fixture, published));
  await page.locator(".as-preview-header__actions")
    .getByRole("button", {exact: true, name: "Share"})
    .click();
  const share = page.locator(".as-share-popover[data-open]");
  await expect(share.getByRole("heading", {exact: true, name: published.artifact.name})).toBeVisible();
  return {
    access: share.getByRole("combobox", {name: "General access"}),
    listing: share.getByRole("switch", {name: listingLabel}),
    share,
  };
}

test.describe("AUTH-038 Shared with me", () => {
  test("AUTH-038-B: an owner lists an Organization artifact and a colleague finds it in Shared with me, next to what they opened by link", async ({browser}) => {
    const fixture = await startTeamFixture(browser, {withCarol: true});
    try {
      if (fixture.carolKey === null) throw new Error("The fixture did not add Carol.");
      const listed = await publishAs(fixture, fixture.adaKey, "L");
      const opened = await publishAs(fixture, fixture.carolKey, "O");

      const page = fixture.ada;
      let {access, listing, share} = await openShare(page, fixture, listed);
      await expect(listing).not.toBeChecked();
      await expect(share.getByText("Only people who have the link find it.", {exact: true}))
        .toBeVisible();
      await listing.click();
      await expect(listing).toBeChecked();
      await expect(share.getByText(
        `Everyone signed in to ${organizationName} sees it in Shared with me.`,
        {exact: true},
      )).toBeVisible();

      const activity = page.locator(".as-inspector__body");
      await share.getByRole("button", {name: "Close Share"}).click();
      await page.getByRole("tab", {name: /Activity/u}).click();
      await expect(activity.getByText("Listed in Shared with me", {exact: true})).toBeVisible();
      await expect(activity.locator(".as-activity-list li")
        .filter({hasText: "Listed in Shared with me"})
        .locator(".as-principal-chip").filter({hasText: "Ada"})).toBeVisible();

      ({access, listing, share} = await openShare(page, fixture, listed));
      await access.selectOption("private");
      await expect(listing).not.toBeChecked();
      await expect(listing).toBeDisabled();
      await expect(share.getByText("Share it with the organization first.", {exact: true}))
        .toBeVisible();
      await share.getByRole("button", {name: "Close Share"}).click();
      await page.getByRole("tab", {name: /Activity/u}).click();
      await expect(activity.getByText("Changed access", {exact: true})).toBeVisible();
      await expect(activity.getByText("Removed from Shared with me", {exact: true}))
        .toBeVisible();

      ({access, listing, share} = await openShare(page, fixture, listed));
      await access.selectOption("account_required");
      await expect(access).toHaveValue("account_required");
      await listing.click();
      await expect(listing).toBeChecked();

      // Switching tabs drops the selected version with the selected artifact.
      const newer = await publishAs(fixture, fixture.adaKey, "M");
      await page.goto(reviewUrl(fixture, listed));
      await page.getByRole("tab", {name: "Shared with me"}).click();
      await page.getByRole("tab", {name: "Mine"}).click();
      await expect(page).toHaveURL(new RegExp(`version=${newer.version.id}`, "u"));
      await expect(page.getByText("The saved version does not exist on this artifact."))
        .toHaveCount(0);

      const bob = fixture.bob;
      await bob.goto(`${fixture.server.baseUrl}/review`);
      await bob.getByRole("tab", {name: "Shared with me"}).click();
      const groups = bob.locator(".as-catalog-group");
      const listedGroup = groups.filter({
        has: bob.getByRole("heading", {name: `Listed for ${organizationName}`}),
      });
      await expect(listedGroup.locator(".as-artifact-card")).toHaveCount(1);
      await expect(listedGroup.locator(".as-artifact-card__title")).toHaveText(/^L$/u);
      await expect(listedGroup.locator(".as-artifact-card")).toContainText("Ada");

      const openingRead = bob.waitForResponse((response) =>
        response.url().includes(`/api/v1/artifacts/${opened.artifact.id}?`)
        && response.status() === 200);
      await bob.goto(reviewUrl(fixture, opened));
      await openingRead;
      await bob.goto(`${fixture.server.baseUrl}/review`);
      await bob.getByRole("tab", {name: "Shared with me"}).click();
      const openedGroup = groups.filter({
        has: bob.getByRole("heading", {name: "Opened by link"}),
      });
      await expect(openedGroup.locator(".as-artifact-card")).toHaveCount(1);
      await expect(openedGroup.locator(".as-artifact-card")).toContainText("Carol");

      const reader = await openShare(bob, fixture, listed);
      await expect(reader.listing).toBeChecked();
      await expect(reader.listing).toBeDisabled();
      await expect(reader.share.getByText("Only Ada can change this.", {exact: true}))
        .toBeVisible();

      await bob.goto(`${fixture.server.baseUrl}/review`);
      await expect(bob.getByRole("tab", {name: "Mine"})).toHaveAttribute("aria-selected", "true");
      await expect(bob.locator(".as-artifact-card")).toHaveCount(0);
    } finally {
      await stopTeamFixture(fixture);
    }
  });
});
