import { z } from "zod";
import {
  EventLogOrphanExpectedTableSchema,
  type EventLogOrphanExpectedTable
} from "./events/event-log-orphan.js";
import { type EventLogEntry } from "./event-log.js";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "./schema-primitives.js";
import { type GardenTaskResult } from "./soul/garden-tier.js";
import { MemoryDimensionSchema } from "./soul/memory-entry.js";
import { type OrphanRadar } from "./soul/orphan-radar.js";

export const StaleMemoryEntrySchema = z
  .object({
    memory_entry_id: NonEmptyStringSchema,
    stale_evidence_refs: z.array(NonEmptyStringSchema).min(1).readonly()
  })
  .strict()
  .readonly();

export const BrokenPointerRecordSchema = z
  .object({
    source_object_id: NonEmptyStringSchema,
    source_object_kind: NonEmptyStringSchema,
    broken_ref: NonEmptyStringSchema,
    ref_kind: z.enum(["evidence_ref", "memory_ref", "synthesis_ref", "source_object_ref"])
  })
  .strict()
  .readonly();

export const HealablePointerRecordSchema = BrokenPointerRecordSchema;

export const OrphanedMemoryRecordSchema = z
  .object({
    memory_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    suspected_surface_gaps: z.array(NonEmptyStringSchema).min(1).readonly(),
    orphan_confidence: z.number().min(0).max(1)
  })
  .strict()
  .readonly();

export const EventLogOrphanRecordSchema = z
  .object({
    audit_event_id: NonEmptyStringSchema,
    event_type: NonEmptyStringSchema,
    expected_table: EventLogOrphanExpectedTableSchema,
    detected_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const EventLogOrphanRadarRecordSchema = z
  .object({
    radar_id: NonEmptyStringSchema,
    audit_event_id: NonEmptyStringSchema,
    event_type: NonEmptyStringSchema,
    expected_table: EventLogOrphanExpectedTableSchema,
    workspace_id: NonEmptyStringSchema,
    detected_at: IsoDatetimeStringSchema,
    expires_at: IsoDatetimeStringSchema,
    requires_review: z.boolean()
  })
  .strict()
  .readonly()
  .refine((data) => data.expires_at > data.detected_at, {
    message: "expires_at must be after detected_at"
  });

export const ExpiringGreenStatusSchema = z
  .object({
    green_status_id: NonEmptyStringSchema,
    memory_entry_id: NonEmptyStringSchema,
    dimension: MemoryDimensionSchema,
    valid_until: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export const ColdStartAssessmentSchema = z
  .object({
    is_cold_start: z.boolean(),
    memory_count: z.number().int().nonnegative(),
    claim_count: z.number().int().nonnegative()
  })
  .strict()
  .readonly();

export const DraftCandidateSchema = z
  .object({
    candidate_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    lifecycle_state: z.literal("candidate"),
    requires_review: z.literal(true),
    workspace_id: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export const HighFrequencyPatternSchema = z
  .object({
    pattern_key: NonEmptyStringSchema,
    frequency: z.number().int().nonnegative()
  })
  .strict()
  .readonly();

export type StaleMemoryEntry = z.infer<typeof StaleMemoryEntrySchema>;
export type BrokenPointerRecord = z.infer<typeof BrokenPointerRecordSchema>;
export type HealablePointerRecord = z.infer<typeof HealablePointerRecordSchema>;
export type OrphanedMemoryRecord = z.infer<typeof OrphanedMemoryRecordSchema>;
export type EventLogOrphanRecord = z.infer<typeof EventLogOrphanRecordSchema>;
export type EventLogOrphanRadarRecord = z.infer<typeof EventLogOrphanRadarRecordSchema>;
export type { EventLogOrphanExpectedTable };
export type ExpiringGreenStatus = z.infer<typeof ExpiringGreenStatusSchema>;
export type ColdStartAssessment = z.infer<typeof ColdStartAssessmentSchema>;
export type DraftCandidate = z.infer<typeof DraftCandidateSchema>;
export type HighFrequencyPattern = z.infer<typeof HighFrequencyPatternSchema>;

export interface AuditorEvidenceCheckPort {
  findMemoriesWithStaleEvidence(workspaceId: string): Promise<readonly StaleMemoryEntry[]>;
}

export interface AuditorPointerHealthPort {
  findBrokenPointers(workspaceId: string): Promise<readonly BrokenPointerRecord[]>;
}

export interface AuditorPointerHealPort {
  findHealablePointers(workspaceId: string): Promise<readonly HealablePointerRecord[]>;
  clearEvidenceRef(sourceObjectId: string, brokenRef: string, taskId: string): void;
  clearMemoryRef(sourceObjectId: string, brokenRef: string, taskId: string): void;
  clearSynthesisRef(sourceObjectId: string, brokenRef: string, taskId: string): void;
}

export interface AuditorOrphanDetectionPort {
  findOrphanedMemories(workspaceId: string): Promise<readonly OrphanedMemoryRecord[]>;
  createOrphanRadarRecord(record: Readonly<OrphanRadar>): void;
  findEventLogOrphans?(workspaceId: string): Promise<readonly EventLogOrphanRecord[]>;
  createEventLogOrphanRadarRecord?(record: Readonly<EventLogOrphanRadarRecord>): void;
}

export interface AuditorGreenMaintenancePort {
  findExpiringGreenStatuses(workspaceId: string, lookaheadMs: number): Promise<readonly ExpiringGreenStatus[]>;
  // gate-6-delta I4: Green-state mutations are now invoked from inside
  // EventPublisher.appendManyWithMutation's sync mutate callback so the
  // SQL write and the SOUL_GREEN_REVOKED / SOUL_GREEN_RENEWED /
  // SOUL_GREEN_GRACE_REQUESTED EventLog row commit in the same SQLite
  // transaction. The underlying better-sqlite3 ops are sync, so the
  // port surface is sync too.
  renewGreenPassiveStable(greenStatusId: string, taskId: string): void;
  requestActiveVerification(greenStatusId: string, taskId: string): void;
  revokeGreen(memoryEntryId: string, reason: "verification_fail", taskId: string): void;
}

export interface AuditorBootstrappingPort {
  assessColdStart(workspaceId: string): Promise<ColdStartAssessment>;
  generateDraftCandidates(workspaceId: string): Promise<readonly DraftCandidate[]>;
  findHighFrequencyPatterns(workspaceId: string, minFrequency: number): Promise<readonly HighFrequencyPattern[]>;
  createSynthesisCandidate(workspaceId: string, patternKey: string): Promise<{ readonly candidate_id: string }>;
  hasPendingSynthesisCandidate(workspaceId: string, patternKey: string): Promise<boolean>;
}

export interface AuditorSchedulerPort {
  reportCompletion(result: GardenTaskResult): Promise<void>;
}

export interface AuditorEventLogPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  appendManyWithMutation<T>(
    entries: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T>;
}
