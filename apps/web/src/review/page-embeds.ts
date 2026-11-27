import type {ReviewAnchor} from "@/review-frame/protocol";

/** One table or diagram file an HTML entry embeds, as Review tabs it. */
export interface PageEmbed {
  readonly path: string;
  readonly title: string;
}

const embedSuffixes = [".csv", ".mmd"];
const pageOrigin = "https://page.invalid";

/** The tables and diagrams an HTML entry embeds that exist in its version, once each, in document order. */
export function pageEmbeds(
  html: string,
  entryPath: string,
  manifestPaths: ReadonlySet<string>,
): readonly PageEmbed[] {
  const page = new URL(encodedPath(entryPath), `${pageOrigin}/`);
  const embeds: PageEmbed[] = [];
  for (const element of new DOMParser().parseFromString(html, "text/html").querySelectorAll("as-embed[src]")) {
    const path = manifestPathOf(element.getAttribute("src") ?? "", page);
    if (path === null || !embedSuffixes.some((suffix) => path.endsWith(suffix))) continue;
    if (!manifestPaths.has(path) || embeds.some((embed) => embed.path === path)) continue;
    const title = element.getAttribute("title")?.trim() ?? "";
    embeds.push({path, title: title === "" ? path.split("/").at(-1) ?? path : title});
  }
  return embeds;
}

/** A Review document that shows one embedded file full size through the same runtime. */
export function embedDocument(path: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><as-embed src="/${encodedPath(path)}"></as-embed><script src="/.artifactserver/embed.js"></script></body></html>`;
}

/** The embedded file a comment anchor's data-annotate names, when the page embeds it. */
export function embedPathOfAnchor(
  anchor: ReviewAnchor | null,
  embeds: readonly PageEmbed[],
): string | null {
  const value = anchor?.elementContext?.attrs?.find(([name]) => name === "data-annotate")?.[1];
  const separator = value?.lastIndexOf("#") ?? -1;
  if (value === undefined || separator < 0) return null;
  const path = value.slice(0, separator);
  return embeds.some((embed) => embed.path === path) ? path : null;
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function manifestPathOf(src: string, page: URL): string | null {
  try {
    const url = new URL(src, page);
    return url.origin === pageOrigin ? decodeURIComponent(url.pathname.slice(1)) : null;
  } catch {
    return null;
  }
}
