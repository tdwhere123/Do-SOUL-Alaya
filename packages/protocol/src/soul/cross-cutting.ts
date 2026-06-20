import { z } from "zod";
import { NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { PersistentObjectEnvelopeSchema } from "./envelope.js";
import { ObjectKind } from "./object-kind.js";

const crossCuttingStateValues = ["none", "candidate", "active", "revoked"] as const;

export const CrossCuttingState = {
  NONE: "none",
  CANDIDATE: "candidate",
  ACTIVE: "active",
  REVOKED: "revoked"
} as const;

export const CrossCuttingStateSchema = z.enum(crossCuttingStateValues);

export const CrossCuttingPermissionSchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ObjectKind.CROSS_CUTTING_PERMISSION),
    object_id: NonEmptyStringSchema,
    cross_cutting_state: CrossCuttingStateSchema,
    allowed_surfaces: z.array(NonEmptyStringSchema).readonly(),
    workspace_id: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export type CrossCuttingState = z.infer<typeof CrossCuttingStateSchema>;
export type CrossCuttingPermission = z.infer<typeof CrossCuttingPermissionSchema>;
