import {
  HtmlViewer,
  type Annotation,
  type ViewerHandle,
} from "@plannotator/ui/components/html-viewer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { viewDocument, withBaseHref } from "./base-href.ts";
import {
  hostMessageSchema,
  reviewAnchorFrom,
  reviewProtocolVersion,
  type FrameMessage,
  type ReviewAnnotation,
  type ReviewInit,
  type ReviewMode,
  type ReviewTheme,
} from "./protocol.ts";

interface ReviewSession {
  readonly annotations: Annotation[];
  readonly baseHref: string | null;
  readonly entryPath: string;
  readonly html: string;
  readonly mode: ReviewMode;
  readonly readOnly: boolean;
}

/** Project one host thread into the record the viewer paints and numbers. */
function toAnnotation(review: ReviewAnnotation): Annotation {
  const annotation: Annotation = {
    blockId: "",
    createdA: 0,
    endOffset: 0,
    id: review.threadId,
    originalText: review.anchor?.originalText ?? "",
    startOffset: 0,
    text: review.body,
    type: "COMMENT",
  };
  const anchor = review.anchor;
  if (anchor === null) return annotation;
  if (anchor.htmlAnchor !== null) annotation.htmlAnchor = anchor.htmlAnchor;
  if (anchor.htmlAdditionalTargets !== undefined) {
    annotation.htmlAdditionalTargets = anchor.htmlAdditionalTargets;
  }
  return annotation;
}

function sessionFrom(init: ReviewInit): ReviewSession {
  return {
    annotations: init.annotations.map(toAnnotation),
    baseHref: init.baseHref,
    entryPath: init.entryPath,
    html: init.html,
    mode: init.mode,
    readOnly: init.readOnly,
  };
}

/** Adopt the host's palette so the viewer chrome and the sandbox agree. */
function applyTheme(theme: ReviewInit | ReviewTheme): void {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.themeTokens)) {
    root.style.setProperty(token, value);
  }
  root.classList.toggle("light", theme.isLight);
}

/**
 * Open a link the Comment surface swallowed in a new tab. Only web addresses
 * leave; a relative link resolves against the version's content base.
 */
function openLink(href: string, baseHref: string | null): void {
  let url: URL;
  try {
    url = baseHref === null ? new URL(href) : new URL(href, baseHref);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  window.open(url.href, "_blank", "noopener,noreferrer");
}

/**
 * The review frame: a same-origin document that frames the artifact in a
 * sandbox and relays review events to the application shell. View frames the
 * page as published; Comment hosts `@plannotator/ui`'s HTML annotation
 * surface. It holds no credential, makes no request, and
 * learns everything it renders from one validated `as-review-init` message.
 */
export function ReviewFrame(): React.ReactNode {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const paintedIdsRef = useRef<ReadonlySet<string>>(new Set<string>());

  const send = useCallback((message: FrameMessage): void => {
    window.parent.postMessage(message, window.location.origin);
  }, []);

  useEffect(() => {
    // Framed by the application shell or nothing: a top-level review frame has
    // no host to authenticate against, so it never listens and never speaks.
    const framed = window.parent !== window;
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== window.parent) return;
      if (event.origin !== window.location.origin) return;
      const parsed = hostMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "as-review-init") {
        applyTheme(message);
        paintedIdsRef.current = new Set(
          message.annotations.map((annotation) => annotation.threadId),
        );
        setSession(sessionFrom(message));
        return;
      }
      if (message.type === "as-review-theme") {
        applyTheme(message);
        return;
      }
      if (message.type === "as-review-annotations") {
        const annotations = message.annotations.map(toAnnotation);
        setSession((current) =>
          current === null ? current : {...current, annotations}
        );
        return;
      }
      if (message.type === "as-review-mode") {
        setSession((current) =>
          current === null ? current : {...current, mode: message.mode}
        );
        return;
      }
      setSelectedThreadId(message.threadId);
    };
    if (framed) {
      window.addEventListener("message", onMessage);
      send({type: "as-review-ready", v: reviewProtocolVersion});
    }
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [send]);

  // The viewer paints marks for its initial prop set when the bridge reports
  // ready; every later arrival or removal is reconciled by id so a replaced
  // optimistic annotation leaves no orphan marker behind.
  // With no viewer mounted (View), the next one paints the full set itself.
  const annotations = session?.annotations;
  useEffect(() => {
    if (annotations === undefined) return;
    const viewer = viewerRef.current;
    const painted = paintedIdsRef.current;
    const next = new Set(annotations.map((annotation) => annotation.id));
    if (viewer !== null) {
      for (const id of painted) {
        if (!next.has(id)) viewer.removeHighlight(id);
      }
      const added = annotations.filter(
        (annotation) => !painted.has(annotation.id),
      );
      if (added.length > 0) viewer.applySharedAnnotations(added);
    }
    paintedIdsRef.current = next;
  }, [annotations]);

  const handleAdd = useCallback((annotation: Annotation): void => {
    setSession((current) =>
      current === null
        ? current
        : {...current, annotations: [...current.annotations, annotation]}
    );
    send({
      anchor: reviewAnchorFrom(
        annotation.originalText,
        annotation.htmlAnchor,
        annotation.htmlAdditionalTargets,
      ),
      body: annotation.text ?? "",
      originalText: annotation.originalText,
      type: "as-review-submit",
      v: reviewProtocolVersion,
    });
  }, [send]);

  const handleSelect = useCallback((threadId: string | null): void => {
    setSelectedThreadId(threadId);
    send({threadId, type: "as-review-select", v: reviewProtocolVersion});
  }, [send]);

  const handleUnanchored = useCallback((threadIds: string[]): void => {
    send({threadIds, type: "as-review-unanchored", v: reviewProtocolVersion});
  }, [send]);

  const requestMode = useCallback((mode: ReviewMode): void => {
    send({mode, type: "as-review-mode-request", v: reviewProtocolVersion});
  }, [send]);

  const html = session?.html;
  const baseHref = session?.baseHref ?? null;
  const mode = session?.mode;
  const framedHtml = useMemo(() => {
    if (html === undefined) return "";
    return mode === "comment" ? withBaseHref(html, baseHref) : viewDocument(html, baseHref);
  }, [baseHref, html, mode]);

  if (session === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        Waiting for the artifact to load.
      </p>
    );
  }

  const title = `Artifact review: ${session.entryPath}`;
  if (session.mode === "view") {
    // Never widen this sandbox: allow-same-origin beside allow-scripts would
    // let the page lift its own sandbox.
    return (
      <iframe
        className="review-view"
        sandbox="allow-scripts"
        srcDoc={framedHtml}
        title={title}
      />
    );
  }

  return (
    <HtmlViewer
      allowCommentImages={false}
      annotations={session.annotations}
      fullViewport
      hideControls
      inputMethod="pinpoint"
      mode="comment"
      onAddAnnotation={handleAdd}
      onAnnotateModeExit={() => requestMode("view")}
      onAnnotateModeToggle={() => requestMode("view")}
      onOpenLink={(href) => openLink(href, session.baseHref)}
      onSelectAnnotation={handleSelect}
      onUnanchoredChange={handleUnanchored}
      rawHtml={framedHtml}
      readOnly={session.readOnly}
      ref={viewerRef}
      sandbox="allow-scripts"
      selectedAnnotationId={selectedThreadId}
      title={title}
    />
  );
}
