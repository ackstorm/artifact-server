import {expect, test} from "@playwright/test";
import {z} from "zod";

import {listThreadsOverApi} from "./comment-api.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {flowDiagram, publishSite, reviewUrl, revenueCsv, textFile} from "./embed-fixture.js";

const anchorSchema = z.object({
  elementContext: z.object({attrs: z.array(z.tuple([z.string(), z.string()])).optional()}).loose(),
}).loose();

const page = `<!doctype html><html><body><main>
<h1>Quarter</h1>
<as-embed src="data/revenue.csv" title="Revenue"></as-embed>
<as-embed src="flow.mmd"></as-embed>
<as-embed src="second.mmd"></as-embed>
<script src="/.artifactserver/embed.js"></script>
</main></body></html>`;
const hostile = `<!doctype html><html><body><main><p>Hostile page</p></main><script>
document.body.dataset.clears = "0";
addEventListener("message", (event) => {
  if (event.data && event.data.type === "nested-posted") document.body.dataset.nestedPosted = "yes";
  if (String(event.data && event.data.type).includes("clear-marks")) document.body.dataset.clears = String(Number(document.body.dataset.clears) + 1);
});
const nested = document.createElement("iframe");
nested.srcdoc = "<script>parent.parent.postMessage({type: 'as-embeds-rendered'}, '*'); parent.postMessage({type: 'nested-posted'}, '*')<\\/script>";
document.body.append(nested);
setTimeout(() => {
  parent.postMessage({type: "as-embeds-rendered", annotations: [{threadId: "forged"}]}, "*");
  document.body.dataset.selfPosted = "yes";
}, 2500);
</script></body></html>`;
const plain = `<!doctype html><html><body><main>
<p id="forged" data-annotate="data/revenue.csv#B2">Forged on a page without embeds</p>
</main></body></html>`;

async function comment(fixture: BrowserFixture, selector: string, body: string): Promise<void> {
  const review = fixture.page.frameLocator(".as-artifact-frame");
  const preview = review.frameLocator("iframe");
  await preview.locator(selector).first().hover();
  await preview.locator(selector).first().click();
  const composer = review.getByPlaceholder("Add a comment...");
  await expect(composer).toBeVisible();
  await composer.fill(body);
  await review.getByRole("button", {name: "Save"}).click();
  await expect(fixture.page.getByRole("article").filter({hasText: body})).toBeVisible();
}

type Anchor = z.infer<typeof anchorSchema>;

function annotateOf(anchor: Anchor): string | undefined {
  return anchor.elementContext.attrs?.find(([name]) => name === "data-annotate")?.[1];
}

async function expectListed(fixture: BrowserFixture, url: string, pins: number): Promise<void> {
  await fixture.page.goto(url);
  const markers = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe").locator("button[data-plannotator-marker]");
  await expect(markers).toHaveCount(pins);
  await fixture.page.getByRole("tab", {name: /^Comments/u}).click();
  const article = fixture.page.getByRole("article").filter({hasText: "Check this total."});
  await expect(article).toBeVisible();
  await expect(article.locator("code")).toHaveText("data/revenue.csv");
}

test.describe("comments on embeds", () => {
  test("EMB-006-B: a comment inside an embed belongs to the embedded file and is listed under that path and pinned on the Overview and on its tab", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishSite(fixture, [
        textFile("index.html", page, "text/html; charset=utf-8"),
        textFile("data/revenue.csv", revenueCsv, "text/csv; charset=utf-8"),
        textFile("flow.mmd", flowDiagram, "text/plain; charset=utf-8"),
        textFile("second.mmd", "flowchart LR\n  left[Left] --> right[Right]\n", "text/plain; charset=utf-8"),
      ], "emb-006-b-publish-site");
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, published, "&mode=comment"));
      await comment(fixture, 'td[data-annotate="data/revenue.csv#B2"]', "Check this total.");
      await comment(fixture, 'as-embed[data-embed-kind="diagram"] g.node[data-annotate*="flowchart-draft"]', "Rename this step.");
      await comment(fixture, 'g.node[data-annotate^="second.mmd#flowchart-right"]', "Rename the right node.");

      const threads = await listThreadsOverApi(fixture, published.artifact.id);
      const total = threads.find((thread) => thread.body === "Check this total.");
      const step = threads.find((thread) => thread.body === "Rename this step.");
      expect(total?.path).toBe("data/revenue.csv");
      expect(annotateOf(anchorSchema.parse(total?.anchor))).toBe("data/revenue.csv#B2");
      expect(step?.path).toBe("flow.mmd");
      expect(annotateOf(anchorSchema.parse(step?.anchor))).toMatch(/^flow\.mmd#flowchart-draft-\d+$/u);
      const right = threads.find((thread) => thread.body === "Rename the right node.");
      expect(right?.path).toBe("second.mmd");
      expect(annotateOf(anchorSchema.parse(right?.anchor))).toMatch(/^second\.mmd#flowchart-right-\d+$/u);

      await expectListed(fixture, reviewUrl(fixture, published, "&mode=comment"), 3);
      await expectListed(fixture, reviewUrl(fixture, published, "&mode=comment&tab=data%2Frevenue.csv"), 1);
      await fixture.page.goto(reviewUrl(fixture, published, "&mode=comment&tab=second.mmd"));
      await expect(fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe").locator("button[data-plannotator-marker]")).toHaveCount(1);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("EMB-006-F: comments on page content and on forged routing attributes stay on the page, and a page message repaints at most and only from the viewer frame", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishSite(fixture, [
        textFile("index.html", page, "text/html; charset=utf-8"),
        textFile("plain.html", plain, "text/html; charset=utf-8"),
        textFile("hostile.html", hostile, "text/html; charset=utf-8"),
        textFile("data/revenue.csv", revenueCsv, "text/csv; charset=utf-8"),
        textFile("flow.mmd", flowDiagram, "text/plain; charset=utf-8"),
        textFile("second.mmd", "flowchart LR\n  left[Left] --> right[Right]\n", "text/plain; charset=utf-8"),
      ], "emb-006-f-publish-site");
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, published, "&mode=comment"));
      await comment(fixture, "h1", "Retitle the page.");
      await fixture.page.goto(reviewUrl(fixture, published, "&mode=comment&path=plain.html"));
      await comment(fixture, "#forged", "Forged routing stays here.");

      const threads = await listThreadsOverApi(fixture, published.artifact.id);
      expect(threads.find((thread) => thread.body === "Retitle the page.")?.path).toBe("index.html");
      expect(threads.find((thread) => thread.body === "Forged routing stays here.")?.path).toBe("plain.html");

      await fixture.page.goto(reviewUrl(fixture, published, "&mode=comment&path=hostile.html"));
      const hostileFrame = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(hostileFrame.locator("p")).toHaveText("Hostile page");
      const body = hostileFrame.locator("body");
      await expect(body).toHaveAttribute("data-nested-posted", "yes");
      await expect(body).toHaveAttribute("data-clears", "0");
      await expect(body).toHaveAttribute("data-self-posted", "yes");
      await expect(body).toHaveAttribute("data-clears", "1");
      expect(await listThreadsOverApi(fixture, published.artifact.id)).toHaveLength(threads.length);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
