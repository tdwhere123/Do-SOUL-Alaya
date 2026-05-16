import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  MemoryGovernanceEventType,
  SoulMemoryTierChangedPayloadSchema,
  type AuditorEventLogPort,
  type EventLogEntry,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue
} from "@do-soul/alaya-protocol";

export const JANITOR_CONSTANTS = {
  HOT_DEMOTION_THRESHOLD_MS: 7 * 86_400_000,
  HOT_DEMOTION_MIN_ACTIVATION: 0.3,
  BATCH_SIZE: 50
} as const;

export interface ExpiredControlPlaneObject {
  readonly object_kind: string;
  readonly object_id: string;
  readonly expires_at: string;
}

export interface JanitorControlPlaneCleanupPort {
  findExpiredObjects(workspaceId: string, nowIso: string): Promise<readonly ExpiredControlPlaneObject[]>;
  removeExpiredObjects(workspaceId: string, objectIds: readonly string[]): Promise<void>;
}

export interface HotDemotionCandidate {
  readonly memory_entry_id: string;
  readonly last_access_at: string | null;
  readonly activation_score: number;
}

export interface JanitorHotDemotionCriteria {
  readonly maxLastHitAgeMs: number;
  readonly minActivationScore: number;
}

export interface JanitorMemoryTieringPort {
  findHotDemotionCandidates(
    workspaceId: string,
    criteria: JanitorHotDemotionCriteria
  ): Promise<readonly HotDemotionCandidate[]>;
  // Sync so the Janitor can wrap each demote in
  // EventPublisher.appendManyWithMutation atomically with the
  // SOUL_MEMORY_TIER_CHANGED EventLog row.
  demoteToWarm(workspaceId: string, memoryEntryIds: readonly string[]): void;
}

export interface LowActivityMemoryRecord {
  readonly memory_id: string;
}

export interface JanitorDormantDemotionPort {
  findLowActivityActiveMemories(workspaceId: string): Promise<readonly LowActivityMemoryRecord[]>;
  setLifecycleDormant(memoryId: string, taskId: string): Promise<void>;
}

export interface TombstonedMemoryRecord {
  readonly memory_id: string;
}

export interface JanitorTombstoneGcPort {
  findTombstonedMemories(workspaceId: string): Promise<readonly TombstonedMemoryRecord[]>;
  hardDelete(memoryId: string, taskId: string): Promise<void>;
}

export interface JanitorStrongRefProtectionPort {
  isProtected(workspaceId: string, targetEntityType: string, targetEntityId: string): Promise<boolean>;
}

export interface JanitorSchedulerPort {
  reportCompletion(result: GardenTaskResult): Promise<void>;
}

export interface JanitorDependencies {
  readonly cleanupPort: JanitorControlPlaneCleanupPort;
  readonly tieringPort: JanitorMemoryTieringPort;
  readonly scheduler: JanitorSchedulerPort;
  readonly dormantDemotionPort?: JanitorDormantDemotionPort;
  readonly tombstoneGcPort?: JanitorTombstoneGcPort;
  readonly strongRefProtectionPort?: JanitorStrongRefProtectionPort;
  // Optional EventLog writer used to commit SOUL_MEMORY_TIER_CHANGED
  // rows in the same SQLite transaction as the storage_tier UPDATE.
  // When undefined the Janitor falls back to the bare UPDATE in legacy
  // or narrow test paths.
  readonly eventLogRepo?: AuditorEventLogPort;
  readonly now?: () => string;
}

export class Janitor {
  public readonly role: GardenRoleValue = GardenRole.JANITOR;
  public readonly tier: GardenTierValue = GardenTier.TIER_0;

  private readonly cleanupPort: JanitorControlPlaneCleanupPort;
  private readonly tieringPort: JanitorMemoryTieringPort;
  private readonly scheduler: JanitorSchedulerPort;
  private readonly dormantDemotionPort?: JanitorDormantDemotionPort;
  private readonly tombstoneGcPort?: JanitorTombstoneGcPort;
  private readonly strongRefProtectionPort?: JanitorStrongRefProtectionPort;
  private readonly eventLogRepo?: AuditorEventLogPort;
  private readonly now: () => string;

  public constructor(deps: JanitorDependencies) {
    this.cleanupPort = deps.cleanupPort;
    this.tieringPort = deps.tieringPort;
    this.scheduler = deps.scheduler;
    this.dormantDemotionPort = deps.dormantDemotionPort;
    this.tombstoneGcPort = deps.tombstoneGcPort;
    this.strongRefProtectionPort = deps.strongRefProtectionPort;
    this.eventLogRepo = deps.eventLogRepo;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  public async run(task: GardenTaskDescriptor): Promise<GardenTaskResult> {
    const completedAt = this.now();

    try {
      switch (task.task_kind) {
        case GardenTaskKind.TTL_CLEANUP:
          return await this.executeTtlCleanup(task, completedAt);
        case GardenTaskKind.HOT_INDEX_DEMOTION:
          return await this.executeHotIndexDemotion(task, completedAt);
        case GardenTaskKind.DORMANT_DEMOTION:
          return await this.executeDormantDemotion(task, completedAt);
        case GardenTaskKind.TOMBSTONE_GC:
          return await this.executeTombstoneGc(task, completedAt);
        default:
          throw new Error(`Janitor does not handle task kind: ${task.task_kind}`);
      }
    } catch (error) {
      const result = this.createFailureResult(task, completedAt, error);
      await this.scheduler.reportCompletion(result);
      return result;
    }
  }

  private async executeTtlCleanup(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    const expiredObjects = await this.cleanupPort.findExpiredObjects(task.workspace_id, completedAt);
    const objectIds = expiredObjects.slice(0, JANITOR_CONSTANTS.BATCH_SIZE).map((entry) => entry.object_id);

    if (objectIds.length > 0) {
      await this.cleanupPort.removeExpiredObjects(task.workspace_id, objectIds);
    }

    const result = this.createSuccessResult(task, completedAt, objectIds, [
      `ttl_cleanup: removed ${objectIds.length} expired objects in ${task.workspace_id}`
    ]);
    await this.scheduler.reportCompletion(result);
    return result;
  }

  private async executeHotIndexDemotion(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    const candidates = await this.tieringPort.findHotDemotionCandidates(task.workspace_id, {
      maxLastHitAgeMs: JANITOR_CONSTANTS.HOT_DEMOTION_THRESHOLD_MS,
      minActivationScore: JANITOR_CONSTANTS.HOT_DEMOTION_MIN_ACTIVATION
    });
    const objectIds = candidates.slice(0, JANITOR_CONSTANTS.BATCH_SIZE).map((entry) => entry.memory_entry_id);

    if (objectIds.length > 0) {
      // Emit one SOUL_MEMORY_TIER_CHANGED row per demoted entry,
      // atomically with the storage_tier UPDATE. The batch demote runs
      // once inside the mutate callback and the per-entry events land
      // in EventLog for audit replay. Storage writes the "cold" tier
      // (BOUNDARY_COLD_TIER), so keep the audit row consistent.
      const occurredAt = this.now();
      const events = objectIds.map((memoryId) => ({
        event_type: MemoryGovernanceEventType.SOUL_MEMORY_TIER_CHANGED,
        entity_type: "memory_entry",
        entity_id: memoryId,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        caused_by: this.role,
        payload_json: SoulMemoryTierChangedPayloadSchema.parse({
          object_id: memoryId,
          object_kind: "memory_entry",
          workspace_id: task.workspace_id,
          run_id: task.run_id,
          from_tier: "hot",
          to_tier: "cold",
          reason: "hot_index_demotion",
          task_id: task.task_id,
          occurred_at: occurredAt
        })
      }));
      await this.publishEventLogsMutation(events, () => {
        this.tieringPort.demoteToWarm(task.workspace_id, objectIds);
      });
    }

    const result = this.createSuccessResult(task, completedAt, objectIds, [
      `hot_index_demotion: demoted ${objectIds.length} entries to cold storage tier in ${task.workspace_id}`
    ]);
    await this.scheduler.reportCompletion(result);
    return result;
  }

  // Mirrors the Auditor.publishEventLogMutation pattern but accepts
  // multiple events so a batch UPDATE can commit atomically with N audit
  // rows.
  private async publishEventLogsMutation(
    events: ReadonlyArray<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>,
    mutate: () => void
  ): Promise<void> {
    if (this.eventLogRepo === undefined) {
      mutate();
      return;
    }
    await this.eventLogRepo.appendManyWithMutation(events, () => {
      mutate();
      return undefined as never;
    });
  }

  private async executeDormantDemotion(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    if (this.dormantDemotionPort === undefined) {
      const result = this.createSuccessResult(task, completedAt, [], ["[SKIPPED] dormant_demotion: port not wired"]);
      await this.scheduler.reportCompletion(result);
      return result;
    }

    const candidates = await this.dormantDemotionPort.findLowActivityActiveMemories(task.workspace_id);
    const batch = candidates.slice(0, JANITOR_CONSTANTS.BATCH_SIZE);
    const objectIds: string[] = [];

    for (const candidate of batch) {
      await this.dormantDemotionPort.setLifecycleDormant(candidate.memory_id, task.task_id);
      objectIds.push(candidate.memory_id);
    }

    const result = this.createSuccessResult(task, completedAt, objectIds, [
      `dormant_demotion: ${objectIds.length} memories transitioned to lifecycle_state=dormant`
    ]);
    await this.scheduler.reportCompletion(result);
    return result;
  }

  private async executeTombstoneGc(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    if (this.tombstoneGcPort === undefined) {
      const result = this.createSuccessResult(task, completedAt, [], ["[SKIPPED] tombstone_gc: port not wired"]);
      await this.scheduler.reportCompletion(result);
      return result;
    }

    const candidates = await this.tombstoneGcPort.findTombstonedMemories(task.workspace_id);
    const batch = candidates.slice(0, JANITOR_CONSTANTS.BATCH_SIZE);
    const objectIds: string[] = [];
    const auditEntries: string[] = [];

    for (const candidate of batch) {
      if (this.strongRefProtectionPort !== undefined) {
        const isProtected = await this.strongRefProtectionPort.isProtected(task.workspace_id, "memory", candidate.memory_id);
        if (isProtected) {
          auditEntries.push(`[SKIPPED] tombstone_gc: ${candidate.memory_id} protected by strong ref`);
          continue;
        }
      }

      await this.tombstoneGcPort.hardDelete(candidate.memory_id, task.task_id);
      objectIds.push(candidate.memory_id);
    }

    auditEntries.push(
      `tombstone_gc: ${objectIds.length} tombstoned memories hard-deleted`
    );
    const result = this.createSuccessResult(task, completedAt, objectIds, auditEntries);
    await this.scheduler.reportCompletion(result);
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
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      task_id: task.task_id,
      task_kind: task.task_kind,
      role: this.role,
      tier: this.tier,
      workspace_id: task.workspace_id,
      success: false,
      objects_affected: [],
      audit_entries: [],
      error_message: errorMessage,
      completed_at: completedAt
    };
  }
}
