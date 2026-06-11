import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";

const gardenRoleValues = ["janitor", "auditor", "librarian"] as const;
const gardenTierValues = ["tier_0", "tier_1", "tier_2"] as const;
const gardenTaskKindValues = [
  "ttl_cleanup",
  "hot_index_demotion",
  "dormant_demotion",
  "tombstone_gc",
  "evidence_staleness_check",
  "pointer_health_check",
  "green_maintenance",
  "bootstrapping_scan",
  "crystallization_scan",
  "pointer_healing",
  "orphan_detection",
  "event_log_orphan_detection",
  "merge_proposal",
  "path_graph_snapshot",
  "subject_neighbor_detect",
  "path_compression",
  "template_candidate",
  "synthesis_review",
  "embedding_backfill",
  "path_plasticity_update",
  "post_turn_extract",
  "consolidation_cycle",
  "bulk_enrich",
  "edge_classify"
] as const;

export const GardenRole = {
  JANITOR: "janitor",
  AUDITOR: "auditor",
  LIBRARIAN: "librarian"
} as const;

export const GardenTier = {
  TIER_0: "tier_0",
  TIER_1: "tier_1",
  TIER_2: "tier_2"
} as const;

export const GardenTaskKind = {
  TTL_CLEANUP: "ttl_cleanup",
  HOT_INDEX_DEMOTION: "hot_index_demotion",
  DORMANT_DEMOTION: "dormant_demotion",
  TOMBSTONE_GC: "tombstone_gc",
  EVIDENCE_STALENESS_CHECK: "evidence_staleness_check",
  POINTER_HEALTH_CHECK: "pointer_health_check",
  GREEN_MAINTENANCE: "green_maintenance",
  BOOTSTRAPPING_SCAN: "bootstrapping_scan",
  CRYSTALLIZATION_SCAN: "crystallization_scan",
  POINTER_HEALING: "pointer_healing",
  ORPHAN_DETECTION: "orphan_detection",
  EVENT_LOG_ORPHAN_DETECTION: "event_log_orphan_detection",
  MERGE_PROPOSAL: "merge_proposal",
  PATH_GRAPH_SNAPSHOT: "path_graph_snapshot",
  SUBJECT_NEIGHBOR_DETECT: "subject_neighbor_detect",
  PATH_COMPRESSION: "path_compression",
  TEMPLATE_CANDIDATE: "template_candidate",
  SYNTHESIS_REVIEW: "synthesis_review",
  EMBEDDING_BACKFILL: "embedding_backfill",
  PATH_PLASTICITY_UPDATE: "path_plasticity_update",
  POST_TURN_EXTRACT: "post_turn_extract",
  CONSOLIDATION_CYCLE: "consolidation_cycle",
  BULK_ENRICH: "bulk_enrich",
  // invariant: EDGE_CLASSIFY is the host-worker form of the B-2 LLM-quality
  // supports/derives_from pair verdict. The deterministic heuristic still runs
  // inline at enrichment time so an edge always exists; this task carries the
  // best-effort LLM-quality verdict that an attached CLI agent (the compute)
  // produces and reports back via garden.complete_task, refining the existing
  // path. A claim that never arrives leaves the heuristic verdict standing.
  // see also: packages/core/src/path-graph/edge-auto-producer-service.ts decideForNeighbor.
  EDGE_CLASSIFY: "edge_classify"
} as const;

export const GardenRoleSchema = z.enum(gardenRoleValues);
export const GardenTierSchema = z.enum(gardenTierValues);
export const GardenTaskKindSchema = z.enum(gardenTaskKindValues);

export type GardenRoleValue = z.infer<typeof GardenRoleSchema>;
export type GardenTierValue = z.infer<typeof GardenTierSchema>;
export type GardenTaskKindValue = z.infer<typeof GardenTaskKindSchema>;

export const GARDEN_ROLE_TIER_MAP = Object.freeze({
  [GardenRole.JANITOR]: GardenTier.TIER_0,
  [GardenRole.AUDITOR]: GardenTier.TIER_1,
  [GardenRole.LIBRARIAN]: GardenTier.TIER_2
} as const satisfies Record<GardenRoleValue, GardenTierValue>);

export const GardenPermissionSchema = z
  .object({
    role: GardenRoleSchema,
    tier: GardenTierSchema,
    allowed_task_kinds: z.array(GardenTaskKindSchema).min(1).readonly()
  })
  .strict()
  .readonly();

export type GardenPermission = z.infer<typeof GardenPermissionSchema>;

const janitorTaskKinds = Object.freeze([
  GardenTaskKind.TTL_CLEANUP,
  GardenTaskKind.HOT_INDEX_DEMOTION,
  GardenTaskKind.DORMANT_DEMOTION,
  GardenTaskKind.TOMBSTONE_GC
] as const);
const auditorTaskKinds = Object.freeze([
  ...janitorTaskKinds,
  GardenTaskKind.EVIDENCE_STALENESS_CHECK,
  GardenTaskKind.POINTER_HEALTH_CHECK,
  GardenTaskKind.GREEN_MAINTENANCE,
  GardenTaskKind.BOOTSTRAPPING_SCAN,
  GardenTaskKind.CRYSTALLIZATION_SCAN,
  GardenTaskKind.POINTER_HEALING,
  GardenTaskKind.ORPHAN_DETECTION,
  GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION
] as const);
const librarianTaskKinds = Object.freeze([
  ...auditorTaskKinds,
  GardenTaskKind.MERGE_PROPOSAL,
  GardenTaskKind.PATH_GRAPH_SNAPSHOT,
  GardenTaskKind.SUBJECT_NEIGHBOR_DETECT,
  GardenTaskKind.PATH_COMPRESSION,
  GardenTaskKind.TEMPLATE_CANDIDATE,
  GardenTaskKind.SYNTHESIS_REVIEW,
  GardenTaskKind.EMBEDDING_BACKFILL,
  GardenTaskKind.PATH_PLASTICITY_UPDATE,
  GardenTaskKind.CONSOLIDATION_CYCLE,
  GardenTaskKind.BULK_ENRICH
] as const);
// invariant: EDGE_CLASSIFY and POST_TURN_EXTRACT are host-worker-only kinds —
// the attached CLI agent is the compute, so they are intentionally absent from
// every in-process role permission set (an in-process librarian must not claim
// them). They are enqueued under the LIBRARIAN role for queue tiering but
// surface as role "host_worker" to the MCP worker loop.
// see also: apps/core-daemon/src/mcp-memory/tool-handler.ts gardenWorkerRoleForRow.

export const GARDEN_ROLE_PERMISSIONS = Object.freeze({
  [GardenRole.JANITOR]: GardenPermissionSchema.parse({
    role: GardenRole.JANITOR,
    tier: GardenTier.TIER_0,
    allowed_task_kinds: janitorTaskKinds
  }),
  [GardenRole.AUDITOR]: GardenPermissionSchema.parse({
    role: GardenRole.AUDITOR,
    tier: GardenTier.TIER_1,
    allowed_task_kinds: auditorTaskKinds
  }),
  [GardenRole.LIBRARIAN]: GardenPermissionSchema.parse({
    role: GardenRole.LIBRARIAN,
    tier: GardenTier.TIER_2,
    allowed_task_kinds: librarianTaskKinds
  })
} as const satisfies Record<GardenRoleValue, GardenPermission>);

export const GardenTaskDescriptorSchema = z
  .object({
    task_id: NonEmptyStringSchema,
    task_kind: GardenTaskKindSchema,
    required_tier: GardenTierSchema,
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable(),
    target_object_refs: z.array(NonEmptyStringSchema).readonly(),
    priority: NonNegativeIntSchema.max(100),
    created_at: IsoDatetimeStringSchema,
    turn_index: NonNegativeIntSchema.optional(),
    turn_digest: z.unknown().optional()
  })
  .strict()
  .readonly();

export const GardenTaskResultSchema = z
  .object({
    task_id: NonEmptyStringSchema,
    task_kind: GardenTaskKindSchema,
    role: GardenRoleSchema,
    tier: GardenTierSchema,
    workspace_id: NonEmptyStringSchema,
    success: z.boolean(),
    objects_affected: z.array(NonEmptyStringSchema).readonly(),
    audit_entries: z.array(NonEmptyStringSchema).readonly(),
    error_message: z.string().nullable(),
    completed_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type GardenTaskDescriptor = z.infer<typeof GardenTaskDescriptorSchema>;
export type GardenTaskResult = z.infer<typeof GardenTaskResultSchema>;

// invariant: EDGE_CLASSIFY task payload. Carries one candidate pair (the
// freshly materialized source memory + a same-dimension same-scope neighbor)
// plus the content/tag context the classifier needs to judge a supports /
// derives_from relationship. The pair already cleared the cheap eligibility
// prefilter inline; the host worker only renders the LLM-quality verdict. The
// payload is content-only on purpose: it carries no governance, strength, or
// recall-bias hint — those stay owned by the deterministic seed profile in
// edge-auto-producer-service.ts so an untrusted host verdict can never inject
// topology weight. run_id is the run that materialized the source memory.
const EdgeClassifyMemoryRefSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    content: z.string().max(4000),
    domain_tags: z.array(NonEmptyStringSchema).max(64).readonly()
  })
  .strict()
  .readonly();

export const EdgeClassifyTaskPayloadSchema = z
  .object({
    task_id: NonEmptyStringSchema,
    task_kind: z.literal(GardenTaskKind.EDGE_CLASSIFY),
    required_tier: z.literal(GardenTier.TIER_2),
    run_id: NonEmptyStringSchema.nullable(),
    workspace_id: NonEmptyStringSchema,
    priority: NonNegativeIntSchema.max(100),
    created_at: IsoDatetimeStringSchema,
    dimension: NonEmptyStringSchema,
    scope_class: NonEmptyStringSchema,
    source_memory: EdgeClassifyMemoryRefSchema,
    neighbor_memory: EdgeClassifyMemoryRefSchema,
    // provenance only: the source signal that triggered enrichment, echoed
    // into the path why-provenance when the verdict is applied.
    source_signal_id: NonEmptyStringSchema.nullable()
  })
  .strict()
  .readonly();

// invariant: the host-worker edge-classification result. edge_type "none" is
// the well-formed "no relationship" answer (the verdict is not applied, the
// heuristic verdict stands). supports / derives_from carry a 0..1 confidence
// the daemon clamps and floors (LLM_CONFIDENCE_FLOOR) exactly as the in-process
// port did; a below-floor or "none" verdict refines nothing.
export const EdgeClassifyVerdictSchema = z
  .object({
    source_object_id: NonEmptyStringSchema,
    neighbor_object_id: NonEmptyStringSchema,
    edge_type: z.enum(["supports", "derives_from", "none"]),
    confidence: z.number().min(0).max(1),
    rationale: z.string().max(2000)
  })
  .strict()
  .readonly();

export type EdgeClassifyTaskPayload = z.infer<typeof EdgeClassifyTaskPayloadSchema>;
export type EdgeClassifyVerdict = z.infer<typeof EdgeClassifyVerdictSchema>;
