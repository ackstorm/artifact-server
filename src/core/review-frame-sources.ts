/**
 * Hosts the Review frame CSP allows beside the content hosts: the public CDNs
 * and Google Fonts stylesheets that claude.ai Artifacts allow, so pages written
 * for that platform render unchanged.
 */
export const reviewFrameScriptSources = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net/npm/",
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
  "https://code.jquery.com",
] as const;

export const reviewFrameStyleSources = ["https://fonts.googleapis.com"] as const;

/** Whether the Review frame CSP lets a page load a script or stylesheet from `url`. */
export function reviewFrameAllows(load: "script" | "stylesheet", url: URL): boolean {
  const sources = load === "script" ? reviewFrameScriptSources : reviewFrameStyleSources;
  return sources.some((source) => {
    const allowed = new URL(source);
    return url.protocol === allowed.protocol &&
      url.host === allowed.host &&
      url.pathname.startsWith(allowed.pathname);
  });
}
