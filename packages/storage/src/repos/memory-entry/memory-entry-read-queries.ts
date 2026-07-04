import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseMemoryDimension, parseMemoryEntryRow, parseScopeClass, parseStorageTier, type MemoryEntryRow } from "./row-mapper.js";
import type { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { DynamicPreparedStatementCache } from "../../sqlite/dynamic-prepared-statement-cache.js";
import type { MemoryEntryStatements } from "./sqlite-memory-entry-statements.js";
import { MemoryEntryConflictReadQueries } from "./memory-entry-conflict-read-queries.js";
import { MemoryEntryDynamicReadQueries } from "./memory-entry-dynamic-read-queries.js";
import { DEFAULT_MEMORY_ENTRY_PAGE, parseMemoryEntryPage } from "./memory-entry-read-page.js";
import type { MemoryEntryListPageOptions, MemoryEntryRepoDiagnosticSink } from "./types.js";

interface CountRow {
  readonly total: number;
}

export class MemoryEntryReadQueries {
  private readonly conflictQueries: MemoryEntryConflictReadQueries;
  private readonly dynamicQueries: MemoryEntryDynamicReadQueries;

  public constructor(
    db: StorageDatabase,
    private readonly diagnostics: MemoryEntryRepoDiagnosticSink,
    private readonly statementHolder: RefreshableStatementHolder<MemoryEntryStatements>
  ) {
    this.conflictQueries = new MemoryEntryConflictReadQueries(() => this.statements);
    const dynamicStatementCache = new DynamicPreparedStatementCache(db, () => this.ensureActiveConnection());
    this.dynamicQueries = new MemoryEntryDynamicReadQueries(dynamicStatementCache, this.diagnostics);
  }

  private get statements(): MemoryEntryStatements {
    return this.statementHolder.active();
  }

  private ensureActiveConnection(): void {
    this.statementHolder.active();
  }

  public async findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
    return this.findByIdSync(objectId);
  }

  // invariant (§7): synchronous read shared with the async wrapper so the karma
  // transition can re-read the mutated row inside a single EventLog transaction.
  public findByIdSync(objectId: string): Readonly<MemoryEntry> | null {
    try {
      const row = this.statements.findByIdStatement.get(objectId) as MemoryEntryRow | undefined;
      return row === undefined ? null : parseMemoryEntryRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load memory entry ${objectId}.`, error);
    }
  }

  public async findByIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.dynamicQueries.findByIds(workspaceId, objectIds);
  }

  public async findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedPage = parseMemoryEntryPage(page ?? DEFAULT_MEMORY_ENTRY_PAGE);

    try {
      const parsedTier = tier === undefined ? undefined : parseStorageTier(tier);
      const rows =
        parsedTier === undefined || parsedTier === StorageTier.HOT
          ? (this.statements.findByWorkspaceHotPagedStatement.all(workspaceId, parsedPage.limit, parsedPage.offset) as MemoryEntryRow[])
          : (this.statements.findByWorkspaceTierPagedStatement.all(
              workspaceId,
              parsedTier,
              parsedPage.limit,
              parsedPage.offset
            ) as MemoryEntryRow[]);
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByWorkspaceIdAll(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const parsedTier = tier === undefined ? undefined : parseStorageTier(tier);
      const rows =
        parsedTier === undefined || parsedTier === StorageTier.HOT
          ? (this.statements.findByWorkspaceHotStatement.all(workspaceId) as MemoryEntryRow[])
          : (this.statements.findByWorkspaceTierStatement.all(workspaceId, parsedTier) as MemoryEntryRow[]);
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list all memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async countByWorkspaceId(workspaceId: string, tier?: StorageTier): Promise<number> {
    try {
      const parsedTier = tier === undefined ? undefined : parseStorageTier(tier);
      const row =
        parsedTier === undefined || parsedTier === StorageTier.HOT
          ? (this.statements.countByWorkspaceHotStatement.get(workspaceId) as CountRow | undefined)
          : (this.statements.countByWorkspaceTierStatement.get(workspaceId, parsedTier) as CountRow | undefined);
      return readCount(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  // Run-scoped reads intentionally include both hot and cold tiers.
  public async findByRunId(
    runId: string,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedPage = parseMemoryEntryPage(page ?? DEFAULT_MEMORY_ENTRY_PAGE);

    try {
      const rows = this.statements.findByRunIdPagedStatement.all(
        runId,
        parsedPage.limit,
        parsedPage.offset
      ) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list memory entries for run ${runId}.`, error);
    }
  }

  public async findByRunIdAll(runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.statements.findByRunIdStatement.all(runId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list all memory entries for run ${runId}.`, error);
    }
  }

  public async countByRunId(runId: string): Promise<number> {
    try {
      const row = this.statements.countByRunIdStatement.get(runId) as CountRow | undefined;
      return readCount(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to count memory entries for run ${runId}.`, error);
    }
  }

  public async findByDimension(
    workspaceId: string,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedDimension = parseMemoryDimension(dimension);
    const parsedPage = parseMemoryEntryPage(page ?? DEFAULT_MEMORY_ENTRY_PAGE);

    try {
      const rows = this.statements.findByDimensionHotPagedStatement.all(
        workspaceId,
        parsedDimension,
        parsedPage.limit,
        parsedPage.offset
      ) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory entries for workspace ${workspaceId} and dimension ${parsedDimension}.`,
        error
      );
    }
  }

  public async findByDimensionAll(
    workspaceId: string,
    dimension: MemoryDimension
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedDimension = parseMemoryDimension(dimension);

    try {
      const rows = this.statements.findByDimensionHotStatement.all(workspaceId, parsedDimension) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list all memory entries for workspace ${workspaceId} and dimension ${parsedDimension}.`,
        error
      );
    }
  }

  public async countByDimension(workspaceId: string, dimension: MemoryDimension): Promise<number> {
    const parsedDimension = parseMemoryDimension(dimension);

    try {
      const row = this.statements.countByDimensionHotStatement.get(workspaceId, parsedDimension) as CountRow | undefined;
      return readCount(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count memory entries for workspace ${workspaceId} and dimension ${parsedDimension}.`,
        error
      );
    }
  }

  public async findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedScopeClass = parseScopeClass(scopeClass);
    const parsedPage = parseMemoryEntryPage(page ?? DEFAULT_MEMORY_ENTRY_PAGE);

    try {
      const rows = this.statements.findByScopeClassHotPagedStatement.all(
        workspaceId,
        parsedScopeClass,
        parsedPage.limit,
        parsedPage.offset
      ) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory entries for workspace ${workspaceId} and scope class ${parsedScopeClass}.`,
        error
      );
    }
  }

  public async findByScopeClassAll(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedScopeClass = parseScopeClass(scopeClass);

    try {
      const rows = this.statements.findByScopeClassHotStatement.all(workspaceId, parsedScopeClass) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list all memory entries for workspace ${workspaceId} and scope class ${parsedScopeClass}.`,
        error
      );
    }
  }

  public async findByWorkspaceIdWithConflict(
    workspaceId: string,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.conflictQueries.findByWorkspaceIdWithConflict(workspaceId, page);
  }

  public async countByWorkspaceIdWithConflict(workspaceId: string): Promise<number> {
    return await this.conflictQueries.countByWorkspaceIdWithConflict(workspaceId);
  }

  public async findByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.conflictQueries.findByDimensionWithConflict(workspaceId, dimension, page);
  }

  public async countByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryDimension
  ): Promise<number> {
    return await this.conflictQueries.countByDimensionWithConflict(workspaceId, dimension);
  }

  public async findByScopeClassWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.conflictQueries.findByScopeClassWithConflict(workspaceId, scopeClass, page);
  }

  public async countByScopeClassWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<number> {
    return await this.conflictQueries.countByScopeClassWithConflict(workspaceId, scopeClass);
  }

  public async findByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.conflictQueries.findByScopeClassAndDimensionWithConflict(
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
    return await this.conflictQueries.countByScopeClassAndDimensionWithConflict(
      workspaceId,
      scopeClass,
      dimension
    );
  }

  public async findBySharedDomainTags(
    workspaceId: string,
    tags: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.dynamicQueries.findBySharedDomainTags(workspaceId, tags);
  }

  public async findByEvidenceRefs(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    return await this.dynamicQueries.findByEvidenceRefs(workspaceId, evidenceObjectIds);
  }

  public async findLowActivityActiveMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.statements.findLowActivityActiveMemoriesStatement.all(workspaceId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find low-activity active memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findTombstonedMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.statements.findTombstonedMemoriesStatement.all(workspaceId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find tombstoned memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findDormantMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.statements.findDormantMemoriesStatement.all(workspaceId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find dormant memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findTombstonedMemoriesWithDisposition(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.statements.findTombstonedWithDispositionStatement.all(workspaceId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find tombstoned-with-disposition memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

}

function readCount(row: CountRow | undefined): number {
  return row === undefined ? 0 : Number(row.total);
}
