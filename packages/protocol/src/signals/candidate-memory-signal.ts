import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BOUNDED_EVIDENCE_ARRAY_MAX,
  BoundedIdSchema,
  BoundedJsonObjectSchema,
  BoundedLabelSchema,
  IsoDatetimeStringSchema
} from "../shared/schema-primitives.js";

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
const DomainTagsSchema = z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly();
const EvidenceRefsSchema = z.array(BoundedLabelSchema).max(BOUNDED_EVIDENCE_ARRAY_MAX).readonly();
export const CandidateMemorySignalMemoryRefKeys = [
  "source_memory_refs",
  "supersedes_refs",
  "exception_to_refs",
  "contradicts_refs",
  "incompatible_with_refs"
] as const;

export const CandidateMemorySignalMemoryRefsSchema = z
  .array(BoundedIdSchema)
  .max(BOUNDED_DEFAULT_ARRAY_MAX)
  .default([])
  .readonly();
const MemoryRefsSchema = CandidateMemorySignalMemoryRefsSchema;
const RawPayloadSchema = BoundedJsonObjectSchema;
const SourceDeliveryIdsSchema = z.array(BoundedIdSchema).min(1).max(32).readonly();

export const CandidateMemorySignalSchema = z.object({
  signal_id: BoundedIdSchema,
  workspace_id: BoundedIdSchema,
  run_id: BoundedIdSchema,
  surface_id: BoundedIdSchema.nullable(),
  source: SignalSourceSchema,
  signal_kind: SignalKindSchema,
  signal_state: SignalStateSchema.default(SignalState.EMITTED),
  object_kind: BoundedLabelSchema,
  scope_hint: BoundedLabelSchema.nullable(),
  domain_tags: DomainTagsSchema,
  confidence: ConfidenceSchema,
  evidence_refs: EvidenceRefsSchema,
  source_memory_refs: MemoryRefsSchema,
  supersedes_refs: MemoryRefsSchema,
  exception_to_refs: MemoryRefsSchema,
  contradicts_refs: MemoryRefsSchema,
  incompatible_with_refs: MemoryRefsSchema,
  raw_payload: RawPayloadSchema,
  source_delivery_ids: SourceDeliveryIdsSchema.optional(),
  created_at: IsoDatetimeStringSchema
}).readonly();

// Content-only fields that the agent supplies. workspace_id / run_id /
// surface_id are bound from trusted MCP context per invariants §29
// Default Scope; see McpEmitCandidateSignalRequestSchema below.
const CandidateMemorySignalContentFieldsSchema = z.object({
  signal_kind: SignalKindSchema,
  object_kind: BoundedLabelSchema,
  scope_hint: BoundedLabelSchema.nullable(),
  domain_tags: DomainTagsSchema,
  confidence: ConfidenceSchema,
  evidence_refs: EvidenceRefsSchema,
  source_memory_refs: MemoryRefsSchema.optional(),
  supersedes_refs: MemoryRefsSchema.optional(),
  exception_to_refs: MemoryRefsSchema.optional(),
  contradicts_refs: MemoryRefsSchema.optional(),
  incompatible_with_refs: MemoryRefsSchema.optional(),
  raw_payload: RawPayloadSchema
});

export const CandidateMemorySignalContentSchema = CandidateMemorySignalContentFieldsSchema
  .strict()
  .readonly();

// Internal input shape used by signal-service callers that already
// know workspace/run/surface (Garden compile, user seed, import paths).
// Public MCP-facing callers should use McpEmitCandidateSignalRequestSchema
// instead so they never see the scope fields.
export const CandidateMemorySignalInputSchema = CandidateMemorySignalContentFieldsSchema
  .extend({
    workspace_id: BoundedIdSchema,
    run_id: BoundedIdSchema,
    surface_id: BoundedIdSchema.nullable()
  })
  .strict()
  .readonly();

// Agent-facing emit request for soul.emit_candidate_signal. Scope fields are
// omitted because the MCP daemon binds workspace_id / run_id / surface_id
// from the trusted call context per invariant §29. Keeping those fields on
// the public schema would teach attached LLMs to pass caller scope back in
// the payload, reopening the prompt-injection vector even though runtime
// guards reject spoofing.
export const McpEmitCandidateSignalRequestSchema = CandidateMemorySignalContentFieldsSchema
  .extend({
    source_delivery_ids: SourceDeliveryIdsSchema.optional()
  })
  .strict()
  .readonly();

export const EmitCandidateSignalRequestSchema = CandidateMemorySignalInputSchema;

export const EmitCandidateSignalResponseSchema = z
  .object({
    signal_id: BoundedIdSchema,
    status: z.enum(["emitted", "normalized"])
  })
  .readonly();

export type SignalKind = z.infer<typeof SignalKindSchema>;
export type SignalSource = z.infer<typeof SignalSourceSchema>;
export type SignalState = z.infer<typeof SignalStateSchema>;
export type CandidateMemorySignal = z.infer<typeof CandidateMemorySignalSchema>;
export type CandidateMemorySignalInput = z.infer<typeof CandidateMemorySignalInputSchema>;
export type EmitCandidateSignalRequest = z.infer<typeof EmitCandidateSignalRequestSchema>;
export type McpEmitCandidateSignalRequest = z.infer<typeof McpEmitCandidateSignalRequestSchema>;
export type EmitCandidateSignalResponse = z.infer<typeof EmitCandidateSignalResponseSchema>;
