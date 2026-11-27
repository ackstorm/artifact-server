import { z } from "zod";

import type {PersistedHtmlAnchor} from "@plannotator/ui/components/html-viewer";

/** Protocol version carried by every host <-> review-frame message. */
export const reviewProtocolVersion = 1;

const versionSchema = z.literal(reviewProtocolVersion);

const anchorPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

/**
 * Trust-boundary caps mirror @plannotator/ui's own parent-side validation
 * (useHtmlAnnotation.ts:120-140) so a stored anchor can never be larger than
 * one the viewer would have produced.
 */
const htmlElementAnchorSchema = z.object({
  point: anchorPointSchema.optional(),
  selector: z.string().min(1).max(1_024),
  tagName: z.string().min(1).max(64),
  text: z.string().max(400).optional(),
});

/** Caps mirror @plannotator/core's parseHtmlElementContext (html-anchor.ts:143-162). */
const htmlElementContextSchema = z.object({
  attrs: z.array(z.tuple([z.string().max(40), z.string().max(120)])).max(10).optional(),
  children: z.number().int().nonnegative().optional(),
  classes: z.array(z.string().max(48)).max(9).optional(),
  component: z.string().max(100).optional(),
  heading: z.string().max(130).optional(),
  id: z.string().max(100).optional(),
  landmark: z.string().max(80).optional(),
  name: z.string().max(120).optional(),
  outline: z.string().max(600).optional(),
  page: z.object({title: z.string().max(200).optional(), url: z.string().max(2_048)}).optional(),
  path: z.string().max(512).optional(),
  rect: z.object({
    h: z.number(), vh: z.number(), vw: z.number(), w: z.number(), x: z.number(), y: z.number(),
  }).optional(),
  role: z.string().max(32).optional(),
  sourceName: z.string().max(80).optional(),
  tag: z.string().min(1).max(32),
  text: z.string().max(300).optional(),
});

const htmlAnnotationTargetSchema = z.object({
  anchor: htmlElementAnchorSchema.optional(),
  context: htmlElementContextSchema.optional().catch(undefined),
  label: z.string().max(64).optional(),
  text: z.string().max(10_000),
});

/**
 * The anchor this client stores on a comment thread: the package's persisted
 * anchor with htmlAnchor null when absent. The server treats
 * it as opaque, so the frame is its only reader: anything it does not
 * recognise (a whole-file `{kind: "page"}` anchor, an anchor written by a
 * future client) becomes `null` and the thread simply gets no page marker,
 * which is the same fail-closed outcome the bridge's own anchor builder uses.
 */
export const reviewAnchorSchema = z.object({
  elementContext: htmlElementContextSchema.optional().catch(undefined),
  htmlAdditionalTargets: z.array(htmlAnnotationTargetSchema).max(16).optional(),
  htmlAnchor: htmlElementAnchorSchema.nullable(),
  originalText: z.string().max(10_000),
});

const optionalAnchorSchema = reviewAnchorSchema.nullable().catch(null);

/** One comment thread as the host projects it into the page. */
export const reviewAnnotationSchema = z.object({
  anchor: optionalAnchorSchema,
  body: z.string(),
  state: z.enum(["open", "resolved"]),
  threadId: z.string().min(1),
});

const themeTokensSchema = z.record(
  z.string().regex(/^--[a-z0-9-]+$/iu),
  z.string().max(256),
);

/**
 * View renders the artifact exactly as published, with no annotation layer;
 * Comment mounts the annotation surface.
 */
export const reviewModeSchema = z.enum(["view", "comment"]);

/** Every message the host is allowed to send into the review frame. */
export const hostMessageSchema = z.discriminatedUnion("type", [
  z.object({
    annotations: z.array(reviewAnnotationSchema),
    baseHref: z.string().nullable(),
    entryPath: z.string(),
    html: z.string(),
    isLight: z.boolean(),
    mode: reviewModeSchema,
    readOnly: z.boolean(),
    themeTokens: themeTokensSchema,
    type: z.literal("as-review-init"),
    v: versionSchema,
  }),
  z.object({
    annotations: z.array(reviewAnnotationSchema),
    type: z.literal("as-review-annotations"),
    v: versionSchema,
  }),
  z.object({
    isLight: z.boolean(),
    themeTokens: themeTokensSchema,
    type: z.literal("as-review-theme"),
    v: versionSchema,
  }),
  z.object({
    mode: reviewModeSchema,
    type: z.literal("as-review-mode"),
    v: versionSchema,
  }),
  z.object({
    threadId: z.string().nullable(),
    type: z.literal("as-review-focus"),
    v: versionSchema,
  }),
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;
export type ReviewMode = z.infer<typeof reviewModeSchema>;
export type ReviewAnnotation = z.infer<typeof reviewAnnotationSchema>;
export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;
export type ReviewInit = Extract<HostMessage, {type: "as-review-init"}>;
export type ReviewTheme = Extract<HostMessage, {type: "as-review-theme"}>;

/** Every message the review frame sends back to the host. */
export const frameMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("as-review-ready"),
    v: versionSchema,
  }),
  z.object({
    anchor: optionalAnchorSchema,
    body: z.string(),
    originalText: z.string(),
    type: z.literal("as-review-submit"),
    v: versionSchema,
  }),
  z.object({
    threadId: z.string().nullable(),
    type: z.literal("as-review-select"),
    v: versionSchema,
  }),
  z.object({
    mode: reviewModeSchema,
    type: z.literal("as-review-mode-request"),
    v: versionSchema,
  }),
  z.object({
    threadIds: z.array(z.string()),
    type: z.literal("as-review-unanchored"),
    v: versionSchema,
  }),
]);

export type FrameMessage = z.infer<typeof frameMessageSchema>;

/** The anchor stored on a thread from the package's bounded persisted anchor. */
export function reviewAnchorFrom(persisted: PersistedHtmlAnchor): ReviewAnchor {
  return {...persisted, htmlAnchor: persisted.htmlAnchor ?? null};
}
