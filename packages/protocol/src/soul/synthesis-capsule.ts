import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { PersistentObjectEnvelopeSchema } from "./envelope.js";
import { ObjectKind } from "./object-kind.js";

const synthesisTypeValues = ["phase_synthesis", "cross_evidence", "pattern_detection"] as const;

const synthesisStatusValues = ["working", "stable", "superseded", "archived"] as const;

type SynthesisStatusValue = (typeof synthesisStatusValues)[number];

export const SynthesisType = {
  PHASE_SYNTHESIS: "phase_synthesis",
  CROSS_EVIDENCE: "cross_evidence",
  PATTERN_DETECTION: "pattern_detection"
} as const;

export const SynthesisStatus = {
  WORKING: "working",
  STABLE: "stable",
  SUPERSEDED: "superseded",
  ARCHIVED: "archived"
} as const;

export const SynthesisTypeSchema = z.enum(synthesisTypeValues);
export const SynthesisStatusSchema = z.enum(synthesisStatusValues);

const synthesisTransitions: Readonly<Record<SynthesisStatusValue, readonly SynthesisStatusValue[]>> = {
  working: ["stable"],
  stable: ["superseded"],
  superseded: ["archived"],
  archived: []
};

export function isValidSynthesisTransition(
  from: SynthesisStatusValue,
  to: SynthesisStatusValue
): boolean {
  return synthesisTransitions[from].includes(to);
}

export const ClaimCandidateConditionsSchema = z
  .object({
    min_evidence_count: NonNegativeIntSchema,
    min_authority_rounds: NonNegativeIntSchema,
    stability_duration_ms: NonNegativeIntSchema,
    no_active_contradictions: z.boolean(),
    scope_class_determined: z.boolean(),
    governance_subject_compilable: z.boolean()
  })
  .readonly();

// invariant: synthesis capsules describe synthesis-tier observations;
// draft -> active claim transitions are owned by ResolutionService.
// see also: packages/core/src/resolution-service.ts
export const SynthesisCapsuleSchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ObjectKind.SYNTHESIS_CAPSULE),
    topic_key: NonEmptyStringSchema,
    synthesis_type: SynthesisTypeSchema,
    summary: NonEmptyStringSchema,
    evidence_refs: z.array(NonEmptyStringSchema).readonly(),
    source_memory_refs: z.array(NonEmptyStringSchema).readonly(),
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    synthesis_status: SynthesisStatusSchema
  })
  .readonly();

export type SynthesisType = z.infer<typeof SynthesisTypeSchema>;
export type SynthesisStatus = z.infer<typeof SynthesisStatusSchema>;
export type ClaimCandidateConditions = z.infer<typeof ClaimCandidateConditionsSchema>;
export type SynthesisCapsule = z.infer<typeof SynthesisCapsuleSchema>;
