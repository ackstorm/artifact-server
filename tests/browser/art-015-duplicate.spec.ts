import {expect, test} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {startTeamFixture, stopTeamFixture} from "./team-fixture.js";

test.describe("ART-015 Duplicate", () => {
  test("ART-015-B: Duplicate from the More actions menu creates a Private copy owned by the reader and opens it in Mine", async ({browser}) => {
    const fixture = await startTeamFixture(browser);
    try {
      const published = await publishNew(
        fixture.server,
        {...fixture.installation, apiToken: fixture.adaKey},
        {
          accessSetting: "account_required",
          content: "<!doctype html><title>Plan</title><h1>Plan entry text</h1>",
          idempotencyKey: "art-015-publish-plan",
          name: "Plan",
          projectId: "prj_default",
        },
      );
      expect(published.response.status).toBe(201);

      const page = fixture.bob;
      const openingRead = page.waitForResponse((response) =>
        response.url().includes(`/api/v1/artifacts/${published.body.artifact.id}?`)
        && response.status() === 200);
      await page.goto(`${fixture.server.baseUrl}/review?${new URLSearchParams({
        artifact: published.body.artifact.id,
        project: published.body.artifact.projectId,
      })}`);
      await openingRead;
      await page.goto(`${fixture.server.baseUrl}/review`);
      await page.getByRole("tab", {name: "Shared with me"}).click();
      await page.locator(".as-artifact-card").filter({hasText: "Plan"}).click();
      await page.locator(".as-preview-header__actions")
        .getByRole("button", {name: "More actions"})
        .click();
      await page.getByRole("button", {name: /^Duplicate/u}).click();

      await expect(page.getByRole("tab", {name: "Mine"})).toHaveAttribute("aria-selected", "true");
      const copy = page.locator(".as-artifact-card").filter({hasText: "Plan (copy)"});
      await expect(copy).toHaveAttribute("aria-current", "true");
      await expect(copy).toContainText("Private");
      await expect(copy).toContainText("1 version");

      const owner = page.locator(".as-inspector-row").filter({hasText: "owner"});
      await expect(owner).toContainText("Bob");
      await expect(page.frameLocator(".as-artifact-frame").frameLocator("iframe")
        .getByText("Plan entry text")).toBeVisible();
    } finally {
      await stopTeamFixture(fixture);
    }
  });
});
