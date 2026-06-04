import { z } from "zod";
import {
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
import {
  EdgeProposalStatusSchema,
  EdgeProposalTriggerSourceSchema
} from "../soul/edge-proposal.js";
import { MemoryGraphEdgeTypeSchema } from "../soul/memory-graph.js";
import { OrphanRadarSuggestedActionSchema } from "../soul/orphan-radar.js";

const graphAuditorEventTypeValues = [
  "soul.graph.edge_created",
  "soul.graph.edge_proposal_created",
  "soul.graph.edge_proposal_reviewed",
  "soul.graph.edge_proposal_path_mint_failed",
  "soul.graph.explore_completed",
  "soul.auditor.pointer_healed",
  "soul.orphan_radar.reported"
] as const;

export const GraphAuditorEventType = {
  SOUL_GRAPH_EDGE_CREATED: "soul.graph.edge_created",
  SOUL_GRAPH_EDGE_PROPOSAL_CREATED: "soul.graph.edge_proposal_created",
  SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED: "soul.graph.edge_proposal_reviewed",
  // invariant: emitted when an accepted/auto-accepted proposal's owed path
  // mint fails. The reviewed row is already durable, so without this the
  // accepted-owes-a-path obligation would only be findable by forensic
  // cross-join (auditability invariant). Keyed on proposal_id so an operator
  // can reconcile which accepted proposals are missing their minted path.
  // see also: core/src/edge-proposal-service.ts acceptProposal mint-failure branch.
  SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED: "soul.graph.edge_proposal_path_mint_failed",
  SOUL_GRAPH_EXPLORE_COMPLETED: "soul.graph.explore_completed",
  SOUL_AUDITOR_POINTER_HEALED: "soul.auditor.pointer_healed",
  SOUL_ORPHAN_RADAR_REPORTED: "soul.orphan_radar.reported"
} as const;

export const GraphAuditorEventTypeSchema = z.enum(graphAuditorEventTypeValues);

export const SoulGraphEdgeCreatedPayloadSchema = z
  .object({
    edge_id: NonEmptyStringSchema,
    source_memory_id: NonEmptyStringSchema,
    target_memory_id: NonEmptyStringSchema,
    edge_type: MemoryGraphEdgeTypeSchema,
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SoulGraphEdgeProposalCreatedPayloadSchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    source_memory_id: NonEmptyStringSchema,
    target_memory_id: NonEmptyStringSchema,
    edge_type: MemoryGraphEdgeTypeSchema,
    trigger_source: EdgeProposalTriggerSourceSchema,
    confidence: z.number().min(0).max(1),
    reason: BoundedReasonSchema.nullable(),
    source_signal_id: NonEmptyStringSchema.nullable(),
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SoulGraphEdgeProposalReviewedPayloadSchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    status: EdgeProposalStatusSchema,
    reviewer_identity: NonEmptyStringSchema.nullable(),
    review_reason: BoundedReasonSchema.nullable(),
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

// invariant: durable forensic record of an accepted/auto-accepted proposal
// whose owed PathRelation mint failed. proposal_id keys the obligation so an
// operator can reconcile accepted-but-unminted proposals without a forensic
// cross-join of reviewed rows against PATH_RELATION_CREATED rows.
export const SoulGraphEdgeProposalPathMintFailedPayloadSchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    source_memory_id: NonEmptyStringSchema,
    target_memory_id: NonEmptyStringSchema,
    edge_type: MemoryGraphEdgeTypeSchema,
    reviewer_identity: NonEmptyStringSchema.nullable(),
    // failure_kind distinguishes a clean false return (submitCandidate caught
    // its own materialize error) from a thrown error reaching acceptProposal.
    failure_kind: z.enum(["submit_returned_false", "submit_threw"]),
    failure_detail: BoundedReasonSchema.nullable(),
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SoulGraphNeighborExploreCompletedPayloadSchema = z
  .object({
    exploration_kind: z.literal("memory_neighbors").default("memory_neighbors"),
    source_memory_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    direction: z.enum(["inbound", "outbound", "both"]).optional(),
    neighbor_count: NonNegativeIntSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SoulGraphTopologyExploreCompletedPayloadSchema = z
  .object({
    exploration_kind: z.literal("path_topology"),
    workspace_id: NonEmptyStringSchema,
    total_nodes: NonNegativeIntSchema,
    total_edges: NonNegativeIntSchema,
    strongly_connected_components: NonNegativeIntSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SoulGraphExploreCompletedPayloadSchema = z
  .union([
    SoulGraphNeighborExploreCompletedPayloadSchema,
    SoulGraphTopologyExploreCompletedPayloadSchema
  ])
  .readonly();

export const SoulAuditorPointerHealedPayloadSchema = z
  .object({
    source_object_id: NonEmptyStringSchema,
    source_object_kind: NonEmptyStringSchema,
    ref_kind: z.enum(["evidence_ref", "memory_ref", "synthesis_ref", "source_object_ref"]),
    cleared_ref: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    task_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SoulOrphanRadarReportedPayloadSchema = z
  .object({
    radar_id: NonEmptyStringSchema,
    target_memory_id: NonEmptyStringSchema,
    suggested_action: OrphanRadarSuggestedActionSchema,
    confidence: z.number().min(0).max(1).optional(),
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

const graphAuditorPayloadSchemas = {
  [GraphAuditorEventType.SOUL_GRAPH_EDGE_CREATED]: SoulGraphEdgeCreatedPayloadSchema,
  [GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_CREATED]: SoulGraphEdgeProposalCreatedPayloadSchema,
  [GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED]: SoulGraphEdgeProposalReviewedPayloadSchema,
  [GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED]:
    SoulGraphEdgeProposalPathMintFailedPayloadSchema,
  [GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED]: SoulGraphExploreCompletedPayloadSchema,
  [GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED]: SoulAuditorPointerHealedPayloadSchema,
  [GraphAuditorEventType.SOUL_ORPHAN_RADAR_REPORTED]: SoulOrphanRadarReportedPayloadSchema
} as const;

export function createGraphAuditorEventObjectSchema<T extends keyof typeof graphAuditorPayloadSchemas>(
  type: T,
  payloadSchema: (typeof graphAuditorPayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulGraphEdgeCreatedEventObjectSchema = createGraphAuditorEventObjectSchema(
  GraphAuditorEventType.SOUL_GRAPH_EDGE_CREATED,
  SoulGraphEdgeCreatedPayloadSchema
);
const SoulGraphEdgeProposalCreatedEventObjectSchema = createGraphAuditorEventObjectSchema(
  GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_CREATED,
  SoulGraphEdgeProposalCreatedPayloadSchema
);
const SoulGraphEdgeProposalReviewedEventObjectSchema = createGraphAuditorEventObjectSchema(
  GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED,
  SoulGraphEdgeProposalReviewedPayloadSchema
);
const SoulGraphEdgeProposalPathMintFailedEventObjectSchema = createGraphAuditorEventObjectSchema(
  GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED,
  SoulGraphEdgeProposalPathMintFailedPayloadSchema
);
const SoulGraphExploreCompletedEventObjectSchema = createGraphAuditorEventObjectSchema(
  GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
  SoulGraphExploreCompletedPayloadSchema
);
const SoulAuditorPointerHealedEventObjectSchema = createGraphAuditorEventObjectSchema(
  GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED,
  SoulAuditorPointerHealedPayloadSchema
);
const SoulOrphanRadarReportedEventObjectSchema = createGraphAuditorEventObjectSchema(
  GraphAuditorEventType.SOUL_ORPHAN_RADAR_REPORTED,
  SoulOrphanRadarReportedPayloadSchema
);

export const SoulGraphEdgeCreatedEventSchema = SoulGraphEdgeCreatedEventObjectSchema.readonly();
export const SoulGraphEdgeProposalCreatedEventSchema = SoulGraphEdgeProposalCreatedEventObjectSchema.readonly();
export const SoulGraphEdgeProposalReviewedEventSchema = SoulGraphEdgeProposalReviewedEventObjectSchema.readonly();
export const SoulGraphEdgeProposalPathMintFailedEventSchema =
  SoulGraphEdgeProposalPathMintFailedEventObjectSchema.readonly();
export const SoulGraphExploreCompletedEventSchema = SoulGraphExploreCompletedEventObjectSchema.readonly();
export const SoulAuditorPointerHealedEventSchema = SoulAuditorPointerHealedEventObjectSchema.readonly();
export const SoulOrphanRadarReportedEventSchema = SoulOrphanRadarReportedEventObjectSchema.readonly();

export const GraphAuditorEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulGraphEdgeCreatedEventObjectSchema,
    SoulGraphEdgeProposalCreatedEventObjectSchema,
    SoulGraphEdgeProposalReviewedEventObjectSchema,
    SoulGraphEdgeProposalPathMintFailedEventObjectSchema,
    SoulGraphExploreCompletedEventObjectSchema,
    SoulAuditorPointerHealedEventObjectSchema,
    SoulOrphanRadarReportedEventObjectSchema
  ])
  .readonly();

export type GraphAuditorEventPayloadMap = {
  [K in keyof typeof graphAuditorPayloadSchemas]: z.infer<(typeof graphAuditorPayloadSchemas)[K]>;
};

export function parseGraphAuditorEventPayload<T extends keyof typeof graphAuditorPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): GraphAuditorEventPayloadMap[T] {
  const schema = graphAuditorPayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase 4B event type: ${String(type)}`);
  }

  return schema.parse(payload) as GraphAuditorEventPayloadMap[T];
}

export type SoulGraphEdgeCreatedPayload = z.infer<typeof SoulGraphEdgeCreatedPayloadSchema>;
export type SoulGraphEdgeProposalCreatedPayload = z.infer<typeof SoulGraphEdgeProposalCreatedPayloadSchema>;
export type SoulGraphEdgeProposalReviewedPayload = z.infer<typeof SoulGraphEdgeProposalReviewedPayloadSchema>;
export type SoulGraphEdgeProposalPathMintFailedPayload = z.infer<
  typeof SoulGraphEdgeProposalPathMintFailedPayloadSchema
>;
export type SoulGraphNeighborExploreCompletedPayload = z.infer<
  typeof SoulGraphNeighborExploreCompletedPayloadSchema
>;
export type SoulGraphTopologyExploreCompletedPayload = z.infer<
  typeof SoulGraphTopologyExploreCompletedPayloadSchema
>;
export type SoulGraphExploreCompletedPayload = z.infer<typeof SoulGraphExploreCompletedPayloadSchema>;
export type SoulAuditorPointerHealedPayload = z.infer<typeof SoulAuditorPointerHealedPayloadSchema>;
export type SoulOrphanRadarReportedPayload = z.infer<typeof SoulOrphanRadarReportedPayloadSchema>;
export type GraphAuditorEventTypeValue = z.infer<typeof GraphAuditorEventTypeSchema>;
export type GraphAuditorEvent = z.infer<typeof GraphAuditorEventUnionSchema>;
