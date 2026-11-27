/** The runtime's directory on this content host. */
const runtimeBase = new URL("/.artifactserver/", import.meta.url);

/** A manifest path as a URL path, one encoded segment at a time. */
function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The URL of one file of this version on this content host. */
export function fileUrl(path: string): URL {
  return new URL(`/${encodedPath(path)}`, runtimeBase);
}

/** Comment routing: the embedded file's path and the encoded cell or element id inside it. */
export function annotateValue(path: string, reference: string): string {
  return `${path}#${encodeURIComponent(reference)}`;
}

/** Replace an embed's content with a readable error. */
export function showEmbedError(element: HTMLElement, message: string): void {
  const notice = document.createElement("p");
  notice.className = "as-embed-error";
  notice.textContent = message;
  element.setAttribute("data-embed-error", "");
  element.replaceChildren(notice);
}

/** Render every embed of one kind in document order; a failure becomes that embed's error. */
export function renderEach(
  kind: "diagram" | "table",
  render: (element: HTMLElement, path: string) => Promise<void>,
): Promise<void> {
  const elements = Array.from(document.querySelectorAll<HTMLElement>(`as-embed[data-embed-kind="${kind}"]`));
  return renderFrom(elements, render).then(announceRendered);
}

/** Tell a hosting frame (Review) that embeds changed the page; the message carries no data. */
function announceRendered(): void {
  if (window.parent !== window) window.parent.postMessage({type: "as-embeds-rendered"}, "*");
}

async function renderFrom(
  [element, ...rest]: readonly HTMLElement[],
  render: (element: HTMLElement, path: string) => Promise<void>,
): Promise<void> {
  if (element === undefined) return;
  const path = element.dataset["embedSrc"] ?? "";
  try {
    await render(element, path);
  } catch (cause) {
    showEmbedError(element, cause instanceof Error ? cause.message : `${path} could not be shown.`);
  }
  await renderFrom(rest, render);
}
