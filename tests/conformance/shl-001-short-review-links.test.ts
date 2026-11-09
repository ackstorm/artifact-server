import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {publishNew, publishVersion} from "../support/publishing.js";
import {expectExactReviewLink, followReviewLink} from "../support/review-links.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const projectResponseSchema = z.object({project: z.object({id: z.string()})});
const detailsSchema = z.object({
  artifact: z.object({
    currentVersionId: z.string(),
    id: z.string(),
    projectId: z.string(),
  }),
  links: z.object({review: z.url()}),
});

describe("SHL-001 short Review links", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  const apiGet = (path: string): Promise<Response> =>
    fetch(`${server.baseUrl}${path}`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });

  const createProject = async (name: string): Promise<string> => {
    const response = await fetch(`${server.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name}),
      headers: apiHeaders(installation, `shl-001-project-${name}`),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return projectResponseSchema.parse(await response.json()).project.id;
  };

  test("SHL-001-B: short links open the latest or one exact version, and an artifact ID alone finds its project", async () => {
    const projectId = await createProject("Launch");
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><h1>One</h1>",
      idempotencyKey: "short-link-publish-one",
      projectId,
    });
    expect(first.response.status).toBe(201);
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><h1>Two</h1>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "short-link-publish-two",
      projectId,
    });
    expect(second.response.status).toBe(201);

    await expectExactReviewLink(first.body.links.review, {
      artifactId: first.body.artifact.id,
      versionId: first.body.version.id,
    });
    await expectExactReviewLink(second.body.links.review, {
      artifactId: first.body.artifact.id,
      versionId: second.body.version.id,
    });

    // Two active projects exist, so only the artifact's own project can answer.
    const detailsResponse = await apiGet(`/api/v1/artifacts/${first.body.artifact.id}`);
    expect(detailsResponse.status).toBe(200);
    const details = detailsSchema.parse(await detailsResponse.json());
    expect(details.artifact.projectId).toBe(projectId);
    expect(details.artifact.currentVersionId).toBe(second.body.version.id);
    expect(new URL(details.links.review).search).toBe("");
    const latest = await followReviewLink(details.links.review);
    expect(Object.fromEntries(latest.searchParams)).toEqual({
      artifact: first.body.artifact.id,
      view: "focus",
    });

    const withPath = await followReviewLink(
      `${first.body.links.review}&path=index.html&mode=annotate`,
    );
    expect(Object.fromEntries(withPath.searchParams)).toEqual({
      artifact: first.body.artifact.id,
      mode: "annotate",
      path: "index.html",
      version: first.body.version.id,
      view: "focus",
    });
  });

  test("SHL-001-F: malformed short codes answer not found, and an unknown artifact read without a project stays not found", async () => {
    await createProject("Second");
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><h1>One</h1>",
      idempotencyKey: "short-link-hostile-publish",
      projectId: "prj_default",
    });
    const code = new URL(published.body.links.review).pathname.slice("/a/".length);
    const malformedPaths = [
      "/a/short",
      `/a/${code}0`,
      `/a/${code.slice(0, 21)}-`,
      `/a/${code.slice(0, 21)}_`,
      "/a/zzzzzzzzzzzzzzzzzzzzzz",
      `/a/${code}?v=short`,
      `/a/${code}?v=zzzzzzzzzzzzzzzzzzzzzz`,
      `/a/${code}?v=`,
    ];
    const outcomes = await Promise.all(malformedPaths.map(async (path) => {
      const response = await fetch(`${server.baseUrl}${path}`, {redirect: "manual"});
      return {location: response.headers.get("location"), path, status: response.status};
    }));
    expect(outcomes).toEqual(
      malformedPaths.map((path) => ({location: null, path, status: 404})),
    );

    const unknown = await apiGet("/api/v1/artifacts/art_00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({
      error: {code: "ARTIFACT_NOT_FOUND"},
    });
  });
});
