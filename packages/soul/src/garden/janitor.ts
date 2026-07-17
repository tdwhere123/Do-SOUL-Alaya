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
  type GardenTaskKindValue,
  type GardenTaskResult,
  type GardenTierValue
} from "@do-soul/alaya-protocol";
import {
  runJanitorRetentionDecayScan,
  type JanitorRetentionDecayPort
} from "./janitor-retention-decay.js";
import {
  createGardenFailureResult,
  createGardenSuccessResult,
  type GardenTaskHandler,
  safeRunGardenTask
} from "./garden-task-runner.js";

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
  demoteToWarm(workspaceId: string, memoryEntryIds: readonly string[]): void;
}

type EventLogDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

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

// invariant: a dormant disposition candidate can go stale between candidate
// selection and its tombstone turn (concurrent revival / overlapping sweep /
// Inspector pin). The tombstone authority refuses such a row (no longer dormant,
// or became explicitly protected) as a benign concurrent-mutation race, which the
// daemon adapter resolves "skipped" so one racy candidate cannot abort the batch.
// A genuine error (shape precondition / missing port / storage fault) is NOT a
// skip and still rejects loud. Mirrors DormantDemotionOutcome.
// see also: apps/core-daemon/src/forget-disposition-ports.ts createTombstoneDispositionSweepPort,
// packages/core/src/memory/memory-service/service.ts:MemoryService.autonomousTombstone.
export type DispositionSweepOutcome =
  | { readonly status: "tombstoned" }
  | { readonly status: "skipped"; readonly reason: string };

// invariant: the GATED autonomous dormant -> tombstoned producer. The daemon's
// implementation computes each dormant memory's disposition (compressed = live
// capsule membership, judged_useless = mechanical importance gate) and only
// tombstones rows the gate cleared. A memory with a null disposition is left
// dormant (reversible), never terminalized.
// see also: packages/core/src/manifestation/importance-gate.ts classifyMemoryImportance.
export interface JanitorDispositionSweepPort {
  findDormantDispositionCandidates(workspaceId: string): Promise<readonly DormantDispositionCandidate[]>;
  autonomousTombstone(candidate: DormantDispositionCandidate, taskId: string): Promise<DispositionSweepOutcome>;
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
  // Enables a successful, explicit defer audit when the caller intentionally
  // keeps physical GC fail-closed instead of merely omitting the port.
  readonly tombstoneGcDeferredReason?: string;
  readonly dispositionSweepPort?: JanitorDispositionSweepPort;
  readonly strongRefProtectionPort?: JanitorStrongRefProtectionPort;
  readonly retentionDecayPort?: JanitorRetentionDecayPort;
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
  private readonly tombstoneGcDeferredReason?: string;
  private readonly dispositionSweepPort?: JanitorDispositionSweepPort;
  private readonly strongRefProtectionPort?: JanitorStrongRefProtectionPort;
  private readonly retentionDecayPort?: JanitorRetentionDecayPort;
  private readonly eventLogRepo?: AuditorEventLogPort;
  private readonly now: () => string;
  private readonly taskHandlers: ReadonlyMap<GardenTaskKindValue, GardenTaskHandler>;

  public constructor(deps: JanitorDependencies) {
    this.cleanupPort = deps.cleanupPort;
    this.tieringPort = deps.tieringPort;
    this.scheduler = deps.scheduler;
    this.dormantDemotionPort = deps.dormantDemotionPort;
    this.tombstoneGcPort = deps.tombstoneGcPort;
    this.tombstoneGcDeferredReason = deps.tombstoneGcDeferredReason;
    this.dispositionSweepPort = deps.dispositionSweepPort;
    this.strongRefProtectionPort = deps.strongRefProtectionPort;
    this.retentionDecayPort = deps.retentionDecayPort;
    this.eventLogRepo = deps.eventLogRepo;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.taskHandlers = new Map<GardenTaskKindValue, GardenTaskHandler>([
      [GardenTaskKind.TTL_CLEANUP, this.executeTtlCleanup.bind(this)],
      [GardenTaskKind.HOT_INDEX_DEMOTION, this.executeHotIndexDemotion.bind(this)],
      [GardenTaskKind.DORMANT_DEMOTION, this.executeDormantDemotion.bind(this)],
      [GardenTaskKind.TOMBSTONE_GC, this.executeTombstoneGc.bind(this)]
    ]);
  }

  public async run(task: GardenTaskDescriptor): Promise<GardenTaskResult> {
    return safeRunGardenTask({
      roleLabel: "Janitor",
      task,
      completedAt: this.now(),
      handlers: this.taskHandlers,
      createFailureResult: this.createFailureResult.bind(this),
      reportCompletion: (result) => this.scheduler.reportCompletion(result)
    });
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
    const retentionAudit = await runJanitorRetentionDecayScan(
      this.retentionDecayPort,
      task.workspace_id
    );

    const candidates = await this.tieringPort.findHotDemotionCandidates(task.workspace_id, {
      maxLastHitAgeMs: JANITOR_CONSTANTS.HOT_DEMOTION_THRESHOLD_MS,
      minActivationScore: JANITOR_CONSTANTS.HOT_DEMOTION_MIN_ACTIVATION
    });
    const objectIds = candidates.slice(0, JANITOR_CONSTANTS.BATCH_SIZE).map((entry) => entry.memory_entry_id);

    if (objectIds.length > 0) {
      await this.applyHotIndexDemotion(task, objectIds);
    }

    const result = this.createSuccessResult(task, completedAt, objectIds, [
      retentionAudit,
      `hot_index_demotion: demoted ${objectIds.length} entries to cold storage tier in ${task.workspace_id}`
    ]);
    await this.scheduler.reportCompletion(result);
    return result;
  }

  private async applyHotIndexDemotion(
    task: GardenTaskDescriptor,
    objectIds: readonly string[]
  ): Promise<void> {
    await this.publishEventLogsMutation(
      this.buildHotIndexDemotionEvents(task, objectIds, this.now()),
      () => this.tieringPort.demoteToWarm(task.workspace_id, objectIds)
    );
  }

  private buildHotIndexDemotionEvents(
    task: GardenTaskDescriptor,
    objectIds: readonly string[],
    occurredAt: string
  ): readonly EventLogDraft[] {
    return objectIds.map((memoryId) => ({
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
  }

  private async publishEventLogsMutation(
    events: readonly EventLogDraft[],
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
      auditEntries.push(
        this.tombstoneGcDeferredReason === undefined
          ? "[SKIPPED] tombstone_gc: gc port not wired"
          : `[DEFERRED] tombstone_gc: ${this.tombstoneGcDeferredReason}`
      );
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
      if (this.strongRefProtectionPort !== undefined) {
        const isProtected = await this.strongRefProtectionPort.isProtected(task.workspace_id, "memory", candidate.memory_id);
        if (isProtected) {
          auditEntries.push(`[SKIPPED] disposition_sweep: ${candidate.memory_id} protected by strong ref`);
          skipped += 1;
          continue;
        }
      }
      // invariant: a candidate that left dormant OR became explicitly protected
      // between selection and its turn resolves "skipped" (the tombstone authority
      // refused it as a benign concurrent-mutation race). The loop CONTINUES so one
      // racy candidate cannot abort the batch nor erase the in-batch audit trail of
      // candidates already tombstoned this pass; only actually-tombstoned rows enter
      // objects_affected. A genuine error still rejects to run()'s failure path.
      // Mirrors executeDormantDemotion / executeTombstoneGc skip-and-continue.
      const outcome = await this.dispositionSweepPort.autonomousTombstone(candidate, task.task_id);
      if (outcome.status === "tombstoned") {
        tombstoned.push(candidate.memory_id);
      } else {
        auditEntries.push(`[SKIPPED] disposition_sweep: ${candidate.memory_id} ${outcome.reason}`);
        skipped += 1;
      }
    }

    auditEntries.push(
      `disposition_sweep: ${tombstoned.length} dormant memories autonomously tombstoned (${skipped} retained, no disposition or strong ref)`
    );
    return tombstoned;
  }

  private createSuccessResult(
    task: GardenTaskDescriptor,
    completedAt: string,
    objectIds: readonly string[],
    auditEntries: readonly string[]
  ): GardenTaskResult {
    return createGardenSuccessResult(
      { role: this.role, tier: this.tier },
      task,
      completedAt,
      objectIds,
      auditEntries
    );
  }

  private createFailureResult(
    task: GardenTaskDescriptor,
    completedAt: string,
    error: unknown
  ): GardenTaskResult {
    return createGardenFailureResult({ role: this.role, tier: this.tier }, task, completedAt, error);
  }
}
