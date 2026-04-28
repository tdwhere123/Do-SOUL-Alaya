import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";
import { ObjectLifecycleStateSchema } from "./lifecycle.js";
import { ControlPlaneObjectKindSchema, ObjectKindSchema, RetentionPolicySchema } from "./object-kind.js";

const UuidSchema = z.string().uuid();
const SchemaVersionSchema = z.number().int().min(1);

export const PersistentObjectEnvelopeSchema = z
  .object({
    object_id: UuidSchema,
    object_kind: ObjectKindSchema,
    schema_version: SchemaVersionSchema,
    created_at: IsoDatetimeStringSchema,
    updated_at: IsoDatetimeStringSchema,
    created_by: NonEmptyStringSchema,
    lifecycle_state: ObjectLifecycleStateSchema
  })
  .readonly();

export const ControlPlaneEnvelopeSchema = z
  .object({
    runtime_id: UuidSchema,
    object_kind: ControlPlaneObjectKindSchema,
    task_surface_ref: NonEmptyStringSchema.nullable(),
    expires_at: IsoDatetimeStringSchema.nullable(),
    derived_from: NonEmptyStringSchema.nullable(),
    retention_policy: RetentionPolicySchema
  })
  .readonly();

export type PersistentObjectEnvelope = z.infer<typeof PersistentObjectEnvelopeSchema>;
export type ControlPlaneEnvelope = z.infer<typeof ControlPlaneEnvelopeSchema>;
