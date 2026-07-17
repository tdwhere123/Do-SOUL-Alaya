import { createHash } from "node:crypto";
import { z } from "zod";
import {
  LongMemEvalSelectionContractIdentitySchema
} from "@do-soul/alaya-eval";
import { LongMemEvalMatrixTreatmentSchema } from "./contract.js";

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
  hard_gates: z.array(HardGateSchema).min(1)
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
