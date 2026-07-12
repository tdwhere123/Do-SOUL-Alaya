import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import {
  createMemoryEntry,
  createMemoryEntryWithinTransaction,
  type MemoryEntryCreateWorkflowHost
} from "./create-workflow.js";
import type { MemoryEntryEvidenceRefIndexHost } from "./evidence-ref-index.js";
import {
  autonomousTombstone,
  archiveMemoryEntry,
  hardDeleteTombstonedMemoryEntry,
  hardDeleteTombstonedWithDisposition,
  reviveDormantMemoryEntry,
  reviveDormantMemoryEntrySync,
  transitionMemoryEntryLifecycle,
  transitionMemoryEntryLifecycleSync,
  transitionMemoryEntryToDormantIfActive,
  type MemoryEntryLifecycleWorkflowHost
} from "./lifecycle-workflows.js";
import {
  searchByAnchorWithinObjectIds,
  searchByKeyword,
  searchByKeywordWithinObjectIds,
  type MemoryEntrySearchWorkflowHost
} from "./search-workflows.js";
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
  updateMemoryEntryDynamicsSync,
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

// invariant: workflow-host contracts are implemented directly so statement
// getters stay type-checked at the repo boundary instead of cast through unknown.
export class SqliteMemoryEntryRepo
  extends MemoryEntryReadQueries
  implements
    MemoryEntryRepo,
    MemoryEntryCreateWorkflowHost,
    MemoryEntryEvidenceRefIndexHost,
    MemoryEntrySearchWorkflowHost,
    MemoryEntryLifecycleWorkflowHost,
    MemoryEntryUpdateWorkflowHost
{
  private readonly workflowStatementHolder: RefreshableStatementHolder<
    ReturnType<typeof prepareMemoryEntryStatements>
  >;
  public get createStatement() {
    return this.workflowStatementHolder.active().createStatement;
  }
  public get deleteEvidenceRefsByMemoryStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().deleteEvidenceRefsByMemoryStatement;
  }
  public get insertEvidenceRefStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().insertEvidenceRefStatement;
  }
  public get findByIdStatement(): SqliteGetStatement {
    return this.workflowStatementHolder.active().findByIdStatement;
  }
  public get updateStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().updateStatement;
  }
  public get updateScopedStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().updateScopedStatement;
  }
  public get searchByKeywordStatement(): SqliteAllStatement {
    return this.workflowStatementHolder.active().searchByKeywordStatement;
  }
  // see also: packages/storage/src/migrations/077-memory-content-fts-dual.sql
  public get searchByKeywordPorterStatement(): SqliteAllStatement {
    return this.workflowStatementHolder.active().searchByKeywordPorterStatement;
  }
  public get transitionLifecycleStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().transitionLifecycleStatement;
  }
  // invariant: a revived / non-tombstone transition clears the terminal
  // forget marker so an active/dormant row never carries a removal disposition.
  public get transitionLifecycleClearForgetStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().transitionLifecycleClearForgetStatement;
  }
  // invariant (N1): guarded dormant -> active revival; changes=0 when not dormant.
  public get reviveDormantStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().reviveDormantStatement;
  }
  // invariant: active -> dormant skips benign changes=0 races and clears forget markers.
  public get demoteActiveToDormantStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().demoteActiveToDormantStatement;
  }
  public get archiveStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().archiveStatement;
  }
  public get hardDeleteTombstonedStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().hardDeleteTombstonedStatement;
  }
  public get autonomousTombstoneStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().autonomousTombstoneStatement;
  }
  public get hardDeleteTombstonedWithDispositionStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().hardDeleteTombstonedWithDispositionStatement;
  }
  // invariant: compressed delete rechecks capsule liveness atomically with removal.
  public get hardDeleteTombstonedCompressedGuardedStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().hardDeleteTombstonedCompressedGuardedStatement;
  }
  // invariant: judged_useless delete replays the local-only verdict at delete time.
  public get hardDeleteTombstonedJudgedUselessGuardedStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().hardDeleteTombstonedJudgedUselessGuardedStatement;
  }
  // invariant: hard-delete prunes path topology because endpoints are not FK-backed.
  public get deleteOrphanedPathRelationsStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().deleteOrphanedPathRelationsStatement;
  }
  public get deleteOrphanedCoUsageCountersStatement(): SqliteRunStatement {
    return this.workflowStatementHolder.active().deleteOrphanedCoUsageCountersStatement;
  }
  public constructor(
    public readonly db: StorageDatabase,
    diagnostics: MemoryEntryRepoDiagnosticSink = () => {}
  ) {
    const workflowStatementHolder = new RefreshableStatementHolder(db, prepareMemoryEntryStatements);
    super(db, diagnostics, workflowStatementHolder);
    this.workflowStatementHolder = workflowStatementHolder;
  }

  public transaction<T>(fn: () => T, options: { readonly immediate?: boolean } = {}): T {
    const txn = this.activeConnection().transaction(fn);
    return options.immediate === true ? txn.immediate() : txn();
  }

  public async create(entry: MemoryEntry): Promise<Readonly<MemoryEntry>> {
    return createMemoryEntry.call(this, entry);
  }

  public createWithinTransaction(
    entry: MemoryEntry,
    callbacks: {
      readonly beforeCreate?: () => void;
      readonly afterCreate?: () => void;
    }
  ): Readonly<MemoryEntry> {
    return createMemoryEntryWithinTransaction.call(this, entry, callbacks);
  }

  private activeConnection(): StorageDatabase["connection"] {
    this.db.reopenIfClosed();
    return this.db.connection;
  }

  // wiring-time identity of the backing connection for the atomic-karma guard.
  public getStorageConnectionIdentity(): StorageDatabase {
    return this.db;
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

  public updateDynamicsSync(
    objectId: string,
    fields: MemoryEntryRepoDynamicsUpdateFields,
    updatedAt: string
  ): Readonly<MemoryEntry> {
    return updateMemoryEntryDynamicsSync.call(this, objectId, fields, updatedAt);
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

  public reviveDormantSync(objectId: string, updatedAt: string): Readonly<MemoryEntry> | null {
    return reviveDormantMemoryEntrySync.call(this, objectId, updatedAt);
  }

  public transitionLifecycleSync(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string,
    onTransition?: () => void
  ): Readonly<MemoryEntry> {
    return transitionMemoryEntryLifecycleSync.call(this, objectId, lifecycleState, updatedAt, onTransition);
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
