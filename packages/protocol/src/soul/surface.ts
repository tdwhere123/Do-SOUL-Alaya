import { z } from "zod";
import { NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { PersistentObjectEnvelopeSchema } from "./envelope.js";
import { ObjectKind } from "./object-kind.js";

const surfaceStatusValues = ["active", "weakly_bound", "orphaned", "revoked"] as const;
const surfaceAnchorKindValues = ["semantic_landmark", "path_fragment", "artifact_ref", "symbol_ref"] as const;
const bindingStateValues = ["active", "stale", "detached"] as const;

export const SurfaceStatus = {
  ACTIVE: "active",
  WEAKLY_BOUND: "weakly_bound",
  ORPHANED: "orphaned",
  REVOKED: "revoked"
} as const;

export const SurfaceAnchorKind = {
  SEMANTIC_LANDMARK: "semantic_landmark",
  PATH_FRAGMENT: "path_fragment",
  ARTIFACT_REF: "artifact_ref",
  SYMBOL_REF: "symbol_ref"
} as const;

export const BindingState = {
  ACTIVE: "active",
  STALE: "stale",
  DETACHED: "detached"
} as const;

export const SurfaceStatusSchema = z.enum(surfaceStatusValues);
export const SurfaceAnchorKindSchema = z.enum(surfaceAnchorKindValues);
export const BindingStateSchema = z.enum(bindingStateValues);

export const SurfaceIdentitySchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ObjectKind.SURFACE_IDENTITY),
    surface_id: NonEmptyStringSchema,
    surface_kind: NonEmptyStringSchema,
    surface_status: SurfaceStatusSchema,
    workspace_id: NonEmptyStringSchema
  })
  .readonly();

export const SurfaceAnchorSchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ObjectKind.SURFACE_ANCHOR),
    surface_id: NonEmptyStringSchema,
    anchor_kind: SurfaceAnchorKindSchema,
    anchor_value: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema
  })
  .readonly();

export const SurfaceBindingSchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ObjectKind.SURFACE_BINDING),
    object_id: NonEmptyStringSchema,
    surface_id: NonEmptyStringSchema,
    is_primary: z.boolean(),
    binding_state: BindingStateSchema,
    workspace_id: NonEmptyStringSchema
  })
  .readonly();

export type SurfaceStatus = z.infer<typeof SurfaceStatusSchema>;
export type SurfaceAnchorKind = z.infer<typeof SurfaceAnchorKindSchema>;
export type BindingState = z.infer<typeof BindingStateSchema>;
export type SurfaceIdentity = z.infer<typeof SurfaceIdentitySchema>;
export type SurfaceAnchor = z.infer<typeof SurfaceAnchorSchema>;
export type SurfaceBinding = z.infer<typeof SurfaceBindingSchema>;
