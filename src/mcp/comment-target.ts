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

/** What a thread asks to change, when its anchor is recognizable. */
export const commentTargetSchema = z.object({
  element: commentElementSchema.nullable(),
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
  if (!anchor.success) return {element: null, quote: null};
  const {elementContext, htmlAnchor, originalText} = anchor.data;
  const quote = originalText ?? null;
  if (elementContext === undefined) return {element: null, quote};
  const selector = htmlAnchor?.selector;
  return {
    element: selector === undefined ? elementContext : {...elementContext, selector},
    quote,
  };
}
