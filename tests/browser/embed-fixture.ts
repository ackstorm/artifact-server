import {expect} from "@playwright/test";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import type {BrowserFixture} from "./browser-fixture.js";

const encoder = new TextEncoder();
const bootstrapSchema = z.object({bootstrapUrl: z.url()}).loose();

export function textFile(path: string, text: string, mediaType: string): TestSiteFile {
  return {bytes: encoder.encode(text), mediaType, path};
}

/** Quoted commas, doubled quotes, a newline inside quotes, and CRLF line ends. */
export const revenueCsv = "Region,\"Revenue, EUR\",Note\r\nNorth,\"1,200\",\"Said \"\"hi\"\"\"\r\nSouth,-3.5,\"two\nlines\"\r\n";

export const flowDiagram = "flowchart LR\n  draft[Draft] --> review[Review]\n";

export async function publishSite(
  fixture: BrowserFixture,
  files: readonly TestSiteFile[],
  idempotencyKey: string,
): Promise<PublishResponse> {
  const upload = await createStagedUpload(fixture.server, fixture.installation, "index.html", files);
  const uploads = await uploadEveryStagedFile(fixture.installation, upload.body, files);
  expect(uploads.every((response) => response.ok)).toBe(true);
  return (await commitStagedUpload(fixture.installation, upload.body, idempotencyKey, {
    accessSetting: "account_required",
    kind: "new_artifact",
    name: "Embedded objects",
  })).body;
}

export function reviewUrl(fixture: BrowserFixture, published: PublishResponse, query: string): string {
  return `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.artifact.id}&version=${published.version.id}${query}`;
}

/** A one-time raw-link bootstrap for the version's entry. */
export async function rawUrl(fixture: BrowserFixture, published: PublishResponse): Promise<string> {
  const response = await fetch(
    `${fixture.server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/content-sessions?projectId=${published.artifact.projectId}`,
    {headers: {Authorization: `Bearer ${fixture.installation.apiToken}`}, method: "POST"},
  );
  expect(response.status).toBe(201);
  return bootstrapSchema.parse(await response.json()).bootstrapUrl;
}
