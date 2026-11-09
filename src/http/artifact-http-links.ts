/** Build the stable browser URL for an artifact's current version. */
export function artifactBrowserUrl(
  applicationUrl: URL,
  artifactId: string,
): string {
  return new URL(`/artifacts/${artifactId}`, applicationUrl).toString();
}

const base62Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const shortCodePattern = /^[0-9A-Za-z]{22}$/u;
const uuidSpan = 2n ** 128n;

/** Write an `art_` or `ver_` UUID identity as its fixed 22-character base62 code. */
export function shortIdCode(id: string): string {
  let value = BigInt(`0x${id.slice(id.indexOf("_") + 1).replaceAll("-", "")}`);
  let code = "";
  for (let index = 0; index < 22; index += 1) {
    code = base62Alphabet.charAt(Number(value % 62n)) + code;
    value /= 62n;
  }
  return code;
}

/** Read a short code back into its `<prefix>_<uuid>` identity, or null when it is not a code. */
export function idFromShortCode(prefix: "art" | "ver", code: string): string | null {
  if (!shortCodePattern.test(code)) return null;
  let value = 0n;
  for (const character of code) {
    value = value * 62n + BigInt(base62Alphabet.indexOf(character));
  }
  if (value >= uuidSpan) return null;
  const hex = value.toString(16).padStart(32, "0");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Build the short Review URL for an artifact's latest version, or for one exact version. */
export function artifactReviewUrl(
  applicationUrl: URL,
  artifactId: string,
  versionId: string | null,
): string {
  const reviewUrl = new URL(`/a/${shortIdCode(artifactId)}`, applicationUrl);
  if (versionId !== null) reviewUrl.searchParams.set("v", shortIdCode(versionId));
  return reviewUrl.toString();
}

/** Build the browser origin for one exact immutable version. */
export function versionBrowserUrl(
  applicationUrl: URL,
  contentDomain: string,
  contentToken: string,
): string {
  const versionUrl = new URL(applicationUrl);
  versionUrl.hostname = `${contentToken}.${contentDomain}`;
  versionUrl.pathname = "/";
  versionUrl.search = "";
  versionUrl.hash = "";
  return versionUrl.toString();
}

/** Build the browser URL for one file within an immutable version. */
export function versionFileBrowserUrl(
  applicationUrl: URL,
  contentDomain: string,
  contentToken: string,
  manifestPath: string,
): string {
  const fileUrl = new URL(
    versionBrowserUrl(applicationUrl, contentDomain, contentToken),
  );
  fileUrl.pathname = `/${manifestPath.split("/").map(encodeURIComponent).join("/")}`;
  return fileUrl.toString();
}

/** Build the one-time URL that establishes a private version browser session. */
export function contentBootstrapBrowserUrl(
  applicationUrl: URL,
  contentDomain: string,
  contentToken: string,
  bootstrapToken: string,
  destinationPath?: string,
): string {
  const bootstrapUrl = new URL(applicationUrl);
  bootstrapUrl.hostname = `${contentToken}.${contentDomain}`;
  bootstrapUrl.pathname = destinationPath === undefined
    ? "/"
    : `/${destinationPath.split("/").map(encodeURIComponent).join("/")}`;
  bootstrapUrl.search = new URLSearchParams({
    __artifact_bootstrap: bootstrapToken,
  }).toString();
  bootstrapUrl.hash = "";
  return bootstrapUrl.toString();
}

/** Build the content-host base URL for one short-lived embedded Review lease. */
export function previewLeaseBrowserUrl(
  applicationUrl: URL,
  contentDomain: string,
  leaseToken: string,
): string {
  return versionBrowserUrl(applicationUrl, contentDomain, leaseToken);
}
