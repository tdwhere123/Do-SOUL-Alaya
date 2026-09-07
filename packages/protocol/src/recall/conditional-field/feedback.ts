import { z } from "zod";
import { ConditionalFieldIdSchema, SchemaVersionSchema, Sha256DigestSchema } from "./common.js";
import { IsoDatetimeStringSchema } from "../../shared/schema-primitives.js";

export const UsageReportGrainSchema = z.enum(["object", "output", "witness", "action"]);
export const UsageExposureSchema = z.enum(["exposed", "nonexposure", "unknown"]);
export const UsageReportedUseSchema = z.enum(["used", "unused", "missing", "unknown"]);

const UsageReportBaseSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    grain: UsageReportGrainSchema,
    exposure: UsageExposureSchema,
    reported_use: UsageReportedUseSchema,
    query_id: ConditionalFieldIdSchema.optional(),
    snapshot_id: Sha256DigestSchema.optional(),
    interpretation_id: ConditionalFieldIdSchema.optional(),
    as_of: IsoDatetimeStringSchema.optional(),
    object_id: ConditionalFieldIdSchema.optional(),
    output_id: ConditionalFieldIdSchema.optional(),
    witness_id: ConditionalFieldIdSchema.optional(),
    action_id: ConditionalFieldIdSchema.optional()
  })
  .strict()
  .readonly();

export const UsageReportSchema = UsageReportBaseSchema.superRefine((value, ctx) => {
  if (value.grain === "object" && value.object_id === undefined) {
    ctx.addIssue({ code: "custom", message: "object grain requires object_id" });
  }
  if (value.grain === "output" && value.output_id === undefined) {
    ctx.addIssue({ code: "custom", message: "output grain requires output_id" });
  }
  if (value.grain === "witness" && value.witness_id === undefined) {
    ctx.addIssue({ code: "custom", message: "witness grain requires witness_id" });
  }
  if (value.grain === "witness" && (value.query_id === undefined || value.snapshot_id === undefined
    || value.interpretation_id === undefined || value.as_of === undefined)) {
    ctx.addIssue({ code: "custom", message: "witness grain requires query, snapshot and semantic epoch" });
  }
  if (value.grain === "action" && value.action_id === undefined) {
    ctx.addIssue({ code: "custom", message: "action grain requires action_id" });
  }
});

export type UsageReportGrain = z.infer<typeof UsageReportGrainSchema>;
export type UsageExposure = z.infer<typeof UsageExposureSchema>;
export type UsageReportedUse = z.infer<typeof UsageReportedUseSchema>;
export type UsageReport = z.infer<typeof UsageReportSchema>;
