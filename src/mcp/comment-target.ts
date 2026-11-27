import {z} from "zod";

import type {CommentThreadRecord} from "../core/model.js";

const elementContextSchema = z.object({
  attrs: z.array(z.tuple([z.string(), z.string()])).optional(),
  classes: z.array(z.string()).optional(),
  component: z.string().optional(),
  heading: z.string().optional(),
  id: z.string().optional(),
  landmark: z.string().optional(),
  name: z.string().optional(),
  outline: z.string().optional(),
  path: z.string().optional(),
  rect: z.object({
    h: z.number(), vh: z.number(), vw: z.number(), w: z.number(), x: z.number(), y: z.number(),
  }).optional(),
  role: z.string().optional(),
  tag: z.string().min(1),
  text: z.string().optional(),
});

/** The page element a thread's anchor names, as the review bridge described it. */
export const commentElementSchema = elementContextSchema
  .extend({selector: z.string().optional()})
  .strict();

/** One recognized element of a comment anchor. */
export type CommentElement = z.infer<typeof commentElementSchema>;

/** Where inside an embedded table or diagram a thread points: the file and its cell or element. */
export const commentEmbedSchema = z.object({
  cell: z.string().optional(),
  element: z.string().optional(),
  src: z.string(),
}).strict();

/** One recognized embed location of a comment anchor. */
export type CommentEmbed = z.infer<typeof commentEmbedSchema>;

/** What a thread asks to change, when its anchor is recognizable. */
export const commentTargetSchema = z.object({
  element: commentElementSchema.nullable(),
  embed: commentEmbedSchema.nullable(),
  quote: z.string().nullable(),
}).strict();

/** A thread's quoted text and element, each null when the anchor lacks it. */
export type CommentTarget = z.infer<typeof commentTargetSchema>;

const recognizedAnchorSchema = z.object({
  elementContext: elementContextSchema.optional().catch(undefined),
  htmlAnchor: z.object({selector: z.string()}).nullable().optional().catch(null),
  originalText: z.string().optional().catch(undefined),
});

/** Derive a thread's target from its opaque anchor, ignoring what is not recognized. */
export function commentTarget(thread: CommentThreadRecord): CommentTarget {
  const anchor = recognizedAnchorSchema.safeParse(thread.anchor);
  if (!anchor.success) return {element: null, embed: null, quote: null};
  const {elementContext, htmlAnchor, originalText} = anchor.data;
  const quote = originalText ?? null;
  if (elementContext === undefined) return {element: null, embed: null, quote};
  const selector = htmlAnchor?.selector;
  return {
    element: selector === undefined ? elementContext : {...elementContext, selector},
    embed: commentEmbed(thread.path, elementContext.attrs),
    quote,
  };
}

const cellReferencePattern = /^[A-Z]{1,3}[0-9]{1,6}$/u;

/**
 * The embed runtime marks table cells and diagram parts with
 * data-annotate="<path>#<encoded A1 cell or diagram element id>"; it names an
 * embed only on a thread recorded on that same .csv or .mmd path.
 */
function commentEmbed(
  path: string | null,
  attrs: readonly (readonly [string, string])[] | undefined,
): CommentEmbed | null {
  const value = attrs?.find(([name]) => name === "data-annotate")?.[1];
  const separator = value?.lastIndexOf("#") ?? -1;
  if (path === null || value === undefined || separator < 0 || value.slice(0, separator) !== path) {
    return null;
  }
  let reference: string;
  try {
    reference = decodeURIComponent(value.slice(separator + 1));
  } catch {
    return null;
  }
  if (path.endsWith(".csv")) return cellReferencePattern.test(reference) ? {cell: reference, src: path} : null;
  if (path.endsWith(".mmd")) return reference === "" ? {src: path} : {element: reference, src: path};
  return null;
}
