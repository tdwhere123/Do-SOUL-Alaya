import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";

const AuditEventDetailSchema = z.record(z.unknown()).readonly();

export const AuditEventSchema = z
  .object({
    event_type: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema,
    actor: NonEmptyStringSchema,
    detail: AuditEventDetailSchema
  })
  .readonly();

export const AuditTrailSchema = z
  .object({
    events: z.array(AuditEventSchema).min(1).readonly()
  })
  .readonly();

export type ObjectSpec<TSpec extends object> = Readonly<TSpec & { readonly _brand: "spec" }>;
export type ObjectStatus<TStatus extends object> = Readonly<TStatus>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditTrail = z.infer<typeof AuditTrailSchema>;
