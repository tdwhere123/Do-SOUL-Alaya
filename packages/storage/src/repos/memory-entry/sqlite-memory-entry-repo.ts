import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
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
  searchByKeyword,
  searchByKeywordWithinObjectIds,
  type MemoryEntrySearchWorkflowHost
} from "./search-workflows.js";
import {
  parseMemoryEntry} from "./row-mapper.js";
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
// the workflows read through `this` are exposed as `public readonly` rather than
// bridged with an `as unknown as` cast. Consumers still depend on MemoryEntryRepo,
// which does not surface these statements.
export class SqliteMemoryEntryRepo
  implements
    MemoryEntryRepo,
    MemoryEntrySearchWorkflowHost,
    MemoryEntryLifecycleWorkflowHost,
    MemoryEntryUpdateWorkflowHost
{
  private readonly createStatement;
  // Public host-contract members are annotated with the narrow statement aliases
  // (not the unnameable BetterSqlite3.Statement) so the declaration emit stays
  // self-contained and each field matches its workflow-host requirement exactly.
  public readonly findByIdStatement: SqliteGetStatement;
  public readonly updateStatement: SqliteRunStatement;
  public readonly updateScopedStatement: SqliteRunStatement;
  public readonly searchByKeywordStatement: SqliteAllStatement;
  // see also: packages/storage/src/migrations/077-memory-content-fts-dual.sql
  public readonly searchByKeywordPorterStatement: SqliteAllStatement;
  public readonly transitionLifecycleStatement: SqliteRunStatement;
  // invariant (I3): a revived / non-tombstone transition clears the terminal
  // forget marker so an active/dormant row never carries a removal disposition.
  public readonly transitionLifecycleClearForgetStatement: SqliteRunStatement;
  // invariant (N1): guarded dormant -> active revival; changes=0 when not dormant.
  public readonly reviveDormantStatement: SqliteRunStatement;
  // invariant: active -> dormant skips benign changes=0 races and clears forget markers.
  public readonly demoteActiveToDormantStatement: SqliteRunStatement;
  public readonly archiveStatement: SqliteRunStatement;
  public readonly hardDeleteTombstonedStatement: SqliteRunStatement;
  public readonly autonomousTombstoneStatement: SqliteRunStatement;
  public readonly hardDeleteTombstonedWithDispositionStatement: SqliteRunStatement;
  // invariant: compressed delete rechecks capsule liveness atomically with removal.
  public readonly hardDeleteTombstonedCompressedGuardedStatement: SqliteRunStatement;
  // invariant: judged_useless delete replays the local-only verdict at delete time.
  public readonly hardDeleteTombstonedJudgedUselessGuardedStatement: SqliteRunStatement;
  // invariant: hard-delete prunes path topology because endpoints are not FK-backed.
  public readonly deleteOrphanedPathRelationsStatement: SqliteRunStatement;
  public readonly deleteOrphanedCoUsageCountersStatement: SqliteRunStatement;
  private readonly readQueries: MemoryEntryReadQueries;

  public constructor(
    public readonly db: StorageDatabase,
    private readonly diagnostics: MemoryEntryRepoDiagnosticSink = () => {}
  ) {
    const statements = prepareMemoryEntryStatements(db);
    this.createStatement = statements.createStatement;
    this.findByIdStatement = statements.findByIdStatement;
    this.updateStatement = statements.updateStatement;
    this.updateScopedStatement = statements.updateScopedStatement;
    this.searchByKeywordStatement = statements.searchByKeywordStatement;
    this.searchByKeywordPorterStatement = statements.searchByKeywordPorterStatement;
    this.transitionLifecycleStatement = statements.transitionLifecycleStatement;
    this.transitionLifecycleClearForgetStatement = statements.transitionLifecycleClearForgetStatement;
    this.reviveDormantStatement = statements.reviveDormantStatement;
    this.demoteActiveToDormantStatement = statements.demoteActiveToDormantStatement;
    this.archiveStatement = statements.archiveStatement;
    this.hardDeleteTombstonedStatement = statements.hardDeleteTombstonedStatement;
    this.autonomousTombstoneStatement = statements.autonomousTombstoneStatement;
    this.hardDeleteTombstonedWithDispositionStatement = statements.hardDeleteTombstonedWithDispositionStatement;
    this.hardDeleteTombstonedCompressedGuardedStatement = statements.hardDeleteTombstonedCompressedGuardedStatement;
    this.hardDeleteTombstonedJudgedUselessGuardedStatement = statements.hardDeleteTombstonedJudgedUselessGuardedStatement;
    this.deleteOrphanedPathRelationsStatement = statements.deleteOrphanedPathRelationsStatement;
    this.deleteOrphanedCoUsageCountersStatement = statements.deleteOrphanedCoUsageCountersStatement;
    this.readQueries = new MemoryEntryReadQueries(db, this.diagnostics, statements);
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
      this.createStatement.run(
        parsedEntry.object_id,
        parsedEntry.object_kind,
        parsedEntry.schema_version,
        parsedEntry.lifecycle_state,
        parsedEntry.created_at,
        parsedEntry.updated_at,
        parsedEntry.created_by,
        parsedEntry.dimension,
        parsedEntry.source_kind,
        parsedEntry.formation_kind,
        parsedEntry.scope_class,
        parsedEntry.content,
        JSON.stringify(parsedEntry.domain_tags),
        JSON.stringify(parsedEntry.evidence_refs),
        parsedEntry.workspace_id,
        parsedEntry.run_id,
        parsedEntry.surface_id,
        parsedEntry.storage_tier,
        parsedEntry.activation_score,
        parsedEntry.retention_score,
        parsedEntry.manifestation_state,
        parsedEntry.retention_state,
        parsedEntry.decay_profile,
        parsedEntry.confidence,
        parsedEntry.last_used_at,
        parsedEntry.last_hit_at,
        parsedEntry.reinforcement_count,
        parsedEntry.contradiction_count,
        parsedEntry.superseded_by,
        parsedEntry.forget_disposition ?? null,
        parsedEntry.forget_disposition_ref ?? null
      );
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

  public async findByIds(objectIds: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.readQueries.findByIds(objectIds);
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
