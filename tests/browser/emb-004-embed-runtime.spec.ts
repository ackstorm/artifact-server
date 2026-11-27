import {readFileSync} from "node:fs";
import {Script} from "node:vm";

import {expect, type Locator, test} from "@playwright/test";

import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {flowDiagram, publishSite, rawUrl, revenueCsv, reviewUrl, textFile} from "./embed-fixture.js";

interface Scope {
  locator(selector: string): Locator;
}

const diagramPage = `<!doctype html><html><body><as-embed src="flow.mmd"></as-embed>
<script src="/.artifactserver/embed.js"></script></body></html>`;

const embedPage = `<!doctype html><html><head><title>Embeds</title></head><body><main>
<h1>Quarter</h1>
<as-embed src="data/revenue.csv" title="Revenue"></as-embed>
<as-embed src="flow.mmd"></as-embed>
<script src="/.artifactserver/embed.js"></script>
</main></body></html>`;

interface RuntimeRequests {
  readonly hosts: string[];
  readonly paths: string[];
}

function runtimeRequests(fixture: BrowserFixture): RuntimeRequests {
  const seen = {hosts: new Array<string>(), paths: new Array<string>()};
  fixture.context.on("request", (request) => {
    const url = new URL(request.url());
    seen.hosts.push(url.hostname);
    if (url.pathname.startsWith("/.artifactserver/")) seen.paths.push(url.pathname);
  });
  return seen;
}

async function expectRendered(scope: Scope): Promise<void> {
  const table = scope.locator('as-embed[data-embed-kind="table"]');
  await expect(table).toHaveAttribute("data-embed-src", "data/revenue.csv");
  await expect(table.locator('td[data-annotate="data/revenue.csv#B2"]')).toHaveText("1,200");
  await expect(table.locator('td[data-annotate="data/revenue.csv#B2"]')).toBeVisible();
  await expect(scope.locator('as-embed[data-embed-kind="diagram"] svg')).toBeVisible();
  await expect(scope.locator('as-embed[data-embed-kind="diagram"] g[data-annotate^="flow.mmd#"]').first()).toBeAttached();
}

test.describe("embed runtime", () => {
  test("EMB-004-B: tables and diagrams render in place in Review View, Review Comment, and the raw link, loading only the modules the page uses", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishSite(fixture, [
        textFile("index.html", embedPage, "text/html; charset=utf-8"),
        textFile("data/revenue.csv", revenueCsv, "text/csv; charset=utf-8"),
        textFile("flow.mmd", flowDiagram, "text/plain; charset=utf-8"),
        textFile("diagram.html", diagramPage, "text/html; charset=utf-8"),
      ], "emb-004-b-publish-site");
      const seen = runtimeRequests(fixture);
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, published, "&mode=view"));
      await expectRendered(fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe"));
      await fixture.page.goto(reviewUrl(fixture, published, "&mode=comment"));
      await expectRendered(fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe"));
      await fixture.page.goto(await rawUrl(fixture, published));
      await expectRendered(fixture.page);

      expect(seen.paths).toEqual(expect.arrayContaining([
        "/.artifactserver/embed.js",
        "/.artifactserver/table.js",
        "/.artifactserver/diagram.js",
      ]));
      seen.paths.length = 0;
      await fixture.page.goto(new URL("diagram.html", fixture.page.url()).toString());
      await expect(fixture.page.locator('as-embed[data-embed-kind="diagram"] svg')).toBeVisible();
      expect(seen.paths).not.toContain("/.artifactserver/table.js");
      expect(() => new Script(readFileSync("dist/web/embed/embed.js", "utf8"))).not.toThrow();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("EMB-004-F: off-host, unsupported, missing, and hostile embeds show inline errors or sanitized output without leaving the version host", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const otherHost = `http://othervrsn0123456789.localhost:${fixture.server.port}`;
      const hostilePage = `<!doctype html><html><body><main>
<as-embed id="remote" src="https://example.com/data/revenue.csv"></as-embed>
<as-embed id="other-host" src="${otherHost}/data/revenue.csv"></as-embed>
<as-embed id="unsupported" src="notes.txt"></as-embed>
<as-embed id="missing" src="data/missing.csv"></as-embed>
<as-embed id="configured" src="configured.mmd"></as-embed>
<as-embed id="clicky" src="clicky.mmd"></as-embed>
<as-embed id="markup" src="markup.mmd"></as-embed>
<script src="/.artifactserver/embed.js"></script>
</main></body></html>`;
      const published = await publishSite(fixture, [
        textFile("index.html", hostilePage, "text/html; charset=utf-8"),
        textFile("notes.txt", "plain\n", "text/plain"),
        textFile("configured.mmd", "%%{init: {\"securityLevel\": \"loose\"}}%%\nflowchart LR\n  a --> b\n", "text/plain"),
        textFile("clicky.mmd", "flowchart LR\n  a --> b\n  click a call alert(1)\n", "text/plain"),
        textFile("markup.mmd", "flowchart LR\n  a[\"<img src=x onerror=alert(1)>\"] --> b\n", "text/plain"),
      ], "emb-004-f-publish-site");
      const seen = runtimeRequests(fixture);
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(fixture, published, "&mode=view"));
      const page = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await Promise.all(["remote", "other-host", "unsupported"].flatMap((id) => [
        expect(page.locator(`#${id}`)).toHaveAttribute("data-embed-error", ""),
        expect(page.locator(`#${id}`)).toContainText("relative path"),
      ]));
      await expect(page.locator("#missing .as-embed-error")).toContainText("data/missing.csv");
      await Promise.all([["configured", "%%{"], ["clicky", "click"]].map(([id, construct]) =>
        expect(page.locator(`#${id} .as-embed-error`))
          .toHaveText(`Diagram configuration and interactive styling are disabled in preview: ${construct}.`)));
      await expect(page.locator("#markup svg")).toBeVisible();
      await expect(page.locator("#markup img")).toHaveCount(0);
      expect(seen.hosts).not.toContain("example.com");
      expect(seen.hosts).not.toContain("othervrsn0123456789.localhost");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
