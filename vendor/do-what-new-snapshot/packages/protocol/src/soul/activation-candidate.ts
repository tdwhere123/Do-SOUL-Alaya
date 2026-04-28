import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema
} from "../schema-primitives.js";
import {
  PathAnchorRefSchema,
  PathEffectVectorSchema,
  PathGovernanceClassSchema
} from "./path-relation.js";

export const ActivationCandidateSchema = z
  .object({
    candidate_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    source_path_id: NonEmptyStringSchema,
    source_anchor: PathAnchorRefSchema,
    target_anchor: PathAnchorRefSchema,
    why_now: NonEmptyStringSchema,
    effect_vector_snapshot: PathEffectVectorSchema,
    pressure: z.number(),
    confidence: z.number(),
    governance_ceiling: PathGovernanceClassSchema,
    created_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type ActivationCandidate = z.infer<typeof ActivationCandidateSchema>;
