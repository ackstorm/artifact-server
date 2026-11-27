import {expect, test} from "@playwright/test";
import {z} from "zod";

import {listThreadsOverApi} from "./comment-api.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {publishSite, rawUrl, revenueCsv, reviewUrl, textFile} from "./embed-fixture.js";

const runtime = "<script src=\"/.artifactserver/embed.js\"></script>";
const anchorSchema = z.object({
  elementContext: z.object({attrs: z.array(z.tuple([z.string(), z.string()]))}).loose(),
}).loose();
const mebibyte = 1_048_576;

test.describe("table embeds", () => {
  test("EMB-002-B: a CSV renders as a read-only table with letters, row numbers, its header row, right-aligned numbers, and commentable cells", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishSite(fixture, [
        textFile("index.html", `<!doctype html><main><as-embed src="data/revenue.csv" title="Revenue"></as-embed>${runtime}</main>`, "text/html; charset=utf-8"),
        textFile("data/revenue.csv", revenueCsv, "text/csv; charset=utf-8"),
      ], "emb-002-b-publish-site");
      await fixture.page.goto(await rawUrl(fixture, published));
      const table = fixture.page.getByRole("table", {name: "Revenue"});
      await expect(table.locator("thead tr").first().locator("th")).toHaveText(["", "A", "B", "C"]);
      await expect(table.locator("th[scope=row]")).toHaveText(["1", "2", "3"]);
      await expect(table.locator("th[data-cell]")).toHaveText(["Region", "Revenue, EUR", "Note"]);
      await expect(table.locator("tbody tr")).toHaveCount(2);
      const cell = (reference: string) => table.locator(`[data-annotate="data/revenue.csv#${reference}"][data-cell="${reference}"]`);
      await expect(cell("C2")).toHaveText("Said \"hi\"");
      await expect(cell("C3")).toHaveJSProperty("textContent", "two\nlines");
      await Promise.all([
        expect(cell("B2")).toHaveText("1,200"),
        expect(cell("B2")).toHaveCSS("text-align", "right"),
        expect(cell("B3")).toHaveCSS("text-align", "right"),
        expect(cell("A2")).toHaveCSS("text-align", "left"),
      ]);

      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, published, "&mode=comment"));
      const review = fixture.page.frameLocator(".as-artifact-frame");
      const target = review.frameLocator("iframe").locator('td[data-cell="B2"]');
      await target.hover();
      await target.click();
      const composer = review.getByPlaceholder("Add a comment...");
      await expect(composer).toBeVisible();
      await composer.fill("Check this amount.");
      await review.getByRole("button", {name: "Save"}).click();
      await expect(fixture.page.getByRole("article").filter({hasText: "Check this amount."})).toBeVisible();
      const [thread] = await listThreadsOverApi(fixture, published.artifact.id);
      expect(anchorSchema.parse(thread?.anchor).elementContext.attrs).toContainEqual(["data-annotate", "data/revenue.csv#B2"]);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("EMB-002-F: hostile and over-limit CSV files show inline errors without freezing the page, markup stays text, and dot-segment sources are refused", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const page = `<!doctype html><main>
<as-embed id="unclosed" src="unclosed.csv"></as-embed>
<as-embed id="commas" src="commas.csv"></as-embed>
<as-embed id="large" src="large.csv"></as-embed>
<as-embed id="cells" src="cells.csv"></as-embed>
<as-embed id="ragged" src="ragged.csv"></as-embed>
<as-embed id="markup" src="markup.csv"></as-embed>
<as-embed id="dots" src="data/..%2Frevenue.csv"></as-embed>
<as-embed id="protocol-relative" src="//example.com/revenue.csv"></as-embed>
${runtime}</main>`;
      const published = await publishSite(fixture, [
        textFile("index.html", page, "text/html; charset=utf-8"),
        textFile("revenue.csv", revenueCsv, "text/csv"),
        textFile("unclosed.csv", `"${"x".repeat(mebibyte - 1)}`, "text/csv"),
        textFile("commas.csv", ",".repeat(mebibyte), "text/csv"),
        textFile("large.csv", "x".repeat(mebibyte + 1), "text/csv"),
        textFile("cells.csv", "a\n".repeat(20_001), "text/csv"),
        textFile("ragged.csv", `${",".repeat(255)}\n${"a\n".repeat(19_744)}`, "text/csv"),
        textFile("markup.csv", "Name\n<img src=x onerror=\"document.title='owned'\">\n<script>document.title='owned'</script>\n", "text/csv"),
      ], "emb-002-f-publish-site");
      const paths: string[] = [];
      fixture.context.on("request", (request) => paths.push(new URL(request.url()).pathname));
      await fixture.page.goto(await rawUrl(fixture, published));
      const error = (id: string) => fixture.page.locator(`#${id} .as-embed-error`);
      await Promise.all([
        expect(error("unclosed")).toHaveText("A quoted field of this table is never closed."),
        expect(error("commas")).toHaveText("A table has at most 256 columns."),
        expect(error("large")).toHaveText("large.csv is larger than the 1 MiB a table may hold."),
        expect(error("cells")).toHaveText("A table has at most 20000 cells."),
        expect(error("ragged")).toHaveText("A table has at most 20000 cells."),
        expect(fixture.page.locator("#dots")).toContainText("relative path"),
        expect(fixture.page.locator("#protocol-relative")).toContainText("relative path"),
        expect(fixture.page.locator('#markup td[data-cell="A2"]')).toHaveText("<img src=x onerror=\"document.title='owned'\">"),
        expect(fixture.page.locator('#markup td[data-cell="A3"]')).toHaveText("<script>document.title='owned'</script>"),
      ]);
      await expect(fixture.page.locator("#markup img, #markup script")).toHaveCount(0);
      expect(await fixture.page.evaluate(() => document.querySelectorAll("td").length)).toBeLessThan(100);
      expect(await fixture.page.evaluate(() => document.title)).not.toBe("owned");
      expect(paths).not.toContain("/revenue.csv");
      expect(paths.filter((path) => path.endsWith(".csv")).toSorted()).toEqual(
        ["/cells.csv", "/commas.csv", "/large.csv", "/markup.csv", "/ragged.csv", "/unclosed.csv"],
      );
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
