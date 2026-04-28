import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";

const phase1BEventTypeValues = [
  "soul.evidence.created",
  "soul.evidence.health_changed",
  "soul.memory.created",
  "soul.memory.updated",
  "soul.memory.archived",
  "soul.memory.state_changed",
  "soul.memory.retention_updated",
  "soul.memory.manifestation_changed",
  "soul.synthesis.created",
  "soul.synthesis.status_changed",
  "soul.synthesis.promoted",
  "soul.claim.created",
  "soul.claim.lifecycle_changed",
  "soul.claim.contested",
  "soul.claim.won",
  "soul.claim.superseded",
  "soul.proposal.created",
  "soul.proposal.resolved",
  "soul.review.created",
  "soul.review.completed"
] as const;

const transitionCausedByValues = ["user", "system", "review", "deterministic_rule", "auditor", "bootstrap"] as const;

const triageResultValues = ["accepted", "dropped", "deferred"] as const;

export const Phase1BEventType = {
  SOUL_EVIDENCE_CREATED: "soul.evidence.created",
  SOUL_EVIDENCE_HEALTH_CHANGED: "soul.evidence.health_changed",
  SOUL_MEMORY_CREATED: "soul.memory.created",
  SOUL_MEMORY_UPDATED: "soul.memory.updated",
  SOUL_MEMORY_ARCHIVED: "soul.memory.archived",
  SOUL_MEMORY_STATE_CHANGED: "soul.memory.state_changed",
  SOUL_MEMORY_RETENTION_UPDATED: "soul.memory.retention_updated",
  SOUL_MEMORY_MANIFESTATION_CHANGED: "soul.memory.manifestation_changed",
  SOUL_SYNTHESIS_CREATED: "soul.synthesis.created",
  SOUL_SYNTHESIS_STATUS_CHANGED: "soul.synthesis.status_changed",
  SOUL_SYNTHESIS_PROMOTED: "soul.synthesis.promoted",
  SOUL_CLAIM_CREATED: "soul.claim.created",
  SOUL_CLAIM_LIFECYCLE_CHANGED: "soul.claim.lifecycle_changed",
  SOUL_CLAIM_CONTESTED: "soul.claim.contested",
  SOUL_CLAIM_WON: "soul.claim.won",
  SOUL_CLAIM_SUPERSEDED: "soul.claim.superseded",
  SOUL_PROPOSAL_CREATED: "soul.proposal.created",
  SOUL_PROPOSAL_RESOLVED: "soul.proposal.resolved",
  SOUL_REVIEW_CREATED: "soul.review.created",
  SOUL_REVIEW_COMPLETED: "soul.review.completed"
} as const;

export const TransitionCausedBy = {
  USER: "user",
  SYSTEM: "system",
  REVIEW: "review",
  DETERMINISTIC_RULE: "deterministic_rule",
  AUDITOR: "auditor",
  BOOTSTRAP: "bootstrap"
} as const;

export const Phase1BEventTypeSchema = z.enum(phase1BEventTypeValues);
export const TransitionCausedBySchema = z.enum(transitionCausedByValues);

const TransitionRecordObjectSchema = z.object({
  from_state: NonEmptyStringSchema,
  to_state: NonEmptyStringSchema,
  reason_code: NonEmptyStringSchema,
  caused_by: TransitionCausedBySchema,
  evidence_refs: z.array(NonEmptyStringSchema).readonly().nullable(),
  occurred_at: IsoDatetimeStringSchema
});

export const TransitionRecordSchema = TransitionRecordObjectSchema.readonly();

const Phase1BObjectPayloadObjectSchema = z.object({
  object_id: NonEmptyStringSchema,
  object_kind: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable()
});

const TransitionEventPayloadObjectSchema = Phase1BObjectPayloadObjectSchema.merge(TransitionRecordObjectSchema);

export const SoulEvidenceCreatedPayloadSchema = Phase1BObjectPayloadObjectSchema.readonly();
export const SoulEvidenceHealthChangedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

export const SoulMemoryCreatedPayloadSchema = Phase1BObjectPayloadObjectSchema.readonly();
export const SoulMemoryUpdatedPayloadSchema = Phase1BObjectPayloadObjectSchema.extend({
  updated_fields: z.array(NonEmptyStringSchema).readonly().nullable()
}).readonly();
export const SoulMemoryArchivedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();
export const SoulMemoryStateChangedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();
export const SoulMemoryRetentionUpdatedPayloadSchema = TransitionEventPayloadObjectSchema.extend({
  retention_score: z.number().min(0).max(1).nullable()
}).readonly();
export const SoulMemoryManifestationChangedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

export const SoulSynthesisCreatedPayloadSchema = Phase1BObjectPayloadObjectSchema.readonly();
export const SoulSynthesisStatusChangedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();
export const SoulSynthesisPromotedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

export const SoulClaimCreatedPayloadSchema = Phase1BObjectPayloadObjectSchema.readonly();
export const SoulClaimLifecycleChangedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();
export const SoulClaimContestedPayloadSchema = Phase1BObjectPayloadObjectSchema.extend({
  contested_by: NonEmptyStringSchema.nullable(),
  triage_result: z.enum(triageResultValues).nullable()
}).readonly();
export const SoulClaimWonPayloadSchema = TransitionEventPayloadObjectSchema.readonly();
export const SoulClaimSupersededPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

export const SoulProposalCreatedPayloadSchema = Phase1BObjectPayloadObjectSchema.readonly();
export const SoulProposalResolvedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

export const SoulReviewCreatedPayloadSchema = Phase1BObjectPayloadObjectSchema.readonly();
export const SoulReviewCompletedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

const phase1BPayloadSchemas = {
  [Phase1BEventType.SOUL_EVIDENCE_CREATED]: SoulEvidenceCreatedPayloadSchema,
  [Phase1BEventType.SOUL_EVIDENCE_HEALTH_CHANGED]: SoulEvidenceHealthChangedPayloadSchema,
  [Phase1BEventType.SOUL_MEMORY_CREATED]: SoulMemoryCreatedPayloadSchema,
  [Phase1BEventType.SOUL_MEMORY_UPDATED]: SoulMemoryUpdatedPayloadSchema,
  [Phase1BEventType.SOUL_MEMORY_ARCHIVED]: SoulMemoryArchivedPayloadSchema,
  [Phase1BEventType.SOUL_MEMORY_STATE_CHANGED]: SoulMemoryStateChangedPayloadSchema,
  [Phase1BEventType.SOUL_MEMORY_RETENTION_UPDATED]: SoulMemoryRetentionUpdatedPayloadSchema,
  [Phase1BEventType.SOUL_MEMORY_MANIFESTATION_CHANGED]: SoulMemoryManifestationChangedPayloadSchema,
  [Phase1BEventType.SOUL_SYNTHESIS_CREATED]: SoulSynthesisCreatedPayloadSchema,
  [Phase1BEventType.SOUL_SYNTHESIS_STATUS_CHANGED]: SoulSynthesisStatusChangedPayloadSchema,
  [Phase1BEventType.SOUL_SYNTHESIS_PROMOTED]: SoulSynthesisPromotedPayloadSchema,
  [Phase1BEventType.SOUL_CLAIM_CREATED]: SoulClaimCreatedPayloadSchema,
  [Phase1BEventType.SOUL_CLAIM_LIFECYCLE_CHANGED]: SoulClaimLifecycleChangedPayloadSchema,
  [Phase1BEventType.SOUL_CLAIM_CONTESTED]: SoulClaimContestedPayloadSchema,
  [Phase1BEventType.SOUL_CLAIM_WON]: SoulClaimWonPayloadSchema,
  [Phase1BEventType.SOUL_CLAIM_SUPERSEDED]: SoulClaimSupersededPayloadSchema,
  [Phase1BEventType.SOUL_PROPOSAL_CREATED]: SoulProposalCreatedPayloadSchema,
  [Phase1BEventType.SOUL_PROPOSAL_RESOLVED]: SoulProposalResolvedPayloadSchema,
  [Phase1BEventType.SOUL_REVIEW_CREATED]: SoulReviewCreatedPayloadSchema,
  [Phase1BEventType.SOUL_REVIEW_COMPLETED]: SoulReviewCompletedPayloadSchema
} as const;

const Phase1BEventBaseObjectSchema = z.object({
  event_id: NonEmptyStringSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
});

export const Phase1BEventBaseSchema = Phase1BEventBaseObjectSchema.readonly();

function createPhase1BEventObjectSchema<T extends keyof typeof phase1BPayloadSchemas>(
  eventType: T,
  payloadSchema: (typeof phase1BPayloadSchemas)[T]
) {
  return Phase1BEventBaseObjectSchema.extend({
    event_type: z.literal(eventType),
    payload: payloadSchema
  });
}

const SoulEvidenceCreatedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_EVIDENCE_CREATED,
  SoulEvidenceCreatedPayloadSchema
);
const SoulEvidenceHealthChangedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_EVIDENCE_HEALTH_CHANGED,
  SoulEvidenceHealthChangedPayloadSchema
);
const SoulMemoryCreatedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_MEMORY_CREATED,
  SoulMemoryCreatedPayloadSchema
);
const SoulMemoryUpdatedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_MEMORY_UPDATED,
  SoulMemoryUpdatedPayloadSchema
);
const SoulMemoryArchivedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_MEMORY_ARCHIVED,
  SoulMemoryArchivedPayloadSchema
);
const SoulMemoryStateChangedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_MEMORY_STATE_CHANGED,
  SoulMemoryStateChangedPayloadSchema
);
const SoulMemoryRetentionUpdatedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_MEMORY_RETENTION_UPDATED,
  SoulMemoryRetentionUpdatedPayloadSchema
);
const SoulMemoryManifestationChangedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_MEMORY_MANIFESTATION_CHANGED,
  SoulMemoryManifestationChangedPayloadSchema
);
const SoulSynthesisCreatedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_SYNTHESIS_CREATED,
  SoulSynthesisCreatedPayloadSchema
);
const SoulSynthesisStatusChangedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_SYNTHESIS_STATUS_CHANGED,
  SoulSynthesisStatusChangedPayloadSchema
);
const SoulSynthesisPromotedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_SYNTHESIS_PROMOTED,
  SoulSynthesisPromotedPayloadSchema
);
const SoulClaimCreatedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_CLAIM_CREATED,
  SoulClaimCreatedPayloadSchema
);
const SoulClaimLifecycleChangedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_CLAIM_LIFECYCLE_CHANGED,
  SoulClaimLifecycleChangedPayloadSchema
);
const SoulClaimContestedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_CLAIM_CONTESTED,
  SoulClaimContestedPayloadSchema
);
const SoulClaimWonEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_CLAIM_WON,
  SoulClaimWonPayloadSchema
);
const SoulClaimSupersededEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_CLAIM_SUPERSEDED,
  SoulClaimSupersededPayloadSchema
);
const SoulProposalCreatedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_PROPOSAL_CREATED,
  SoulProposalCreatedPayloadSchema
);
const SoulProposalResolvedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_PROPOSAL_RESOLVED,
  SoulProposalResolvedPayloadSchema
);
const SoulReviewCreatedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_REVIEW_CREATED,
  SoulReviewCreatedPayloadSchema
);
const SoulReviewCompletedEventObjectSchema = createPhase1BEventObjectSchema(
  Phase1BEventType.SOUL_REVIEW_COMPLETED,
  SoulReviewCompletedPayloadSchema
);

export const SoulEvidenceCreatedEventSchema = SoulEvidenceCreatedEventObjectSchema.readonly();
export const SoulEvidenceHealthChangedEventSchema = SoulEvidenceHealthChangedEventObjectSchema.readonly();
export const SoulMemoryCreatedEventSchema = SoulMemoryCreatedEventObjectSchema.readonly();
export const SoulMemoryUpdatedEventSchema = SoulMemoryUpdatedEventObjectSchema.readonly();
export const SoulMemoryArchivedEventSchema = SoulMemoryArchivedEventObjectSchema.readonly();
export const SoulMemoryStateChangedEventSchema = SoulMemoryStateChangedEventObjectSchema.readonly();
export const SoulMemoryRetentionUpdatedEventSchema = SoulMemoryRetentionUpdatedEventObjectSchema.readonly();
export const SoulMemoryManifestationChangedEventSchema = SoulMemoryManifestationChangedEventObjectSchema.readonly();
export const SoulSynthesisCreatedEventSchema = SoulSynthesisCreatedEventObjectSchema.readonly();
export const SoulSynthesisStatusChangedEventSchema = SoulSynthesisStatusChangedEventObjectSchema.readonly();
export const SoulSynthesisPromotedEventSchema = SoulSynthesisPromotedEventObjectSchema.readonly();
export const SoulClaimCreatedEventSchema = SoulClaimCreatedEventObjectSchema.readonly();
export const SoulClaimLifecycleChangedEventSchema = SoulClaimLifecycleChangedEventObjectSchema.readonly();
export const SoulClaimContestedEventSchema = SoulClaimContestedEventObjectSchema.readonly();
export const SoulClaimWonEventSchema = SoulClaimWonEventObjectSchema.readonly();
export const SoulClaimSupersededEventSchema = SoulClaimSupersededEventObjectSchema.readonly();
export const SoulProposalCreatedEventSchema = SoulProposalCreatedEventObjectSchema.readonly();
export const SoulProposalResolvedEventSchema = SoulProposalResolvedEventObjectSchema.readonly();
export const SoulReviewCreatedEventSchema = SoulReviewCreatedEventObjectSchema.readonly();
export const SoulReviewCompletedEventSchema = SoulReviewCompletedEventObjectSchema.readonly();

const Phase1BEventUnionSchema = z.discriminatedUnion("event_type", [
  SoulEvidenceCreatedEventObjectSchema,
  SoulEvidenceHealthChangedEventObjectSchema,
  SoulMemoryCreatedEventObjectSchema,
  SoulMemoryUpdatedEventObjectSchema,
  SoulMemoryArchivedEventObjectSchema,
  SoulMemoryStateChangedEventObjectSchema,
  SoulMemoryRetentionUpdatedEventObjectSchema,
  SoulMemoryManifestationChangedEventObjectSchema,
  SoulSynthesisCreatedEventObjectSchema,
  SoulSynthesisStatusChangedEventObjectSchema,
  SoulSynthesisPromotedEventObjectSchema,
  SoulClaimCreatedEventObjectSchema,
  SoulClaimLifecycleChangedEventObjectSchema,
  SoulClaimContestedEventObjectSchema,
  SoulClaimWonEventObjectSchema,
  SoulClaimSupersededEventObjectSchema,
  SoulProposalCreatedEventObjectSchema,
  SoulProposalResolvedEventObjectSchema,
  SoulReviewCreatedEventObjectSchema,
  SoulReviewCompletedEventObjectSchema
]);

export const Phase1BEventSchema = Phase1BEventUnionSchema.readonly();

export type Phase1BEventPayloadMap = {
  [K in keyof typeof phase1BPayloadSchemas]: z.infer<(typeof phase1BPayloadSchemas)[K]>;
};

export function parsePhase1BEventPayload<T extends keyof typeof phase1BPayloadSchemas>(
  eventType: T,
  payload: Record<string, unknown>
): Phase1BEventPayloadMap[T] {
  const schema = phase1BPayloadSchemas[eventType];
  return schema.parse(payload) as Phase1BEventPayloadMap[T];
}

export type Phase1BEventType = z.infer<typeof Phase1BEventTypeSchema>;
export type TransitionCausedBy = z.infer<typeof TransitionCausedBySchema>;
export type TransitionRecord = z.infer<typeof TransitionRecordSchema>;
export type Phase1BEvent = z.infer<typeof Phase1BEventSchema>;
