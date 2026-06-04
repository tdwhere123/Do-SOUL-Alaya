import { randomUUID } from "node:crypto";
import {
  FactualPolicyConditionSchema,
  IsoDatetimeStringSchema,
  MemoryDimension,
  MemoryEntrySchema,
  ObjectLifecycleStateSchema,
  MemoryGovernanceEventType,
  RevokeReason,
  SoulMemoryArchivedPayloadSchema,
  SoulMemoryCreatedPayloadSchema,
  SoulMemoryStateChangedPayloadSchema,
  SoulMemoryUpdatedPayloadSchema,
  StorageTier,
  StorageTierSchema,
  TransitionCausedBySchema,
  isValidLifecycleTransition,
  type EventLogEntry,
  type FactualPolicyCondition,
  type MemoryEntry,
  type MemoryEntryMutableFields,
  type MemoryEntryRepoUpdateFields as ProtocolMemoryEntryRepoUpdateFields,
  type ScopeClass,
  type SynthesisCapsule,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import { parseNonEmptyString, parseObjectId } from "./shared/validators.js";

export type MemoryEntryInput = Omit<
  MemoryEntry,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "storage_tier"
  | "activation_score"
  | "retention_score"
  | "manifestation_state"
  | "retention_state"
  | "decay_profile"
  | "confidence"
  | "last_used_at"
  | "last_hit_at"
  | "reinforcement_count"
  | "contradiction_count"
  | "superseded_by"
> & {
  readonly storage_tier?: MemoryEntry["storage_tier"];
  // invariant: atomic create + enrich_pending no-drop marker. When present, the
  // memory row insert and the enrich_pending enqueue commit in ONE storage
  // transaction (so a created memory ALWAYS carries its marker, or neither
  // lands and the originating signal can replay). The caller (soul materializer)
  // owns the enqueue DECISION — it sets this only on the branches that enqueue;
  // run_id / source_signal_id are carried here, while workspace_id + memory_id
  // are filled from the freshly created row inside core. Requires both the
  // enrichPendingWriter dep and memoryEntryRepo.createWithinTransaction to be
  // wired; otherwise create throws rather than silently dropping the marker.
  // see also: packages/soul/src/garden/materialization-router.ts enqueueEnrichment
  // see also: packages/storage/src/repos/enrich-pending-repo.ts enqueue
  readonly enqueueEnrichment?: {
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  };
};

export type MemoryEntryUpdateFields = MemoryEntryMutableFields & {
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
};
export type MemoryEntryRepoUpdateFields = ProtocolMemoryEntryRepoUpdateFields & {
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
};

export interface MemoryServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface MemoryServiceMemoryEntryRepoPort {
  create(entry: MemoryEntry): Promise<Readonly<MemoryEntry>>;
  // see also: packages/storage/src/repos/memory-entry-repo.ts createWithinTransaction.
  // The synchronous callbacks commit atomically with the row insert. `beforeCreate`
  // is used for the EventLog-first audit row; `afterCreate` is used for the
  // enrich_pending no-drop marker.
  createWithinTransaction?(
    entry: MemoryEntry,
    callbacks: {
      readonly beforeCreate?: () => void;
      readonly afterCreate?: () => void;
    }
  ): Readonly<MemoryEntry>;
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
  findByWorkspaceId(
    workspaceId: string,
    tier?: MemoryEntry["storage_tier"]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByRunId(runId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  update(objectId: string, fields: MemoryEntryRepoUpdateFields): Promise<Readonly<MemoryEntry>>;
  updateScoped?(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>>;
  transitionLifecycle?(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>>;
  // invariant: guarded active -> dormant demotion. onTransition (the
  // active->dormant audit append) commits atomically with the guarded UPDATE
  // inside one transaction; resolves null on a 0-row benign race (row not active
  // anymore) so the caller skips without a spurious audit and without throwing.
  transitionToDormantIfActive?(
    objectId: string,
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry> | null>;
  archive(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry>>;
  hardDeleteTombstoned?(objectId: string): Promise<void>;
  // invariant: the GATED autonomous-tombstone authority (R3d). Writes the
  // durable forget_disposition marker and terminalizes a DORMANT row only.
  autonomousTombstone?(input: {
    readonly objectId: string;
    readonly disposition: MemoryEntry["forget_disposition"];
    readonly dispositionRef: string | null;
    readonly updatedAt: string;
  }): Promise<Readonly<MemoryEntry>>;
  // invariant: the GATED autonomous physical-delete authority (R3d). Removes a
  // tombstoned + past-grace row ONLY when it carries a non-null disposition.
  // requireLiveCapsuleRef makes the compressed-member preservation re-check
  // (capsule liveness + membership) atomic with the physical delete; resolves
  // false when that guard removed 0 rows (preservation revoked, fail-closed).
  hardDeleteTombstonedWithDisposition?(
    objectId: string,
    options?: { readonly requireLiveCapsuleRef?: boolean; readonly onDeleted?: () => void }
  ): Promise<boolean>;
}

export interface MemoryServiceEvidenceServicePort {
  findById(objectId: string): Promise<unknown | null>;
}

// invariant (B1 delete-time TOCTOU backstop): the disposition-gated physical
// delete authority re-verifies a `compressed` member's preserving capsule at
// DELETE time, not just at marking time. A capsule can archive / tombstone /
// drop the member / be cascade-deleted during the >=24h grace, which would make
// the member's "preserved" rationale stale and turn the hard-delete into
// permanent loss. This port lets the delete authority re-load the capsule by
// forget_disposition_ref and re-assert liveness + membership before deleting.
export interface MemoryServiceSynthesisCapsuleLookupPort {
  findById(objectId: string): Promise<Readonly<SynthesisCapsule> | null>;
}

export interface MemoryRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface MemoryServiceDynamicsPort {
  assignInitialDynamics(params: {
    readonly dimension: MemoryEntry["dimension"];
    readonly formation_kind: MemoryEntry["formation_kind"];
    readonly created_at: string;
  }): {
    readonly decay_profile: MemoryEntry["decay_profile"];
    readonly confidence: number;
    readonly retention_score: number;
    readonly retention_state: MemoryEntry["retention_state"];
    readonly activation_score: number;
    readonly manifestation_state: NonNullable<MemoryEntry["manifestation_state"]>;
    readonly reinforcement_count: number;
    readonly contradiction_count: number;
  };
}

// invariant: synchronous enrich_pending writer for the atomic create+enqueue
// path. The enqueue runs INSIDE the memory-row create transaction, so it must be
// synchronous (better-sqlite3 commits on return). memory_id + workspace_id come
// from the freshly created row; run_id + source_signal_id from the create input.
// Core depends on a storage abstraction here exactly as it does on
// memoryEntryRepo — the daemon wires it to SqliteEnrichPendingRepo.enqueue.
// see also: packages/storage/src/repos/enrich-pending-repo.ts enqueue
export interface MemoryServiceEnrichPendingWriterPort {
  enqueue(params: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }): void;
}

export interface MemoryServiceGreenPort {
  reevaluate(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
  }): Promise<unknown>;
  pierce?(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly reason: typeof RevokeReason.MAPPING_REVOKED;
    readonly runId?: string;
  }): Promise<unknown>;
}

export interface MemoryServiceDependencies {
  readonly memoryEntryRepo: MemoryServiceMemoryEntryRepoPort;
  readonly evidenceService: MemoryServiceEvidenceServicePort;
  readonly eventLogRepo: MemoryServiceEventLogRepoPort;
  readonly runtimeNotifier: MemoryRuntimeNotifier;
  readonly dynamicsService?: MemoryServiceDynamicsPort;
  readonly greenService?: MemoryServiceGreenPort;
  // invariant (B1): the delete authority re-verifies a `compressed` member's
  // preserving capsule at delete time. Optional so narrow test fakes that never
  // exercise the compressed branch need not wire it — but a `compressed`
  // tombstone whose capsule cannot be re-verified is REFUSED rather than
  // silently deleted (fail-closed), so an absent port can never cause loss.
  readonly synthesisCapsuleLookup?: MemoryServiceSynthesisCapsuleLookupPort;
  // invariant: when wired alongside memoryEntryRepo.createWithinTransaction, a
  // create whose input carries `enqueueEnrichment` commits the row + the
  // enrich_pending marker atomically. Absent, an enqueueEnrichment intent throws
  // (no silent no-drop violation) rather than dropping the marker.
  readonly enrichPendingWriter?: MemoryServiceEnrichPendingWriterPort;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

export class MemoryService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: MemoryServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async create(input: MemoryEntryInput): Promise<Readonly<MemoryEntry>> {
    const timestamp = this.now();
    const dynamics =
      this.dependencies.dynamicsService?.assignInitialDynamics({
        dimension: input.dimension,
        formation_kind: input.formation_kind,
        created_at: timestamp
      }) ?? {
        activation_score: null,
        retention_score: null,
        manifestation_state: null,
        retention_state: null,
        decay_profile: null,
        confidence: null,
        reinforcement_count: null,
        contradiction_count: null
      };
    const memoryEntry = parseMemoryEntry({
      ...input,
      object_id: this.generateObjectId(),
      object_kind: "memory_entry",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp,
      storage_tier: parseStorageTier(input.storage_tier ?? StorageTier.HOT),
      activation_score: dynamics.activation_score,
      retention_score: dynamics.retention_score,
      manifestation_state: dynamics.manifestation_state,
      retention_state: dynamics.retention_state,
      decay_profile: dynamics.decay_profile,
      confidence: dynamics.confidence,
      last_used_at: null,
      last_hit_at: null,
      reinforcement_count: dynamics.reinforcement_count,
      contradiction_count: dynamics.contradiction_count,
      superseded_by: null
    });

    await this.validateEvidenceRefs(memoryEntry.evidence_refs);
    const eventInput = {
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_CREATED,
      entity_type: "memory_entry",
      entity_id: memoryEntry.object_id,
      workspace_id: memoryEntry.workspace_id,
      run_id: memoryEntry.run_id,
      caused_by: memoryEntry.created_by,
      payload_json: SoulMemoryCreatedPayloadSchema.parse({
        object_id: memoryEntry.object_id,
        object_kind: memoryEntry.object_kind,
        workspace_id: memoryEntry.workspace_id,
        run_id: memoryEntry.run_id
      })
    } satisfies Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

    const { created, event } = await this.createRowMaybeAtomicallyEnqueued(
      memoryEntry,
      input.enqueueEnrichment,
      eventInput
    );
    await this.dependencies.runtimeNotifier.notifyEntry(event);

    if (
      created.evidence_refs.length > 0 &&
      (created.dimension === MemoryDimension.PREFERENCE || created.dimension === MemoryDimension.EPISODE)
    ) {
      void this.dependencies.greenService
        ?.reevaluate({
          targetObjectId: created.object_id,
          workspaceId: created.workspace_id
        })
        .catch(() => undefined);
    }

    return created;
  }

  // invariant: atomic audit + create + enrich_pending no-drop marker. When the
  // storage transaction seam is available (production SQLite), the
  // soul.memory.created event, memory row, and optional enrich_pending marker
  // commit in ONE transaction and in EventLog-first order. A create failure
  // rolls back the audit row; an audit/enqueue failure leaves no marker-less or
  // audit-less memory row. The plain async fallback exists only for minimal test
  // fakes that do not advertise the transaction seam.
  // see also: packages/soul/src/garden/materialization-router.ts enqueueEnrichment
  // see also: packages/core/src/signal-service.ts terminal-FAILED on success!=true
  private async createRowMaybeAtomicallyEnqueued(
    memoryEntry: Readonly<MemoryEntry>,
    enqueueEnrichment: MemoryEntryInput["enqueueEnrichment"],
    createdEventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): Promise<{
    readonly created: Readonly<MemoryEntry>;
    readonly event: EventLogEntry;
  }> {
    const createWithinTransaction = this.dependencies.memoryEntryRepo.createWithinTransaction;
    if (createWithinTransaction !== undefined) {
      const enrichPendingWriter = this.dependencies.enrichPendingWriter;
      if (enqueueEnrichment !== undefined && enrichPendingWriter === undefined) {
        throw new CoreError(
          "CONFLICT",
          "Atomic enrich_pending enqueue requested but the enrich-pending writer is not wired."
        );
      }

      let event: EventLogEntry | undefined;
      const created = createWithinTransaction.call(this.dependencies.memoryEntryRepo, memoryEntry, {
        beforeCreate: () => {
          event = this.appendCreatedEventSynchronously(createdEventInput);
        },
        afterCreate: () => {
          if (enqueueEnrichment !== undefined) {
            enrichPendingWriter?.enqueue({
              workspaceId: memoryEntry.workspace_id,
              memoryId: memoryEntry.object_id,
              runId: enqueueEnrichment.runId,
              sourceSignalId: enqueueEnrichment.sourceSignalId
            });
          }
        }
      });

      if (event === undefined) {
        throw new CoreError("CONFLICT", "Memory create transaction did not append its audit event.");
      }

      return { created, event };
    }

    if (enqueueEnrichment !== undefined) {
      throw new CoreError(
        "CONFLICT",
        "Atomic enrich_pending enqueue requested but the storage transaction port is not wired."
      );
    }

    const event = await this.dependencies.eventLogRepo.append(createdEventInput);
    const created = await this.dependencies.memoryEntryRepo.create(memoryEntry);
    return { created, event };
  }

  private appendCreatedEventSynchronously(
    eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): EventLogEntry {
    const event = this.dependencies.eventLogRepo.append(eventInput);
    if (isPromiseLike(event)) {
      throw new CoreError(
        "CONFLICT",
        "Memory create transaction requires a synchronous EventLog append port."
      );
    }
    return event;
  }

  public async update(
    objectId: string,
    fields: MemoryEntryUpdateFields,
    reason: string
  ): Promise<Readonly<MemoryEntry>> {
    return await this.updateInternal({ objectId, fields, reason });
  }

  public async updateScoped(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryUpdateFields,
    reason: string
  ): Promise<Readonly<MemoryEntry>> {
    return await this.updateInternal({ objectId, workspaceId, fields, reason });
  }

  public async validateUpdate(
    objectId: string,
    fields: MemoryEntryUpdateFields
  ): Promise<void> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedFields = parseUpdateFields(fields);

    if (parsedFields.evidence_refs !== undefined) {
      await this.validateEvidenceRefs(parsedFields.evidence_refs);
    }

    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);
    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.lifecycle_state === "archived") {
      throw new CoreError("VALIDATION", "Memory entry is archived and cannot be updated");
    }
  }

  public async archive(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.lifecycle_state === "archived") {
      throw new CoreError("VALIDATION", "Memory entry is already archived");
    }

    const occurredAt = this.now();
    const transitionPayload = {
      object_id: existing.object_id,
      object_kind: existing.object_kind,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      from_state: existing.lifecycle_state,
      to_state: "archived",
      reason_code: parsedReason,
      caused_by: parsedCausedBy,
      evidence_refs: null,
      occurred_at: occurredAt
    } as const;
    const archivedEvent = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_ARCHIVED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryArchivedPayloadSchema.parse(transitionPayload)
    });

    const stateChangedEvent = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse(transitionPayload)
    });

    const archived = await this.dependencies.memoryEntryRepo.archive(parsedObjectId, occurredAt);
    await this.dependencies.runtimeNotifier.notifyEntry(archivedEvent);
    await this.dependencies.runtimeNotifier.notifyEntry(stateChangedEvent);
    return archived;
  }

  public async transitionLifecycle(
    objectId: string,
    nextState: MemoryEntry["lifecycle_state"],
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedNextState = parseLifecycleState(nextState);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    ensureAllowedLifecycleTransition(existing.lifecycle_state, parsedNextState);

    if (parsedNextState === "archived") {
      return await this.archive(parsedObjectId, parsedReason, parsedCausedBy);
    }

    const transitionLifecycle = this.dependencies.memoryEntryRepo.transitionLifecycle;
    if (transitionLifecycle === undefined) {
      throw new CoreError("CONFLICT", "Memory lifecycle transition port is not available");
    }

    const occurredAt = this.now();
    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.lifecycle_state,
        to_state: parsedNextState,
        reason_code: parsedReason,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    });

    const updated = await transitionLifecycle(parsedObjectId, parsedNextState, occurredAt);

    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return updated;
  }

  /**
   * Audited, race-tolerant autonomous active -> dormant demotion (the Janitor
   * dormant-demotion sweep). The candidate snapshot can go stale before a
   * candidate's turn (concurrent revival / overlapping sweep / Inspector retire),
   * so this never throws on the benign "no longer active" race: it resolves
   * `{ status: "skipped" }` and the batch continues. A row that actually
   * transitions gets its SOUL_MEMORY_STATE_CHANGED active->dormant audit appended
   * ATOMICALLY with the guarded UPDATE (audit + UPDATE in one transaction); a
   * 0-row guarded UPDATE rolls back so no spurious audit is written. A genuine
   * storage error still rejects.
   *
   * see also: apps/core-daemon/src/index.ts auditedDormantDemotionPort
   * see also: packages/soul/src/garden/janitor.ts executeDormantDemotion
   */
  public async demoteActiveToDormantIfActive(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<{ readonly status: "demoted"; readonly entry: Readonly<MemoryEntry> } | { readonly status: "skipped" }> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    const transitionToDormantIfActive = this.dependencies.memoryEntryRepo.transitionToDormantIfActive;
    if (transitionToDormantIfActive === undefined) {
      throw new CoreError("CONFLICT", "Guarded active->dormant demotion port is not available");
    }

    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);
    // The row left existence entirely (e.g. autonomously deleted) between the
    // candidate snapshot and this turn: a benign race for the demotion sweep.
    if (existing === null) {
      return { status: "skipped" };
    }
    if (existing.lifecycle_state !== "active") {
      return { status: "skipped" };
    }

    const occurredAt = this.now();
    const eventInput = {
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: "active",
        to_state: "dormant",
        reason_code: parsedReason,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    } satisfies Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

    // invariant: the audit append is the onTransition callback, so it commits
    // INSIDE the guarded-UPDATE transaction (EventLog-first audit atomic with the
    // demotion). A 0-row guarded UPDATE (row no longer active) fires no callback
    // and resolves null, so no spurious audit is written and the caller skips.
    let event: EventLogEntry | undefined;
    const demoted = await transitionToDormantIfActive(parsedObjectId, occurredAt, () => {
      event = this.appendAuditEventSynchronously(eventInput);
    });
    if (demoted === null) {
      return { status: "skipped" };
    }
    if (event === undefined) {
      throw new CoreError("CONFLICT", "Active->dormant demotion transaction did not append its audit event.");
    }
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return { status: "demoted", entry: demoted };
  }

  public async hardDeleteTombstoned(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<void> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.retention_state !== "tombstoned") {
      throw new CoreError("VALIDATION", "Only tombstoned memories can be hard-deleted");
    }

    const hardDeleteTombstoned = this.dependencies.memoryEntryRepo.hardDeleteTombstoned;
    if (hardDeleteTombstoned === undefined) {
      throw new CoreError("CONFLICT", "Memory tombstone delete port is not available");
    }

    const occurredAt = this.now();
    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.lifecycle_state,
        to_state: "deleted",
        reason_code: parsedReason,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: occurredAt
      })
    });

    await hardDeleteTombstoned(parsedObjectId);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
  }

  /**
   * GATED autonomous tombstone (R3d): move a DORMANT memory to tombstoned with a
   * durable forget_disposition marker, audited via SOUL_MEMORY_STATE_CHANGED.
   *
   * SAFE-BY-CONSTRUCTION: the caller (the Garden disposition sweep) has already
   * verified the disposition — `compressed` means content is preserved in a live
   * capsule that references this member (dispositionRef = capsule id);
   * `judged_useless` means the mechanical importance gate cleared it. This method
   * re-asserts the precondition shape (compressed requires a ref, judged_useless
   * forbids one) and refuses to terminalize anything but a dormant row (the repo
   * UPDATE is guarded on lifecycle_state='dormant'). A null/absent disposition is
   * impossible to pass here.
   */
  public async autonomousTombstone(
    objectId: string,
    disposition: NonNullable<MemoryEntry["forget_disposition"]>,
    dispositionRef: string | null,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    if (disposition === "compressed" && (dispositionRef === null || dispositionRef.trim().length === 0)) {
      throw new CoreError("VALIDATION", "compressed disposition requires a live synthesis-capsule ref");
    }
    if (disposition === "judged_useless" && dispositionRef !== null) {
      throw new CoreError("VALIDATION", "judged_useless disposition must not carry a disposition ref");
    }

    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);
    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }
    if (existing.lifecycle_state !== "dormant") {
      throw new CoreError(
        "VALIDATION",
        "Only a dormant memory may be autonomously tombstoned"
      );
    }

    const autonomousTombstone = this.dependencies.memoryEntryRepo.autonomousTombstone;
    if (autonomousTombstone === undefined) {
      throw new CoreError("CONFLICT", "Autonomous tombstone port is not available");
    }

    const occurredAt = this.now();
    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.lifecycle_state,
        to_state: "tombstone",
        // reason_code carries the disposition + caller rationale so the durable
        // EventLog row records WHY the autonomous tombstone was permitted.
        reason_code: `forget_disposition=${disposition}: ${parsedReason}`,
        caused_by: parsedCausedBy,
        evidence_refs: dispositionRef === null ? null : [dispositionRef],
        occurred_at: occurredAt
      })
    });

    const updated = await autonomousTombstone({
      objectId: parsedObjectId,
      disposition,
      dispositionRef,
      updatedAt: occurredAt
    });
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return updated;
  }

  /**
   * GATED autonomous physical removal (R3d, defense in depth): physically remove
   * a tombstoned + past-grace row ONLY when it carries a non-null disposition.
   * The repo restates the disposition gate in SQL; this method also re-asserts it
   * on the loaded row so a no-disposition tombstone (e.g. human Inspector retire)
   * can never be auto-GC'd. The human/legacy path stays on hardDeleteTombstoned.
   *
   * invariant: returns `true` only when the row was physically deleted; returns
   * `false` on the B1 preservation_revoked fail-closed refuse path (row stays
   * tombstoned). Callers count actually-deleted rows by this signal.
   */
  public async autonomousHardDeleteTombstoned(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<boolean> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);
    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }
    if (existing.retention_state !== "tombstoned") {
      throw new CoreError("VALIDATION", "Only tombstoned memories can be hard-deleted");
    }
    if (existing.forget_disposition === null || existing.forget_disposition === undefined) {
      throw new CoreError(
        "VALIDATION",
        "Autonomous hard-delete refused: tombstoned row carries no forget disposition"
      );
    }

    const isCompressed = existing.forget_disposition === "compressed";

    // invariant (delete-time TOCTOU re-verify): a `compressed` member earned its
    // terminal-removal right ONLY because a live capsule preserved its content.
    // That right is re-checked HERE (T0+>=24h), not just at marking time (T0). If
    // the capsule archived / tombstoned / dropped this member / was
    // cascade-deleted during the grace window, the preservation is gone, so
    // physical deletion would be permanent loss. This pre-check fails fast with a
    // precise reason; the physical delete below is ALSO guarded atomically so a
    // capsule mutation racing between this check and the delete cannot leak.
    // see also: apps/core-daemon/src/forget-disposition-ports.ts isCapsuleLive.
    if (isCompressed) {
      const preserved = await this.compressedPreservationStillValid(existing);
      if (!preserved) {
        await this.emitPreservationRevoked(existing, parsedReason, parsedCausedBy);
        return false;
      }
    }

    const hardDeleteWithDisposition = this.dependencies.memoryEntryRepo.hardDeleteTombstonedWithDisposition;
    if (hardDeleteWithDisposition === undefined) {
      throw new CoreError("CONFLICT", "Disposition-gated tombstone delete port is not available");
    }

    // invariant: a `compressed` member's physical delete restates capsule
    // liveness + membership INSIDE the DELETE (requireLiveCapsuleRef), so the
    // preservation re-check is atomic with the removal — no TOCTOU window. The
    // guarded delete runs FIRST so a capsule revocation that raced past the
    // fast pre-check (0 rows changed) is recorded as preservation_revoked
    // instead of a spurious "deleted" audit. The judged_useless path has no
    // capsule dependency and keeps strict EventLog-first (append -> delete).
    if (isCompressed) {
      // invariant: the to_state=deleted audit append is the onDeleted callback,
      // so it commits INSIDE the guarded-delete transaction (a crash cannot leave
      // the row gone with no durable audit) and is skipped on a 0-row
      // preservation-revoked race (no spurious "deleted" audit). The append joins
      // the open SQLite txn synchronously, so a sync EventLog port is required.
      const deleteEventInput = this.buildAutonomousDeleteEventInput(existing, parsedReason, parsedCausedBy);
      let deletedEvent: EventLogEntry | undefined;
      const deleted = await hardDeleteWithDisposition(parsedObjectId, {
        requireLiveCapsuleRef: true,
        onDeleted: () => {
          deletedEvent = this.appendAuditEventSynchronously(deleteEventInput);
        }
      });
      if (!deleted) {
        await this.emitPreservationRevoked(existing, parsedReason, parsedCausedBy);
        return false;
      }
      if (deletedEvent === undefined) {
        throw new CoreError("CONFLICT", "Compressed tombstone delete transaction did not append its audit event.");
      }
      await this.dependencies.runtimeNotifier.notifyEntry(deletedEvent);
      return true;
    }

    const event = await this.appendAutonomousDeleteEvent(existing, parsedReason, parsedCausedBy);
    await hardDeleteWithDisposition(parsedObjectId);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return true;
  }

  // invariant: the audited terminal-removal record (to_state=deleted). reason_code
  // carries the disposition + caller rationale so the durable EventLog row records
  // WHY the autonomous physical delete was permitted.
  private buildAutonomousDeleteEventInput(
    existing: Readonly<MemoryEntry>,
    parsedReason: string,
    parsedCausedBy: TransitionCausedBy
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return {
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        from_state: existing.lifecycle_state,
        to_state: "deleted",
        reason_code: `forget_disposition=${existing.forget_disposition}: ${parsedReason}`,
        caused_by: parsedCausedBy,
        evidence_refs: null,
        occurred_at: this.now()
      })
    };
  }

  private async appendAutonomousDeleteEvent(
    existing: Readonly<MemoryEntry>,
    parsedReason: string,
    parsedCausedBy: TransitionCausedBy
  ): Promise<EventLogEntry> {
    return await this.dependencies.eventLogRepo.append(
      this.buildAutonomousDeleteEventInput(existing, parsedReason, parsedCausedBy)
    );
  }

  // invariant: synchronous EventLog append for the audit-inside-transaction seams
  // (compressed delete onDeleted, active->dormant onTransition). eventLogRepo.append
  // joins the open SQLite txn (inTransaction) when called from a transaction
  // callback; a Promise-returning port cannot, so reject it loudly rather than
  // silently committing the storage mutation without an atomic audit.
  private appendAuditEventSynchronously(
    eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): EventLogEntry {
    const event = this.dependencies.eventLogRepo.append(eventInput);
    if (isPromiseLike(event)) {
      throw new CoreError(
        "CONFLICT",
        "Autonomous audit-inside-transaction requires a synchronous EventLog append port."
      );
    }
    return event;
  }

  // invariant (delete-time fail-closed): a `compressed` member whose preserving
  // capsule no longer preserves it (archived / tombstoned / member dropped /
  // cascade-deleted) is NOT physically removed. The row stays tombstoned
  // (recoverable) and this audited skip event records the revocation. Emitted
  // both by the fast pre-check and by the atomic guarded delete returning 0 rows.
  private async emitPreservationRevoked(
    existing: Readonly<MemoryEntry>,
    parsedReason: string,
    parsedCausedBy: TransitionCausedBy
  ): Promise<void> {
    const skipEvent = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedCausedBy,
      payload_json: SoulMemoryStateChangedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        // The row is NOT deleted: tombstone -> tombstone, preservation_revoked.
        from_state: existing.lifecycle_state,
        to_state: existing.lifecycle_state,
        reason_code: `preservation_revoked: compressed capsule ${
          existing.forget_disposition_ref ?? "<null>"
        } no longer preserves this member; physical delete refused: ${parsedReason}`,
        caused_by: parsedCausedBy,
        evidence_refs:
          existing.forget_disposition_ref === null ||
          existing.forget_disposition_ref === undefined
            ? null
            : [existing.forget_disposition_ref],
        occurred_at: this.now()
      })
    });
    await this.dependencies.runtimeNotifier.notifyEntry(skipEvent);
  }

  // invariant (B1): re-verify that a `compressed` member is STILL preserved by a
  // live capsule that STILL references it, at delete time. Fail-closed: a null
  // ref, an unwired capsule-lookup port, a missing/archived/tombstoned capsule,
  // or a capsule that no longer lists this member all return false -> the caller
  // REFUSES the physical delete. Mirrors the marking-time liveness + membership
  // check in forget-disposition-ports.ts (isCapsuleLive + source_memory_refs).
  private async compressedPreservationStillValid(
    existing: Readonly<MemoryEntry>
  ): Promise<boolean> {
    const ref = existing.forget_disposition_ref;
    if (ref === null || ref === undefined) {
      return false;
    }
    const capsuleLookup = this.dependencies.synthesisCapsuleLookup;
    if (capsuleLookup === undefined) {
      return false;
    }
    const capsule = await capsuleLookup.findById(ref);
    if (capsule === null) {
      return false;
    }
    const isLive =
      capsule.lifecycle_state !== "tombstone" && capsule.synthesis_status !== "archived";
    if (!isLive) {
      return false;
    }
    return capsule.source_memory_refs.includes(existing.object_id);
  }

  public findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
    return this.dependencies.memoryEntryRepo.findById(objectId);
  }

  /**
   * Workspace-scoped lookup. Per invariants §29 (Default Scope) + §30
   * (Fix at Source), MCP/CLI surfaces MUST use this method instead of
   * `findById` so cross-workspace leaks cannot recur at any handler
   * boundary.
   * Returns null when the object exists in a different workspace —
   * indistinguishable from "not found", which is the intended privacy
   * surface.
   */
  public async findByIdScoped(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<MemoryEntry> | null> {
    const entry = await this.dependencies.memoryEntryRepo.findById(objectId);
    if (entry === null || entry.workspace_id !== workspaceId) {
      return null;
    }
    return entry;
  }

  public findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByWorkspaceId(workspaceId);
  }

  public findByRunId(runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByRunId(runId);
  }

  public findByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByDimension(workspaceId, dimension);
  }

  public findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.dependencies.memoryEntryRepo.findByScopeClass(workspaceId, scopeClass);
  }

  public validateFactualPolicyBoundary(entry: MemoryEntry, condition: FactualPolicyCondition): boolean {
    const parsedEntry = parseMemoryEntry(entry);
    const parsedCondition = parseFactualPolicyCondition(condition);

    if (parsedEntry.dimension !== MemoryDimension.FACT) {
      return false;
    }

    return (
      parsedCondition.affects_execution_paths ||
      parsedCondition.affects_tool_choices ||
      parsedCondition.affects_write_permissions ||
      parsedCondition.affects_governance_decisions
    );
  }

  private async updateInternal(input: {
    readonly objectId: string;
    readonly workspaceId?: string;
    readonly fields: MemoryEntryUpdateFields;
    readonly reason: string;
  }): Promise<Readonly<MemoryEntry>> {
    const parsedObjectId = parseObjectId(input.objectId);
    const parsedWorkspaceId =
      input.workspaceId === undefined ? undefined : parseNonEmptyString(input.workspaceId, "workspaceId");
    const parsedReason = parseReason(input.reason);
    const parsedFields = parseUpdateFields(input.fields);

    if (parsedFields.evidence_refs !== undefined) {
      await this.validateEvidenceRefs(parsedFields.evidence_refs);
    }

    const existing = await this.dependencies.memoryEntryRepo.findById(parsedObjectId);

    if (existing === null || (parsedWorkspaceId !== undefined && existing.workspace_id !== parsedWorkspaceId)) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    if (existing.lifecycle_state === "archived") {
      throw new CoreError("VALIDATION", "Memory entry is archived and cannot be updated");
    }

    const updatedFields = toUpdatedFieldNames(parsedFields);
    const occurredAt = this.now();

    // The repo write and the audit append are not transactional. Append
    // SOUL_MEMORY_UPDATED only after the repo write succeeds, so a failed
    // write never leaves an EventLog row asserting a rewrite that did not
    // happen.
    const repoFields = {
      ...parsedFields,
      updated_at: occurredAt
    };
    const updated =
      parsedWorkspaceId === undefined
        ? await this.dependencies.memoryEntryRepo.update(parsedObjectId, repoFields)
        : await this.updateRepoScoped(parsedObjectId, parsedWorkspaceId, repoFields);

    const event = await this.dependencies.eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
      entity_type: "memory_entry",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: existing.run_id,
      caused_by: parsedReason,
      payload_json: SoulMemoryUpdatedPayloadSchema.parse({
        object_id: existing.object_id,
        object_kind: existing.object_kind,
        workspace_id: existing.workspace_id,
        run_id: existing.run_id,
        updated_fields: updatedFields
      })
    });

    await this.dependencies.runtimeNotifier.notifyEntry(event);
    if (
      parsedFields.evidence_refs !== undefined &&
      shouldRevokeGreenForEvidenceRewrite(existing.evidence_refs, parsedFields.evidence_refs)
    ) {
      await this.dependencies.greenService?.pierce?.({
        targetObjectId: existing.object_id,
        workspaceId: existing.workspace_id,
        reason: RevokeReason.MAPPING_REVOKED,
        runId: existing.run_id
      });
    }
    return updated;
  }

  private async updateRepoScoped(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>> {
    if (this.dependencies.memoryEntryRepo.updateScoped === undefined) {
      throw new CoreError("VALIDATION", "Scoped memory update is not available");
    }

    return await this.dependencies.memoryEntryRepo.updateScoped(objectId, workspaceId, fields);
  }

  private async validateEvidenceRefs(evidenceRefs: readonly string[]): Promise<void> {
    const results = await Promise.all(
      evidenceRefs.map(async (evidenceRef) => ({
        evidenceRef,
        evidence: await this.dependencies.evidenceService.findById(evidenceRef)
      }))
    );

    const firstMissing = results.find((result) => result.evidence === null);

    if (firstMissing !== undefined) {
      throw new CoreError("VALIDATION", `Evidence reference not found: ${firstMissing.evidenceRef}`);
    }
  }
}

function parseMemoryEntry(value: MemoryEntry): MemoryEntry {
  try {
    return MemoryEntrySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid memory entry payload", { cause: error });
  }
}

function parseFactualPolicyCondition(condition: FactualPolicyCondition): FactualPolicyCondition {
  try {
    return FactualPolicyConditionSchema.parse(condition);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid factual policy condition", { cause: error });
  }
}

function parseStorageTier(value: MemoryEntry["storage_tier"]): MemoryEntry["storage_tier"] {
  try {
    return StorageTierSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid storage tier", { cause: error });
  }
}

function parseLifecycleState(value: MemoryEntry["lifecycle_state"]): MemoryEntry["lifecycle_state"] {
  try {
    return ObjectLifecycleStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid lifecycle state", { cause: error });
  }
}

function parseReason(value: string): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", "Reason is required");
  }

  return value;
}

function parseTransitionCausedBy(value: TransitionCausedBy): TransitionCausedBy {
  try {
    return TransitionCausedBySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid transition caused_by", { cause: error });
  }
}

function parseUpdateFields(fields: MemoryEntryUpdateFields): MemoryEntryUpdateFields {
  const parsed: MemoryEntryUpdateFields = {
    content: fields.content,
    domain_tags: fields.domain_tags,
    evidence_refs: fields.evidence_refs,
    storage_tier: fields.storage_tier,
    last_used_at: fields.last_used_at,
    last_hit_at: fields.last_hit_at
  };

  if (
    parsed.content === undefined &&
    parsed.domain_tags === undefined &&
    parsed.evidence_refs === undefined &&
    parsed.storage_tier === undefined &&
    parsed.last_used_at === undefined &&
    parsed.last_hit_at === undefined
  ) {
    throw new CoreError("VALIDATION", "At least one field is required for update");
  }

  if (parsed.content !== undefined && parsed.content.trim().length === 0) {
    throw new CoreError("VALIDATION", "Memory content cannot be empty");
  }

  if (parsed.domain_tags !== undefined) {
    assertStringArray(parsed.domain_tags, "domain_tags");
  }

  if (parsed.evidence_refs !== undefined) {
    assertStringArray(parsed.evidence_refs, "evidence_refs");
  }

  const parsedStorageTier =
    parsed.storage_tier === undefined ? undefined : parseStorageTier(parsed.storage_tier);
  const parsedLastUsedAt =
    parsed.last_used_at === undefined ? undefined : parseIsoDatetime(parsed.last_used_at);
  const parsedLastHitAt =
    parsed.last_hit_at === undefined ? undefined : parseIsoDatetime(parsed.last_hit_at);

  return {
    ...parsed,
    storage_tier: parsedStorageTier,
    last_used_at: parsedLastUsedAt,
    last_hit_at: parsedLastHitAt
  };
}

function shouldRevokeGreenForEvidenceRewrite(
  previousEvidenceRefs: readonly string[],
  nextEvidenceRefs: readonly string[]
): boolean {
  if (previousEvidenceRefs.length === 0) {
    return false;
  }
  const next = new Set(nextEvidenceRefs);
  return !previousEvidenceRefs.some((ref) => next.has(ref));
}

function parseIsoDatetime(value: string): string {
  try {
    return IsoDatetimeStringSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid timestamp", { cause: error });
  }
}

function assertStringArray(value: readonly string[], field: "domain_tags" | "evidence_refs"): void {
  for (const item of value) {
    if (item.trim().length === 0) {
      throw new CoreError("VALIDATION", `${field} cannot contain empty items`);
    }
  }
}

function toUpdatedFieldNames(fields: MemoryEntryUpdateFields): string[] {
  const updatedFields: string[] = [];

  if (fields.content !== undefined) {
    updatedFields.push("content");
  }
  if (fields.domain_tags !== undefined) {
    updatedFields.push("domain_tags");
  }
  if (fields.evidence_refs !== undefined) {
    updatedFields.push("evidence_refs");
  }
  if (fields.storage_tier !== undefined) {
    updatedFields.push("storage_tier");
  }
  if (fields.last_used_at !== undefined) {
    updatedFields.push("last_used_at");
  }
  if (fields.last_hit_at !== undefined) {
    updatedFields.push("last_hit_at");
  }

  return updatedFields;
}

function ensureAllowedLifecycleTransition(
  from: MemoryEntry["lifecycle_state"],
  to: MemoryEntry["lifecycle_state"]
): void {
  if (!isValidLifecycleTransition(from, to)) {
    throw new CoreError("VALIDATION", `Invalid memory lifecycle transition: ${from} -> ${to}`);
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return value instanceof Promise || typeof (value as { readonly then?: unknown })?.then === "function";
}
