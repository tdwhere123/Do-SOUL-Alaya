import { randomUUID } from "node:crypto";
import {
  MemoryDimension,
  type FactualPolicyCondition,
  type MemoryEntry,
  type ScopeClass,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import type {
  MemoryEntryInput,
  MemoryEntryUpdateFields,
  MemoryListPageOptions,
  MemoryServiceDependencies
} from "./types.js";
import { parseFactualPolicyCondition, parseMemoryEntry } from "./validators.js";
import { MemoryAutonomousForget } from "./memory-autonomous-forget.js";
import { MemoryLifecycleManager } from "./memory-lifecycle-manager.js";
import { MemoryQueryService } from "./memory-query-service.js";
import { MemoryWriteService } from "./memory-write-service.js";

export class MemoryService {
  private readonly write: MemoryWriteService;
  private readonly lifecycle: MemoryLifecycleManager;
  private readonly autonomousForget: MemoryAutonomousForget;
  private readonly query: MemoryQueryService;

  public constructor(dependencies: MemoryServiceDependencies) {
    const generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    const now = dependencies.now ?? (() => new Date().toISOString());
    this.write = new MemoryWriteService({
      memoryEntryRepo: dependencies.memoryEntryRepo,
      evidenceService: dependencies.evidenceService,
      eventLogRepo: dependencies.eventLogRepo,
      runtimeNotifier: dependencies.runtimeNotifier,
      dynamicsService: dependencies.dynamicsService,
      greenService: dependencies.greenService,
      enrichPendingWriter: dependencies.enrichPendingWriter,
      generateObjectId,
      now
    });
    this.lifecycle = new MemoryLifecycleManager({
      memoryEntryRepo: dependencies.memoryEntryRepo,
      eventLogRepo: dependencies.eventLogRepo,
      runtimeNotifier: dependencies.runtimeNotifier,
      now
    });
    this.autonomousForget = new MemoryAutonomousForget({
      memoryEntryRepo: dependencies.memoryEntryRepo,
      eventLogRepo: dependencies.eventLogRepo,
      runtimeNotifier: dependencies.runtimeNotifier,
      synthesisCapsuleLookup: dependencies.synthesisCapsuleLookup,
      now
    });
    this.query = new MemoryQueryService({ memoryEntryRepo: dependencies.memoryEntryRepo });
  }

  public create(input: MemoryEntryInput): Promise<Readonly<MemoryEntry>> {
    return this.write.create(input);
  }

  public update(
    objectId: string,
    fields: MemoryEntryUpdateFields,
    reason: string
  ): Promise<Readonly<MemoryEntry>> {
    return this.write.update(objectId, fields, reason);
  }

  public updateScoped(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryUpdateFields,
    reason: string
  ): Promise<Readonly<MemoryEntry>> {
    return this.write.updateScoped(objectId, workspaceId, fields, reason);
  }

  public validateUpdate(objectId: string, fields: MemoryEntryUpdateFields): Promise<void> {
    return this.write.validateUpdate(objectId, fields);
  }

  public archive(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>> {
    return this.lifecycle.archive(objectId, reason, causedBy);
  }

  public transitionLifecycle(
    objectId: string,
    nextState: MemoryEntry["lifecycle_state"],
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>> {
    return this.lifecycle.transitionLifecycle(objectId, nextState, reason, causedBy);
  }

  public demoteActiveToDormantIfActive(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<{ readonly status: "demoted"; readonly entry: Readonly<MemoryEntry> } | { readonly status: "skipped" }> {
    return this.lifecycle.demoteActiveToDormantIfActive(objectId, reason, causedBy);
  }

  public hardDeleteTombstoned(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<void> {
    return this.lifecycle.hardDeleteTombstoned(objectId, reason, causedBy);
  }

  public autonomousTombstone(
    objectId: string,
    disposition: NonNullable<MemoryEntry["forget_disposition"]>,
    dispositionRef: string | null,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<Readonly<MemoryEntry>> {
    return this.autonomousForget.autonomousTombstone(objectId, disposition, dispositionRef, reason, causedBy);
  }

  public autonomousHardDeleteTombstoned(
    objectId: string,
    reason: string,
    causedBy: TransitionCausedBy
  ): Promise<boolean> {
    return this.autonomousForget.autonomousHardDeleteTombstoned(objectId, reason, causedBy);
  }

  public findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
    return this.query.findById(objectId);
  }

  public findByIdScoped(objectId: string, workspaceId: string): Promise<Readonly<MemoryEntry> | null> {
    return this.query.findByIdScoped(objectId, workspaceId);
  }

  public findByIdsScoped(
    objectIds: readonly string[],
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByIdsScoped(objectIds, workspaceId);
  }

  public findByWorkspaceId(
    workspaceId: string,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByWorkspaceId(workspaceId, page);
  }

  public findByWorkspaceIdAll(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByWorkspaceIdAll(workspaceId);
  }

  public countByWorkspaceId(workspaceId: string): Promise<number> {
    return this.query.countByWorkspaceId(workspaceId);
  }

  public findByRunId(
    runId: string,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByRunId(runId, page);
  }

  public findByRunIdAll(runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByRunIdAll(runId);
  }

  public countByRunId(runId: string): Promise<number> {
    return this.query.countByRunId(runId);
  }

  public findByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"],
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByDimension(workspaceId, dimension, page);
  }

  public findByDimensionAll(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByDimensionAll(workspaceId, dimension);
  }

  public countByDimension(workspaceId: string, dimension: MemoryEntry["dimension"]): Promise<number> {
    return this.query.countByDimension(workspaceId, dimension);
  }

  public findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByScopeClass(workspaceId, scopeClass, page);
  }

  public findByScopeClassAll(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByScopeClassAll(workspaceId, scopeClass);
  }

  public countByScopeClass(workspaceId: string, scopeClass: ScopeClass): Promise<number> {
    return this.query.countByScopeClass(workspaceId, scopeClass);
  }

  public findByWorkspaceIdWithConflict(
    workspaceId: string,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByWorkspaceIdWithConflict(workspaceId, page);
  }

  public countByWorkspaceIdWithConflict(workspaceId: string): Promise<number> {
    return this.query.countByWorkspaceIdWithConflict(workspaceId);
  }

  public findByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryEntry["dimension"],
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByDimensionWithConflict(workspaceId, dimension, page);
  }

  public countByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<number> {
    return this.query.countByDimensionWithConflict(workspaceId, dimension);
  }

  public findByScopeClassWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByScopeClassWithConflict(workspaceId, scopeClass, page);
  }

  public countByScopeClassWithConflict(workspaceId: string, scopeClass: ScopeClass): Promise<number> {
    return this.query.countByScopeClassWithConflict(workspaceId, scopeClass);
  }

  public findByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryEntry["dimension"],
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return this.query.findByScopeClassAndDimensionWithConflict(workspaceId, scopeClass, dimension, page);
  }

  public countByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryEntry["dimension"]
  ): Promise<number> {
    return this.query.countByScopeClassAndDimensionWithConflict(workspaceId, scopeClass, dimension);
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
}
