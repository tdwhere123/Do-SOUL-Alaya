import { createHash } from "node:crypto";
import { z } from "zod";
import {
  LongMemEvalSelectionContractIdentitySchema
} from "@do-soul/alaya-eval";
import { LongMemEvalMatrixTreatmentSchema } from "./contract.js";
import {
  exactTwoSidedMcNemarPValue,
  LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY,
  type LongMemEvalMaterialEffect
} from "./material-effect.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const HardGateSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  current: z.number().nullable(),
  target: z.number(),
  direction: z.enum(["min", "max"]),
  unit: z.enum(["ratio", "count", "ms"]),
  passed: z.literal(true),
  missing: z.literal(false)
}).strict();

const MetricDeltaSchema = z.object({
  control: z.number(),
  product: z.number(),
  delta: z.number()
}).strict();

const MaterialEffectSchema = z.object({
  status: z.literal("passed"),
  directional: z.object({
    r_at_1: MetricDeltaSchema,
    r_at_5: MetricDeltaSchema,
    r_at_10: MetricDeltaSchema,
    full_gold_at_5: MetricDeltaSchema
  }).strict(),
  safeguards: z.object({
    token_saved_ratio_vs_full_prompt: MetricDeltaSchema,
    measurement_attribution: z.literal("eligible_in_both")
  }).strict(),
  paired_r_at_5: z.object({
    answerable_count: z.literal(LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.answerableCount),
    control_hits: z.number().int().nonnegative().max(
      LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.answerableCount
    ),
    product_hits: z.number().int().nonnegative().max(
      LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.answerableCount
    ),
    gained: z.number().int().nonnegative(),
    lost: z.number().int().nonnegative(),
    net: z.number().int(),
    mcnemar: z.object({
      method: z.literal(LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.mcnemarMethod),
      p_value: z.number().min(0).max(1)
    }).strict()
  }).strict()
}).strict().superRefine((effect, context) => {
  validateMaterialEffect(effect, context);
});

const UnsignedLongMemEvalMatrixPromotionAuthorizationSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("longmemeval_matrix_promotion_authorization"),
  status: z.literal("authorized"),
  contract_sha256: Sha256Schema,
  policy_version: z.literal("longmemeval-product-default-v1"),
  source_selection: LongMemEvalSelectionContractIdentitySchema,
  next_selection: LongMemEvalSelectionContractIdentitySchema,
  matrix: z.object({
    sha256: Sha256Schema,
    cells: z.array(z.object({
      cell: z.enum(["A", "B", "C", "D"]),
      treatment: LongMemEvalMatrixTreatmentSchema,
      evidence_root: z.string().min(1),
      bundle_sha256: Sha256Schema
    }).strict()).length(4)
  }).strict(),
  product_default: z.object({
    cell: z.literal("B"),
    treatment: LongMemEvalMatrixTreatmentSchema,
    bundle_sha256: Sha256Schema
  }).strict(),
  hard_gates: z.array(HardGateSchema).min(1),
  product_default_replication: z.object({
    cell: z.literal("B2"),
    treatment: LongMemEvalMatrixTreatmentSchema,
    evidence_root: z.string().min(1),
    bundle_sha256: Sha256Schema,
    hard_gates: z.array(HardGateSchema).min(1)
  }).strict(),
  material_effect: MaterialEffectSchema
}).strict();

export const LongMemEvalMatrixPromotionAuthorizationSchema =
  UnsignedLongMemEvalMatrixPromotionAuthorizationSchema.extend({
    authorization_sha256: Sha256Schema
  }).strict().superRefine((authorization, context) => {
    const { authorization_sha256: digest, ...unsigned } = authorization;
    if (sha256(JSON.stringify(unsigned)) !== digest) {
      context.addIssue({
        code: "custom",
        path: ["authorization_sha256"],
        message: "authorization digest differs from the signed payload"
      });
    }
  });

export type LongMemEvalMatrixPromotionAuthorization = z.infer<
  typeof LongMemEvalMatrixPromotionAuthorizationSchema
>;

type UnsignedAuthorization = Omit<
  LongMemEvalMatrixPromotionAuthorization,
  "authorization_sha256"
>;

export function buildLongMemEvalMatrixPromotionAuthorization(
  unsigned: UnsignedAuthorization
): LongMemEvalMatrixPromotionAuthorization {
  const parsed = UnsignedLongMemEvalMatrixPromotionAuthorizationSchema.parse(unsigned);
  return LongMemEvalMatrixPromotionAuthorizationSchema.parse({
    ...parsed,
    authorization_sha256: sha256(JSON.stringify(parsed))
  });
}

export function renderLongMemEvalMatrixPromotionAuthorization(
  authorization: LongMemEvalMatrixPromotionAuthorization
): string {
  return `${JSON.stringify(
    LongMemEvalMatrixPromotionAuthorizationSchema.parse(authorization),
    null,
    2
  )}\n`;
}

export function hashPromotionMatrix(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateMaterialEffect(
  effect: z.infer<typeof MaterialEffectSchema>,
  context: z.RefinementCtx
): void {
  const directional = Object.values(effect.directional);
  const token = effect.safeguards.token_saved_ratio_vs_full_prompt;
  const allMetrics = [...directional, token];
  if (allMetrics.some((metric) => metric.delta !== metric.product - metric.control)) {
    context.addIssue({ code: "custom", message: "material-effect delta is inconsistent" });
  }
  if (directional.some((metric) => metric.delta < 0) ||
      !directional.some((metric) => metric.delta > 0) || token.delta < 0) {
    context.addIssue({ code: "custom", message: "material-effect direction is not authorized" });
  }
  const paired = effect.paired_r_at_5;
  validatePairedContingencyTable(paired, context);
  const pValue = exactTwoSidedMcNemarPValue(paired.gained, paired.lost);
  const rAt5 = effect.directional.r_at_5;
  const denominator = paired.answerable_count;
  if (paired.gained + paired.lost > denominator ||
      paired.product_hits - paired.control_hits !== paired.net ||
      rAt5.control !== paired.control_hits / denominator ||
      rAt5.product !== paired.product_hits / denominator ||
      paired.net !== paired.gained - paired.lost ||
      paired.net < LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.minimumNetR5Wins ||
      paired.mcnemar.p_value !== pValue ||
      pValue >= LONGMEMEVAL_R2_MATERIAL_EFFECT_POLICY.mcnemarPValueMaxExclusive) {
    context.addIssue({ code: "custom", message: "paired material effect is not authorized" });
  }
}

function validatePairedContingencyTable(
  paired: LongMemEvalMaterialEffect["paired_r_at_5"],
  context: z.RefinementCtx
): void {
  const answerable = paired.answerable_count;
  if (paired.lost > paired.control_hits || paired.gained > paired.product_hits ||
      paired.control_hits + paired.gained > answerable ||
      paired.product_hits + paired.lost > answerable) {
    context.addIssue({
      code: "custom",
      message: "paired R@5 contingency table is impossible"
    });
  }
}
