import mermaid from "mermaid";

import {diagramSourceRefusal, sanitizedDiagramSvg} from "../review/diagram-safety.ts";
import {mermaidConfiguration} from "../review/diagram-sandbox-protocol.ts";
import {annotateValue, fileUrl, renderEach} from "./embed-dom.ts";

const occurrences = new Map<string, number>();

/** FNV-1a of the path: a render id that is stable wherever the page shows the file, so DOM ids match between the Overview and the file's tab. */
function renderId(path: string): string {
  let hash = 0x811c9dc5;
  for (const character of path) hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  const occurrence = (occurrences.get(path) ?? 0) + 1;
  occurrences.set(path, occurrence);
  return `as-embed-${hash.toString(16)}-${occurrence}`;
}

void renderEach("diagram", async (element, path) => {
  const response = await fetch(fileUrl(path)).catch(() => null);
  if (response?.ok !== true) throw new Error(`${path} could not be loaded.`);
  const text = await response.text();
  const refusal = diagramSourceRefusal(text);
  if (refusal !== null) throw new Error(refusal);
  const id = renderId(path);
  mermaid.initialize(mermaidConfiguration(id, !window.matchMedia("(prefers-color-scheme: dark)").matches));
  const output = await mermaid.render(id, text).catch(() => {
    throw new Error(`${path} could not be rendered as a Mermaid diagram.`);
  });
  const result = sanitizedDiagramSvg(output.svg);
  if ("refusal" in result) throw new Error(result.refusal);
  result.svg.setAttribute("data-annotate", annotateValue(path, ""));
  for (const group of result.svg.querySelectorAll("g")) {
    group.setAttribute("data-annotate", annotateValue(path, group.closest("g[id]")?.id.slice(id.length + 1) ?? ""));
  }
  element.replaceChildren(result.svg);
});
