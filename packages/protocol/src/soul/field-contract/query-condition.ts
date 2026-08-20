import { z } from "zod";
import {
  BoundedIdSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../../shared/schema-primitives.js";
import {
  FieldContractDigestSchema,
  FieldReceiptContractFieldsSchema,
  assertFieldIdentity,
  assertFieldOperatorId,
  hashConditionDigest,
  hashQueryCacheKey,
  type FieldContractSha256
} from "./canonical-identity.js";
import { QUERY_CONDITION_OPERATOR_ID } from "./operator-manifest.js";

export const QueryConditionSchema = z.object({
  principal: NonEmptyStringSchema.max(256),
  workspace_id: BoundedIdSchema,
  authorized_scopes: z.array(NonEmptyStringSchema.max(256)).readonly(),
  explicit_bridges: z.array(NonEmptyStringSchema.max(256)).readonly(),
  workspace_project: NonEmptyStringSchema.max(256),
  effective_as_of: IsoDatetimeStringSchema,
  query_task_factors: z.array(NonEmptyStringSchema).readonly(),
  governance_state: NonEmptyStringSchema.max(256),
  activation_budget: NonNegativeIntSchema,
  token_budget: NonNegativeIntSchema,
  request_id: NonEmptyStringSchema.max(256).optional(),
  trace_id: NonEmptyStringSchema.max(256).optional(),
  span_id: NonEmptyStringSchema.max(256).optional()
}).strict().readonly();

export const QueryConditionReceiptSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  condition: QueryConditionSchema,
  generation_id: FieldContractDigestSchema,
  query_operator_id: z.literal(QUERY_CONDITION_OPERATOR_ID),
  query_cache_key: FieldContractDigestSchema,
  recorded_at: IsoDatetimeStringSchema
}).strict().readonly();

export type QueryCondition = z.infer<typeof QueryConditionSchema>;
export type QueryConditionReceipt = z.infer<typeof QueryConditionReceiptSchema>;
export type FieldValidTimeClass = "hard_active" | "soft_recallable" | "inactive";

export function classifyFieldValidTime(
  time: Readonly<{
    readonly valid_from: string | null;
    readonly valid_to: string | null;
  }>,
  asOf: string
): FieldValidTimeClass {
  if (time.valid_from === null) return "soft_recallable";
  if (time.valid_from > asOf) return "inactive";
  if (time.valid_to !== null && asOf >= time.valid_to) return "inactive";
  return "hard_active";
}

export function verifyQueryConditionReceipt(
  receipt: QueryConditionReceipt,
  sha256: FieldContractSha256
): QueryConditionReceipt {
  assertFieldOperatorId(receipt.query_operator_id, QUERY_CONDITION_OPERATOR_ID);
  const conditionDigest = hashConditionDigest(receipt.condition, sha256);
  assertFieldIdentity(receipt.identity, conditionDigest, "query condition");
  assertFieldIdentity(receipt.query_cache_key, hashQueryCacheKey({
    generation_id: receipt.generation_id,
    condition_digest: conditionDigest,
    query_operator_id: receipt.query_operator_id
  }, sha256), "query cache key");
  return receipt;
}
