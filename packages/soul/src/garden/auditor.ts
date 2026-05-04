import { randomUUID } from "node:crypto";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  MemoryDimension,
  type OrphanRadar,
  type OrphanRadarSuggestedActionValue,
  GraphAuditorEventType,
  SoulGardenEventLogOrphanDetectedEventType,
  SoulGardenEventLogOrphanDetectedPayloadSchema,
  type AuditorBootstrappingPort,
  type AuditorEventLogPort,
  type AuditorEvidenceCheckPort,
  type AuditorGreenMaintenancePort,
  type AuditorOrphanDetectionPort,
  type AuditorPointerHealPort,
  type AuditorPointerHealthPort,
  type AuditorSchedulerPort,
  type BrokenPointerRecord,
  type ColdStartAssessment,
  type DraftCandidate,
  type EventLogEntry,
  type ExpiringGreenStatus,
  SoulAuditorPointerHealedPayloadSchema,
  SoulOrphanRadarReportedPayloadSchema,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue,
  type HealablePointerRecord,
  type HealthJournalRecordPort,
  type HighFrequencyPattern,
  type OrphanedMemoryRecord,
  type StaleMemoryEntry
} from "@do-soul/alaya-protocol";
import {
  resolvePathPlasticitySinceIso,
  type PathPlasticityComputePort
} from "./path-plasticity-task.js";

export const AUDITOR_CONSTANTS = {
  COLD_START_MEMORY_THRESHOLD: 10,
  COLD_START_CLAIM_THRESHOLD: 5,
  CRYSTALLIZATION_THRESHOLD: 3,
  EXPIRY_LOOKAHEAD_MS: 7 * 86_400_000,
  ORPHAN_RADAR_TTL_MS: 48 * 3_600_000,
  RECOVERY_WINDOW_MS: 3_600_000,
  BATCH_SIZE: 20
} as const;

export interface AuditorDependencies {
  readonly evidenceCheckPort: AuditorEvidenceCheckPort;
  readonly pointerHealthPort: AuditorPointerHealthPort;
  readonly pointerHealPort?: AuditorPointerHealPort;
  readonly orphanDetectionPort?: AuditorOrphanDetectionPort;
  readonly greenMaintenancePort: AuditorGreenMaintenancePort;
  readonly bootstrappingPort: AuditorBootstrappingPort;
  readonly pathPlasticityPort?: PathPlasticityComputePort;
  readonly scheduler: AuditorSchedulerPort;
  readonly eventLogRepo?: AuditorEventLogPort;
  readonly healthJournal?: HealthJournalRecordPort;
  readonly now?: () => string;
}

export class Auditor {
  public readonly role: GardenRoleValue = GardenRole.AUDITOR;
  public readonly tier: GardenTierValue = GardenTier.TIER_1;

  private readonly healthJournal: HealthJournalRecordPort | null;
  private readonly now: () => string;

  public constructor(private readonly dependencies: AuditorDependencies) {
    this.healthJournal = dependencies.healthJournal ?? null;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async run(task: GardenTaskDescriptor): Promise<GardenTaskResult> {
    const completedAt = this.now();

    try {
      switch (task.task_kind) {
        case GardenTaskKind.EVIDENCE_STALENESS_CHECK:
          return await this.executeEvidenceCheck(task, completedAt);
        case GardenTaskKind.POINTER_HEALTH_CHECK:
          return await this.executePointerHealthCheck(task, completedAt);
        case GardenTaskKind.POINTER_HEALING:
          return await this.executePointerHealing(task, completedAt);
        case GardenTaskKind.ORPHAN_DETECTION:
          return await this.executeOrphanDetection(task, completedAt);
        case GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION:
          return await this.executeEventLogOrphanDetection(task, completedAt);
        case GardenTaskKind.GREEN_MAINTENANCE:
          return await this.executeGreenMaintenance(task, completedAt);
        case GardenTaskKind.BOOTSTRAPPING_SCAN:
          return await this.executeBootstrappingScan(task, completedAt);
        case GardenTaskKind.CRYSTALLIZATION_SCAN:
          return await this.executeCrystallizationScan(task, completedAt);
        case GardenTaskKind.PATH_PLASTICITY_UPDATE:
          return await this.executePathPlasticityUpdate(task, completedAt);
        default:
          throw new Error(`Auditor does not handle task kind: ${task.task_kind}`);
      }
    } catch (error) {
      const result = this.createFailureResult(task, completedAt, error);
      await this.dependencies.scheduler.reportCompletion(result);
      return result;
    }
  }

  private async executeEvidenceCheck(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    const staleEntries = await this.dependencies.evidenceCheckPort.findMemoriesWithStaleEvidence(task.workspace_id);
    const batch = staleEntries.slice(0, AUDITOR_CONSTANTS.BATCH_SIZE);

    for (const entry of batch) {
      await this.dependencies.greenMaintenancePort.revokeGreen(
        entry.memory_entry_id,
        "verification_fail",
        task.task_id
      );
    }

    if (batch.length > 0) {
      await this.healthJournal?.record({
        event_kind: HealthEventKind.EVIDENCE_FAILURE,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        summary: `Evidence staleness check: ${batch.length} memories with stale refs had Green revoked`,
        detail_json: {
          affected_memory_ids: batch.map((entry) => entry.memory_entry_id),
          total_stale_refs: batch.reduce((sum, entry) => sum + entry.stale_evidence_refs.length, 0)
        }
      });
    }

    const result = this.createSuccessResult(task, completedAt, batch.map((entry) => entry.memory_entry_id), [
      `evidence_staleness_check: revoked green for ${batch.length} entries`
    ]);
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  private async executePointerHealthCheck(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    const brokenPointers = await this.dependencies.pointerHealthPort.findBrokenPointers(task.workspace_id);
    const batch = brokenPointers.slice(0, AUDITOR_CONSTANTS.BATCH_SIZE);

    if (batch.length > 0) {
      await this.healthJournal?.record({
        event_kind: HealthEventKind.POINTER_FAILURE,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        summary: `Pointer health check: ${batch.length} broken references detected (no repair in Phase 4A)`,
        detail_json: {
          broken_count: batch.length,
          sample_broken: batch.slice(0, 5).map((record) => ({
            source: record.source_object_id,
            kind: record.source_object_kind,
            broken_ref: record.broken_ref,
            ref_kind: record.ref_kind
          }))
        }
      });
    }

    const result = this.createSuccessResult(
      task,
      completedAt,
      batch.map((record) => record.source_object_id),
      [`pointer_health_check: detected ${batch.length} broken refs (detection only)`]
    );
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  private async executePointerHealing(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    const pointerHealPort = this.dependencies.pointerHealPort;

    if (pointerHealPort === undefined) {
      throw new Error("Auditor pointer healing port is not configured.");
    }

    const healablePointers = await pointerHealPort.findHealablePointers(task.workspace_id);
    const batch = healablePointers.slice(0, AUDITOR_CONSTANTS.BATCH_SIZE);

    for (const pointer of batch) {
      const payload = SoulAuditorPointerHealedPayloadSchema.parse({
        source_object_id: pointer.source_object_id,
        source_object_kind: pointer.source_object_kind,
        ref_kind: pointer.ref_kind,
        cleared_ref: pointer.broken_ref,
        workspace_id: task.workspace_id,
        occurred_at: completedAt,
        task_id: task.task_id
      });

      await this.dependencies.eventLogRepo?.append({
        event_type: GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED,
        entity_type: pointer.source_object_kind,
        entity_id: pointer.source_object_id,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        caused_by: this.role,
        revision: 0,
        payload_json: payload
      });

      switch (pointer.ref_kind) {
        case "evidence_ref":
          await pointerHealPort.clearEvidenceRef(pointer.source_object_id, pointer.broken_ref, task.task_id);
          break;
        case "memory_ref":
          await pointerHealPort.clearMemoryRef(pointer.source_object_id, pointer.broken_ref, task.task_id);
          break;
        case "synthesis_ref":
          await pointerHealPort.clearSynthesisRef(pointer.source_object_id, pointer.broken_ref, task.task_id);
          break;
        case "source_object_ref":
          // Claim source_object_refs can point to memory or synthesis IDs.
          // When the referenced ID is missing we cannot prove which one it
          // originally targeted, so healing requires a follow-up review step.
          break;
      }
    }

    if (batch.length > 0) {
      await this.healthJournal?.record({
        event_kind: HealthEventKind.POINTER_REPAIR,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        summary: `Pointer healing: cleared ${batch.length} broken references`,
        detail_json: {
          healed_count: batch.length,
          refs: batch.map((pointer) => ({
            source_object_id: pointer.source_object_id,
            source_object_kind: pointer.source_object_kind,
            ref_kind: pointer.ref_kind,
            broken_ref: pointer.broken_ref
          }))
        }
      });
    }

    const result = this.createSuccessResult(
      task,
      completedAt,
      batch.map((pointer) => pointer.source_object_id),
      [`pointer_healing: cleared ${batch.length} broken refs`]
    );
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  private async executeOrphanDetection(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    const orphanDetectionPort = this.dependencies.orphanDetectionPort;

    if (orphanDetectionPort === undefined) {
      const result = this.createSuccessResult(task, completedAt, [], [
        "orphan_detection: skipped because orphan detection port is not configured"
      ]);
      await this.dependencies.scheduler.reportCompletion(result);
      return result;
    }

    const orphanedMemories = await orphanDetectionPort.findOrphanedMemories(task.workspace_id);
    const batch = orphanedMemories.slice(0, AUDITOR_CONSTANTS.BATCH_SIZE);
    const expiresAt = new Date(Date.parse(completedAt) + AUDITOR_CONSTANTS.ORPHAN_RADAR_TTL_MS).toISOString();
    const createdRadarIds: string[] = [];

    for (let index = 0; index < batch.length; index += 1) {
      const orphan = batch[index];
      const radarId = randomUUID();
      const suggestedAction = determineOrphanSuggestedAction(orphan.orphan_confidence);
      const radarRecord = {
        radar_id: radarId,
        target_memory_id: orphan.memory_id,
        workspace_id: orphan.workspace_id,
        suspected_surface_gaps: [...orphan.suspected_surface_gaps],
        suggested_action: suggestedAction,
        confidence: orphan.orphan_confidence,
        detected_at: completedAt,
        expires_at: expiresAt,
        requires_review: true
      } satisfies Readonly<OrphanRadar>;
      const payload = SoulOrphanRadarReportedPayloadSchema.parse({
        radar_id: radarId,
        target_memory_id: orphan.memory_id,
        suggested_action: suggestedAction,
        workspace_id: task.workspace_id,
        occurred_at: completedAt,
        confidence: orphan.orphan_confidence
      });

      await this.publishEventLogMutation(
        {
          event_type: GraphAuditorEventType.SOUL_ORPHAN_RADAR_REPORTED,
          entity_type: "orphan_radar",
          entity_id: radarId,
          workspace_id: task.workspace_id,
          run_id: task.run_id,
          caused_by: this.role,
          revision: 0,
          payload_json: payload
        },
        async () => {
          await orphanDetectionPort.createOrphanRadarRecord(radarRecord);
        }
      );
      createdRadarIds.push(radarId);
    }

    const result = this.createSuccessResult(
      task,
      completedAt,
      createdRadarIds,
      [`orphan_detection: created ${createdRadarIds.length} orphan radar candidates`]
    );
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  private async executeEventLogOrphanDetection(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    const orphanDetectionPort = this.dependencies.orphanDetectionPort;

    if (
      orphanDetectionPort?.findEventLogOrphans === undefined ||
      orphanDetectionPort.createEventLogOrphanRadarRecord === undefined
    ) {
      const result = this.createSuccessResult(task, completedAt, [], [
        "event_log_orphan_detection: skipped because orphan detection port is not configured"
      ]);
      await this.dependencies.scheduler.reportCompletion(result);
      return result;
    }

    const findEventLogOrphans = orphanDetectionPort.findEventLogOrphans;
    const createEventLogOrphanRadarRecord = orphanDetectionPort.createEventLogOrphanRadarRecord;
    const orphanedEvents = await findEventLogOrphans(task.workspace_id);
    const batch = orphanedEvents.slice(0, AUDITOR_CONSTANTS.BATCH_SIZE);
    const expiresAt = new Date(Date.parse(completedAt) + AUDITOR_CONSTANTS.ORPHAN_RADAR_TTL_MS).toISOString();
    const createdRadarIds: string[] = [];

    for (const orphan of batch) {
      const radarId = randomUUID();
      const payload = SoulGardenEventLogOrphanDetectedPayloadSchema.parse({
        audit_event_id: orphan.audit_event_id,
        event_type: orphan.event_type,
        expected_table: orphan.expected_table,
        detected_at: completedAt
      });

      await this.publishEventLogMutation(
        {
          event_type: SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED,
          entity_type: "orphan_radar",
          entity_id: radarId,
          workspace_id: task.workspace_id,
          run_id: task.run_id,
          caused_by: this.role,
          revision: 0,
          payload_json: payload
        },
        async () => {
          await createEventLogOrphanRadarRecord({
            radar_id: radarId,
            audit_event_id: orphan.audit_event_id,
            event_type: orphan.event_type,
            expected_table: orphan.expected_table,
            workspace_id: task.workspace_id,
            detected_at: completedAt,
            expires_at: expiresAt,
            requires_review: true
          });
        }
      );
      createdRadarIds.push(radarId);
    }

    const result = this.createSuccessResult(task, completedAt, createdRadarIds, [
      `event_log_orphan_detection: created ${createdRadarIds.length} event log orphan radar candidates`
    ]);
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  private async publishEventLogMutation<T>(
    entry: Omit<EventLogEntry, "event_id" | "created_at">,
    mutate: (entry: EventLogEntry | null) => Promise<T>
  ): Promise<T> {
    const eventLogRepo = this.dependencies.eventLogRepo;
    if (eventLogRepo === undefined) {
      return await mutate(null);
    }

    return await eventLogRepo.publishWithMutation(entry, async (eventLogEntry) => await mutate(eventLogEntry));
  }

  private async executeGreenMaintenance(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    const expiringStatuses = await this.dependencies.greenMaintenancePort.findExpiringGreenStatuses(
      task.workspace_id,
      AUDITOR_CONSTANTS.EXPIRY_LOOKAHEAD_MS
    );
    const batch = expiringStatuses.slice(0, AUDITOR_CONSTANTS.BATCH_SIZE);
    let affected: readonly string[] = [];

    for (const status of batch) {
      if (isPassiveStableDimension(status.dimension)) {
        await this.dependencies.greenMaintenancePort.renewGreenPassiveStable(
          status.green_status_id,
          task.task_id
        );
        affected = [...affected, status.green_status_id];
        continue;
      }

      // D8: hazard dimensions stay on the explicit user_reconfirm path in Phase 4A.
      if (status.dimension === MemoryDimension.HAZARD) {
        continue;
      }

      if (requiresActiveVerification(status.dimension)) {
        await this.dependencies.greenMaintenancePort.requestActiveVerification(
          status.green_status_id,
          task.task_id
        );
        affected = [...affected, status.green_status_id];
      }
    }

    const result = this.createSuccessResult(task, completedAt, affected, [
      `green_maintenance: processed ${affected.length} expiring green statuses`
    ]);
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  private async executeBootstrappingScan(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    const assessment = await this.dependencies.bootstrappingPort.assessColdStart(task.workspace_id);
    const candidates = assessment.is_cold_start
      ? (await this.dependencies.bootstrappingPort.generateDraftCandidates(task.workspace_id))
          .slice(0, AUDITOR_CONSTANTS.BATCH_SIZE)
          .map((draft) => draft.candidate_id)
      : [];

    const result = this.createSuccessResult(task, completedAt, candidates, [
      assessment.is_cold_start
        ? `bootstrapping_scan: cold start detected (${assessment.memory_count} memories, ${assessment.claim_count} claims); ${candidates.length} draft candidates generated`
        : `bootstrapping_scan: not cold start (${assessment.memory_count} memories, ${assessment.claim_count} claims)`
    ]);
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  private async executeCrystallizationScan(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    const patterns = await this.dependencies.bootstrappingPort.findHighFrequencyPatterns(
      task.workspace_id,
      AUDITOR_CONSTANTS.CRYSTALLIZATION_THRESHOLD
    );
    let created: readonly string[] = [];

    for (const pattern of patterns.slice(0, AUDITOR_CONSTANTS.BATCH_SIZE)) {
      const hasPending = await this.dependencies.bootstrappingPort.hasPendingSynthesisCandidate(
        task.workspace_id,
        pattern.pattern_key
      );
      if (hasPending) {
        continue;
      }

      const candidate = await this.dependencies.bootstrappingPort.createSynthesisCandidate(
        task.workspace_id,
        pattern.pattern_key
      );
      created = [...created, candidate.candidate_id];
    }

    const result = this.createSuccessResult(task, completedAt, created, [
      `crystallization_scan: ${created.length} synthesis candidates created from ${Math.min(
        patterns.length,
        AUDITOR_CONSTANTS.BATCH_SIZE
      )} high-frequency patterns`
    ]);
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  private async executePathPlasticityUpdate(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    const pathPlasticityPort = this.dependencies.pathPlasticityPort;

    if (pathPlasticityPort === undefined) {
      const result = this.createSuccessResult(task, completedAt, [], [
        "path_plasticity_update: skipped because path plasticity port is not configured"
      ]);
      await this.dependencies.scheduler.reportCompletion(result);
      return result;
    }

    const sinceIso = resolvePathPlasticitySinceIso(task.target_object_refs, completedAt);
    const computed = await pathPlasticityPort.computeAndApplyPlasticity({
      workspaceId: task.workspace_id,
      sinceIso
    });

    const result = this.createSuccessResult(task, completedAt, computed.affectedPathIds, [
      `path_plasticity_update: reinforced=${computed.reinforced} weakened=${computed.weakened} retired=${computed.retired} since=${sinceIso}`
    ]);
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  private createSuccessResult(
    task: GardenTaskDescriptor,
    completedAt: string,
    objectIds: readonly string[],
    auditEntries: readonly string[]
  ): GardenTaskResult {
    return {
      task_id: task.task_id,
      task_kind: task.task_kind,
      role: this.role,
      tier: this.tier,
      workspace_id: task.workspace_id,
      success: true,
      objects_affected: [...objectIds],
      audit_entries: [...auditEntries],
      error_message: null,
      completed_at: completedAt
    };
  }

  private createFailureResult(
    task: GardenTaskDescriptor,
    completedAt: string,
    error: unknown
  ): GardenTaskResult {
    return {
      task_id: task.task_id,
      task_kind: task.task_kind,
      role: this.role,
      tier: this.tier,
      workspace_id: task.workspace_id,
      success: false,
      objects_affected: [],
      audit_entries: [],
      error_message: error instanceof Error ? error.message : String(error),
      completed_at: completedAt
    };
  }
}

function isPassiveStableDimension(dimension: MemoryDimension): boolean {
  return dimension === MemoryDimension.PREFERENCE || dimension === MemoryDimension.EPISODE;
}

function requiresActiveVerification(dimension: MemoryDimension): boolean {
  return (
    dimension === MemoryDimension.FACT ||
    dimension === MemoryDimension.CONSTRAINT ||
    dimension === MemoryDimension.PROCEDURE
  );
}

function determineOrphanSuggestedAction(confidence: number): OrphanRadarSuggestedActionValue {
  if (confidence >= 0.75) {
    return "re_anchor_candidate";
  }

  if (confidence >= 0.4) {
    return "archive_candidate";
  }

  return "no_action";
}
