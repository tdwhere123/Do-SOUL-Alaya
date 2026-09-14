import { z } from "zod";
import {
  AuthorizedScopesAdmissionSchema,
  EvidenceCapsuleSchema,
  MemoryDimensionSchema,
  MemoryEntrySchema,
  PathAnchorRefSchema,
  PathRelationSchema,
  ScopeClassSchema,
  SoulActiveConstraintSchema,
  StorageTierSchema,
  SynthesisCapsuleSchema,
  type BoundedActiveConstraintsRequest
} from "@do-soul/alaya-protocol";
import {
  BoundedActiveConstraintsResultSchema,
  ConditionalFieldRecallPortResultSchema,
  ConditionalFieldRecallWorkerPayloadSchema,
  type RecallReadWorkerOperation
} from "./protocol.js";

const EmptyObjectSchema = z.object({}).strict();
const KeywordSearchSchema = z.object({
  workspaceId: z.string(),
  queryText: z.string(),
  limit: z.number()
}).strict();
const KeywordFieldSearchSchema = z.object({
  workspaceId: z.string(),
  queryText: z.string(),
  limit: z.number(),
  refinementDepths: z.array(z.number().int().positive()).readonly().optional(),
  capture: z.object({ variant: z.enum(["lexical_relaxed", "lexical_expanded"]) }).strict().optional(),
  scope: z.object({
    objectIds: z.array(z.string()).readonly().optional(),
    tier: StorageTierSchema.optional()
  }).strict().optional()
}).strict();
const KeywordBatchSchema = z.object({
  workspaceId: z.string(),
  queries: z.array(z.object({
    queryText: z.string(),
    limit: z.number(),
    refinement_depths: z.array(z.number().int().positive()).readonly().optional()
  }).strict()).readonly()
}).strict();
const ObjectIdsSchema = z.object({
  workspaceId: z.string(),
  objectIds: z.array(z.string()).readonly()
}).strict();
const EvidenceIdsSchema = z.object({
  workspaceId: z.string(),
  evidenceObjectIds: z.array(z.string()).readonly()
}).strict();
const PageSchema = z.object({
  limit: z.number(),
  offset: z.number()
}).strict();
const AcknowledgeSchema = z.object({
  preparation_id: z.string(),
  issued_entry_ids: z.array(z.string()).readonly(),
  previews: z.record(z.string(), z.string())
}).strict();
const DiscardSchema = z.object({
  preparation_id: z.string()
}).strict();

export const BoundedRequestSchema = z.object({
  workspaceId: z.string(),
  asOf: z.string(),
  snapshotId: z.string().optional(),
  authorizedScopes: AuthorizedScopesAdmissionSchema.optional(),
  cap: z.number().nullable().optional(),
  nativeLimit: z.number(),
  byteLimit: z.number()
}).strict();

type BoundedRequestPayload = z.infer<typeof BoundedRequestSchema>;
type BoundedPayloadFitsRequest = BoundedRequestPayload extends BoundedActiveConstraintsRequest ? true : false;
const boundedPayloadFitsRequest: BoundedPayloadFitsRequest = true;
void boundedPayloadFitsRequest;

const PAYLOAD_SCHEMAS = {
  ready: EmptyObjectSchema,
  close: EmptyObjectSchema,
  "snapshot.beginDeferred": EmptyObjectSchema,
  "snapshot.commit": EmptyObjectSchema,
  "snapshot.rollback": EmptyObjectSchema,
  "conditionalField.recall": ConditionalFieldRecallWorkerPayloadSchema,
  "conditionalField.acknowledge": AcknowledgeSchema,
  "conditionalField.discard": DiscardSchema,
  "memory.findByWorkspaceId": z.object({
    workspaceId: z.string(),
    tier: StorageTierSchema.optional(),
    page: PageSchema.optional()
  }).strict(),
  "memory.findRecallTierWindow": z.object({
    workspaceId: z.string(),
    tier: StorageTierSchema,
    limit: z.number(),
    cursor: z.object({
      created_at: z.string(),
      object_id: z.string()
    }).strict().optional()
  }).strict(),
  "memory.findByEventTimeWindow": z.object({
    workspaceId: z.string(),
    tier: StorageTierSchema,
    startTime: z.string(),
    endTime: z.string(),
    limit: z.number()
  }).strict(),
  "memory.findByDimension": z.object({
    workspaceId: z.string(),
    dimension: MemoryDimensionSchema
  }).strict(),
  "memory.findByScopeClass": z.object({
    workspaceId: z.string(),
    scopeClass: ScopeClassSchema
  }).strict(),
  "memory.searchByKeyword": KeywordSearchSchema,
  "memory.searchByKeywordField": KeywordFieldSearchSchema,
  "memory.searchByKeywordWithinObjectIds": KeywordSearchSchema.extend({
    objectIds: z.array(z.string()).readonly()
  }).strict(),
  "memory.searchByKeywordWithinTier": KeywordSearchSchema.extend({
    tier: StorageTierSchema
  }).strict(),
  "memory.searchManyByKeywordWithinObjectIds": KeywordBatchSchema.extend({
    objectIds: z.array(z.string()).readonly()
  }).strict(),
  "memory.searchByAnchorWithinObjectIds": z.object({
    workspaceId: z.string(),
    anchorTokens: z.array(z.string()).readonly(),
    optionalTokens: z.array(z.string()).readonly(),
    limit: z.number(),
    objectIds: z.array(z.string()).readonly()
  }).strict(),
  "memory.searchByAnchorWithinTier": z.object({
    workspaceId: z.string(),
    anchorTokens: z.array(z.string()).readonly(),
    optionalTokens: z.array(z.string()).readonly(),
    limit: z.number(),
    tier: StorageTierSchema
  }).strict(),
  "memory.searchByAnchorField": z.object({
    workspaceId: z.string(),
    anchorTokens: z.array(z.string()).readonly(),
    optionalTokens: z.array(z.string()).readonly(),
    limit: z.number(),
    refinementDepths: z.array(z.number().int().positive()).readonly().optional(),
    scope: z.object({
      objectIds: z.array(z.string()).readonly().optional(),
      tier: StorageTierSchema.optional()
    }).strict().optional()
  }).strict(),
  "memory.findByEvidenceRefs": EvidenceIdsSchema,
  "memory.findBoundEvidenceRefs": EvidenceIdsSchema,
  "memory.findByIds": ObjectIdsSchema,
  "evidence.searchByKeyword": KeywordSearchSchema,
  "evidence.searchByKeywordField": KeywordFieldSearchSchema.omit({ capture: true, scope: true }).strict(),
  "evidence.searchManyByKeywordField": KeywordBatchSchema,
  "evidence.findByIds": EvidenceIdsSchema,
  "evidence.findRecallQualifiedByIds": z.object({
    workspaceId: z.string(),
    matches: z.unknown()
  }).strict(),
  "evidence.findRecallQualifiedFactKeysByIds": EvidenceIdsSchema,
  "evidence.findSourceAnchorsByIds": EvidenceIdsSchema,
  "synthesis.searchByKeyword": KeywordSearchSchema,
  "synthesis.searchByKeywordField": KeywordFieldSearchSchema.omit({ capture: true, scope: true }).strict(),
  "synthesis.searchManyByKeywordField": KeywordBatchSchema,
  "synthesis.findByIds": ObjectIdsSchema,
  "path.findByAnchors": z.object({
    workspaceId: z.string(),
    anchorRefs: z.array(PathAnchorRefSchema).readonly(),
    asOf: z.string().optional()
  }).strict(),
  "path.findByTimeConcernWindowDigests": z.object({
    workspaceId: z.string(),
    windowDigests: z.array(z.string()).readonly(),
    asOf: z.string().optional()
  }).strict(),
  "pathPlasticity.getStrengthByMemoryId": z.object({
    workspaceId: z.string(),
    memoryIds: z.array(z.string()).readonly(),
    asOf: z.string().optional()
  }).strict(),
  "constraints.findActive": z.object({
    workspaceId: z.string(),
    cap: z.number().nullable().optional(),
    asOf: z.string().optional()
  }).strict(),
  "constraints.readBounded": BoundedRequestSchema
} satisfies Record<RecallReadWorkerOperation, z.ZodTypeAny>;

export type WorkerOperationPayloadMap = {
  [K in RecallReadWorkerOperation]: z.infer<(typeof PAYLOAD_SCHEMAS)[K]>;
};

export type WorkerOperationPayload<O extends RecallReadWorkerOperation> =
  WorkerOperationPayloadMap[O];

const KeywordHitSchema = z.object({
  object_id: z.string(),
  normalized_rank: z.number(),
  trigram_rank: z.number().optional(),
  object_key_rank: z.number().optional(),
  matched_fts_lanes: z.array(z.string()).readonly().optional(),
  matched_projection: z.unknown().optional(),
  rank: z.number().optional(),
  source_id: z.string().optional()
}).strict();
const KeywordHitsSchema = z.array(KeywordHitSchema).readonly();
const KeywordFieldResultSchema = z.object({
  matches: KeywordHitsSchema,
  lanes: z.array(z.unknown()).readonly(),
  lexical_raw_rank: z.unknown().optional(),
  lexical_raw_rank_receipt: z.unknown().optional(),
  refinement_levels: z.array(z.unknown()).readonly().optional()
}).strict();
const MemoryEntriesSchema = z.array(MemoryEntrySchema).readonly();
const PathRelationsSchema = z.array(PathRelationSchema).readonly();
const QualifiedEvidenceSchema = z.array(z.object({
  capsule: EvidenceCapsuleSchema,
  verified_user_projection: z.boolean(),
  matched_projection: z.unknown().optional(),
  matched_fact_key_forms: z.array(z.unknown()).readonly().optional(),
  matched_fact_frame: z.unknown().optional(),
  fact_frame_formation: z.unknown().optional(),
  semantic_factor_formation: z.unknown().optional(),
  kind_projection_drafts: z.array(z.unknown()).readonly().optional()
}).strict()).readonly();
const SourceAnchorSchema = z.object({
  evidence_object_id: z.string(),
  artifact_ref: z.string()
}).strict();
const RecallTierWindowCursorSchema = z.object({
  created_at: z.string(),
  object_id: z.string()
}).strict();
const RecallTierWindowResultSchema = z.object({
  memories: z.array(z.unknown()).readonly(),
  next_cursor: RecallTierWindowCursorSchema.nullable(),
  truncated: z.boolean()
}).strict();
export const RecallTierWindowChunkSchema = RecallTierWindowResultSchema.extend({
  kind: z.literal("recall-tier-window-chunk"),
  done: z.boolean()
}).strict();

const RESULT_SCHEMAS = {
  ready: z.null(),
  close: z.null(),
  "snapshot.beginDeferred": z.null(),
  "snapshot.commit": z.null(),
  "snapshot.rollback": z.null(),
  "conditionalField.recall": ConditionalFieldRecallPortResultSchema,
  // Receipt fields are owned by core; this boundary only requires the version tag.
  "conditionalField.acknowledge": z.union([
    z.null(),
    z.object({ schema_version: z.number() }).passthrough()
  ]),
  "conditionalField.discard": z.null(),
  "memory.findByWorkspaceId": MemoryEntriesSchema,
  "memory.findRecallTierWindow": z.union([RecallTierWindowChunkSchema, RecallTierWindowResultSchema]),
  "memory.findByEventTimeWindow": MemoryEntriesSchema,
  "memory.findByDimension": MemoryEntriesSchema,
  "memory.findByScopeClass": MemoryEntriesSchema,
  "memory.searchByKeyword": KeywordHitsSchema,
  "memory.searchByKeywordField": KeywordFieldResultSchema,
  "memory.searchByKeywordWithinObjectIds": KeywordHitsSchema,
  "memory.searchByKeywordWithinTier": KeywordHitsSchema,
  "memory.searchManyByKeywordWithinObjectIds": z.array(KeywordHitsSchema).readonly(),
  "memory.searchByAnchorWithinObjectIds": KeywordHitsSchema,
  "memory.searchByAnchorWithinTier": KeywordHitsSchema,
  "memory.searchByAnchorField": KeywordFieldResultSchema,
  "memory.findByEvidenceRefs": MemoryEntriesSchema,
  "memory.findBoundEvidenceRefs": z.array(z.string()).readonly(),
  "memory.findByIds": MemoryEntriesSchema,
  "evidence.searchByKeyword": KeywordHitsSchema,
  "evidence.searchByKeywordField": KeywordFieldResultSchema,
  "evidence.searchManyByKeywordField": z.array(KeywordFieldResultSchema).readonly(),
  "evidence.findByIds": z.array(EvidenceCapsuleSchema).readonly(),
  "evidence.findRecallQualifiedByIds": QualifiedEvidenceSchema,
  "evidence.findRecallQualifiedFactKeysByIds": QualifiedEvidenceSchema,
  "evidence.findSourceAnchorsByIds": z.array(SourceAnchorSchema).readonly(),
  "synthesis.searchByKeyword": KeywordHitsSchema,
  "synthesis.searchByKeywordField": KeywordFieldResultSchema,
  "synthesis.searchManyByKeywordField": z.array(KeywordFieldResultSchema).readonly(),
  "synthesis.findByIds": z.array(SynthesisCapsuleSchema).readonly(),
  "path.findByAnchors": PathRelationsSchema,
  "path.findByTimeConcernWindowDigests": PathRelationsSchema,
  "pathPlasticity.getStrengthByMemoryId": z.array(z.tuple([z.string(), z.number()])).readonly(),
  "constraints.findActive": z.object({
    constraints: z.array(SoulActiveConstraintSchema).readonly(),
    total_count: z.number()
  }).strict(),
  "constraints.readBounded": BoundedActiveConstraintsResultSchema
} satisfies Record<RecallReadWorkerOperation, z.ZodTypeAny>;

export function parseWorkerOperationPayload<O extends RecallReadWorkerOperation>(
  operation: O,
  payload: unknown
): WorkerOperationPayload<O> {
  return PAYLOAD_SCHEMAS[operation].parse(payload ?? {}) as WorkerOperationPayload<O>;
}

export function parseWorkerOperationResult(
  operation: RecallReadWorkerOperation,
  result: unknown
): unknown {
  return RESULT_SCHEMAS[operation].parse(result);
}

export function parseConditionalFieldRecallPayload(payload: unknown) {
  return ConditionalFieldRecallWorkerPayloadSchema.parse(payload ?? {});
}

export type WorkerBoundedRequest = BoundedRequestPayload;
