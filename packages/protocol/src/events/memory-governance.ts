import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { StorageTierSchema } from "../soul/memory-entry.js";

const memoryGovernanceEventTypeValues = [
  "soul.evidence.created",
  "soul.evidence.health_changed",
  "soul.memory.created",
  "soul.memory.updated",
  "soul.memory.archived",
  "soul.memory.state_changed",
  "soul.memory.retention_updated",
  "soul.memory.manifestation_changed",
  // gate-6-delta I4: storage_tier transitions used to be a direct
  // UPDATE in Janitor.executeHotIndexDemotion with no audit row.
  // SOUL_MEMORY_TIER_CHANGED closes the §8 gap.
  "soul.memory.tier_changed",
  "soul.memory.tier_promoted",
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
const memoryTierPromotionReasonValues = ["recall_hit", "other"] as const;

export const MemoryGovernanceEventType = {
  SOUL_EVIDENCE_CREATED: "soul.evidence.created",
  SOUL_EVIDENCE_HEALTH_CHANGED: "soul.evidence.health_changed",
  SOUL_MEMORY_CREATED: "soul.memory.created",
  SOUL_MEMORY_UPDATED: "soul.memory.updated",
  SOUL_MEMORY_ARCHIVED: "soul.memory.archived",
  SOUL_MEMORY_STATE_CHANGED: "soul.memory.state_changed",
  SOUL_MEMORY_RETENTION_UPDATED: "soul.memory.retention_updated",
  SOUL_MEMORY_MANIFESTATION_CHANGED: "soul.memory.manifestation_changed",
  SOUL_MEMORY_TIER_CHANGED: "soul.memory.tier_changed",
  SOUL_MEMORY_TIER_PROMOTED: "soul.memory.tier_promoted",
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

export const MemoryGovernanceEventTypeSchema = z.enum(memoryGovernanceEventTypeValues);
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

const MemoryGovernanceObjectPayloadObjectSchema = z.object({
  object_id: NonEmptyStringSchema,
  object_kind: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable()
});

const TransitionEventPayloadObjectSchema = MemoryGovernanceObjectPayloadObjectSchema.merge(TransitionRecordObjectSchema);

export const SoulEvidenceCreatedPayloadSchema = MemoryGovernanceObjectPayloadObjectSchema.readonly();
export const SoulEvidenceHealthChangedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

export const SoulMemoryCreatedPayloadSchema = MemoryGovernanceObjectPayloadObjectSchema.readonly();
export const SoulMemoryUpdatedPayloadSchema = MemoryGovernanceObjectPayloadObjectSchema.extend({
  updated_fields: z.array(NonEmptyStringSchema).readonly().nullable()
}).readonly();
export const SoulMemoryArchivedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();
export const SoulMemoryStateChangedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();
export const SoulMemoryRetentionUpdatedPayloadSchema = TransitionEventPayloadObjectSchema.extend({
  retention_score: z.number().min(0).max(1).nullable()
}).readonly();
export const SoulMemoryManifestationChangedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

// gate-6-delta I4: storage_tier transition emitted by the Janitor
// alongside the UPDATE memory_entries.storage_tier write.
export const SoulMemoryTierChangedPayloadSchema = MemoryGovernanceObjectPayloadObjectSchema.extend({
  from_tier: NonEmptyStringSchema,
  to_tier: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
  task_id: NonEmptyStringSchema,
  occurred_at: IsoDatetimeStringSchema
}).readonly();
export const SoulMemoryTierPromotedReasonSchema = z.enum(memoryTierPromotionReasonValues);
export const SoulMemoryTierPromotedPayloadSchema = MemoryGovernanceObjectPayloadObjectSchema.extend({
  from_tier: StorageTierSchema,
  to_tier: StorageTierSchema,
  reason: SoulMemoryTierPromotedReasonSchema,
  task_id: NonEmptyStringSchema.optional(),
  occurred_at: IsoDatetimeStringSchema
}).readonly();

export const SoulSynthesisCreatedPayloadSchema = MemoryGovernanceObjectPayloadObjectSchema.readonly();
export const SoulSynthesisStatusChangedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();
export const SoulSynthesisPromotedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

export const SoulClaimCreatedPayloadSchema = MemoryGovernanceObjectPayloadObjectSchema.readonly();
export const SoulClaimLifecycleChangedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();
export const SoulClaimContestedPayloadSchema = MemoryGovernanceObjectPayloadObjectSchema.extend({
  contested_by: NonEmptyStringSchema.nullable(),
  triage_result: z.enum(triageResultValues).nullable()
}).readonly();
export const SoulClaimWonPayloadSchema = TransitionEventPayloadObjectSchema.readonly();
export const SoulClaimSupersededPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

export const SoulProposalCreatedPayloadSchema = MemoryGovernanceObjectPayloadObjectSchema.readonly();
export const SoulProposalResolvedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

export const SoulReviewCreatedPayloadSchema = MemoryGovernanceObjectPayloadObjectSchema.readonly();
export const SoulReviewCompletedPayloadSchema = TransitionEventPayloadObjectSchema.readonly();

const memoryGovernancePayloadSchemas = {
  [MemoryGovernanceEventType.SOUL_EVIDENCE_CREATED]: SoulEvidenceCreatedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_EVIDENCE_HEALTH_CHANGED]: SoulEvidenceHealthChangedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_MEMORY_CREATED]: SoulMemoryCreatedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_MEMORY_UPDATED]: SoulMemoryUpdatedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_MEMORY_ARCHIVED]: SoulMemoryArchivedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED]: SoulMemoryStateChangedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_MEMORY_RETENTION_UPDATED]: SoulMemoryRetentionUpdatedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_MEMORY_MANIFESTATION_CHANGED]: SoulMemoryManifestationChangedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_MEMORY_TIER_CHANGED]: SoulMemoryTierChangedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED]: SoulMemoryTierPromotedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED]: SoulSynthesisCreatedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_SYNTHESIS_STATUS_CHANGED]: SoulSynthesisStatusChangedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_SYNTHESIS_PROMOTED]: SoulSynthesisPromotedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_CLAIM_CREATED]: SoulClaimCreatedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_CLAIM_LIFECYCLE_CHANGED]: SoulClaimLifecycleChangedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_CLAIM_CONTESTED]: SoulClaimContestedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_CLAIM_WON]: SoulClaimWonPayloadSchema,
  [MemoryGovernanceEventType.SOUL_CLAIM_SUPERSEDED]: SoulClaimSupersededPayloadSchema,
  [MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED]: SoulProposalCreatedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED]: SoulProposalResolvedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_REVIEW_CREATED]: SoulReviewCreatedPayloadSchema,
  [MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED]: SoulReviewCompletedPayloadSchema
} as const;

const MemoryGovernanceEventBaseObjectSchema = z.object({
  event_id: NonEmptyStringSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
});

export const MemoryGovernanceEventBaseSchema = MemoryGovernanceEventBaseObjectSchema.readonly();

function createMemoryGovernanceEventObjectSchema<T extends keyof typeof memoryGovernancePayloadSchemas>(
  eventType: T,
  payloadSchema: (typeof memoryGovernancePayloadSchemas)[T]
) {
  return MemoryGovernanceEventBaseObjectSchema.extend({
    event_type: z.literal(eventType),
    payload: payloadSchema
  });
}

const SoulEvidenceCreatedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_EVIDENCE_CREATED,
  SoulEvidenceCreatedPayloadSchema
);
const SoulEvidenceHealthChangedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_EVIDENCE_HEALTH_CHANGED,
  SoulEvidenceHealthChangedPayloadSchema
);
const SoulMemoryCreatedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_MEMORY_CREATED,
  SoulMemoryCreatedPayloadSchema
);
const SoulMemoryUpdatedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
  SoulMemoryUpdatedPayloadSchema
);
const SoulMemoryArchivedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_MEMORY_ARCHIVED,
  SoulMemoryArchivedPayloadSchema
);
const SoulMemoryStateChangedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
  SoulMemoryStateChangedPayloadSchema
);
const SoulMemoryRetentionUpdatedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_MEMORY_RETENTION_UPDATED,
  SoulMemoryRetentionUpdatedPayloadSchema
);
const SoulMemoryManifestationChangedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_MEMORY_MANIFESTATION_CHANGED,
  SoulMemoryManifestationChangedPayloadSchema
);
const SoulMemoryTierChangedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_MEMORY_TIER_CHANGED,
  SoulMemoryTierChangedPayloadSchema
);
const SoulMemoryTierPromotedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED,
  SoulMemoryTierPromotedPayloadSchema
);
const SoulSynthesisCreatedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED,
  SoulSynthesisCreatedPayloadSchema
);
const SoulSynthesisStatusChangedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_SYNTHESIS_STATUS_CHANGED,
  SoulSynthesisStatusChangedPayloadSchema
);
const SoulSynthesisPromotedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_SYNTHESIS_PROMOTED,
  SoulSynthesisPromotedPayloadSchema
);
const SoulClaimCreatedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_CLAIM_CREATED,
  SoulClaimCreatedPayloadSchema
);
const SoulClaimLifecycleChangedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_CLAIM_LIFECYCLE_CHANGED,
  SoulClaimLifecycleChangedPayloadSchema
);
const SoulClaimContestedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_CLAIM_CONTESTED,
  SoulClaimContestedPayloadSchema
);
const SoulClaimWonEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_CLAIM_WON,
  SoulClaimWonPayloadSchema
);
const SoulClaimSupersededEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_CLAIM_SUPERSEDED,
  SoulClaimSupersededPayloadSchema
);
const SoulProposalCreatedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
  SoulProposalCreatedPayloadSchema
);
const SoulProposalResolvedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
  SoulProposalResolvedPayloadSchema
);
const SoulReviewCreatedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
  SoulReviewCreatedPayloadSchema
);
const SoulReviewCompletedEventObjectSchema = createMemoryGovernanceEventObjectSchema(
  MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
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
export const SoulMemoryTierChangedEventSchema = SoulMemoryTierChangedEventObjectSchema.readonly();
export const SoulMemoryTierPromotedEventSchema = SoulMemoryTierPromotedEventObjectSchema.readonly();
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

const MemoryGovernanceEventUnionSchema = z.discriminatedUnion("event_type", [
  SoulEvidenceCreatedEventObjectSchema,
  SoulEvidenceHealthChangedEventObjectSchema,
  SoulMemoryCreatedEventObjectSchema,
  SoulMemoryUpdatedEventObjectSchema,
  SoulMemoryArchivedEventObjectSchema,
  SoulMemoryStateChangedEventObjectSchema,
  SoulMemoryRetentionUpdatedEventObjectSchema,
  SoulMemoryManifestationChangedEventObjectSchema,
  SoulMemoryTierChangedEventObjectSchema,
  SoulMemoryTierPromotedEventObjectSchema,
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

export const MemoryGovernanceEventSchema = MemoryGovernanceEventUnionSchema.readonly();

export type MemoryGovernanceEventPayloadMap = {
  [K in keyof typeof memoryGovernancePayloadSchemas]: z.infer<(typeof memoryGovernancePayloadSchemas)[K]>;
};

export function parseMemoryGovernanceEventPayload<T extends keyof typeof memoryGovernancePayloadSchemas>(
  eventType: T,
  payload: Record<string, unknown>
): MemoryGovernanceEventPayloadMap[T] {
  const schema = memoryGovernancePayloadSchemas[eventType];
  return schema.parse(payload) as MemoryGovernanceEventPayloadMap[T];
}

export type MemoryGovernanceEventType = z.infer<typeof MemoryGovernanceEventTypeSchema>;
export type TransitionCausedBy = z.infer<typeof TransitionCausedBySchema>;
export type TransitionRecord = z.infer<typeof TransitionRecordSchema>;
export type MemoryGovernanceEvent = z.infer<typeof MemoryGovernanceEventSchema>;
