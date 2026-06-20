import { z } from "zod";
import { NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { ControlPlaneObjectKind } from "./object-kind.js";

export const TaskObjectSurfaceSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.TASK_OBJECT_SURFACE),
    surface_kind: NonEmptyStringSchema,
    display_name: NonEmptyStringSchema,
    context_refs: z.array(NonEmptyStringSchema).readonly()
  })
  .strict()
  .readonly();

export type TaskObjectSurface = z.infer<typeof TaskObjectSurfaceSchema>;
