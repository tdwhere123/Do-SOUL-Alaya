import {
  FieldContractDigestSchema
} from "@do-soul/alaya-protocol";
import { z } from "zod";

export const RecallQueryConditionParitySchema = z.object({
  effective_as_of: z.string().datetime({ offset: true }),
  condition_digest: FieldContractDigestSchema,
  query_cache_key: FieldContractDigestSchema,
  generation_id: FieldContractDigestSchema
}).strict().readonly();

const FieldProjectionKeyReceiptSchema = z.object({
  dimension: z.string().min(1),
  query_key_id: z.string().min(1),
  candidate_key_id: z.string().min(1),
  candidate_authority: z.enum([
    "grounded",
    "proposed_routing_only",
    "derived_query",
    "derived_path"
  ]),
  independence_group: z.string().min(1),
  support: z.number().finite().min(0).max(1)
}).strict().readonly();

const FieldProjectionActivationSchema = z.object({
  workspace_id: z.string().min(1),
  generation_id: z.string().min(1),
  condition_digest: z.string().min(1),
  seed_ids: z.array(z.string().min(1)).readonly(),
  opened_candidate_keys: z.array(z.string().min(1)).readonly(),
  stop_disposition: z.enum(["certified", "uncertified"]),
  frontier: z.enum(["closed", "incomplete"])
}).strict().readonly();

const FieldProjectionTraceFieldsSchema = z.object({
  generation_id: z.string().min(1),
  condition_digest: z.string().min(1),
  candidate_keys: z.array(z.string().min(1)).readonly(),
  candidate_activation: z.record(
    z.string().min(1),
    z.number().finite().min(0).max(1)
  ).readonly(),
  candidate_receipts: z.record(
    z.string().min(1),
    z.array(FieldProjectionKeyReceiptSchema).readonly()
  ).readonly(),
  activation: FieldProjectionActivationSchema
}).strict().superRefine((trace, context) => {
  if (trace.activation.generation_id !== trace.generation_id) {
    context.addIssue({ code: "custom", message: "Field projection generation is inconsistent" });
  }
  if (trace.activation.condition_digest !== trace.condition_digest) {
    context.addIssue({ code: "custom", message: "Field projection condition is inconsistent" });
  }
  if (!trace.candidate_keys.every((key) =>
    trace.activation.opened_candidate_keys.includes(key))) {
    context.addIssue({ code: "custom", message: "Field projection membership is inconsistent" });
  }
}).readonly();

export const FieldProjectionTraceSchema = z.preprocess(
  stripLegacyTraceStop,
  FieldProjectionTraceFieldsSchema
);

function stripLegacyTraceStop(value: unknown): unknown {
  if (!isPlainRecord(value) || !Object.hasOwn(value, "stop")) return value;
  const { stop: _stop, ...fields } = value;
  return fields;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
