import {expect, test} from "@playwright/test";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {listThreadsOverApi} from "./comment-api.js";

const storedAnchorSchema = z.object({
  elementContext: z.object({
    classes: z.array(z.string()).optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    tag: z.string(),
    text: z.string().optional(),
  }).loose(),
  htmlAnchor: z.object({selector: z.string()}).loose(),
  originalText: z.string(),
}).loose();

const page = `<!doctype html><html><body><main><h2>Draft</h2>
<button id="save" class="btn primary" type="button">Save draft</button>
<button id="huge" type="button" aria-label="${"A".repeat(5_000)}">${"word ".repeat(5_000)}</button>
</main></body></html>`;

async function commentOn(
  fixture: BrowserFixture,
  idempotencyKey: string,
  selector: string,
  body: string,
) {
  const published = await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: page,
    idempotencyKey,
    name: "Element context",
  });
  await localLogin(fixture);
  await fixture.page.goto(
    `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}&mode=comment`,
  );
  const review = fixture.page.frameLocator(".as-artifact-frame");
  const preview = review.frameLocator("iframe");
  await preview.locator(selector).hover();
  await preview.locator(selector).click();
  const composer = review.getByPlaceholder("Add a comment...");
  await expect(composer).toBeVisible();
  await composer.fill(body);
  await review.getByRole("button", {name: "Save"}).click();
  await expect(fixture.page.getByRole("article").filter({hasText: body})).toBeVisible();
  const [thread] = await listThreadsOverApi(fixture, published.body.artifact.id);
  return thread?.anchor;
}

test.describe("element context in comment anchors", () => {
  test("CMT-023-B: a pinpoint comment stores the element's context inside its anchor", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const anchor = storedAnchorSchema.parse(
        await commentOn(fixture, "cmt-023-element-context-b", "#save", "Rename this button."),
      );
      expect(anchor.elementContext).toMatchObject({
        classes: ["btn", "primary"],
        id: "save",
        tag: "button",
      });
      expect(anchor.elementContext.path).toContain("button#save");
      expect(anchor.htmlAnchor.selector).toContain("save");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-023-F: page-controlled element context stays bounded inside the 16 KiB anchor", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const stored = await commentOn(fixture, "cmt-023-element-context-f", "#huge", "Shorten this label.");
      expect(new TextEncoder().encode(JSON.stringify(stored)).byteLength)
        .toBeLessThanOrEqual(16_384);
      const anchor = storedAnchorSchema.parse(stored);
      expect(anchor.elementContext.tag).toBe("button");
      expect(anchor.elementContext.name?.length ?? 0).toBeLessThanOrEqual(120);
      expect(anchor.elementContext.text?.length ?? 0).toBeLessThanOrEqual(300);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
