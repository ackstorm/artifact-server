import DOMPurify from "dompurify";

export {diagramSourceRefusal} from "../../../../src/core/diagram-source-rules.ts";

/** Mermaid output as one sanitized SVG element, or why it is refused. */
export function sanitizedDiagramSvg(
  rendered: string,
): {readonly svg: SVGSVGElement} | {readonly refusal: string} {
  if (/url\s*\(\s*["']?\s*(?!#)[^\s)"']|@import/iu.test(rendered)) {
    return {refusal: "Diagram contains unsupported external styling."};
  }
  // Parse only after sanitation; diagram-provided markup is never mounted unsanitized.
  const fragment = DOMPurify.sanitize(rendered, {
    USE_PROFILES: {svg: true, svgFilters: true},
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["foreignObject", "foreignobject", "script", "a", "image", "use", "animate", "animateMotion", "animateTransform", "set"],
    FORBID_ATTR: ["href", "xlink:href"],
    RETURN_DOM_FRAGMENT: true,
  });
  const svg = fragment.firstElementChild;
  const extraText = Array.from(fragment.childNodes).some((node) =>
    node.nodeType !== Node.ELEMENT_NODE && (node.textContent ?? "").trim() !== ""
  );
  if (fragment.children.length !== 1 || !(svg instanceof SVGSVGElement) || extraText) {
    return {refusal: "This diagram did not produce a valid SVG preview."};
  }
  return {svg};
}
