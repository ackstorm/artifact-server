import {expect} from "vitest";

/** Follows a short Review link and returns the Review address it redirects to. */
export async function followReviewLink(link: string): Promise<URL> {
  const response = await fetch(link, {redirect: "manual"});
  expect(response.status).toBe(308);
  return new URL(response.headers.get("location") ?? "", link);
}

/** Asserts a short Review link opens exactly one version in focus view. */
export async function expectExactReviewLink(
  link: string,
  expected: {readonly artifactId: string; readonly versionId: string},
): Promise<void> {
  expect(link).not.toContain("__artifact_bootstrap=");
  expect(new URL(link).pathname).toMatch(/^\/a\/[0-9A-Za-z]{22}$/u);
  const review = await followReviewLink(link);
  expect(review.pathname).toBe("/review");
  expect(Object.fromEntries(review.searchParams)).toEqual({
    artifact: expected.artifactId,
    version: expected.versionId,
    view: "focus",
  });
}
