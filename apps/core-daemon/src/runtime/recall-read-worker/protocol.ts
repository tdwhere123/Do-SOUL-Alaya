import { z } from "zod";
import {
  AssociationCapContractSchema,
  ClaimDemandSchema,
  ContinuationSchema,
  EnumerationPolicySchema,
  InformationIndexSchema,
  PathRelationSchema,
  PayloadContinuationRequestSchema,
  QueryInterpretationProposalSchema,
  RecallTargetKindSchema,
  RequestBudgetSchema,
  ResultKindViewSchema,
  SoulActiveConstraintSchema
} from "@do-soul/alaya-protocol";

// Target recall uses "conditionalField.recall" only. The memory/evidence/
// synthesis/path/plasticity operations remain for leftover RecallService
// ports and are not a second selector.
export const RECALL_READ_WORKER_OPERATIONS = [
  "ready",
  "memory.findByWorkspaceId",
  "memory.findRecallTierWindow",
  "memory.findByEventTimeWindow",
  "memory.findByDimension",
  "memory.findByScopeClass",
  "memory.searchByKeyword",
  "memory.searchByKeywordField",
  "memory.searchByKeywordWithinObjectIds",
  "memory.searchByKeywordWithinTier",
  "memory.searchManyByKeywordWithinObjectIds",
  "memory.searchByAnchorWithinObjectIds",
  "memory.searchByAnchorWithinTier",
  "memory.searchByAnchorField",
  "memory.findByEvidenceRefs",
  "memory.findBoundEvidenceRefs",
  "memory.findByIds",
  "evidence.searchByKeyword",
  "evidence.searchByKeywordField",
  "evidence.searchManyByKeywordField",
  "evidence.findByIds",
  "evidence.findRecallQualifiedByIds",
  "evidence.findRecallQualifiedFactKeysByIds",
  "evidence.findSourceAnchorsByIds",
  "synthesis.searchByKeyword",
  "synthesis.searchByKeywordField",
  "synthesis.searchManyByKeywordField",
  "synthesis.findByIds",
  "path.findByAnchors",
  "path.findByTimeConcernWindowDigests",
  "pathPlasticity.getStrengthByMemoryId",
  "constraints.findActive",
  "constraints.readBounded",
  "snapshot.beginDeferred",
  "snapshot.commit",
  "snapshot.rollback",
  "conditionalField.recall",
  "conditionalField.acknowledge",
  "conditionalField.discard",
  "close"
] as const;

export type RecallReadWorkerOperation = (typeof RECALL_READ_WORKER_OPERATIONS)[number];

export const RECALL_READ_WORKER_PROTOCOL_VERSION = 1 as const;

const RECALL_READ_WORKER_OPERATION_SET: ReadonlySet<string> = new Set(
  RECALL_READ_WORKER_OPERATIONS
);

export function isRecallReadWorkerOperation(
  value: unknown
): value is RecallReadWorkerOperation {
  return typeof value === "string" && RECALL_READ_WORKER_OPERATION_SET.has(value);
}

export const RecallReadWorkerProtocolVersionSchema = z.number().int().min(1);

export const BoundedActiveConstraintsResultSchema = z
  .object({
    constraints: z.array(SoulActiveConstraintSchema).readonly(),
    total_count: z.number().int().nullable(),
    completeness: z.enum(["complete", "incomplete"]),
    paths: z.array(PathRelationSchema).readonly(),
    temporal_uncertain: z.boolean(),
    work: z
      .object({
        native_visits: z.number(),
        bytes_read: z.number(),
        retained_bytes: z.number()
      })
      .strict()
      .readonly(),
    binding: z
      .object({
        workspace_id: z.string(),
        as_of: z.string(),
        snapshot_id: z.string(),
        authorized_scopes: z.array(z.string()).readonly()
      })
      .strict()
      .readonly()
  })
  .strict()
  .readonly();

export const ConditionalFieldRecallPortResultSchema = z
  .object({
    index: InformationIndexSchema,
    previews: z.record(z.string(), z.string()),
    source_metadata: z.record(z.string(), z.unknown()).optional(),
    issued_delivery_id: z.string().optional(),
    preparation_id: z.string().optional(),
    execution_receipt: z.unknown().optional()
  })
  .strict()
  .readonly();

export const ConditionalFieldRecallWorkerPayloadSchema = z
  .object({
    workspace_id: z.string(),
    query_text: z.string(),
    budget: RequestBudgetSchema,
    requested_budget: RequestBudgetSchema.optional(),
    snapshot_id: z.string(),
    interpretation_clock: z.string(),
    as_of: z.string(),
    expires_at: z.string(),
    lifetime_now: z.string().optional(),
    cancelled: z.boolean().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    time_field: z.enum(["created_at", "last_used_at"]).optional(),
    dimension_filter: z.array(z.string()).readonly().optional(),
    domain_tag_filter: z.array(z.string()).readonly().optional(),
    continuation: ContinuationSchema.nullable().optional(),
    authorized_scopes: z.array(z.string()).readonly().nullable().optional(),
    governance: BoundedActiveConstraintsResultSchema.optional(),
    enumeration_policy: EnumerationPolicySchema.optional(),
    result_kind_view: ResultKindViewSchema.optional(),
    interpretation_proposal: QueryInterpretationProposalSchema.optional(),
    payload_continuation: PayloadContinuationRequestSchema.optional(),
    cap_contracts: z.array(AssociationCapContractSchema).readonly().optional(),
    claim_demands: z.array(ClaimDemandSchema).readonly().optional(),
    protocol_version: RecallReadWorkerProtocolVersionSchema.optional(),
    supported_result_kinds: z.array(RecallTargetKindSchema).readonly().optional(),
    supports_source_evidence: z.boolean().optional(),
    supports_product_updates: z.boolean().optional()
  })
  .strict()
  .readonly();

export const RecallReadWorkerEnvelopeSchema = z
  .object({
    protocol_version: RecallReadWorkerProtocolVersionSchema,
    id: z.number().finite(),
    operation: z.enum(RECALL_READ_WORKER_OPERATIONS),
    payload: z.unknown()
  })
  .strict()
  .readonly();

export type ConditionalFieldRecallWorkerPayload = z.infer<
  typeof ConditionalFieldRecallWorkerPayloadSchema
>;

export type RecallReadWorkerRequest = z.infer<typeof RecallReadWorkerEnvelopeSchema>;

export type ConditionalFieldRecallWorkerRequest = Readonly<{
  readonly protocol_version: number;
  readonly id: number;
  readonly operation: "conditionalField.recall";
  readonly payload: ConditionalFieldRecallWorkerPayload;
}>;

export type RecallReadWorkerResponse =
  | Readonly<{ readonly id: number; readonly ok: true; readonly result: unknown }>
  | Readonly<{
      readonly id: number;
      readonly ok: false;
      readonly error: Readonly<{
        readonly name: string;
        readonly message: string;
        readonly stack?: string;
      }>;
    }>;
