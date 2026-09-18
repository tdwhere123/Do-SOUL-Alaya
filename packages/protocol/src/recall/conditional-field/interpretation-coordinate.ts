import { z } from "zod";
import { BoundedIdSchema } from "../../shared/schema-primitives.js";

/** A computational node in a proposed source interpretation, never a memory object. */
export const InterpretationNodeCoordinateSchema = z.object({
  packet_id: BoundedIdSchema,
  hypothesis_id: BoundedIdSchema,
  node_id: z.string().min(1).max(64)
}).strict().readonly();

export const InterpretationPremiseValiditySchema = z.object({
  kind: z.literal("interpretation"),
  packet_id: BoundedIdSchema,
  hypothesis_id: BoundedIdSchema
}).strict().readonly();

export type InterpretationNodeCoordinate = z.infer<typeof InterpretationNodeCoordinateSchema>;
export type InterpretationPremiseValidity = z.infer<typeof InterpretationPremiseValiditySchema>;

export function interpretationNodeIdentity(node: InterpretationNodeCoordinate): string {
  return `${node.hypothesis_id}/${node.node_id}`;
}
