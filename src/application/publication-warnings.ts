import {Effect} from "effect";

import {diagramSourceRefusal} from "../core/diagram-source-rules.js";
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

/** A non-fatal problem found in a published version's HTML, Markdown, or Mermaid diagrams. */
export interface PublicationWarning {
  readonly code:
    | "blocked_host"
    | "diagram_refused"
    | "embed_runtime_missing"
    | "missing_reference";
  /** The manifest path of the file the problem is in. */
  readonly path: string;
  /** The reference as written or the refused diagram construct. */
  readonly reference: string;
}

/** A committed publication with the warnings computed over its version. */
export interface CommittedPublication extends PublishedVersion {
  readonly warnings: readonly PublicationWarning[];
}

interface FoundReference {
  readonly embed: boolean;
  readonly loads: "script" | "stylesheet" | null;
  readonly navigation: boolean;
  readonly url: string;
}

// ponytail: regex attribute scanner, not an HTML parser. It also reads references in comments, <template>, and script text, stops a tag at the first "<" or ">", and skips srcset, CSS url(), and URLs built by JavaScript; adopt a parser if false or missed warnings matter. Every pattern excludes the characters that open its next match, so scanning is linear in the text.
const htmlTagPattern = /<(a|as-embed|audio|iframe|img|link|script|source|video)\b([^<>]*)>/giu;
const urlAttributePattern =
  /\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu;
const relAttributePattern =
  /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu;
// ponytail: inline Markdown links and images only; reference-style definitions, raw HTML, and code spans are not told apart.
const markdownLinkPattern = /!?\[[^[\]\n]*\]\(\s*<?([^\s<>)]+)>?/gu;
// ponytail: top-level fences only; fences inside lists and block quotes are not read.
const markdownFencePattern = /^ {0,3}(`{3,}|~{3,})/u;
// ponytail: the content domain is unknown here, so an absolute script or stylesheet URL on a version host warns as blocked_host.
const artifactBase = new URL("https://artifact.invalid/");

/** The script every page with `<as-embed>` loads. */
const embedRuntimeScript = "/.artifactserver/embed.js";

type BlobReader = (
  entry: ManifestEntry,
) => Effect.Effect<Uint8Array, BlobStorageFailure>;

/** Warnings over one version's HTML, Markdown, and Mermaid diagrams; analysis never fails a publication. */
export const publicationWarnings = Effect.fn("publicationWarnings")(
  function*(
    manifest: CanonicalManifest,
    readBytes: BlobReader,
  ): Effect.fn.Return<readonly PublicationWarning[], BlobStorageFailure> {
    const paths = new Set(manifest.entries.map((entry) => entry.path));
    const warnings: PublicationWarning[] = [];
    let budget = maximumWarningScanBytes;
    for (const entry of manifest.entries) {
      const format = scannedFormat(entry);
      if (format === null || entry.size > budget) continue;
      budget -= entry.size;
      const text = new TextDecoder().decode(yield* readBytes(entry));
      for (const warning of fileWarnings(entry.path, format, text, manifest, paths)) {
        warnings.push(warning);
        if (warnings.length === maximumPublicationWarnings) return warnings;
      }
    }
    return warnings;
  },
  Effect.catchCause(() => Effect.succeed<readonly PublicationWarning[]>([])),
);

function fileWarnings(
  fromPath: string,
  format: "diagram" | "html" | "markdown",
  text: string,
  manifest: CanonicalManifest,
  paths: ReadonlySet<string>,
): readonly PublicationWarning[] {
  if (format === "diagram") {
    const refusal = diagramSourceRefusal(text);
    return refusal === null ? [] : [{code: "diagram_refused", path: fromPath, reference: refusal}];
  }
  const diagramWarnings = format === "markdown"
    ? mermaidFences(text).flatMap(({line, source}): readonly PublicationWarning[] => {
      const refusal = diagramSourceRefusal(source);
      return refusal === null ? [] : [{code: "diagram_refused", path: fromPath, reference: `line ${line}: ${refusal}`}];
    })
    : [];
  const references = format === "html" ? htmlReferences(text) : markdownReferences(text);
  const warnings = references.flatMap((reference) => {
    const warning = referenceWarning(reference, fromPath, manifest, paths);
    return warning === null ? [] : [warning];
  });
  const runtimeMissing = references.some((reference) => reference.embed) &&
    !references.some((reference) =>
      reference.loads === "script" && artifactPathname(reference.url, fromPath) === embedRuntimeScript
    );
  return runtimeMissing
    ? [...diagramWarnings, ...warnings, {code: "embed_runtime_missing", path: fromPath, reference: embedRuntimeScript}]
    : [...diagramWarnings, ...warnings];
}

/** Each Mermaid fence's opening line number and source. */
function mermaidFences(text: string): readonly {readonly line: number; readonly source: string}[] {
  const fences: {line: number; source: string}[] = [];
  let open: {readonly fence: string; readonly line: number; readonly lines: string[]; readonly mermaid: boolean} | null = null;
  for (const [index, line] of text.split(/\r\n|\r|\n/u).entries()) {
    const fence = markdownFencePattern.exec(line);
    const marker = fence?.[1] ?? "";
    const rest = line.slice(fence?.[0].length ?? 0);
    if (open === null) {
      if (fence !== null && !(marker.startsWith("`") && rest.includes("`"))) {
        const language = rest.trim().split(/\s/u)[0]?.toLowerCase() ?? "";
        open = {fence: marker, line: index + 1, lines: [], mermaid: language === "mermaid"};
      }
    } else if (fence !== null && marker[0] === open.fence[0] && marker.length >= open.fence.length && rest.trim() === "") {
      if (open.mermaid) fences.push({line: open.line, source: open.lines.join("\n")});
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  // An unclosed fence runs to the end of the document.
  if (open?.mermaid === true) fences.push({line: open.line, source: open.lines.join("\n")});
  return fences;
}

/** The pathname a reference resolves to inside the artifact, or null when it leaves it. */
function artifactPathname(reference: string, fromPath: string): string | null {
  try {
    const url = new URL(reference, new URL(fromPath.split("/").map(encodeURIComponent).join("/"), artifactBase));
    return url.origin === artifactBase.origin ? url.pathname : null;
  } catch {
    return null;
  }
}

function scannedFormat(entry: ManifestEntry): "diagram" | "html" | "markdown" | null {
  if (entry.path.endsWith(".mmd")) return "diagram";
  const essence = entry.mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (essence === "text/html" || essence === "application/xhtml+xml") return "html";
  return essence === "text/markdown" ? "markdown" : null;
}

function htmlReferences(text: string): readonly FoundReference[] {
  return [...text.matchAll(htmlTagPattern)].flatMap(([, tagName = "", attributes = ""]) => {
    const tag = tagName.toLowerCase();
    const stylesheet = tag === "link" && isStylesheet(attributes);
    return [...attributes.matchAll(urlAttributePattern)].map(
      ([, attribute = "", doubleQuoted, singleQuoted, bare]) => ({
        embed: tag === "as-embed",
        loads: loadKind(tag, attribute.toLowerCase(), stylesheet),
        navigation: tag === "a",
        url: (doubleQuoted ?? singleQuoted ?? bare ?? "").trim(),
      }),
    );
  });
}

function isStylesheet(attributes: string): boolean {
  const match = relAttributePattern.exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return value.toLowerCase().split(/\s+/u).includes("stylesheet");
}

function loadKind(
  tag: string,
  attribute: string,
  stylesheet: boolean,
): FoundReference["loads"] {
  if (tag === "script" && attribute === "src") return "script";
  if (stylesheet && attribute === "href") return "stylesheet";
  return null;
}

function markdownReferences(text: string): readonly FoundReference[] {
  return [...text.matchAll(markdownLinkPattern)].map(([, url = ""]) => ({
    embed: false,
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
    if (url.pathname.startsWith("/.artifactserver/")) return null;
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
