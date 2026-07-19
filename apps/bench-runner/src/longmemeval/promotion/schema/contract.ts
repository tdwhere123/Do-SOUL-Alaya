import { createHash } from "node:crypto";
import path from "node:path";
import {
  LongMemEvalMatrixTreatmentWireSchema,
  LongMemEvalPromotionCodeWireSchema
} from "@do-soul/alaya-eval/internal";
import { z } from "zod";
import { LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY } from "./material-effect.js";
import { LONGMEMEVAL_R2_ABSOLUTE_QUALITY_POLICY } from "./absolute-quality.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const LongMemEvalMatrixTreatmentSchema =
  LongMemEvalMatrixTreatmentWireSchema;

const MatrixEntrySchema = z.object({
  treatment: LongMemEvalMatrixTreatmentSchema,
  evidence_root: z.string().min(1)
}).strict().readonly();

const ProductDefaultReplicationSchema = z.object({
  cell: z.literal("B2"),
  treatment: LongMemEvalMatrixTreatmentSchema,
  evidence_root: z.string().min(1)
}).strict().readonly();

const AbsoluteQualityPolicySchema = z.object({
  product_cell: z.literal("B"),
  replication_cell: z.literal("B2"),
  metric: z.literal("r_at_5"),
  cohort: z.literal("answerable"),
  expected_denominator: z.literal(
    LONGMEMEVAL_R2_ABSOLUTE_QUALITY_POLICY.answerableCount
  ),
  minimum_hits: z.literal(
    LONGMEMEVAL_R2_ABSOLUTE_QUALITY_POLICY.minimumR5Hits
  )
}).strict().readonly();

const MaterialEffectPolicySchema = z.object({
  control_cell: z.literal("A"),
  product_cell: z.literal("B"),
  answerable_count: z.literal(LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.answerableCount),
  declared_abstention_count: z.literal(
    LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.declaredAbstentionCount
  ),
  directional_metrics: z.tuple([
    z.literal("r_at_1"),
    z.literal("r_at_5"),
    z.literal("r_at_10"),
    z.literal("full_gold_at_5")
  ]).readonly(),
  token_non_regression_metric: z.literal("token_saved_ratio_vs_full_prompt"),
  minimum_net_r_at_5_wins: z.literal(
    LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.minimumNetR5Wins
  ),
  mcnemar: z.object({
    method: z.literal(LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.mcnemarMethod),
    p_value_max_exclusive: z.literal(
      LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.mcnemarPValueMaxExclusive
    )
  }).strict().readonly()
}).strict().readonly();

export const LongMemEvalMatrixPromotionCodeSchema =
  LongMemEvalPromotionCodeWireSchema;

const LongMemEvalMatrixPromotionContractBaseSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal("longmemeval_matrix_promotion_contract"),
  policy_version: z.literal("longmemeval-product-default-v1"),
  code: LongMemEvalMatrixPromotionCodeSchema,
  dataset: z.object({
    variant: z.literal("longmemeval_s")
  }).strict(),
  selection: z.object({
    policy_version: z.literal("dataset-prefix-full-snapshot-v1"),
    source_prefix_count: z.literal(100),
    target_full_count: z.literal(500)
  }).strict(),
  snapshot: z.object({
    db_path: z.string().min(1),
    manifest_sha256: Sha256Schema
  }).strict(),
  execution_order: z.tuple([
    z.literal("A"),
    z.literal("B"),
    z.literal("C"),
    z.literal("D"),
    z.literal("B2")
  ]).readonly(),
  matrix: z.object({
    entries: z.array(MatrixEntrySchema).length(4).readonly()
  }).strict(),
  product_default_replication: ProductDefaultReplicationSchema,
  absolute_quality_policy: AbsoluteQualityPolicySchema,
  material_effect_policy: MaterialEffectPolicySchema
}).strict();

export const LongMemEvalMatrixPromotionContractSchema =
  LongMemEvalMatrixPromotionContractBaseSchema.superRefine(validatePromotionContract);

type PromotionContractCandidate = z.infer<
  typeof LongMemEvalMatrixPromotionContractBaseSchema
>;

function validatePromotionContract(
  contract: PromotionContractCandidate,
  context: z.RefinementCtx
): void {
  validateCodeIdentity(contract, context);
  validateMatrixTreatments(contract, context);
  validateReplicationTreatment(contract, context);
  validateEvidenceRoots(contract, context);
  validateSnapshotPath(contract, context);
}

function validateCodeIdentity(
  contract: PromotionContractCandidate,
  context: z.RefinementCtx
): void {
  if (!contract.code.commit_sha.startsWith(contract.code.commit_sha7)) {
    context.addIssue({
      code: "custom",
      path: ["code", "commit_sha7"],
      message: "commit_sha7 must prefix commit_sha"
    });
  }
}

function validateMatrixTreatments(
  contract: PromotionContractCandidate,
  context: z.RefinementCtx
): void {
  const treatments = contract.matrix.entries.map((entry) => treatmentKey(entry.treatment));
  if (new Set(treatments).size !== MATRIX_TREATMENTS.length ||
      MATRIX_TREATMENTS.some((treatment) => !treatments.includes(treatmentKey(treatment)))) {
    context.addIssue({
      code: "custom",
      path: ["matrix", "entries"],
      message: "matrix entries must be the exact four-cell treatment Cartesian product"
    });
  }
}

function validateReplicationTreatment(
  contract: PromotionContractCandidate,
  context: z.RefinementCtx
): void {
  const replication = contract.product_default_replication;
  const productTreatment = productDefaultTreatment(contract.policy_version);
  if (treatmentKey(replication.treatment) !== treatmentKey(productTreatment)) {
    context.addIssue({
      code: "custom",
      path: ["product_default_replication", "treatment"],
      message: "B2 replication must use the product-default treatment"
    });
  }
}

function validateEvidenceRoots(
  contract: PromotionContractCandidate,
  context: z.RefinementCtx
): void {
  const replication = contract.product_default_replication;
  const roots = [
    ...contract.matrix.entries.map((entry) => entry.evidence_root),
    replication.evidence_root
  ];
  if (new Set(roots).size !== roots.length) {
    context.addIssue({
      code: "custom",
      path: ["product_default_replication", "evidence_root"],
      message: "matrix and replication evidence roots must be unique"
    });
  }
  contract.matrix.entries.forEach((entry, index) => {
    if (!isSafeRelativeRoot(entry.evidence_root)) {
      context.addIssue({
        code: "custom",
        path: ["matrix", "entries", index, "evidence_root"],
        message: "matrix evidence root must be a contained relative path"
      });
    }
  });
  if (!isSafeRelativeRoot(replication.evidence_root)) {
    context.addIssue({
      code: "custom",
      path: ["product_default_replication", "evidence_root"],
      message: "replication evidence root must be a contained relative path"
    });
  }
}

function validateSnapshotPath(
  contract: PromotionContractCandidate,
  context: z.RefinementCtx
): void {
  if (!isSafeRelativeRoot(contract.snapshot.db_path)) {
    context.addIssue({
      code: "custom",
      path: ["snapshot", "db_path"],
      message: "snapshot DB must be a contained relative path"
    });
  }
}

export type LongMemEvalMatrixTreatment = z.infer<
  typeof LongMemEvalMatrixTreatmentSchema
>;
export type LongMemEvalMatrixPromotionContract = z.infer<
  typeof LongMemEvalMatrixPromotionContractSchema
>;

export interface ParsedLongMemEvalMatrixPromotionContract {
  readonly contract: LongMemEvalMatrixPromotionContract;
  readonly sha256: string;
}

const MATRIX_TREATMENTS: readonly LongMemEvalMatrixTreatment[] = Object.freeze([
  Object.freeze({ embedding_supplement: false, answer_rerank: false }),
  Object.freeze({ embedding_supplement: true, answer_rerank: false }),
  Object.freeze({ embedding_supplement: false, answer_rerank: true }),
  Object.freeze({ embedding_supplement: true, answer_rerank: true })
]);

export function parseLongMemEvalMatrixPromotionContract(
  contents: string | Uint8Array
): ParsedLongMemEvalMatrixPromotionContract {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw = JSON.parse(text) as unknown;
  return {
    contract: LongMemEvalMatrixPromotionContractSchema.parse(raw),
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

export function matrixCellForTreatment(
  treatment: LongMemEvalMatrixTreatment
): "A" | "B" | "C" | "D" {
  if (!treatment.embedding_supplement && !treatment.answer_rerank) return "A";
  if (treatment.embedding_supplement && !treatment.answer_rerank) return "B";
  if (!treatment.embedding_supplement && treatment.answer_rerank) return "C";
  return "D";
}

export function productDefaultTreatment(
  policyVersion: LongMemEvalMatrixPromotionContract["policy_version"]
): LongMemEvalMatrixTreatment {
  if (policyVersion !== "longmemeval-product-default-v1") {
    throw new Error(`unsupported product-default policy: ${policyVersion}`);
  }
  return MATRIX_TREATMENTS[1]!;
}

export function treatmentKey(treatment: LongMemEvalMatrixTreatment): string {
  return `${treatment.embedding_supplement ? 1 : 0}${treatment.answer_rerank ? 1 : 0}`;
}

function isSafeRelativeRoot(reference: string): boolean {
  return reference !== "." && !path.isAbsolute(reference) &&
    !/^[a-zA-Z]:[\\/]/u.test(reference) &&
    !reference.split(/[\\/]/u).includes("..");
}
