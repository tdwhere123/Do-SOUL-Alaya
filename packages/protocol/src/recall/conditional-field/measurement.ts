import { z } from "zod";
import {
  ASSOCIATION_DOMAIN_ID,
  ConditionalFieldIdSchema,
  MilligradeSchema,
  Sha256DigestSchema
} from "./common.js";
import { RecallTargetRefSchema } from "./product-identity.js";

const FiniteRawNumberSchema = z.number().finite();

export const MeasuredRawMeasurementSchema = z
  .object({
    status: z.literal("measured"),
    producer_id: ConditionalFieldIdSchema,
    model_id: ConditionalFieldIdSchema,
    obligation_id: ConditionalFieldIdSchema.optional(),
    provider_kind: ConditionalFieldIdSchema.optional(),
    schema_version: z.number().int().nonnegative().optional(),
    dimensions: z.number().int().positive().optional(),
    domain: ConditionalFieldIdSchema,
    normalization: ConditionalFieldIdSchema,
    referent: RecallTargetRefSchema,
    source_revision: ConditionalFieldIdSchema,
    query_digest: Sha256DigestSchema,
    raw: z.union([FiniteRawNumberSchema, z.string(), z.boolean(), z.null()])
  })
  .strict()
  .superRefine((value, context) => {
    if (typeof value.raw === "number" && !Number.isFinite(value.raw)) {
      context.addIssue({
        code: "custom",
        message: "raw measurement must not be NaN or non-finite"
      });
    }
  })
  .readonly();

export const AbsentRawMeasurementSchema = z
  .object({
    status: z.enum(["missing", "unavailable", "unsupported"])
  })
  .strict()
  .readonly();

export const RawMeasurementSchema = z.union([
  MeasuredRawMeasurementSchema,
  AbsentRawMeasurementSchema
]);

export const ProjectedCapSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("projected"),
      domain_id: z.literal(ASSOCIATION_DOMAIN_ID),
      transfer_id: ConditionalFieldIdSchema,
      transfer_version: ConditionalFieldIdSchema,
      milligrades: MilligradeSchema
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("inapplicable")
    })
    .strict()
    .readonly()
]);

export const FieldActivationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("unreachable")
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("reachable"),
      milligrades: MilligradeSchema,
      low: MilligradeSchema.optional(),
      high: MilligradeSchema.optional()
    })
    .strict()
    .readonly()
]);

export type RawMeasurement = z.infer<typeof RawMeasurementSchema>;
export type ProjectedCap = z.infer<typeof ProjectedCapSchema>;
export type FieldActivation = z.infer<typeof FieldActivationSchema>;

export function fieldActivationOf(value: Readonly<{
  readonly activation?: FieldActivation;
  readonly milligrades?: number;
  readonly low_milligrades?: number;
  readonly high_milligrades?: number;
}>): FieldActivation {
  if (value.activation !== undefined) return value.activation;
  if (value.milligrades === undefined) return { kind: "unreachable" };
  return {
    kind: "reachable",
    milligrades: value.milligrades,
    ...(value.low_milligrades === undefined ? {} : { low: value.low_milligrades }),
    ...(value.high_milligrades === undefined ? {} : { high: value.high_milligrades })
  };
}

export function reachableMilligradesOf(value: Readonly<{
  readonly activation?: FieldActivation;
  readonly milligrades?: number;
  readonly low_milligrades?: number;
  readonly high_milligrades?: number;
}>): number | undefined {
  const activation = fieldActivationOf(value);
  return activation.kind === "reachable" ? activation.milligrades : undefined;
}
