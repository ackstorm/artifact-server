import {Effect} from "effect";

import type {BlobStorageFailure} from "../core/errors.js";
import type {
  CanonicalManifest,
  ManifestEntry,
  PublishedVersion,
} from "../core/model.js";
import {
  maximumPublicationWarnings,
  maximumWarningScanBytes,
} from "../core/publishing-limits.js";
import {reviewFrameAllows} from "../core/review-frame-sources.js";

/** A non-fatal problem found in a published version's HTML or Markdown. */
export interface PublicationWarning {
  readonly code: "blocked_host" | "missing_reference";
  /** The manifest path of the file containing the reference. */
  readonly path: string;
  /** The reference as written. */
  readonly reference: string;
}

/** A committed publication with the warnings computed over its version. */
export interface CommittedPublication extends PublishedVersion {
  readonly warnings: readonly PublicationWarning[];
}

interface FoundReference {
  readonly loads: "script" | "stylesheet" | null;
  readonly navigation: boolean;
  readonly url: string;
}

// ponytail: regex attribute scanner, not an HTML parser. It also reads references in comments, <template>, and script text, stops an attribute list at the first ">", and skips srcset, CSS url(), and URLs built by JavaScript; adopt a parser if false or missed warnings matter.
const htmlTagPattern = /<(a|audio|iframe|img|link|script|source|video)\b([^>]*)>/giu;
const urlAttributePattern =
  /\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu;
const stylesheetRelPattern =
  /\srel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|stylesheet\b)/iu;
// ponytail: inline Markdown links and images only; reference-style definitions, raw HTML, and code spans are not told apart.
const markdownLinkPattern = /!?\[[^\]]*\]\(\s*<?([^\s<>)]+)>?/gu;
// ponytail: the content domain is unknown here, so an absolute script or stylesheet URL on a version host warns as blocked_host.
const artifactBase = new URL("https://artifact.invalid/");

type BlobReader = (
  entry: ManifestEntry,
) => Effect.Effect<Uint8Array, BlobStorageFailure>;

/** Warnings over one version's HTML and Markdown; analysis never fails a publication. */
export const publicationWarnings = Effect.fn("publicationWarnings")(
  function*(
    manifest: CanonicalManifest,
    readBytes: BlobReader,
  ): Effect.fn.Return<readonly PublicationWarning[], BlobStorageFailure> {
    const paths = new Set(manifest.entries.map((entry) => entry.path));
    const warnings: PublicationWarning[] = [];
    let budget = maximumWarningScanBytes;
    for (const entry of manifest.entries) {
      const format = scannedFormat(entry.mediaType);
      if (format === null || entry.size > budget) continue;
      budget -= entry.size;
      const text = new TextDecoder().decode(yield* readBytes(entry));
      const references = format === "html" ? htmlReferences(text) : markdownReferences(text);
      for (const reference of references) {
        const warning = referenceWarning(reference, entry.path, manifest, paths);
        if (warning !== null) warnings.push(warning);
        if (warnings.length === maximumPublicationWarnings) return warnings;
      }
    }
    return warnings;
  },
  Effect.catchCause(() => Effect.succeed<readonly PublicationWarning[]>([])),
);

function scannedFormat(mediaType: string): "html" | "markdown" | null {
  const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (essence === "text/html" || essence === "application/xhtml+xml") return "html";
  return essence === "text/markdown" ? "markdown" : null;
}

function htmlReferences(text: string): readonly FoundReference[] {
  return [...text.matchAll(htmlTagPattern)].flatMap(([, tagName = "", attributes = ""]) => {
    const tag = tagName.toLowerCase();
    return [...attributes.matchAll(urlAttributePattern)].map(
      ([, attribute = "", doubleQuoted, singleQuoted, bare]) => ({
        loads: loadKind(tag, attribute.toLowerCase(), attributes),
        navigation: tag === "a",
        url: (doubleQuoted ?? singleQuoted ?? bare ?? "").trim(),
      }),
    );
  });
}

function loadKind(
  tag: string,
  attribute: string,
  attributes: string,
): FoundReference["loads"] {
  if (tag === "script" && attribute === "src") return "script";
  if (tag === "link" && attribute === "href" && stylesheetRelPattern.test(attributes)) {
    return "stylesheet";
  }
  return null;
}

function markdownReferences(text: string): readonly FoundReference[] {
  return [...text.matchAll(markdownLinkPattern)].map(([, url = ""]) => ({
    loads: null,
    navigation: false,
    url,
  }));
}

function referenceWarning(
  reference: FoundReference,
  fromPath: string,
  manifest: CanonicalManifest,
  paths: ReadonlySet<string>,
): PublicationWarning | null {
  let url: URL;
  try {
    url = new URL(
      reference.url,
      new URL(fromPath.split("/").map(encodeURIComponent).join("/"), artifactBase),
    );
  } catch {
    return null;
  }
  if (url.origin === artifactBase.origin) {
    if (reference.navigation && manifest.routingMode === "spa") return null;
    const path = manifestPathOf(url, manifest.entryPath);
    return path === null || paths.has(path)
      ? null
      : {code: "missing_reference", path: fromPath, reference: reference.url};
  }
  if (
    reference.loads === null ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    reviewFrameAllows(reference.loads, url)
  ) {
    return null;
  }
  return {code: "blocked_host", path: fromPath, reference: reference.url};
}

function manifestPathOf(url: URL, entryPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
  if (path === "") return entryPath;
  return path.endsWith("/") ? `${path}index.html` : path;
}
