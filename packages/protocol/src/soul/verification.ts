import { z } from "zod";
import { NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { ControlPlaneObjectKind } from "./object-kind.js";

const verificationVerdictValues = ["go", "no_go"] as const;

export const VerificationVerdict = {
  GO: "go",
  NO_GO: "no_go"
} as const;

export const VerificationVerdictSchema = z.enum(verificationVerdictValues);

export const VerificationResultSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.VERIFICATION_RESULT),
    verdict: VerificationVerdictSchema,
    micro_correction_hint: NonEmptyStringSchema.nullable(),
    necessary_patch: NonEmptyStringSchema.nullable()
  })
  .strict()
  .readonly();

export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
