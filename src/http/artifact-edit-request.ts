import {z} from "zod";

const editPathSchema = z.string().min(1).max(1_024);

/** The ordered operations of one edit commit, as HTTP and MCP accept them. */
export const editOperationsSchema = z.array(z.discriminatedUnion("kind", [
  z.object({
    edits: z.array(z.object({
      newText: z.string(),
      oldText: z.string().min(1),
    }).strict()).min(1),
    kind: z.literal("replace"),
    path: editPathSchema,
  }).strict(),
  z.object({
    kind: z.literal("write"),
    mediaType: z.string().trim().min(1).max(200).optional(),
    path: editPathSchema,
    text: z.string(),
  }).strict(),
  z.object({kind: z.literal("delete"), path: editPathSchema}).strict(),
  z.object({
    from: editPathSchema,
    kind: z.literal("rename"),
    to: editPathSchema,
  }).strict(),
])).min(1);
