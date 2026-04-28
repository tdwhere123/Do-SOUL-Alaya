import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";

export const SecurityPostureSchema = z.enum([
  "baseline",
  "configured",
  "elevated",
  "locked_down"
]);

export const SecurityStatusContractSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    posture: SecurityPostureSchema,
    zero_day_active: z.boolean(),
    active_security_locks: NonNegativeIntSchema,
    last_assessment_at: IsoDatetimeStringSchema,
    active_protections: z.array(NonEmptyStringSchema).readonly()
  })
  .strict()
  .readonly();

export type SecurityPosture = z.infer<typeof SecurityPostureSchema>;
export type SecurityStatusContract = z.infer<typeof SecurityStatusContractSchema>;
