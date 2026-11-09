import {expect, test} from "@playwright/test";
import {z} from "zod";

import {publishNew, publishVersion} from "../support/publishing.js";
import {apiHeaders} from "../support/runtime-harness.js";
import {startTeamFixture, stopTeamFixture} from "./team-fixture.js";

const detailsSchema = z.object({links: z.object({review: z.url()})});
const projectResponseSchema = z.object({project: z.object({id: z.string()})});

test.describe("SHL-002 short Review links in the browser", () => {
  test("SHL-002-B: a short link opens Review on the artifact's own project and latest version, and a pinned link on its exact version", async ({browser}) => {
    const fixture = await startTeamFixture(browser);
    try {
      const ada = {...fixture.installation, apiToken: fixture.adaKey};
      // A second project: Review's fallback picks the first project, so only real resolution passes.
      const projectResponse = await fetch(`${fixture.server.baseUrl}/api/v1/projects`, {
        body: JSON.stringify({name: "Launch"}),
        headers: apiHeaders(ada, "shl-002-project-launch"),
        method: "POST",
      });
      expect(projectResponse.status).toBe(201);
      const projectId = projectResponseSchema.parse(await projectResponse.json()).project.id;
      const first = await publishNew(fixture.server, ada, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Plan</title><h1>First draft text</h1>",
        idempotencyKey: "shl-002-first-version",
        name: "Plan",
        projectId,
      });
      expect(first.response.status).toBe(201);
      const second = await publishVersion(fixture.server, ada, {
        artifactId: first.body.artifact.id,
        content: "<!doctype html><title>Plan</title><h1>Second draft text</h1>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "shl-002-second-version",
        projectId,
      });
      expect(second.response.status).toBe(201);
      const detailsResponse = await fetch(
        `${fixture.server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}`,
        {headers: {Authorization: `Bearer ${fixture.adaKey}`}},
      );
      const latestLink = detailsSchema.parse(await detailsResponse.json()).links.review;

      const page = fixture.ada;
      const preview = page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await page.goto(latestLink);
      await expect(page).toHaveURL(new RegExp(`[?&]project=${projectId}(?:&|$)`, "u"));
      await expect(preview.getByText("Second draft text")).toBeVisible();

      await page.goto(first.body.links.review);
      await expect(page).toHaveURL(new RegExp(`[?&]version=${first.body.version.id}(?:&|$)`, "u"));
      await expect(preview.getByText("First draft text")).toBeVisible();
    } finally {
      await stopTeamFixture(fixture);
    }
  });

  test("SHL-002-F: a short link to an artifact the reader cannot see shows the unavailable state and no content", async ({browser}) => {
    const fixture = await startTeamFixture(browser);
    try {
      const hidden = await publishNew(
        fixture.server,
        {...fixture.installation, apiToken: fixture.adaKey},
        {
          accessSetting: "private",
          content: "<!doctype html><title>Hidden</title><h1>Hidden plan text</h1>",
          idempotencyKey: "shl-002-hidden-plan",
          name: "Hidden",
          projectId: "prj_default",
        },
      );
      expect(hidden.response.status).toBe(201);

      const page = fixture.bob;
      await page.goto(hidden.body.links.review);
      await expect(page.getByText("Review target unavailable")).toBeVisible();
      await expect(
        page.frameLocator(".as-artifact-frame").frameLocator("iframe").getByText("Hidden plan text"),
      ).toHaveCount(0);
    } finally {
      await stopTeamFixture(fixture);
    }
  });
});
