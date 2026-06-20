import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { ControlPlaneObjectKind } from "./object-kind.js";

export const SessionOverrideScopeSchema = z.literal("session_only");

export const SessionOverrideSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.SESSION_OVERRIDE),
    scope: SessionOverrideScopeSchema,
    target_object: NonEmptyStringSchema,
    correction: NonEmptyStringSchema,
    priority: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export type SessionOverrideScope = z.infer<typeof SessionOverrideScopeSchema>;
export type SessionOverride = z.infer<typeof SessionOverrideSchema>;
