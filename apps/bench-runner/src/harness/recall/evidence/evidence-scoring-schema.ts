import { z } from "zod";
import {
  BenchEvidenceEmbeddingFailureClassSchema,
  BenchEvidenceEmbeddingStatusSchema
} from "../recall-stage-status-schema.js";
import { NonBlankStringSchema } from "../packet-plan-membership-schema.js";

const EvidenceCandidateScoringSelectionReceiptShapeSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal("ordered_candidate_prefix_v1"),
  input_candidate_keys: z.array(NonBlankStringSchema).readonly(),
  owner_gist_enabled: z.boolean(),
  owner_gist_candidate_keys: z.array(NonBlankStringSchema).readonly(),
  full_evidence_candidate_keys: z.array(NonBlankStringSchema).readonly(),
  owner_gist_limit: z.literal(16),
  full_evidence_limit: z.literal(32),
  input_memory_count: z.number().int().nonnegative(),
  owner_gist_selected_count: z.number().int().nonnegative(),
  full_evidence_selected_count: z.number().int().nonnegative(),
  owner_gist_excluded_count: z.number().int().nonnegative(),
  full_evidence_excluded_count: z.number().int().nonnegative()
}).strict().readonly();

export const EvidenceCandidateScoringSelectionReceiptSchema =
  EvidenceCandidateScoringSelectionReceiptShapeSchema.superRefine(
    (receipt, context) => validateSelectionReceipt(receipt, context)
  );

export const EvidenceEmbeddingDiagnosticsSchemaShape = {
  evidence_embedding_status:
    BenchEvidenceEmbeddingStatusSchema.default("not_requested"),
  evidence_embedding_expected_count: z.number().int().nonnegative().default(0),
  evidence_embedding_scored_count: z.number().int().nonnegative().default(0),
  evidence_embedding_inference_calls: z.number().int().nonnegative().default(0),
  evidence_embedding_latency_ms: z.number().nonnegative().default(0),
  evidence_embedding_failure_class:
    BenchEvidenceEmbeddingFailureClassSchema.nullable().default(null),
  evidence_embedding_selection_receipt:
    EvidenceCandidateScoringSelectionReceiptSchema.optional()
} as const;

type SelectionReceipt = z.infer<
  typeof EvidenceCandidateScoringSelectionReceiptShapeSchema
>;

function validateSelectionReceipt(
  receipt: SelectionReceipt,
  context: z.RefinementCtx
): void {
  validateCount(context, "input_memory_count", receipt.input_memory_count,
    receipt.input_candidate_keys.length);
  validateCount(context, "owner_gist_selected_count",
    receipt.owner_gist_selected_count, receipt.owner_gist_candidate_keys.length);
  validateCount(context, "full_evidence_selected_count",
    receipt.full_evidence_selected_count, receipt.full_evidence_candidate_keys.length);
  validateUniqueInputKeys(receipt, context);
  validatePrefix(receipt, context, "owner_gist_candidate_keys");
  validatePrefix(receipt, context, "full_evidence_candidate_keys");
  const ownerSelected = receipt.owner_gist_enabled
    ? Math.min(receipt.input_memory_count, receipt.owner_gist_limit)
    : 0;
  validateCount(context, "owner_gist_selected_count",
    receipt.owner_gist_selected_count, ownerSelected);
  validateCount(context, "owner_gist_excluded_count",
    receipt.owner_gist_excluded_count,
    receipt.owner_gist_enabled ? receipt.input_memory_count - ownerSelected : 0);
  validateCount(context, "full_evidence_selected_count",
    receipt.full_evidence_selected_count,
    Math.min(receipt.input_memory_count, receipt.full_evidence_limit));
  validateCount(context, "full_evidence_excluded_count",
    receipt.full_evidence_excluded_count,
    Math.max(0, receipt.input_memory_count - receipt.full_evidence_limit));
}

function validateUniqueInputKeys(
  receipt: SelectionReceipt,
  context: z.RefinementCtx
): void {
  if (new Set(receipt.input_candidate_keys).size === receipt.input_candidate_keys.length) {
    return;
  }
  context.addIssue({
    code: "custom",
    path: ["input_candidate_keys"],
    message: "Evidence scoring input candidate keys must be unique"
  });
}

function validatePrefix(
  receipt: SelectionReceipt,
  context: z.RefinementCtx,
  field: "owner_gist_candidate_keys" | "full_evidence_candidate_keys"
): void {
  const selected = receipt[field];
  if (selected.every((key, index) => receipt.input_candidate_keys[index] === key)) return;
  context.addIssue({
    code: "custom",
    path: [field],
    message: "Evidence scoring selection must be an ordered input prefix"
  });
}

function validateCount(
  context: z.RefinementCtx,
  field: keyof SelectionReceipt,
  actual: number,
  expected: number
): void {
  if (actual === expected) return;
  context.addIssue({
    code: "custom",
    path: [field],
    message: `Expected ${expected}, received ${actual}`
  });
}
