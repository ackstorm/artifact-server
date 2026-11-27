/**
 * Boundary declaration for `@plannotator/ui/components/html-viewer`.
 *
 * The package ships raw `.tsx` source, so `tsc --noEmit` would otherwise
 * type-check ~5,400 lines of third-party code under this repository's much
 * stricter options (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
 * `noPropertyAccessFromIndexSignature`) and report 886 errors we may not fix.
 * `apps/web/tsconfig.json` maps `@plannotator/ui/*` here so the compiler sees
 * this declared contract instead; Vite still bundles the real source.
 *
 * Mirrors @plannotator/ui@0.66.0:
 *   components/html-viewer/HtmlViewer.tsx:227-597 (HtmlViewerProps)
 *   components/Viewer.tsx:546-549 (ViewerHandle)
 *   types.ts:23, 83-118, 127-165 (AnnotationType, Annotation, anchors)
 *   components/html-viewer/index.ts:25 (buildPersistedHtmlAnchor) and
 *   @plannotator/core@0.25.34 html-anchor.ts:66-100, 426-571
 * Only the props this application drives are declared; unused Vim, diff,
 * attachment, and Ask-AI inputs are deliberately omitted so they cannot be
 * passed by accident.
 */
import type { ReactNode, RefAttributes } from "react";

/** Verified-unique CSS selector plus fingerprint for one annotated element. */
export interface HtmlElementAnchor {
  selector: string;
  tagName: string;
  text?: string | undefined;
  point?: {x: number; y: number} | undefined;
}

/** Bounded agent-facing description of a pinpointed element (types.ts:179-230). */
export interface HtmlElementContext {
  tag: string;
  id?: string | undefined;
  classes?: string[] | undefined;
  path?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  attrs?: Array<[string, string]> | undefined;
  text?: string | undefined;
  outline?: string | undefined;
  children?: number | undefined;
  rect?: {x: number; y: number; w: number; h: number; vw: number; vh: number} | undefined;
  landmark?: string | undefined;
  heading?: string | undefined;
  component?: string | undefined;
  page?: {url: string; title?: string | undefined} | undefined;
  sourceName?: string | undefined;
}

/** One additional element covered by a multi-target pinpoint comment. */
export interface HtmlAnnotationTarget {
  label?: string | undefined;
  text: string;
  anchor?: HtmlElementAnchor | undefined;
  context?: HtmlElementContext | undefined;
}

/** The anchor record a host persists for one raw-HTML comment. */
export interface PersistedHtmlAnchor {
  originalText: string;
  htmlAnchor?: HtmlElementAnchor | undefined;
  htmlAdditionalTargets?: HtmlAnnotationTarget[] | undefined;
  elementContext?: HtmlElementContext | undefined;
}

/** Validate and bound one composed comment's anchor for persistence. */
export declare function buildPersistedHtmlAnchor(
  source: {
    originalText: string;
    htmlAnchor?: HtmlElementAnchor | null | undefined;
    htmlAdditionalTargets?: readonly HtmlAnnotationTarget[] | null | undefined;
    elementContext?: HtmlElementContext | null | undefined;
  },
  options?: {maxBytes?: number | undefined; maxTargets?: number | undefined},
): {
  anchor: PersistedHtmlAnchor;
  droppedTargets: number;
  capDroppedTargets: number;
  sizeDroppedTargets: number;
};

/** The annotation kinds the viewer distinguishes (string enum in the package). */
export type AnnotationKind = "COMMENT" | "DELETION" | "GLOBAL_COMMENT";

/** The annotation record the viewer renders and emits. */
export interface Annotation {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  type: AnnotationKind;
  text?: string | undefined;
  originalText: string;
  createdA: number;
  author?: string | undefined;
  htmlAnchor?: HtmlElementAnchor | undefined;
  htmlAdditionalTargets?: HtmlAnnotationTarget[] | undefined;
  elementContext?: HtmlElementContext | undefined;
}

/** Imperative repaint handle for a prop-driven mount. */
export interface ViewerHandle {
  removeHighlight: (id: string) => void;
  clearAllHighlights: () => void;
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

/** Inputs for the sandboxed raw-HTML viewer and its parent-side annotation UI. */
export interface HtmlViewerProps {
  rawHtml: string;
  /** The srcdoc frame's whole `sandbox` attribute; absent widens it with `allow-modals`. */
  sandbox?: string | undefined;
  /** A non-fragment link the frame swallowed, as its raw, screened href. */
  onOpenLink?: ((href: string) => void) | undefined;
  /** False drops the image button from every comment box. */
  allowCommentImages?: boolean | undefined;
  annotations: Annotation[];
  onAddAnnotation: (annotation: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: "selection" | "comment" | "redline" | "quickLabel";
  inputMethod: "drag" | "pinpoint";
  annotateModeActive?: boolean | undefined;
  onAnnotateModeExit?: (() => void) | undefined;
  onAnnotateModeToggle?: (() => void) | undefined;
  fullViewport?: boolean | undefined;
  hideControls?: boolean | undefined;
  readOnly?: boolean | undefined;
  onUnanchoredChange?: ((ids: string[]) => void) | undefined;
  title?: string | undefined;
}

export declare const HtmlViewer: (
  props: HtmlViewerProps & RefAttributes<ViewerHandle>,
) => ReactNode;
