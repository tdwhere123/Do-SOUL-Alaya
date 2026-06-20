import { z } from "zod";
import {
  BoundedIdSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  RatioSchema
} from "../shared/schema-primitives.js";
import {
  PathAnchorRefSchema,
  PathEffectVectorSchema,
  PathGovernanceClassSchema
} from "./path-relation.js";

export const ActivationCandidateSchema = z
  .object({
    candidate_id: BoundedIdSchema,
    workspace_id: BoundedIdSchema,
    run_id: BoundedIdSchema,
    source_path_id: BoundedIdSchema,
    source_anchor: PathAnchorRefSchema,
    target_anchor: PathAnchorRefSchema,
    why_now: BoundedReasonSchema,
    effect_vector_snapshot: PathEffectVectorSchema,
    pressure: RatioSchema,
    confidence: RatioSchema,
    governance_ceiling: PathGovernanceClassSchema,
    created_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type ActivationCandidate = z.infer<typeof ActivationCandidateSchema>;
