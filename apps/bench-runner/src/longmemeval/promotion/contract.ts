import { createHash } from "node:crypto";
import path from "node:path";
import {
  LongMemEvalMatrixTreatmentWireSchema,
  LongMemEvalPromotionCodeWireSchema
} from "@do-soul/alaya-eval/internal";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const LongMemEvalMatrixTreatmentSchema =
  LongMemEvalMatrixTreatmentWireSchema;

const MatrixEntrySchema = z.object({
  treatment: LongMemEvalMatrixTreatmentSchema,
  evidence_root: z.string().min(1)
}).strict().readonly();

export const LongMemEvalMatrixPromotionCodeSchema =
  LongMemEvalPromotionCodeWireSchema;

export const LongMemEvalMatrixPromotionContractSchema = z.object({
  schema_version: z.literal(1),
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
  matrix: z.object({
    entries: z.array(MatrixEntrySchema).length(4).readonly()
  }).strict()
}).strict().superRefine((contract, context) => {
  if (!contract.code.commit_sha.startsWith(contract.code.commit_sha7)) {
    context.addIssue({
      code: "custom",
      path: ["code", "commit_sha7"],
      message: "commit_sha7 must prefix commit_sha"
    });
  }
  const treatments = contract.matrix.entries.map((entry) => treatmentKey(entry.treatment));
  if (new Set(treatments).size !== MATRIX_TREATMENTS.length ||
      MATRIX_TREATMENTS.some((treatment) => !treatments.includes(treatmentKey(treatment)))) {
    context.addIssue({
      code: "custom",
      path: ["matrix", "entries"],
      message: "matrix entries must be the exact four-cell treatment Cartesian product"
    });
  }
  const roots = contract.matrix.entries.map((entry) => entry.evidence_root);
  if (new Set(roots).size !== roots.length) {
    context.addIssue({
      code: "custom",
      path: ["matrix", "entries"],
      message: "matrix evidence roots must be unique"
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
  if (!isSafeRelativeRoot(contract.snapshot.db_path)) {
    context.addIssue({
      code: "custom",
      path: ["snapshot", "db_path"],
      message: "snapshot DB must be a contained relative path"
    });
  }
});

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
