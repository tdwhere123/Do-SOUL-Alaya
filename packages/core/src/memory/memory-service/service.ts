import { randomUUID } from "node:crypto";
import {
  type EventLogEntry,
  type FactualPolicyCondition,
  type MemoryEntry,
  type ScopeClass,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type {
  MemoryEntryInput,
  MemoryEntryRepoUpdateFields,
  MemoryEntryUpdateFields,
  MemoryListPageOptions,
  MemoryServiceDependencies
} from "./types.js";

import { memoryServiceCreate, memoryServiceCreateRowMaybeAtomicallyEnqueued, memoryServiceAppendCreatedEventSynchronously, memoryServiceUpdate, memoryServiceUpdateScoped, memoryServiceValidateUpdate, memoryServiceArchive, memoryServiceTransitionLifecycle, memoryServiceDemoteActiveToDormantIfActive, memoryServiceHardDeleteTombstoned } from "./service-methods-1.js";
import { memoryServiceAutonomousTombstone, memoryServiceClassifyAutonomousTombstoneRepoRefusal, memoryServiceAutonomousHardDeleteTombstoned, memoryServiceBuildAutonomousDeleteEventInput, memoryServiceAppendAuditEventSynchronously, memoryServiceEmitPreservationRevoked, memoryServiceEmitVerdictRevoked, memoryServiceCompressedPreservationStillValid, memoryServiceFindById, memoryServiceFindByIdScoped, memoryServiceFindByIdsScoped, memoryServiceFindByWorkspaceId, memoryServiceFindByWorkspaceIdAll, memoryServiceCountByWorkspaceId, memoryServiceFindByRunId, memoryServiceFindByRunIdAll, memoryServiceCountByRunId, memoryServiceFindByDimension } from "./service-methods-2.js";
import { memoryServiceFindByDimensionAll, memoryServiceCountByDimension, memoryServiceFindByScopeClass, memoryServiceFindByScopeClassAll, memoryServiceValidateFactualPolicyBoundary, memoryServiceUpdateInternal, memoryServiceUpdateRepoScoped, memoryServiceValidateEvidenceRefs } from "./service-methods-3.js";

const MEMORY_SERVICE_SCAN_PAGE_LIMIT = 500;

export class MemoryService {
public readonly generateObjectId: () => string;

public readonly now: () => string;

public constructor(public readonly dependencies: MemoryServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async create(input: MemoryEntryInput): Promise<Readonly<MemoryEntry>> {
    return memoryServiceCreate(this, input);
  }

  private async createRowMaybeAtomicallyEnqueued(memoryEntry: Readonly<MemoryEntry>, enqueueEnrichment: MemoryEntryInput["enqueueEnrichment"], createdEventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<{
    readonly created: Readonly<MemoryEntry>;
    readonly event: EventLogEntry;
  }> {
    return memoryServiceCreateRowMaybeAtomicallyEnqueued(this, memoryEntry, enqueueEnrichment, createdEventInput);
  }

  private appendCreatedEventSynchronously(eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry {
    return memoryServiceAppendCreatedEventSynchronously(this, eventInput);
  }

  public async update(objectId: string, fields: MemoryEntryUpdateFields, reason: string): Promise<Readonly<MemoryEntry>> {
    return memoryServiceUpdate(this, objectId, fields, reason);
  }

  public async updateScoped(objectId: string, workspaceId: string, fields: MemoryEntryUpdateFields, reason: string): Promise<Readonly<MemoryEntry>> {
    return memoryServiceUpdateScoped(this, objectId, workspaceId, fields, reason);
  }

  public async validateUpdate(objectId: string, fields: MemoryEntryUpdateFields): Promise<void> {
    return memoryServiceValidateUpdate(this, objectId, fields);
  }

  public async archive(objectId: string, reason: string, causedBy: TransitionCausedBy): Promise<Readonly<MemoryEntry>> {
    return memoryServiceArchive(this, objectId, reason, causedBy);
  }

  public async transitionLifecycle(objectId: string, nextState: MemoryEntry["lifecycle_state"], reason: string, causedBy: TransitionCausedBy): Promise<Readonly<MemoryEntry>> {
    return memoryServiceTransitionLifecycle(this, objectId, nextState, reason, causedBy);
  }

  public async demoteActiveToDormantIfActive(objectId: string, reason: string, causedBy: TransitionCausedBy): Promise<{ readonly status: "demoted"; readonly entry: Readonly<MemoryEntry> } | { readonly status: "skipped" }> {
    return memoryServiceDemoteActiveToDormantIfActive(this, objectId, reason, causedBy);
  }

  public async hardDeleteTombstoned(objectId: string, reason: string, causedBy: TransitionCausedBy): Promise<void> {
    return memoryServiceHardDeleteTombstoned(this, objectId, reason, causedBy);
  }

  public async autonomousTombstone(objectId: string, disposition: NonNullable<MemoryEntry["forget_disposition"]>, dispositionRef: string | null, reason: string, causedBy: TransitionCausedBy): Promise<Readonly<MemoryEntry>> {
    return memoryServiceAutonomousTombstone(this, objectId, disposition, dispositionRef, reason, causedBy);
  }

  private async classifyAutonomousTombstoneRepoRefusal(objectId: string, error: unknown): Promise<CoreError | null> {
    return memoryServiceClassifyAutonomousTombstoneRepoRefusal(this, objectId, error);
  }

  public async autonomousHardDeleteTombstoned(objectId: string, reason: string, causedBy: TransitionCausedBy): Promise<boolean> {
    return memoryServiceAutonomousHardDeleteTombstoned(this, objectId, reason, causedBy);
  }

  private buildAutonomousDeleteEventInput(existing: Readonly<MemoryEntry>, parsedReason: string, parsedCausedBy: TransitionCausedBy): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return memoryServiceBuildAutonomousDeleteEventInput(this, existing, parsedReason, parsedCausedBy);
  }

  private appendAuditEventSynchronously(eventInput: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry {
    return memoryServiceAppendAuditEventSynchronously(this, eventInput);
  }

  private async emitPreservationRevoked(existing: Readonly<MemoryEntry>, parsedReason: string, parsedCausedBy: TransitionCausedBy): Promise<void> {
    return memoryServiceEmitPreservationRevoked(this, existing, parsedReason, parsedCausedBy);
  }

  private async emitVerdictRevoked(existing: Readonly<MemoryEntry>, parsedReason: string, parsedCausedBy: TransitionCausedBy): Promise<void> {
    return memoryServiceEmitVerdictRevoked(this, existing, parsedReason, parsedCausedBy);
  }

  private async compressedPreservationStillValid(existing: Readonly<MemoryEntry>): Promise<boolean> {
    return memoryServiceCompressedPreservationStillValid(this, existing);
  }

  public findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
    return memoryServiceFindById(this, objectId);
  }

  public async findByIdScoped(objectId: string, workspaceId: string): Promise<Readonly<MemoryEntry> | null> {
    return memoryServiceFindByIdScoped(this, objectId, workspaceId);
  }

  public async findByIdsScoped(objectIds: readonly string[], workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return memoryServiceFindByIdsScoped(this, objectIds, workspaceId);
  }

  public findByWorkspaceId(workspaceId: string, page?: MemoryListPageOptions): Promise<readonly Readonly<MemoryEntry>[]> {
    return memoryServiceFindByWorkspaceId(this, workspaceId, page);
  }

  public async findByWorkspaceIdAll(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return memoryServiceFindByWorkspaceIdAll(this, workspaceId);
  }

  public async countByWorkspaceId(workspaceId: string): Promise<number> {
    return memoryServiceCountByWorkspaceId(this, workspaceId);
  }

  public findByRunId(runId: string, page?: MemoryListPageOptions): Promise<readonly Readonly<MemoryEntry>[]> {
    return memoryServiceFindByRunId(this, runId, page);
  }

  public async findByRunIdAll(runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return memoryServiceFindByRunIdAll(this, runId);
  }

  public async countByRunId(runId: string): Promise<number> {
    return memoryServiceCountByRunId(this, runId);
  }

  public findByDimension(workspaceId: string, dimension: MemoryEntry["dimension"], page?: MemoryListPageOptions): Promise<readonly Readonly<MemoryEntry>[]> {
    return memoryServiceFindByDimension(this, workspaceId, dimension, page);
  }

  public async findByDimensionAll(workspaceId: string, dimension: MemoryEntry["dimension"]): Promise<readonly Readonly<MemoryEntry>[]> {
    return memoryServiceFindByDimensionAll(this, workspaceId, dimension);
  }

  public async countByDimension(workspaceId: string, dimension: MemoryEntry["dimension"]): Promise<number> {
    return memoryServiceCountByDimension(this, workspaceId, dimension);
  }

  public findByScopeClass(workspaceId: string, scopeClass: ScopeClass, page?: MemoryListPageOptions): Promise<readonly Readonly<MemoryEntry>[]> {
    return memoryServiceFindByScopeClass(this, workspaceId, scopeClass, page);
  }

  public async findByScopeClassAll(workspaceId: string, scopeClass: ScopeClass): Promise<readonly Readonly<MemoryEntry>[]> {
    return memoryServiceFindByScopeClassAll(this, workspaceId, scopeClass);
  }

  public validateFactualPolicyBoundary(entry: MemoryEntry, condition: FactualPolicyCondition): boolean {
    return memoryServiceValidateFactualPolicyBoundary(this, entry, condition);
  }

  private async updateInternal(input: {
    readonly objectId: string;
    readonly workspaceId?: string;
    readonly fields: MemoryEntryUpdateFields;
    readonly reason: string;
  }): Promise<Readonly<MemoryEntry>> {
    return memoryServiceUpdateInternal(this, input);
  }

  private async updateRepoScoped(objectId: string, workspaceId: string, fields: MemoryEntryRepoUpdateFields): Promise<Readonly<MemoryEntry>> {
    return memoryServiceUpdateRepoScoped(this, objectId, workspaceId, fields);
  }

  private async validateEvidenceRefs(evidenceRefs: readonly string[]): Promise<void> {
    return memoryServiceValidateEvidenceRefs(this, evidenceRefs);
  }
}
