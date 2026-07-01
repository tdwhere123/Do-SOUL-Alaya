import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { StorageError } from "../../shared/errors.js";
import {
  autonomousTombstone,
  archiveMemoryEntry,
  hardDeleteTombstonedMemoryEntry,
  hardDeleteTombstonedWithDisposition,
  reviveDormantMemoryEntry,
  transitionMemoryEntryLifecycle,
  transitionMemoryEntryToDormantIfActive,
  type MemoryEntryLifecycleWorkflowHost
} from "./lifecycle-workflows.js";
import {
  searchByAnchorWithinObjectIds,
  searchByKeyword,
  searchByKeywordWithinObjectIds,
  type MemoryEntrySearchWorkflowHost
} from "./search-workflows.js";
import {
  parseMemoryEntry} from "./row-mapper.js";
import { buildMemoryEntryCreateParams } from "./create-params.js";
import { MemoryEntryReadQueries } from "./memory-entry-read-queries.js";
import { prepareMemoryEntryStatements } from "./sqlite-memory-entry-statements.js";
import type {
  SqliteAllStatement,
  SqliteGetStatement,
  SqliteRunStatement
} from "./statement-types.js";
import {
  updateMemoryEntry,
  updateMemoryEntryDynamics,
  updateMemoryEntryTier,
  updateScopedMemoryEntry,
  type MemoryEntryUpdateWorkflowHost
} from "./update-workflows.js";
import {
  type AutonomousTombstoneInput,
  type MemoryEntryListPageOptions,
  type MemoryEntryKeywordSearchResult,
  type MemoryEntryRepo,
  type MemoryEntryRepoDiagnosticSink,
  type MemoryEntryRepoDynamicsUpdateFields,
  type MemoryEntryRepoTierUpdateInput,
  type MemoryEntryRepoUpdateFields
} from "./types.js";

// Implementing the three workflow-host interfaces makes the delegate calls below
// type-checked at the class boundary: if a host contract grows a member the repo
// lacks, this declaration stops compiling — which is why the prepared statements
// the workflows read through `this` are exposed as public getters rather than
// bridged with an `as unknown as` cast. Consumers still depend on MemoryEntryRepo,
// which does not surface these statements.
export class SqliteMemoryEntryRepo
  implements
    MemoryEntryRepo,
    MemoryEntrySearchWorkflowHost,
    MemoryEntryLifecycleWorkflowHost,
    MemoryEntryUpdateWorkflowHost
{
  private readonly statementHolder: RefreshableStatementHolder<
    ReturnType<typeof prepareMemoryEntryStatements>
  >;
  public get createStatement() {
    return this.statementHolder.active().createStatement;
  }
  public get findByIdStatement(): SqliteGetStatement {
    return this.statementHolder.active().findByIdStatement;
  }
  public get updateStatement(): SqliteRunStatement {
    return this.statementHolder.active().updateStatement;
  }
  public get updateScopedStatement(): SqliteRunStatement {
    return this.statementHolder.active().updateScopedStatement;
  }
  public get searchByKeywordStatement(): SqliteAllStatement {
    return this.statementHolder.active().searchByKeywordStatement;
  }
  // see also: packages/storage/src/migrations/077-memory-content-fts-dual.sql
  public get searchByKeywordPorterStatement(): SqliteAllStatement {
    return this.statementHolder.active().searchByKeywordPorterStatement;
  }
  public get transitionLifecycleStatement(): SqliteRunStatement {
    return this.statementHolder.active().transitionLifecycleStatement;
  }
  // invariant (I3): a revived / non-tombstone transition clears the terminal
  // forget marker so an active/dormant row never carries a removal disposition.
  public get transitionLifecycleClearForgetStatement(): SqliteRunStatement {
    return this.statementHolder.active().transitionLifecycleClearForgetStatement;
  }
  // invariant (N1): guarded dormant -> active revival; changes=0 when not dormant.
  public get reviveDormantStatement(): SqliteRunStatement {
    return this.statementHolder.active().reviveDormantStatement;
  }
  // invariant: active -> dormant skips benign changes=0 races and clears forget markers.
  public get demoteActiveToDormantStatement(): SqliteRunStatement {
    return this.statementHolder.active().demoteActiveToDormantStatement;
  }
  public get archiveStatement(): SqliteRunStatement {
    return this.statementHolder.active().archiveStatement;
  }
  public get hardDeleteTombstonedStatement(): SqliteRunStatement {
    return this.statementHolder.active().hardDeleteTombstonedStatement;
  }
  public get autonomousTombstoneStatement(): SqliteRunStatement {
    return this.statementHolder.active().autonomousTombstoneStatement;
  }
  public get hardDeleteTombstonedWithDispositionStatement(): SqliteRunStatement {
    return this.statementHolder.active().hardDeleteTombstonedWithDispositionStatement;
  }
  // invariant: compressed delete rechecks capsule liveness atomically with removal.
  public get hardDeleteTombstonedCompressedGuardedStatement(): SqliteRunStatement {
    return this.statementHolder.active().hardDeleteTombstonedCompressedGuardedStatement;
  }
  // invariant: judged_useless delete replays the local-only verdict at delete time.
  public get hardDeleteTombstonedJudgedUselessGuardedStatement(): SqliteRunStatement {
    return this.statementHolder.active().hardDeleteTombstonedJudgedUselessGuardedStatement;
  }
  // invariant: hard-delete prunes path topology because endpoints are not FK-backed.
  public get deleteOrphanedPathRelationsStatement(): SqliteRunStatement {
    return this.statementHolder.active().deleteOrphanedPathRelationsStatement;
  }
  public get deleteOrphanedCoUsageCountersStatement(): SqliteRunStatement {
    return this.statementHolder.active().deleteOrphanedCoUsageCountersStatement;
  }
  private readonly readQueries: MemoryEntryReadQueries;

  public constructor(
    public readonly db: StorageDatabase,
    private readonly diagnostics: MemoryEntryRepoDiagnosticSink = () => {}
  ) {
    this.statementHolder = new RefreshableStatementHolder(db, prepareMemoryEntryStatements);
    this.readQueries = new MemoryEntryReadQueries(db, this.diagnostics, this.statementHolder);
  }

  public async create(entry: MemoryEntry): Promise<Readonly<MemoryEntry>> {
    const parsedEntry = parseMemoryEntry(entry);
    this.runCreateStatement(parsedEntry);
    return parsedEntry;
  }

  public createWithinTransaction(
    entry: MemoryEntry,
    callbacks: {
      readonly beforeCreate?: () => void;
      readonly afterCreate?: () => void;
    }
  ): Readonly<MemoryEntry> {
    const parsedEntry = parseMemoryEntry(entry);
    const txn = this.db.connection.transaction(() => {
      callbacks.beforeCreate?.();
      this.runCreateStatement(parsedEntry);
      callbacks.afterCreate?.();
    });
    txn.immediate();
    return parsedEntry;
  }

  private runCreateStatement(parsedEntry: Readonly<MemoryEntry>): void {
    try {
      this.createStatement.run(...buildMemoryEntryCreateParams(parsedEntry));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create memory entry ${parsedEntry.object_id}.`,
        error
      );
    }
  }

  public async findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
    return await this.readQueries.findById(objectId);
  }

  public async findByIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByIds(workspaceId, objectIds);
  }

  public async findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByWorkspaceId(workspaceId, tier, page);
  }

  public async findByWorkspaceIdAll(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByWorkspaceIdAll(workspaceId, tier);
  }

  public async countByWorkspaceId(workspaceId: string, tier?: StorageTier): Promise<number> {
    return await this.readQueries.countByWorkspaceId(workspaceId, tier);
  }

  public async findByRunId(
    runId: string,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByRunId(runId, page);
  }

  public async findByRunIdAll(runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByRunIdAll(runId);
  }

  public async countByRunId(runId: string): Promise<number> {
    return await this.readQueries.countByRunId(runId);
  }

  public async findByDimension(
    workspaceId: string,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByDimension(workspaceId, dimension, page);
  }

  public async findByDimensionAll(
    workspaceId: string,
    dimension: MemoryDimension
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByDimensionAll(workspaceId, dimension);
  }

  public async countByDimension(workspaceId: string, dimension: MemoryDimension): Promise<number> {
    return await this.readQueries.countByDimension(workspaceId, dimension);
  }

  public async findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByScopeClass(workspaceId, scopeClass, page);
  }

  public async findByScopeClassAll(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByScopeClassAll(workspaceId, scopeClass);
  }

  public async findByWorkspaceIdWithConflict(
    workspaceId: string,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByWorkspaceIdWithConflict(workspaceId, page);
  }

  public async countByWorkspaceIdWithConflict(workspaceId: string): Promise<number> {
    return await this.readQueries.countByWorkspaceIdWithConflict(workspaceId);
  }

  public async findByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByDimensionWithConflict(workspaceId, dimension, page);
  }

  public async countByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryDimension
  ): Promise<number> {
    return await this.readQueries.countByDimensionWithConflict(workspaceId, dimension);
  }

  public async findByScopeClassWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByScopeClassWithConflict(workspaceId, scopeClass, page);
  }

  public async countByScopeClassWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<number> {
    return await this.readQueries.countByScopeClassWithConflict(workspaceId, scopeClass);
  }

  public async findByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByScopeClassAndDimensionWithConflict(
      workspaceId,
      scopeClass,
      dimension,
      page
    );
  }

  public async countByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryDimension
  ): Promise<number> {
    return await this.readQueries.countByScopeClassAndDimensionWithConflict(
      workspaceId,
      scopeClass,
      dimension
    );
  }

  public async findBySharedDomainTags(
    workspaceId: string,
    tags: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findBySharedDomainTags(workspaceId, tags);
  }

  public async findByEvidenceRefs(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByEvidenceRefs(workspaceId, evidenceObjectIds);
  }
  public async searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly MemoryEntryKeywordSearchResult[]> {
    return searchByKeyword.call(this, workspaceId, queryText, limit);
  }

  public async searchByKeywordWithinObjectIds(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly MemoryEntryKeywordSearchResult[]> {
    return searchByKeywordWithinObjectIds.call(
      this,
      workspaceId,
      queryText,
      limit,
      objectIds
    );
  }

  public async searchByAnchorWithinObjectIds(
    workspaceId: string,
    anchorTokens: readonly string[],
    optionalTokens: readonly string[],
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly MemoryEntryKeywordSearchResult[]> {
    return searchByAnchorWithinObjectIds.call(
      this,
      workspaceId,
      anchorTokens,
      optionalTokens,
      limit,
      objectIds
    );
  }

  public async findLowActivityActiveMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findLowActivityActiveMemories(workspaceId);
  }

  public async findTombstonedMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findTombstonedMemories(workspaceId);
  }

  public async findDormantMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findDormantMemories(workspaceId);
  }

  public async findTombstonedMemoriesWithDisposition(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findTombstonedMemoriesWithDisposition(workspaceId);
  }
  public async autonomousTombstone(
    input: AutonomousTombstoneInput,
    options?: { readonly onTransition?: () => void }
  ): Promise<Readonly<MemoryEntry>> {
    return autonomousTombstone.call(this, input, options);
  }

  public async hardDeleteTombstonedWithDisposition(
    objectId: string,
    options?: {
      readonly requireLiveCapsuleRef?: boolean;
      readonly requireJudgedUselessVerdict?: boolean;
      readonly onDeleted?: () => void;
    }
  ): Promise<boolean> {
    return hardDeleteTombstonedWithDisposition.call(
      this,
      objectId,
      options
    );
  }

  public async update(
    objectId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>> {
    return updateMemoryEntry.call(this, objectId, fields);
  }

  public async updateScoped(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>> {
    return updateScopedMemoryEntry.call(
      this,
      objectId,
      workspaceId,
      fields
    );
  }

  public updateTier(input: MemoryEntryRepoTierUpdateInput): Readonly<MemoryEntry> | null {
    return updateMemoryEntryTier.call(this, input);
  }

  public async archive(
    objectId: string,
    updatedAt: string,
    onArchived?: () => void
  ): Promise<Readonly<MemoryEntry>> {
    return archiveMemoryEntry.call(
      this,
      objectId,
      updatedAt,
      onArchived
    );
  }

  public async updateDynamics(
    objectId: string,
    fields: MemoryEntryRepoDynamicsUpdateFields,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>> {
    return updateMemoryEntryDynamics.call(
      this,
      objectId,
      fields,
      updatedAt
    );
  }

  public async transitionLifecycle(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry>> {
    return transitionMemoryEntryLifecycle.call(
      this,
      objectId,
      lifecycleState,
      updatedAt,
      onTransition
    );
  }

  public async reviveDormant(
    objectId: string,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry> | null> {
    return reviveDormantMemoryEntry.call(this, objectId, updatedAt);
  }

  public async transitionToDormantIfActive(
    objectId: string,
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry> | null> {
    return transitionMemoryEntryToDormantIfActive.call(
      this,
      objectId,
      updatedAt,
      onTransition
    );
  }

  public async hardDeleteTombstoned(objectId: string, onDeleted?: () => void): Promise<void> {
    return hardDeleteTombstonedMemoryEntry.call(this, objectId, onDeleted);
  }
}
