import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import { z } from "zod";

const ReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal("open_semantic_factor_candidate_activation_v1"),
  state: z.literal("observed"),
  score: z.number().finite().gt(0).max(1),
  evidence_ids: z.array(z.string().min(1)).min(1),
  solution_count: z.number().int().positive(),
  proposition_match_count: z.number().int().positive(),
  receipt_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
}).strict().superRefine((receipt, context) => {
  const { receipt_digest: digest, ...body } = receipt;
  if (!isSortedUnique(receipt.evidence_ids) || digest !== digestRecallFieldIdentity(body)) {
    context.addIssue({ code: "custom", message: "invalid candidate activation receipt" });
  }
}).readonly();

export const OpenSemanticFactorCandidateActivationEntrySchema = z.object({
  candidate_key: z.string().min(1),
  receipt: ReceiptSchema
}).strict().readonly();

export const OpenSemanticFactorCandidateActivationsSchema = z.array(
  OpenSemanticFactorCandidateActivationEntrySchema
).readonly().superRefine((entries, context) => {
  if (!isSortedUnique(entries.map((entry) => entry.candidate_key))) {
    context.addIssue({ code: "custom", message: "candidate activation keys are not canonical" });
  }
});

export type OpenSemanticFactorCandidateActivationEntry = z.infer<
  typeof OpenSemanticFactorCandidateActivationEntrySchema
>;

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}
