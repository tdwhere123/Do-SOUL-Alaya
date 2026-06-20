import { z } from "zod";
import {
  BoundedJsonObjectSchema,
  BoundedLabelSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema
} from "../shared/schema-primitives.js";

const AuditEventDetailSchema = BoundedJsonObjectSchema;

export const AuditEventSchema = z
  .object({
    event_type: BoundedLabelSchema,
    occurred_at: IsoDatetimeStringSchema,
    actor: NonEmptyStringSchema,
    detail: AuditEventDetailSchema
  })
  .strict()
  .readonly();

export const AuditTrailSchema = z
  .object({
    events: z.array(AuditEventSchema).min(1).readonly()
  })
  .strict()
  .readonly();

export type ObjectSpec<TSpec extends object> = Readonly<TSpec & { readonly _brand: "spec" }>;
export type ObjectStatus<TStatus extends object> = Readonly<TStatus>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditTrail = z.infer<typeof AuditTrailSchema>;
