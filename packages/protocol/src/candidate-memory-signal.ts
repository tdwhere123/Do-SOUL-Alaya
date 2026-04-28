import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "./schema-primitives.js";

const signalKindValues = [
  "potential_claim",
  "potential_synthesis",
  "potential_handoff",
  "potential_evidence_anchor",
  "potential_conflict",
  "potential_preference"
] as const;

const signalSourceValues = ["model_tool", "garden_compile", "user_seed", "import"] as const;

const signalStateValues = [
  "emitted",
  "normalized",
  "triaged",
  "dropped",
  "deferred",
  "compiled",
  "materialized",
  "proposal",
  "reviewed",
  "accepted",
  "rejected",
  "superseded",
  "expired",
  "failed"
] as const;

export const SignalKind = {
  POTENTIAL_CLAIM: "potential_claim",
  POTENTIAL_SYNTHESIS: "potential_synthesis",
  POTENTIAL_HANDOFF: "potential_handoff",
  POTENTIAL_EVIDENCE_ANCHOR: "potential_evidence_anchor",
  POTENTIAL_CONFLICT: "potential_conflict",
  POTENTIAL_PREFERENCE: "potential_preference"
} as const;

export const SignalSource = {
  MODEL_TOOL: "model_tool",
  GARDEN_COMPILE: "garden_compile",
  USER_SEED: "user_seed",
  IMPORT: "import"
} as const;

export const SignalState = {
  EMITTED: "emitted",
  NORMALIZED: "normalized",
  TRIAGED: "triaged",
  DROPPED: "dropped",
  DEFERRED: "deferred",
  COMPILED: "compiled",
  MATERIALIZED: "materialized",
  PROPOSAL: "proposal",
  REVIEWED: "reviewed",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  SUPERSEDED: "superseded",
  EXPIRED: "expired",
  FAILED: "failed"
} as const;

export const SignalKindSchema = z.enum(signalKindValues);
export const SignalSourceSchema = z.enum(signalSourceValues);
export const SignalStateSchema = z.enum(signalStateValues);

const ConfidenceSchema = z.number().min(0).max(1);
const DomainTagsSchema = z.array(NonEmptyStringSchema).readonly();
const EvidenceRefsSchema = z.array(NonEmptyStringSchema).readonly();
const RawPayloadSchema = z.record(z.unknown()).readonly();

export const CandidateMemorySignalSchema = z.object({
  signal_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema,
  surface_id: NonEmptyStringSchema.nullable(),
  source: SignalSourceSchema,
  signal_kind: SignalKindSchema,
  signal_state: SignalStateSchema.default(SignalState.EMITTED),
  object_kind: NonEmptyStringSchema,
  scope_hint: NonEmptyStringSchema.nullable(),
  domain_tags: DomainTagsSchema,
  confidence: ConfidenceSchema,
  evidence_refs: EvidenceRefsSchema,
  raw_payload: RawPayloadSchema,
  created_at: IsoDatetimeStringSchema
}).readonly();

export const CandidateMemorySignalInputSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    surface_id: NonEmptyStringSchema.nullable(),
    signal_kind: SignalKindSchema,
    object_kind: NonEmptyStringSchema,
    scope_hint: NonEmptyStringSchema.nullable(),
    domain_tags: DomainTagsSchema,
    confidence: ConfidenceSchema,
    evidence_refs: EvidenceRefsSchema,
    raw_payload: RawPayloadSchema
  })
  .strict()
  .readonly();

export const EmitCandidateSignalRequestSchema = CandidateMemorySignalInputSchema;

export const EmitCandidateSignalResponseSchema = z
  .object({
    signal_id: NonEmptyStringSchema,
    status: z.enum(["emitted", "normalized"])
  })
  .readonly();

export type SignalKind = z.infer<typeof SignalKindSchema>;
export type SignalSource = z.infer<typeof SignalSourceSchema>;
export type SignalState = z.infer<typeof SignalStateSchema>;
export type CandidateMemorySignal = z.infer<typeof CandidateMemorySignalSchema>;
export type CandidateMemorySignalInput = z.infer<typeof CandidateMemorySignalInputSchema>;
export type EmitCandidateSignalRequest = z.infer<typeof EmitCandidateSignalRequestSchema>;
export type EmitCandidateSignalResponse = z.infer<typeof EmitCandidateSignalResponseSchema>;
