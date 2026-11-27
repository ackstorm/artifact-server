import {expect, test, type FrameLocator, type Locator, type Page} from "@playwright/test";

import {publishNew, publishVersion, type PublishResponse} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const interactiveArtifact = `<!doctype html><html lang="en"><body>
  <p><span id="copy-text">Select and copy this sentence.</span></p>
  <button onclick="document.getElementById('count').textContent='clicked'">Run action</button>
  <p id="count">waiting</p>
  <p id="key">key:none</p>
  <p id="copied">copied:none</p>
  <p id="probe-parent">parent:pending</p>
  <script>
    document.addEventListener("keydown", function (event) {
      document.getElementById("key").textContent = "key:" + event.key;
    });
    document.addEventListener("copy", function () {
      document.getElementById("copied").textContent = "copied:" + document.getSelection().toString();
    });
    try {
      document.getElementById("probe-parent").textContent = "parent:reached:" + window.parent.document.title;
    } catch (error) {
      document.getElementById("probe-parent").textContent = "parent:blocked";
    }
  </script>
</body></html>`;

test.describe("Artifact review mode", () => {
  test("PRV-006-B: View runs the page as published, Comment comments on a selection, and a thread opens Comment", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-view",
        name: "Interactive fixture",
      });
      await localLogin(fixture);
      await fixture.page.goto(normalReviewUrl(fixture.server.baseUrl, published.body).href);
      const {page} = fixture;
      const review = page.frameLocator(".as-artifact-frame");
      const preview = review.frameLocator("iframe");
      const composer = review.getByPlaceholder("Add a comment...");
      await expectMode(page, "view");

      await preview.getByRole("button", {name: "Run action"}).click();
      await expect(preview.locator("#count")).toHaveText("clicked");
      await preview.locator("#key").click();
      await page.keyboard.press("k");
      await expect(preview.locator("#key")).toHaveText("key:k");
      await dragSelect(page, preview.locator("#copy-text"));
      await expect.poll(() => selectionIn(preview)).toContain("and copy this");
      await page.keyboard.press("ControlOrMeta+c");
      await expect(preview.locator("#copied")).toContainText("and copy this");
      await expect(composer).toHaveCount(0);

      await modeButton(page).click();
      await expectMode(page, "comment");
      await dragSelect(page, preview.locator("#copy-text"));
      await expect(composer).toBeVisible();
      await composer.fill("Tighten this sentence.");
      await review.getByRole("button", {name: "Save"}).click();
      const thread = page.getByRole("article").filter({hasText: "Tighten this sentence."});
      await expect(thread).toBeVisible();

      await page.locator(".as-preview-panel").focus();
      await page.keyboard.press("Escape");
      await expectMode(page, "view");
      await modeButton(page).click();
      await expectMode(page, "comment");
      await modeButton(page).click();
      await expectMode(page, "view");
      await thread.getByRole("button", {name: "Show in page"}).click();
      await expectMode(page, "comment");
      await expect(thread).toHaveAttribute("aria-current", "true");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("PRV-006-B: a mode override persists through artifact, version, file, and focus navigation and history", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-navigation-first",
        name: "First fixture",
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: interactiveArtifact,
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "review-mode-navigation-second-version",
      });
      await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-navigation-other",
        name: "Other fixture",
      });
      await localLogin(fixture);
      const {page} = fixture;
      const url = normalReviewUrl(fixture.server.baseUrl, first.body);
      url.searchParams.set("mode", "comment");
      await page.goto(url.href);
      await expectMode(page, "comment");

      await page.getByRole("tab", {name: /Versions/u}).click();
      await page.locator(".as-version-list li").filter({hasText: "Version 2"})
        .getByRole("button", {name: /Version 2/u}).first().click();
      await expect(page).toHaveURL(/mode=comment/u);
      await expectMode(page, "comment");
      await page.getByRole("tab", {name: /Files/u}).click();
      await page.locator(".as-file-list button").filter({hasText: "index.html"}).click();
      await expect(page).toHaveURL(/path=index\.html/u);
      await expect(page).toHaveURL(/mode=comment/u);
      await page.locator(".as-artifact-card").filter({hasText: "Other fixture"}).click();
      await expect(page).toHaveURL(/mode=comment/u);
      await expectMode(page, "comment");

      await page.getByRole("button", {name: "Full screen", exact: true}).click();
      await expect(page).toHaveURL(/mode=comment/u);
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("artifact-review-return-url")))
        .toContain("mode=comment");
      await page.getByRole("button", {name: "Exit full screen", exact: true}).click();
      await page.goBack();
      await expect(page).toHaveURL(/mode=comment/u);
      await expectMode(page, "comment");
      await page.goForward();
      await expectMode(page, "comment");
      await modeButton(page).click();
      await expectMode(page, "view");
      await page.goBack();
      await expectMode(page, "comment");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("PRV-006-F: invalid and legacy mode values open View, and neither mode widens the sandbox", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-invalid",
      });
      await localLogin(fixture);
      const {page} = fixture;
      const review = page.frameLocator(".as-artifact-frame");
      const preview = review.frameLocator("iframe");
      const url = normalReviewUrl(fixture.server.baseUrl, published.body);
      const opensView = async (value: string): Promise<void> => {
        url.searchParams.set("mode", value);
        await page.goto(url.href);
        await expect(preview.locator("#count")).toHaveText("waiting");
        await expectMode(page, "view");
      };
      await opensView("annotate");
      await opensView("interact");
      await opensView("COMMENT");
      await opensView("garbage");
      const staysSandboxed = async (): Promise<void> => {
        await expect(preview.locator("#probe-parent")).toHaveText("parent:blocked");
        await expect(review.locator("iframe")).toHaveCount(1);
        await expect(review.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      };
      await staysSandboxed();
      await modeButton(page).click();
      await expectMode(page, "comment");
      await staysSandboxed();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("PRV-006-F: a manual toggle or Escape survives refreshed details and version loading", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-refresh-first",
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: interactiveArtifact,
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "review-mode-refresh-second",
      });
      await localLogin(fixture);
      const {page} = fixture;
      await page.goto(normalReviewUrl(fixture.server.baseUrl, first.body).href);
      await expectMode(page, "view");
      await modeButton(page).click();
      await expectMode(page, "comment");
      await page.locator(".as-preview-panel").focus();
      await page.keyboard.press("Escape");
      await expectMode(page, "view");
      await modeButton(page).click();
      await expectMode(page, "comment");

      await page.getByRole("tab", {name: /Versions/u}).click();
      const firstRow = page.locator(".as-version-list li").filter({hasText: "Version 1"});
      await firstRow.getByRole("button", {name: "Make current"}).click();
      await page.getByRole("dialog", {name: "Make Version 1 current?"})
        .getByRole("button", {name: "Make current"}).click();
      await expect(firstRow.getByText("current", {exact: true})).toBeVisible();
      await expectMode(page, "comment");
      await page.locator(".as-version-list li").filter({hasText: "Version 2"})
        .getByRole("button", {name: /Version 2/u}).first().click();
      await expect(page).toHaveURL(/version=/u);
      await expectMode(page, "comment");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

function modeButton(page: Page): Locator {
  return page.getByRole("button", {name: /^(View|Comment) mode\b/u});
}

async function expectMode(page: Page, mode: "comment" | "view"): Promise<void> {
  await expect(page.locator(".as-app")).toHaveAttribute("data-review-mode", mode);
  await expect(modeButton(page)).toHaveAttribute("aria-pressed", String(mode === "comment"));
}

async function dragSelect(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("The selection target is not visible.");
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {steps: 8});
  await page.mouse.up();
}

function selectionIn(preview: FrameLocator): Promise<string> {
  return preview.locator("body").evaluate(() => document.getSelection()?.toString() ?? "");
}

function normalReviewUrl(baseUrl: string, published: PublishResponse): URL {
  const url = new URL("/review", baseUrl);
  url.search = new URLSearchParams({
    artifact: published.artifact.id,
    project: published.artifact.projectId,
    version: published.version.id,
  }).toString();
  return url;
}
