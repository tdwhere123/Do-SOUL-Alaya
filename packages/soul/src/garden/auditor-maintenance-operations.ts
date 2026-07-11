import {
  GraphAuditorEventType,
  GreenGovernanceEventType,
  HealthEventKind,
  HealthIssueCauseKind,
  HealthIssueSeverity,
  HealthIssueSuggestedAction,
  MemoryDimension,
  SoulAuditorPointerHealedPayloadSchema,
  SoulGreenGraceRequestedPayloadSchema,
  SoulGreenRenewedPayloadSchema,
  SoulGreenRevokedPayloadSchema,
  type AuditorPointerHealPort,
  type GardenTaskDescriptor,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";
import {
  addMillisecondsIso,
  GreenRevokeNoopError
} from "./auditor-core.js";
import { AuditorOrphanOperations } from "./auditor-orphan-operations.js";
import { AUDITOR_CONSTANTS } from "./auditor-types.js";

export abstract class AuditorMaintenanceOperations extends AuditorOrphanOperations {
  protected async executeEvidenceCheck(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    const staleEntries = await this.dependencies.evidenceCheckPort.findMemoriesWithStaleEvidence(task.workspace_id);
    const batch = staleEntries.slice(0, AUDITOR_CONSTANTS.BATCH_SIZE);
    const revokedMemoryIds: string[] = [];
    const noopMemoryIds: string[] = [];

    for (const entry of batch) {
      const revokedAt = this.now();
      const payload = SoulGreenRevokedPayloadSchema.parse({
        target_object_id: entry.memory_entry_id,
        workspace_id: task.workspace_id,
        revoke_reason: "verification_fail",
        task_id: task.task_id,
        occurred_at: revokedAt
      });
      try {
        await this.appendEventLogAndMutate(
          {
            event_type: GreenGovernanceEventType.SOUL_GREEN_REVOKED,
            entity_type: "memory_entry",
            entity_id: entry.memory_entry_id,
            workspace_id: task.workspace_id,
            run_id: task.run_id,
            caused_by: this.role,
            payload_json: payload
          },
          () => {
            const result = this.dependencies.greenMaintenancePort.revokeGreen(
              entry.memory_entry_id,
              "verification_fail",
              task.task_id,
              task.workspace_id
            );
            if (result.affected === 0) {
              throw new GreenRevokeNoopError(entry.memory_entry_id, task.workspace_id);
            }
          }
        );
        revokedMemoryIds.push(entry.memory_entry_id);
      } catch (err) {
        if (err instanceof GreenRevokeNoopError) {
          noopMemoryIds.push(entry.memory_entry_id);
          continue;
        }
        throw err;
      }
    }

    await this.recordEvidenceCheckEffects(task, completedAt, batch, revokedMemoryIds, noopMemoryIds);
    const result = this.createSuccessResult(task, completedAt, revokedMemoryIds, [
      `evidence_staleness_check: revoked green for ${revokedMemoryIds.length} entries (noop: ${noopMemoryIds.length})`
    ]);
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  protected async executePointerHealthCheck(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
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

  protected async executePointerHealing(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
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

      await this.appendEventLogAndMutate(
        {
          event_type: GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED,
          entity_type: pointer.source_object_kind,
          entity_id: pointer.source_object_id,
          workspace_id: task.workspace_id,
          run_id: task.run_id,
          caused_by: this.role,
          payload_json: payload
        },
        () => clearHealablePointer(pointerHealPort, pointer, task.task_id)
      );
    }

    if (batch.length > 0) {
      await this.recordPointerRepair(task, batch);
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

  protected async executeGreenMaintenance(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    const expiringStatuses = await this.dependencies.greenMaintenancePort.findExpiringGreenStatuses(
      task.workspace_id,
      AUDITOR_CONSTANTS.EXPIRY_LOOKAHEAD_MS
    );
    const batch = expiringStatuses.slice(0, AUDITOR_CONSTANTS.BATCH_SIZE);
    let affected: readonly string[] = [];

    for (const status of batch) {
      if (isPassiveStableDimension(status.dimension)) {
        const renewedAt = this.now();
        const renewedPayload = SoulGreenRenewedPayloadSchema.parse({
          object_id: status.green_status_id,
          target_object_id: status.memory_entry_id,
          workspace_id: task.workspace_id,
          verification_basis: "passive_stable",
          task_id: task.task_id,
          occurred_at: renewedAt
        });
        await this.appendEventLogAndMutate(
          {
            event_type: GreenGovernanceEventType.SOUL_GREEN_RENEWED,
            entity_type: "green_status",
            entity_id: status.green_status_id,
            workspace_id: task.workspace_id,
            run_id: task.run_id,
            caused_by: this.role,
            payload_json: renewedPayload
          },
          () => {
            this.dependencies.greenMaintenancePort.renewGreenPassiveStable(
              status.green_status_id,
              task.task_id
            );
          }
        );
        affected = [...affected, status.green_status_id];
        continue;
      }

      if (status.dimension === MemoryDimension.HAZARD) {
        continue;
      }

      if (requiresActiveVerification(status.dimension)) {
        affected = [
          ...affected,
          await this.requestActiveVerification(task, status.green_status_id, status.memory_entry_id)
        ];
      }
    }

    const result = this.createSuccessResult(task, completedAt, affected, [
      `green_maintenance: processed ${affected.length} expiring green statuses`
    ]);
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }

  protected async executeBootstrappingScan(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
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

  protected async executeCrystallizationScan(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
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

  private async recordEvidenceCheckEffects(
    task: GardenTaskDescriptor,
    completedAt: string,
    batch: readonly { readonly memory_entry_id: string; readonly stale_evidence_refs: readonly unknown[] }[],
    revokedMemoryIds: readonly string[],
    noopMemoryIds: readonly string[]
  ): Promise<void> {
    if (revokedMemoryIds.length > 0) {
      await this.healthJournal?.record({
        event_kind: HealthEventKind.EVIDENCE_FAILURE,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        summary: `Evidence staleness check: ${revokedMemoryIds.length} memories with stale refs had Green revoked`,
        detail_json: {
          affected_memory_ids: revokedMemoryIds,
          total_stale_refs: batch.reduce((sum, entry) => sum + entry.stale_evidence_refs.length, 0)
        }
      });
      await this.upsertEvidenceFailureGroups(task.workspace_id, completedAt, batch, revokedMemoryIds);
    }

    if (noopMemoryIds.length > 0) {
      await this.healthJournal?.record({
        event_kind: HealthEventKind.GREEN_REVOKE_NOOP,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        summary: `Evidence staleness check: ${noopMemoryIds.length} revoke calls hit zero rows (already revoked / cross-workspace target)`,
        detail_json: {
          affected_memory_ids: noopMemoryIds,
          task_id: task.task_id
        }
      });
    }
  }

  private async upsertEvidenceFailureGroups(
    workspaceId: string,
    completedAt: string,
    batch: readonly { readonly memory_entry_id: string; readonly stale_evidence_refs: readonly unknown[] }[],
    revokedMemoryIds: readonly string[]
  ): Promise<void> {
    for (const memoryId of revokedMemoryIds) {
      const staleRefs =
        batch.find((entry) => entry.memory_entry_id === memoryId)?.stale_evidence_refs ?? [];
      await this.upsertHealthIssueGroup({
        workspaceId,
        targetObjectId: memoryId,
        causeKind: HealthIssueCauseKind.EVIDENCE_FAILURE,
        severity: HealthIssueSeverity.WARN,
        confidence: 1,
        observedAt: completedAt,
        suggestedActions: [
          HealthIssueSuggestedAction.REQUEST_EVIDENCE,
          HealthIssueSuggestedAction.MARK_QUESTIONABLE_OK
        ],
        incrementCount: Math.max(1, staleRefs.length)
      });
    }
  }

  private async recordPointerRepair(
    task: GardenTaskDescriptor,
    batch: readonly {
      readonly source_object_id: string;
      readonly source_object_kind: string;
      readonly ref_kind: string;
      readonly broken_ref: string;
    }[]
  ): Promise<void> {
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

  private async requestActiveVerification(
    task: GardenTaskDescriptor,
    greenStatusId: string,
    memoryEntryId: string
  ): Promise<string> {
    const requestedAt = this.now();
    const graceUntil = addMillisecondsIso(requestedAt, AUDITOR_CONSTANTS.ACTIVE_VERIFICATION_GRACE_MS);
    const requestedPayload = SoulGreenGraceRequestedPayloadSchema.parse({
      object_id: greenStatusId,
      target_object_id: memoryEntryId,
      workspace_id: task.workspace_id,
      valid_until: graceUntil,
      task_id: task.task_id,
      occurred_at: requestedAt
    });
    await this.appendEventLogAndMutate(
      {
        event_type: GreenGovernanceEventType.SOUL_GREEN_GRACE_REQUESTED,
        entity_type: "green_status",
        entity_id: greenStatusId,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        caused_by: this.role,
        payload_json: requestedPayload
      },
      () => {
        this.dependencies.greenMaintenancePort.requestActiveVerification(greenStatusId, task.task_id);
      }
    );
    return greenStatusId;
  }
}

function clearHealablePointer(
  pointerHealPort: AuditorPointerHealPort,
  pointer: {
    readonly source_object_id: string;
    readonly ref_kind: "evidence_ref" | "memory_ref" | "synthesis_ref" | "source_object_ref";
    readonly broken_ref: string;
  },
  taskId: string
): void {
  switch (pointer.ref_kind) {
    case "evidence_ref":
      pointerHealPort.clearEvidenceRef(pointer.source_object_id, pointer.broken_ref, taskId);
      break;
    case "memory_ref":
      pointerHealPort.clearMemoryRef(pointer.source_object_id, pointer.broken_ref, taskId);
      break;
    case "synthesis_ref":
      pointerHealPort.clearSynthesisRef(pointer.source_object_id, pointer.broken_ref, taskId);
      break;
    case "source_object_ref":
      break;
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
