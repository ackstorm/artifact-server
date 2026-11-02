import {createHash} from "node:crypto";

import {expect, test, type Locator} from "@playwright/test";
import {z} from "zod";

import {publishNew, type PublishResponse} from "../support/publishing.js";
import {startTeamFixture, stopTeamFixture, type TeamFixture} from "./team-fixture.js";

const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({uploadUrl: z.url()})).min(1),
});

const ada = (scope: Locator) => scope.locator(".as-principal-chip").filter({hasText: "Ada"});

/** Publish a second version the way a signed-in member's browser session does. */
async function publishVersionFromSession(
  fixture: TeamFixture,
  published: PublishResponse,
  content: string,
): Promise<void> {
  const {baseUrl} = fixture.server;
  const headers = new Headers({
    "Content-Type": "application/json",
    Cookie: fixture.adaCookies.header,
    Origin: baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": fixture.adaCookies.csrf,
  });
  const bytes = new TextEncoder().encode(content);
  const upload = await fetch(`${baseUrl}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
      projectId: published.artifact.projectId,
      routingMode: "static",
    }),
    headers,
    method: "POST",
  });
  expect(upload.status).toBe(201);
  const plan = uploadPlanSchema.parse(await upload.json());
  const [file] = plan.files;
  expect((await fetch(file?.uploadUrl ?? "", {body: bytes, headers, method: "PUT"})).status)
    .toBe(200);
  headers.set("Idempotency-Key", "art-013-version-two");
  const commit = await fetch(plan.commitUrl, {
    body: JSON.stringify({target: {
      artifactId: published.artifact.id,
      expectedCurrentVersionId: published.version.id,
      kind: "new_version",
    }}),
    headers,
    method: "POST",
  });
  expect(commit.status).toBe(201);
}

test.describe("ART-013 attribution names", () => {
  test("ART-013-B: Details, Versions and Activity show names and initials, with \"via API key\" for key-authorized actions", async ({browser}) => {
    const fixture = await startTeamFixture(browser);
    try {
      const published = await publishNew(
        fixture.server,
        {...fixture.installation, apiToken: fixture.adaKey},
        {
          accessSetting: "account_required",
          content: "<!doctype html><title>O</title><h1>One</h1>",
          idempotencyKey: "art-013-version-one",
          name: "O",
          projectId: "prj_default",
        },
      );
      expect(published.response.status).toBe(201);
      await publishVersionFromSession(
        fixture,
        published.body,
        "<!doctype html><title>O</title><h1>Two</h1>",
      );

      const page = fixture.bob;
      await page.goto(`${fixture.server.baseUrl}/review?${new URLSearchParams({
        artifact: published.body.artifact.id,
        project: published.body.artifact.projectId,
      })}`);
      await expect(page.locator(".as-inspector-row").filter({hasText: "owner"})
        .locator(".as-principal-chip__avatar")).toHaveText("A");
      await expect(ada(page.locator(".as-inspector-row").filter({hasText: "owner"}))).toBeVisible();

      await page.getByRole("tab", {name: /Versions/u}).click();
      await expect(ada(page.locator(".as-version-list li"))).toHaveCount(2);

      await page.getByRole("tab", {name: /Activity/u}).click();
      const publications = page.locator(".as-activity-list li").filter({hasText: "Published version"});
      await expect(publications).toHaveCount(2);
      await expect(publications.filter({has: page.locator(".as-principal-chip__via", {hasText: "via API key"})})).toHaveCount(1);
      await expect(publications.filter({hasNot: page.locator(".as-principal-chip__via")})).toHaveCount(1);
      await expect(ada(publications.filter({hasNot: page.locator(".as-principal-chip__via")}))).toBeVisible();

      await expect(page.locator(".as-inspector__body")).not.toContainText(/mem_|service:/u);
    } finally {
      await stopTeamFixture(fixture);
    }
  });
});
