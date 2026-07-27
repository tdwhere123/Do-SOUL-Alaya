import { z } from "zod";

export const LongMemEvalMissClassificationSchema = z.enum([
  "hit_at_5",
  "budget_dropped",
  "under_ranked",
  "active_constraint_only",
  "structural_gap",
  "lexical_gap",
  "candidate_absent",
  "no_gold",
  "evaluator_identity_inconsistent",
  "evaluator_identity_indeterminate",
  "abstained_correctly",
  "abstain_false_confident",
  "abstention_uncalibrated",
  "diagnostics_unavailable"
]);
