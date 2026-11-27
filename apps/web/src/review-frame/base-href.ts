import { installFragmentLinks } from "./fragment-links.ts";
import { SANDBOX_SHIM_SCRIPT } from "./sandbox-shim.ts";

/**
 * Multi-file artifacts reference their sub-resources relatively. The viewer
 * renders the entry document from a `srcdoc` sandbox, whose base URL is the
 * frame's own document, so those references would resolve against this
 * application. When the host knows a content-domain base for the version it
 * passes it here and the tag is spliced in as the first child of `<head>`,
 * where the first `<base>` in document order wins.
 */
const absoluteHttpUrl = /^https?:\/\/[^\s"'<>]+$/u;
const doctypeTag = /<!doctype\b[^>]*>/iu;
const resourceUrlAttributes = [
  ["[src]", "src"],
  ["link[href]", "href"],
  ["[poster]", "poster"],
  ["object[data]", "data"],
] as const;

/** Return `html` with a `<base href>` in place, or unchanged when it cannot be. */
export function withBaseHref(html: string, baseHref: string | null): string {
  if (!usableBase(baseHref)) return html;
  return transformDocument(html, (parsed) => resolveDocumentResources(parsed, baseHref));
}

/**
 * The document View frames: the page as published, with the content-domain
 * base when there is one and the sandbox shim ahead of every page script.
 */
export function viewDocument(html: string, baseHref: string | null): string {
  return transformDocument(html, (parsed) => {
    if (usableBase(baseHref)) resolveDocumentResources(parsed, baseHref);
    const shim = parsed.createElement("script");
    shim.textContent = SANDBOX_SHIM_SCRIPT;
    parsed.head.prepend(shim);
  });
}

function usableBase(baseHref: string | null): baseHref is string {
  return baseHref !== null && absoluteHttpUrl.test(baseHref);
}

function transformDocument(html: string, change: (parsed: Document) => void): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  change(parsed);
  const doctype = doctypeTag.exec(html)?.[0] ?? "";
  return `${doctype}${parsed.documentElement.outerHTML}`;
}

/**
 * Resolve parser-fetched resources before `srcdoc` navigation starts.
 *
 * Firefox can begin an image request against the frame document before a
 * dynamically supplied base URL settles, then retain the failed image even
 * after it retries the correct URL. Parsing here does not execute or fetch
 * anything. It makes eager resource attributes absolute up front, while the
 * base element still governs CSS, modules, runtime fetches, and navigation.
 */
function resolveDocumentResources(parsed: Document, baseHref: string): void {
  const base = parsed.createElement("base");
  base.href = baseHref;
  parsed.head.prepend(base);
  for (const [selector, attribute] of resourceUrlAttributes) {
    for (const element of parsed.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute);
      if (value === null || value.trim() === "") continue;
      try {
        element.setAttribute(attribute, new URL(value, baseHref).toString());
      } catch {
        // Leave invalid authored URLs intact so the browser reports them in
        // the artifact instead of turning Review into an HTML validator.
      }
    }
  }
  const fragmentLinks = parsed.createElement("script");
  fragmentLinks.textContent = `(${installFragmentLinks.toString()})();`;
  parsed.body.append(fragmentLinks);
}
