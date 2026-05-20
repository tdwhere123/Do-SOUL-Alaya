import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";

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
  "consolidation_cycle"
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
  CONSOLIDATION_CYCLE: "consolidation_cycle"
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
  GardenTaskKind.CONSOLIDATION_CYCLE
] as const);

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
