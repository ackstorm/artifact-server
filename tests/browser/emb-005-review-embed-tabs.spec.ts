import {expect, test} from "@playwright/test";
import {readFile} from "node:fs/promises";

import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {flowDiagram, publishSite, reviewUrl, revenueCsv, textFile} from "./embed-fixture.js";

const page = `<!doctype html><html><body><main>
<as-embed src="data/revenue.csv" title="Revenue"></as-embed>
<as-embed src="flow.mmd"></as-embed>
<as-embed src="data/revenue.csv"></as-embed>
<as-embed src="data/missing.csv"></as-embed>
<as-embed src="notes.txt"></as-embed>
<script src="/.artifactserver/embed.js"></script>
</main></body></html>`;

async function open(browser: Parameters<typeof startBrowserFixture>[0], idempotencyKey: string) {
  const fixture = await startBrowserFixture(browser);
  const published = await publishSite(fixture, [
    textFile("index.html", page, "text/html; charset=utf-8"),
    textFile("plain.html", "<!doctype html><h1>No embeds</h1>", "text/html; charset=utf-8"),
    textFile("data/revenue.csv", revenueCsv, "text/csv; charset=utf-8"),
    textFile("flow.mmd", flowDiagram, "text/plain; charset=utf-8"),
    textFile("notes.txt", "plain\n", "text/plain"),
  ], idempotencyKey);
  await localLogin(fixture);
  return {fixture, published};
}

test.describe("Review embed tabs", () => {
  test("EMB-005-B: Review shows Overview and one tab per embedded table and diagram, deep-links a tab, and downloads the tab's stored file", async ({browser}) => {
    const {fixture, published} = await open(browser, "emb-005-b-publish-site");
    try {
      await fixture.page.goto(reviewUrl(fixture, published, "&mode=view"));
      const tabs = fixture.page.getByRole("tablist", {name: "Embedded objects"}).getByRole("tab");
      await expect(tabs).toHaveText(["Overview", "Revenue", "flow.mmd"]);
      await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
      const frame = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(frame.locator("as-embed")).toHaveCount(5);

      await tabs.nth(1).click();
      await expect(fixture.page).toHaveURL(/[?&]tab=data%2Frevenue\.csv/u);
      await expect(frame.locator('td[data-annotate="data/revenue.csv#B2"]')).toHaveText("1,200");
      await expect(frame.locator("as-embed")).toHaveCount(1);
      const [download] = await Promise.all([
        fixture.page.waitForEvent("download"),
        fixture.page.getByRole("link", {name: "Download", exact: true}).click(),
      ]);
      expect(download.suggestedFilename()).toBe("revenue.csv");
      const stored = await download.path();
      expect(new TextDecoder().decode(await readFile(stored))).toBe(revenueCsv);

      await fixture.page.reload();
      await expect(fixture.page.getByRole("tab", {name: "Revenue"})).toHaveAttribute("aria-selected", "true");
      await expect(frame.locator('td[data-annotate="data/revenue.csv#B2"]')).toHaveText("1,200");

      await fixture.page.getByRole("tab", {name: "flow.mmd"}).click();
      await expect(frame.locator('as-embed[data-embed-kind="diagram"] svg')).toBeVisible();

      await fixture.page.getByRole("tab", {name: "Overview"}).click();
      await expect(fixture.page).not.toHaveURL(/[?&]tab=/u);
      await expect(frame.locator("as-embed")).toHaveCount(5);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("EMB-005-F: unknown tabs open Overview, missing, duplicate, and unsupported embeds get no tab, and a page without embeds has no tab bar", async ({browser}) => {
    const {fixture, published} = await open(browser, "emb-005-f-publish-site");
    try {
      await fixture.page.goto(reviewUrl(fixture, published, "&mode=view&tab=data%2Fmissing.csv"));
      const tabs = fixture.page.getByRole("tablist", {name: "Embedded objects"}).getByRole("tab");
      await expect(tabs).toHaveText(["Overview", "Revenue", "flow.mmd"]);
      await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
      await expect(fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe").locator("as-embed")).toHaveCount(5);

      await fixture.page.goto(reviewUrl(fixture, published, "&mode=view&tab=notes.txt"));
      await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
      await expect(fixture.page).not.toHaveURL(/[?&]tab=/u);
      await expect(fixture.page.locator('a[href*="notes.txt"]')).toHaveCount(0);

      await fixture.page.goto(reviewUrl(fixture, published, "&mode=view&path=plain.html"));
      await expect(fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe").locator("h1")).toHaveText("No embeds");
      await expect(fixture.page.getByRole("tablist", {name: "Embedded objects"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
