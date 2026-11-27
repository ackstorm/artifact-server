/**
 * Classic-script entry for `<script src="/.artifactserver/embed.js">`. It
 * resolves every `<as-embed src>` against this content host and imports only
 * the renderer modules for the types on the page. It imports nothing itself,
 * so the build emits it as a plain script.
 */
const embedKinds = [
  [".csv", "table"],
  [".mmd", "diagram"],
] as const;

const embedStyle = `as-embed{display:block;margin:1rem 0;max-width:100%;overflow:auto;font:13px/1.4 system-ui,sans-serif}
.as-embed-error{color:#b3261e;margin:0}
.as-embed-table{border-collapse:collapse}
.as-embed-table th,.as-embed-table td{border:1px solid #c7c7c7;padding:.15rem .4rem;white-space:pre;text-align:left}
.as-embed-table th{background:#f2f2f2;color:#555;font-weight:400;text-align:center}
.as-embed-table th[data-cell]{color:inherit;font-weight:600;text-align:left}
.as-embed-table td.as-embed-number{text-align:right}`;

const runtimeScript = document.currentScript;

function mountEmbeds(): void {
  if (!(runtimeScript instanceof HTMLScriptElement)) return;
  const runtime = new URL(runtimeScript.src);
  const style = document.createElement("style");
  style.textContent = embedStyle;
  document.head.append(style);
  const kinds = new Set<string>();
  for (const element of document.querySelectorAll("as-embed")) {
    const path = manifestPath(element.getAttribute("src"), runtime.origin);
    const kind = embedKinds.find(([suffix]) => path?.endsWith(suffix) === true)?.[1];
    if (path === null || kind === undefined) {
      element.setAttribute("data-embed-error", "");
      element.textContent =
        "An embed names a .csv or .mmd file of this artifact by relative path.";
      continue;
    }
    element.setAttribute("data-embed-src", path);
    element.setAttribute("data-embed-kind", kind);
    kinds.add(kind);
  }
  for (const kind of kinds) {
    void import(/* @vite-ignore */ new URL(`${kind}.js`, runtime).href).catch(() => {
      for (const element of document.querySelectorAll(`as-embed[data-embed-kind="${kind}"]`)) {
        element.textContent = "This embed's renderer could not load.";
      }
    });
  }
}

/** The manifest path a src names on this content host, or null when it leaves the host or names no manifest path. */
function manifestPath(src: string | null, origin: string): string | null {
  if (src === null || src.trim() === "") return null;
  try {
    const url = new URL(src, document.baseURI);
    if (url.origin !== origin) return null;
    const path = decodeURIComponent(url.pathname.slice(1));
    // Decoded dot or empty segments would name one path and fetch another.
    return path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ? null : path;
  } catch {
    return null;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountEmbeds, {once: true});
} else {
  mountEmbeds();
}
