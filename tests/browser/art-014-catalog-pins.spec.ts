import {expect, test} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {startTeamFixture, stopTeamFixture} from "./team-fixture.js";

const levels = [
  ["Private artifact", "private"],
  ["Organization artifact", "account_required"],
  ["Public artifact", "public_link"],
] as const;

test.describe("ART-014 catalog filters and pins", () => {
  test("ART-014-B: the catalog filters by sharing level, and pinned artifacts stay grouped at the top across reloads and under Pinned only", async ({browser}) => {
    const fixture = await startTeamFixture(browser);
    try {
      const results = await Promise.all(levels.map(([name, accessSetting]) => publishNew(
        fixture.server,
        {...fixture.installation, apiToken: fixture.adaKey},
        {
          accessSetting,
          content: `<!doctype html><title>${name}</title><h1>${name}</h1>`,
          idempotencyKey: `art-014-catalog-pins-${accessSetting}`,
          name,
          projectId: "prj_default",
        },
      )));
      expect(results.map(({response}) => response.status)).toEqual([201, 201, 201]);
      const page = fixture.ada;
      await page.goto(`${fixture.server.baseUrl}/review`);
      const cards = page.locator(".as-artifact-card");
      const labels = page.locator(".as-catalog-group__label");
      const filters = page.getByRole("button", {name: /^Filter artifacts/u});
      await expect(cards).toHaveCount(3);

      await filters.click();
      await page.getByRole("checkbox", {name: "Members"}).check();
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toContainText("Organization artifact");
      await expect(cards.first().locator(".as-artifact-card__mark")).toHaveText("HTML");
      await expect(filters).toContainText("1 filter");
      await expect(filters).not.toContainText("1 filters");
      await page.getByRole("button", {name: "Clear filters"}).click();
      await expect(cards).toHaveCount(3);
      await page.keyboard.press("Escape");

      const privateCard = page.locator(".as-artifact-card-row").filter({hasText: "Private artifact"});
      await privateCard.hover();
      await privateCard.getByRole("button", {name: "Pin Private artifact"}).click();
      await expect(labels).toHaveText(["Pinned", "All"]);
      await expect(cards.first()).toContainText("Private artifact");

      await page.reload();
      await expect(labels).toHaveText(["Pinned", "All"]);
      await expect(cards.first()).toContainText("Private artifact");

      await filters.click();
      await page.getByRole("checkbox", {name: "Pinned only"}).check();
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toContainText("Private artifact");
      await page.getByRole("checkbox", {name: "Pinned only"}).uncheck();
      await page.keyboard.press("Escape");

      await page.getByRole("button", {name: "Unpin Private artifact"}).click();
      await expect(labels).toHaveCount(0);
      await expect(cards).toHaveCount(3);
    } finally {
      await stopTeamFixture(fixture);
    }
  });
});
