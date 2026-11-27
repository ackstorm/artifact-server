/**
 * The Mermaid sources a preview refuses, shared by the web renderers and the
 * server's publication warnings.
 */

/** Largest Mermaid source a preview renders, in characters. */
export const diagramTextLimit = 20_000;

// User configuration, event links, and custom CSS cannot cross the renderer's security boundary.
// Whitespace before a line keyword stops at a line end, so the scan is linear in the source.
const refusedConstructPattern =
  /(%%\s*\{)|^[^\S\n\r\u2028\u2029]*(---)|(?:^|[;\n])[^\S\n\r\u2028\u2029]*(click|classDef|style|linkStyle)\s/imu;

/** Why a Mermaid source is not rendered, naming the refused construct, or null when it may be. */
export function diagramSourceRefusal(text: string): string | null {
  if (text.length > diagramTextLimit) return `Diagram exceeds the preview size limit of ${diagramTextLimit} characters.`;
  const match = refusedConstructPattern.exec(text);
  if (match === null) return null;
  const construct = match[1] === undefined ? match[2] ?? match[3] ?? "" : "%%{";
  return `Diagram configuration and interactive styling are disabled in preview: ${construct}.`;
}
