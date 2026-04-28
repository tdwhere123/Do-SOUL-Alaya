import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "./schema-primitives.js";
import { NodeTemplateKindSchema } from "./node-template.js";

export const NodeInstanceStateSchema = z.enum(["pending", "active", "completed", "aborted", "frozen"]);

export const NodeInstanceSchema = z
  .object({
    node_id: NonEmptyStringSchema,
    principal_run_id: NonEmptyStringSchema,
    node_template: NodeTemplateKindSchema,
    state: NodeInstanceStateSchema,
    task_surface_ref: NonEmptyStringSchema,
    stance_resolution_ref: NonEmptyStringSchema.nullable(),
    created_at: IsoDatetimeStringSchema,
    updated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type NodeInstanceState = z.infer<typeof NodeInstanceStateSchema>;
export type NodeInstance = Readonly<z.infer<typeof NodeInstanceSchema>>;
