import { randomUUID } from "node:crypto";
import {
  GraphAuditorEventType,
  HealthIssueCauseKind,
  HealthIssueSeverity,
  HealthIssueSuggestedAction,
  SoulGardenEventLogOrphanDetectedEventType,
  SoulGardenEventLogOrphanDetectedPayloadSchema,
  SoulOrphanRadarReportedPayloadSchema,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type HealthIssueSuggestedActionValue,
  type OrphanRadar,
  type OrphanRadarSuggestedActionValue
} from "@do-soul/alaya-protocol";
import { AuditorCore } from "./auditor-core.js";
import { AUDITOR_CONSTANTS } from "./auditor-types.js";

export abstract class AuditorOrphanOperations extends AuditorCore {
  protected async executeOrphanDetection(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    const orphanDetectionPort = this.dependencies.orphanDetectionPort;

    if (orphanDetectionPort === undefined) {
      const result = this.createSuccessResult(task, completedAt, [], [
        "orphan_detection: skipped because orphan detection port is not configured"
      ]);
      await this.dependencies.scheduler.reportCompletion(result);
      return result;
    }

    return await this.executeOrphanRadarDetection({
      task,
      completedAt,
      loadRecords: async () => await orphanDetectionPort.findOrphanedMemories(task.workspace_id),
      createRadarRecord: async (orphan, expiresAt) => {
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

        await this.appendEventLogAndMutate(
          {
            event_type: GraphAuditorEventType.SOUL_ORPHAN_RADAR_REPORTED,
            entity_type: "orphan_radar",
            entity_id: radarId,
            workspace_id: task.workspace_id,
            run_id: task.run_id,
            caused_by: this.role,
            payload_json: payload
          },
          () => {
            orphanDetectionPort.createOrphanRadarRecord(radarRecord);
          }
        );
        await this.upsertHealthIssueGroup({
          workspaceId: orphan.workspace_id,
          targetObjectId: orphan.memory_id,
          causeKind: HealthIssueCauseKind.ORPHAN_RADAR,
          severity: orphan.orphan_confidence >= 0.75 ? HealthIssueSeverity.WARN : HealthIssueSeverity.INFO,
          confidence: orphan.orphan_confidence,
          observedAt: completedAt,
          suggestedActions: orphanSuggestedActionToHealthAction(suggestedAction),
          incrementCount: 1
        });
        return radarId;
      },
      completionSummary: (count) => `orphan_detection: created ${count} orphan radar candidates`
    });
  }

  protected async executeEventLogOrphanDetection(
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
    return await this.executeOrphanRadarDetection({
      task,
      completedAt,
      loadRecords: async () => await findEventLogOrphans(task.workspace_id),
      createRadarRecord: async (orphan, expiresAt) => {
        const radarId = randomUUID();
        const payload = SoulGardenEventLogOrphanDetectedPayloadSchema.parse({
          audit_event_id: orphan.audit_event_id,
          event_type: orphan.event_type,
          expected_table: orphan.expected_table,
          detected_at: completedAt
        });

        await this.appendEventLogAndMutate(
          {
            event_type: SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED,
            entity_type: "orphan_radar",
            entity_id: radarId,
            workspace_id: task.workspace_id,
            run_id: task.run_id,
            caused_by: this.role,
            payload_json: payload
          },
          () => {
            createEventLogOrphanRadarRecord({
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
        return radarId;
      },
      completionSummary: (count) =>
        `event_log_orphan_detection: created ${count} event log orphan radar candidates`
    });
  }

  private async executeOrphanRadarDetection<TRecord>(input: {
    readonly task: GardenTaskDescriptor;
    readonly completedAt: string;
    readonly loadRecords: () => Promise<readonly TRecord[]>;
    readonly createRadarRecord: (record: TRecord, expiresAt: string) => Promise<string>;
    readonly completionSummary: (createdCount: number) => string;
  }): Promise<GardenTaskResult> {
    const records = await input.loadRecords();
    const batch = records.slice(0, AUDITOR_CONSTANTS.BATCH_SIZE);
    const expiresAt = new Date(
      Date.parse(input.completedAt) + AUDITOR_CONSTANTS.ORPHAN_RADAR_TTL_MS
    ).toISOString();
    const createdRadarIds: string[] = [];

    for (const record of batch) {
      createdRadarIds.push(await input.createRadarRecord(record, expiresAt));
    }

    const result = this.createSuccessResult(input.task, input.completedAt, createdRadarIds, [
      input.completionSummary(createdRadarIds.length)
    ]);
    await this.dependencies.scheduler.reportCompletion(result);
    return result;
  }
}

function orphanSuggestedActionToHealthAction(
  action: OrphanRadarSuggestedActionValue
): readonly HealthIssueSuggestedActionValue[] {
  switch (action) {
    case "re_anchor_candidate":
      return Object.freeze([HealthIssueSuggestedAction.RELINK]);
    case "archive_candidate":
      return Object.freeze([HealthIssueSuggestedAction.RETIRE_MEMORY]);
    case "no_action":
      return Object.freeze([HealthIssueSuggestedAction.DEFER]);
  }
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
