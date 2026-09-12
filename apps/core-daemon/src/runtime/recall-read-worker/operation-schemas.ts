import { z } from "zod";
import { encodeAuthorizedScopesAdmission as encodeCoreAuthorizedScopesAdmission } from "@do-soul/alaya-core";
import {
  InformationIndexSchema,
  MemoryDimensionSchema,
  PathAnchorRefSchema,
  ScopeClassSchema,
  StorageTierSchema
} from "@do-soul/alaya-protocol";
import {
  BoundedActiveConstraintsResultSchema,
  ConditionalFieldRecallPortResultSchema,
  ConditionalFieldRecallWorkerPayloadSchema,
  type RecallReadWorkerOperation
} from "./protocol.js";

export const AuthorizedScopesAdmissionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("unrestricted") }).strict(),
  z.object({ mode: z.literal("denied") }).strict(),
  z.object({
    mode: z.literal("named"),
    scopes: z.array(z.string()).min(1).readonly()
  }).strict()
]);

export type AuthorizedScopesAdmission = z.infer<typeof AuthorizedScopesAdmissionSchema>;

const EmptyObjectSchema = z.object({}).passthrough();
const WorkspaceIdSchema = z.object({ workspaceId: z.string() }).strict();
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
}).passthrough();
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
  index: InformationIndexSchema,
  previews: z.record(z.string(), z.string())
}).strict();
const DiscardSchema = z.object({
  preparation_id: z.string()
}).strict();

const PAYLOAD_SCHEMAS: Record<RecallReadWorkerOperation, z.ZodType> = {
  ready: EmptyObjectSchema,
  close: EmptyObjectSchema,
  "snapshot.beginDeferred": EmptyObjectSchema,
  "snapshot.commit": EmptyObjectSchema,
  "snapshot.rollback": EmptyObjectSchema,
  "conditionalField.recall": z.unknown(),
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
  }),
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
  "constraints.readBounded": z.object({
    workspaceId: z.string(),
    asOf: z.string(),
    snapshotId: z.string().optional(),
    authorizedScopes: z.array(z.string()).readonly().optional(),
    cap: z.number().nullable().optional(),
    nativeLimit: z.number(),
    byteLimit: z.number()
  }).strict()
};

const RESULT_SCHEMAS: Partial<Record<RecallReadWorkerOperation, z.ZodType>> = {
  ready: z.null(),
  close: z.null(),
  "snapshot.beginDeferred": z.null(),
  "snapshot.commit": z.null(),
  "snapshot.rollback": z.null(),
  "conditionalField.recall": ConditionalFieldRecallPortResultSchema,
  "constraints.readBounded": BoundedActiveConstraintsResultSchema,
  "constraints.findActive": z.object({
    constraints: z.array(z.unknown()).readonly(),
    total_count: z.number()
  }).passthrough()
};

export function parseWorkerOperationPayload(
  operation: RecallReadWorkerOperation,
  payload: unknown
): unknown {
  if (operation === "conditionalField.recall") {
    return parseConditionalFieldRecallPayload(payload);
  }
  return PAYLOAD_SCHEMAS[operation].parse(payload ?? {});
}

export function parseWorkerOperationResult(
  operation: RecallReadWorkerOperation,
  result: unknown
): unknown {
  const schema = RESULT_SCHEMAS[operation];
  return schema === undefined ? z.unknown().parse(result) : schema.parse(result);
}

export function parseConditionalFieldRecallPayload(payload: unknown) {
  const record = EmptyObjectSchema.parse(payload ?? {});
  const rest: Record<string, unknown> = { ...record };
  const admission = rest.authorized_scopes;
  delete rest.authorized_scopes;
  if (admission !== undefined && admission !== null && typeof admission === "object" && !Array.isArray(admission)) {
    rest.authorized_scopes = AuthorizedScopesAdmissionSchema.parse(admission);
  } else if (admission === null) {
    AuthorizedScopesAdmissionSchema.parse(admission);
  } else if (Array.isArray(admission)) {
    if (admission.length > 0 && admission.every((scope) => typeof scope === "string")) {
      rest.authorized_scopes = admission;
    }
  }
  return ConditionalFieldRecallWorkerPayloadSchema.parse(rest);
}

export function encodeAuthorizedScopesAdmission(
  authorized: readonly string[] | null | undefined | AuthorizedScopesAdmission
): AuthorizedScopesAdmission {
  if (authorized !== null && typeof authorized === "object" && !Array.isArray(authorized) && "mode" in authorized) {
    return AuthorizedScopesAdmissionSchema.parse(authorized);
  }
  return encodeCoreAuthorizedScopesAdmission(authorized);
}
