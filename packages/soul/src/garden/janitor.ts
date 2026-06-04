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

// invariant: setLifecycleDormant tolerates the benign "no longer active" race.
// The candidate snapshot can go stale before a candidate's turn (concurrent
// revival / overlapping sweep / Inspector retire), so the audited demotion is a
// guarded active->dormant transition that resolves "skipped" (no audit, no
// throw) when the row is not active anymore. The sweep counts only "demoted"
// rows and CONTINUES past a skip so one racy candidate cannot abort the batch.
export type DormantDemotionOutcome = "demoted" | "skipped";

export interface JanitorDormantDemotionPort {
  findLowActivityActiveMemories(workspaceId: string): Promise<readonly LowActivityMemoryRecord[]>;
  setLifecycleDormant(memoryId: string, taskId: string): Promise<DormantDemotionOutcome>;
}

export interface TombstonedMemoryRecord {
  readonly memory_id: string;
}

export interface JanitorTombstoneGcPort {
  // invariant: returns ONLY tombstoned rows that carry a durable
  // forget_disposition AND are past the grace age — the disposition gate is
  // enforced inside the port's query (daemon wires it to
  // memory-entry-repo.findTombstonedMemoriesWithDisposition).
  findTombstonedMemories(workspaceId: string): Promise<readonly TombstonedMemoryRecord[]>;
  // invariant: physical removal is GATED. The daemon wires this to
  // memory-service.autonomousHardDeleteTombstoned, which refuses any row lacking
  // a non-null disposition even if tombstoned (defense in depth). Resolves
  // `true` only when the row was physically deleted; `false` when the delete was
  // refused (B1 preservation_revoked) so the caller counts only deleted rows.
  hardDelete(memoryId: string, taskId: string): Promise<boolean>;
}

export interface DormantDispositionCandidate {
  readonly memory_id: string;
  // The disposition the gate computed for this dormant memory. null means the
  // memory failed the gate (kept / protected / not yet preserved) and MUST NOT
  // be tombstoned. Only a non-null disposition is eligible.
  readonly disposition: "compressed" | "judged_useless" | null;
  readonly disposition_ref: string | null;
}

// invariant: the GATED autonomous dormant -> tombstoned producer. The daemon's
// implementation computes each dormant memory's disposition (compressed = live
// capsule membership, judged_useless = mechanical importance gate) and only
// tombstones rows the gate cleared. A memory with a null disposition is left
// dormant (reversible), never terminalized.
// see also: packages/core/src/importance-gate.ts classifyMemoryImportance.
export interface JanitorDispositionSweepPort {
  findDormantDispositionCandidates(workspaceId: string): Promise<readonly DormantDispositionCandidate[]>;
  autonomousTombstone(candidate: DormantDispositionCandidate, taskId: string): Promise<void>;
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
  readonly dispositionSweepPort?: JanitorDispositionSweepPort;
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
  private readonly dispositionSweepPort?: JanitorDispositionSweepPort;
  private readonly strongRefProtectionPort?: JanitorStrongRefProtectionPort;
  private readonly eventLogRepo?: AuditorEventLogPort;
  private readonly now: () => string;

  public constructor(deps: JanitorDependencies) {
    this.cleanupPort = deps.cleanupPort;
    this.tieringPort = deps.tieringPort;
    this.scheduler = deps.scheduler;
    this.dormantDemotionPort = deps.dormantDemotionPort;
    this.tombstoneGcPort = deps.tombstoneGcPort;
    this.dispositionSweepPort = deps.dispositionSweepPort;
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
    let skipped = 0;

    for (const candidate of batch) {
      // invariant: a candidate that left active between the snapshot and its turn
      // resolves "skipped" (no audit emitted, no throw). The loop CONTINUES so one
      // racy candidate cannot abort the batch, and only actually-demoted rows are
      // counted in objects_affected (a skip-lying empty result is impossible).
      const outcome = await this.dormantDemotionPort.setLifecycleDormant(candidate.memory_id, task.task_id);
      if (outcome === "demoted") {
        objectIds.push(candidate.memory_id);
      } else {
        skipped += 1;
      }
    }

    const auditEntry =
      skipped === 0
        ? `dormant_demotion: ${objectIds.length} memories transitioned to lifecycle_state=dormant`
        : `dormant_demotion: ${objectIds.length} memories transitioned to lifecycle_state=dormant (${skipped} skipped: no longer active)`;
    const result = this.createSuccessResult(task, completedAt, objectIds, [auditEntry]);
    await this.scheduler.reportCompletion(result);
    return result;
  }

  // invariant: the terminal forgetting stage (R3d). Two GATED phases run in one
  // task: (1) the autonomous dormant -> tombstoned disposition sweep (only rows
  // the gate cleared as compressed-into-a-live-capsule or judged_useless get a
  // durable marker + tombstone), then (2) the physical GC of tombstoned rows
  // that carry a disposition and are past grace. Neither phase can touch an
  // un-preserved/un-judged memory: phase 1 needs a non-null disposition, phase 2
  // re-checks the disposition gate in the delete authority (defense in depth).
  private async executeTombstoneGc(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    const auditEntries: string[] = [];

    const tombstonedNow = await this.runDispositionSweep(task, auditEntries);

    if (this.tombstoneGcPort === undefined) {
      auditEntries.push("[SKIPPED] tombstone_gc: gc port not wired");
      const result = this.createSuccessResult(task, completedAt, tombstonedNow, auditEntries);
      await this.scheduler.reportCompletion(result);
      return result;
    }

    const candidates = await this.tombstoneGcPort.findTombstonedMemories(task.workspace_id);
    const batch = candidates.slice(0, JANITOR_CONSTANTS.BATCH_SIZE);
    const objectIds: string[] = [];
    let refused = 0;

    for (const candidate of batch) {
      if (this.strongRefProtectionPort !== undefined) {
        const isProtected = await this.strongRefProtectionPort.isProtected(task.workspace_id, "memory", candidate.memory_id);
        if (isProtected) {
          auditEntries.push(`[SKIPPED] tombstone_gc: ${candidate.memory_id} protected by strong ref`);
          continue;
        }
      }

      // invariant: count only rows the gate actually deleted. A `false` return is
      // the B1 preservation_revoked refuse path (row stays tombstoned), so it must
      // not enter objects_affected nor the hard-deleted tally.
      const deleted = await this.tombstoneGcPort.hardDelete(candidate.memory_id, task.task_id);
      if (deleted) {
        objectIds.push(candidate.memory_id);
      } else {
        refused += 1;
      }
    }

    auditEntries.push(
      `tombstone_gc: ${objectIds.length} tombstoned memories hard-deleted${
        refused > 0 ? ` (${refused} refused: preservation revoked)` : ""
      }`
    );
    const result = this.createSuccessResult(
      task,
      completedAt,
      [...tombstonedNow, ...objectIds],
      auditEntries
    );
    await this.scheduler.reportCompletion(result);
    return result;
  }

  // The gated dormant -> tombstoned disposition sweep. Returns the ids
  // freshly tombstoned this pass (appended to objects_affected). Skips any
  // candidate whose disposition is null — that memory stays dormant (reversible)
  // because it is neither compressed into a live capsule nor judged useless.
  private async runDispositionSweep(
    task: GardenTaskDescriptor,
    auditEntries: string[]
  ): Promise<readonly string[]> {
    if (this.dispositionSweepPort === undefined) {
      auditEntries.push("[SKIPPED] tombstone_gc: disposition sweep port not wired");
      return [];
    }

    const candidates = await this.dispositionSweepPort.findDormantDispositionCandidates(task.workspace_id);
    const batch = candidates.slice(0, JANITOR_CONSTANTS.BATCH_SIZE);
    const tombstoned: string[] = [];
    let skipped = 0;

    for (const candidate of batch) {
      if (candidate.disposition === null) {
        skipped += 1;
        continue;
      }
      await this.dispositionSweepPort.autonomousTombstone(candidate, task.task_id);
      tombstoned.push(candidate.memory_id);
    }

    auditEntries.push(
      `disposition_sweep: ${tombstoned.length} dormant memories autonomously tombstoned (${skipped} retained, no disposition)`
    );
    return tombstoned;
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
