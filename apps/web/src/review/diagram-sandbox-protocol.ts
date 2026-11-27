import type {MermaidConfig} from "mermaid";
import {z} from "zod";

export const diagramRequestSchema = z.object({
  id: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/u),
  isLight: z.boolean(),
  text: z.string().max(20_000),
}).strict();

export const diagramReplySchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("ready")}).strict(),
  z.object({id: z.string(), svg: z.string().max(2_000_000), type: z.literal("result")}).strict(),
  z.object({id: z.string(), type: z.literal("error")}).strict(),
]);

/** The only Mermaid configuration previews render with. */
export function mermaidConfiguration(id: string, isLight: boolean): MermaidConfig {
  return {
    deterministicIds: true,
    deterministicIDSeed: id,
    flowchart: {htmlLabels: false},
    htmlLabels: false,
    maxEdges: 200,
    maxTextSize: 20_000,
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: isLight ? "default" : "dark",
  };
}
