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
const SourceDeliveryIdsSchema = z.array(NonEmptyStringSchema).min(1).readonly();

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
  source_delivery_ids: SourceDeliveryIdsSchema.optional(),
  created_at: IsoDatetimeStringSchema
}).readonly();

// Content-only fields that the agent supplies. workspace_id / run_id /
// surface_id are bound from trusted MCP context per invariants §29
// Default Scope; see McpEmitCandidateSignalRequestSchema below.
const CandidateMemorySignalContentFieldsSchema = z.object({
  signal_kind: SignalKindSchema,
  object_kind: NonEmptyStringSchema,
  scope_hint: NonEmptyStringSchema.nullable(),
  domain_tags: DomainTagsSchema,
  confidence: ConfidenceSchema,
  evidence_refs: EvidenceRefsSchema,
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
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    surface_id: NonEmptyStringSchema.nullable()
  })
  .strict()
  .readonly();

// gate-6-delta I5: agent-facing emit request for soul.emit_candidate_signal.
// Strips workspace_id / run_id / surface_id — the MCP daemon binds those
// from the trusted call context. This mirrors the §29 hardening already
// applied to SoulExploreGraphRequestSchema and
// SoulListPendingProposalsRequestSchema. Keeping the scope fields on the
// public schema would teach every attached LLM to learn its workspace
// and pass it back, reopening the prompt-inject vector ("now pass
// workspace_id=foreign") even though the runtime guard catches the
// spoof.
export const McpEmitCandidateSignalRequestSchema = CandidateMemorySignalContentFieldsSchema
  .extend({
    source_delivery_ids: SourceDeliveryIdsSchema.optional()
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
export type McpEmitCandidateSignalRequest = z.infer<typeof McpEmitCandidateSignalRequestSchema>;
export type EmitCandidateSignalResponse = z.infer<typeof EmitCandidateSignalResponseSchema>;
