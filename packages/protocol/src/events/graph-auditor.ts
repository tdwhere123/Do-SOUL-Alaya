import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { MemoryGraphEdgeTypeSchema } from "../soul/memory-graph.js";
import { OrphanRadarSuggestedActionSchema } from "../soul/orphan-radar.js";

const graphAuditorEventTypeValues = [
  "soul.graph.edge_created",
  "soul.graph.explore_completed",
  "soul.auditor.pointer_healed",
  "soul.orphan_radar.reported"
] as const;

export const GraphAuditorEventType = {
  SOUL_GRAPH_EDGE_CREATED: "soul.graph.edge_created",
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
export const SoulGraphExploreCompletedEventSchema = SoulGraphExploreCompletedEventObjectSchema.readonly();
export const SoulAuditorPointerHealedEventSchema = SoulAuditorPointerHealedEventObjectSchema.readonly();
export const SoulOrphanRadarReportedEventSchema = SoulOrphanRadarReportedEventObjectSchema.readonly();

export const GraphAuditorEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulGraphEdgeCreatedEventObjectSchema,
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
