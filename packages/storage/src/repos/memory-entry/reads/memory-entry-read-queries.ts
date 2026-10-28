import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import { parseMemoryDimension, parseScopeClass, parseStorageTier } from "../mappers/row-mapper.js";
import { createPrivacyMemoryRowParser } from "./privacy-memory-row-parser.js";
import { requirePrivacyRowsAvailable, requirePrivacyRunMemoriesAvailable, requirePrivacyWorkspaceAvailable } from "../../field/privacy-availability.js";
import type { RefreshableStatementHolder } from "../../../sqlite/refreshable-statement-holder.js";
import { DynamicPreparedStatementCache } from "../../../sqlite/dynamic-prepared-statement-cache.js";
import type { MemoryEntryStatements } from "../statements/sqlite-memory-entry-statements.js";
import { MemoryEntryConflictReadQueries } from "./memory-entry-conflict-read-queries.js";
import { MemoryEntryDynamicReadQueries } from "./memory-entry-dynamic-read-queries.js";
import { DEFAULT_MEMORY_ENTRY_PAGE, parseMemoryEntryPage } from "./memory-entry-read-page.js";
import type { MemoryEntryListPageOptions, MemoryEntryRepoDiagnosticSink } from "../types.js";
import type {
  RecallEventTimeWindowQuery,
  RecallTierWindowQuery,
  RecallTierWindowResult
} from "../types.js";
import { findRecallTierWindow } from "./recall/recall-tier-window-query.js";
import { findByEventTimeWindow } from "./recall/event-time-window-query.js";
import { CountRowParser, parseOptionalRow, parseRows } from "../../shared/parse-row.js";

export class MemoryEntryReadQueries {
  private readonly conflictQueries: MemoryEntryConflictReadQueries;
  private readonly dynamicQueries: MemoryEntryDynamicReadQueries;
  private readonly memoryRowParser: ReturnType<typeof createPrivacyMemoryRowParser>;

  public constructor(
    private readonly privacyDatabase: StorageDatabase,
    private readonly diagnostics: MemoryEntryRepoDiagnosticSink,
    private readonly statementHolder: RefreshableStatementHolder<MemoryEntryStatements>
  ) {
    this.memoryRowParser = createPrivacyMemoryRowParser(privacyDatabase);
    this.conflictQueries = new MemoryEntryConflictReadQueries(() => this.statements, this.memoryRowParser);
    const dynamicStatementCache = new DynamicPreparedStatementCache(privacyDatabase, () => this.ensureActiveConnection());
    this.dynamicQueries = new MemoryEntryDynamicReadQueries(dynamicStatementCache, this.diagnostics, this.memoryRowParser, privacyDatabase);
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
      return parseOptionalRow(
        this.statements.findByIdStatement.get(objectId),
        this.memoryRowParser,
        "memory entry row"
      );
    } catch (error) {
      throw wrapMemoryEntryQueryError(`Failed to load memory entry ${objectId}.`, error);
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
      return parsedTier === undefined || parsedTier === StorageTier.HOT
        ? parseRows(
            this.statements.findByWorkspaceHotPagedStatement.all(workspaceId, parsedPage.limit, parsedPage.offset),
            this.memoryRowParser,
            "memory entry row"
          )
        : parseRows(
            this.statements.findByWorkspaceTierPagedStatement.all(
              workspaceId,
              parsedTier,
              parsedPage.limit,
              parsedPage.offset
            ),
            this.memoryRowParser,
            "memory entry row"
          );
    } catch (error) {
      throw wrapMemoryEntryQueryError(`Failed to list memory entries for workspace ${workspaceId}.`, error);
    }
  }

  public async findRecallTierWindow(
    query: RecallTierWindowQuery
  ): Promise<Readonly<RecallTierWindowResult>> {
    const result = findRecallTierWindow(this.statements, query);
    requirePrivacyRowsAvailable(this.privacyDatabase, "memory_entry", result.memories);
    return result;
  }

  public async findByEventTimeWindow(
    query: RecallEventTimeWindowQuery
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const result = findByEventTimeWindow(this.statements, query);
    requirePrivacyRowsAvailable(this.privacyDatabase, "memory_entry", result);
    return result;
  }

  public async findByWorkspaceIdAll(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const parsedTier = tier === undefined ? undefined : parseStorageTier(tier);
      return parsedTier === undefined || parsedTier === StorageTier.HOT
        ? parseRows(
            this.statements.findByWorkspaceHotStatement.all(workspaceId),
            this.memoryRowParser,
            "memory entry row"
          )
        : parseRows(
            this.statements.findByWorkspaceTierStatement.all(workspaceId, parsedTier),
            this.memoryRowParser,
            "memory entry row"
          );
    } catch (error) {
      throw wrapMemoryEntryQueryError(
        `Failed to list all memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async countByWorkspaceId(workspaceId: string, tier?: StorageTier): Promise<number> {
    requirePrivacyWorkspaceAvailable(this.privacyDatabase, workspaceId, ["memory_entry"]);
    try {
      const parsedTier = tier === undefined ? undefined : parseStorageTier(tier);
      const row =
        parsedTier === undefined || parsedTier === StorageTier.HOT
          ? parseOptionalRow(
              this.statements.countByWorkspaceHotStatement.get(workspaceId),
              CountRowParser,
              "memory entry count row"
            )
          : parseOptionalRow(
              this.statements.countByWorkspaceTierStatement.get(workspaceId, parsedTier),
              CountRowParser,
              "memory entry count row"
            );
      return row?.total ?? 0;
    } catch (error) {
      throw wrapMemoryEntryQueryError(
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
      return parseRows(
        this.statements.findByRunIdPagedStatement.all(runId, parsedPage.limit, parsedPage.offset),
        this.memoryRowParser,
        "memory entry row"
      );
    } catch (error) {
      throw wrapMemoryEntryQueryError(`Failed to list memory entries for run ${runId}.`, error);
    }
  }

  public async findByRunIdAll(runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      return parseRows(this.statements.findByRunIdStatement.all(runId), this.memoryRowParser, "memory entry row");
    } catch (error) {
      throw wrapMemoryEntryQueryError(`Failed to list all memory entries for run ${runId}.`, error);
    }
  }

  public async countByRunId(runId: string): Promise<number> {
    requirePrivacyRunMemoriesAvailable(this.privacyDatabase, runId);
    try {
      return parseOptionalRow(
        this.statements.countByRunIdStatement.get(runId),
        CountRowParser,
        "memory entry count row"
      )?.total ?? 0;
    } catch (error) {
      throw wrapMemoryEntryQueryError(`Failed to count memory entries for run ${runId}.`, error);
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
      return parseRows(
        this.statements.findByDimensionHotPagedStatement.all(
          workspaceId,
          parsedDimension,
          parsedPage.limit,
          parsedPage.offset
        ),
        this.memoryRowParser,
        "memory entry row"
      );
    } catch (error) {
      throw wrapMemoryEntryQueryError(
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
      return parseRows(
        this.statements.findByDimensionHotStatement.all(workspaceId, parsedDimension),
        this.memoryRowParser,
        "memory entry row"
      );
    } catch (error) {
      throw wrapMemoryEntryQueryError(
        `Failed to list all memory entries for workspace ${workspaceId} and dimension ${parsedDimension}.`,
        error
      );
    }
  }

  public async countByDimension(workspaceId: string, dimension: MemoryDimension): Promise<number> {
    requirePrivacyWorkspaceAvailable(this.privacyDatabase, workspaceId, ["memory_entry"]);
    const parsedDimension = parseMemoryDimension(dimension);

    try {
      return parseOptionalRow(
        this.statements.countByDimensionHotStatement.get(workspaceId, parsedDimension),
        CountRowParser,
        "memory entry count row"
      )?.total ?? 0;
    } catch (error) {
      throw wrapMemoryEntryQueryError(
        `Failed to count memory entries for workspace ${workspaceId} and dimension ${parsedDimension}.`,
        error
      );
    }
  }

  public async findByScopeClassAndDimension(
    workspaceId: string, scopeClass: ScopeClass, dimension: MemoryDimension, page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedPage = parseMemoryEntryPage(page ?? DEFAULT_MEMORY_ENTRY_PAGE);
    const scope = parseScopeClass(scopeClass);
    const parsedDimension = parseMemoryDimension(dimension);
    try {
      return parseRows(this.statements.findByScopeClassAndDimensionHotPagedStatement.all(
        workspaceId, scope, parsedDimension, parsedPage.limit, parsedPage.offset
      ), this.memoryRowParser, "memory entry row");
    } catch (error) {
      throw wrapMemoryEntryQueryError("Failed to list memory entries by scope and dimension.", error);
    }
  }

  public async countByScopeClassAndDimension(
    workspaceId: string, scopeClass: ScopeClass, dimension: MemoryDimension
  ): Promise<number> {
    requirePrivacyWorkspaceAvailable(this.privacyDatabase, workspaceId, ["memory_entry"]);
    const scope = parseScopeClass(scopeClass);
    const parsedDimension = parseMemoryDimension(dimension);
    try {
      return parseOptionalRow(this.statements.countByScopeClassAndDimensionHotStatement.get(
        workspaceId, scope, parsedDimension
      ), CountRowParser, "memory entry count row")?.total ?? 0;
    } catch (error) {
      throw wrapMemoryEntryQueryError("Failed to count memory entries by scope and dimension.", error);
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
      return parseRows(
        this.statements.findByScopeClassHotPagedStatement.all(
          workspaceId,
          parsedScopeClass,
          parsedPage.limit,
          parsedPage.offset
        ),
        this.memoryRowParser,
        "memory entry row"
      );
    } catch (error) {
      throw wrapMemoryEntryQueryError(
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
      return parseRows(
        this.statements.findByScopeClassHotStatement.all(workspaceId, parsedScopeClass),
        this.memoryRowParser,
        "memory entry row"
      );
    } catch (error) {
      throw wrapMemoryEntryQueryError(
        `Failed to list all memory entries for workspace ${workspaceId} and scope class ${parsedScopeClass}.`,
        error
      );
    }
  }

  public async countByScopeClass(workspaceId: string, scopeClass: ScopeClass): Promise<number> {
    requirePrivacyWorkspaceAvailable(this.privacyDatabase, workspaceId, ["memory_entry"]);
    const parsedScopeClass = parseScopeClass(scopeClass);

    try {
      return parseOptionalRow(
        this.statements.countByScopeClassHotStatement.get(workspaceId, parsedScopeClass),
        CountRowParser,
        "memory entry count row"
      )?.total ?? 0;
    } catch (error) {
      throw wrapMemoryEntryQueryError(
        `Failed to count memory entries for workspace ${workspaceId} and scope class ${parsedScopeClass}.`,
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
    requirePrivacyWorkspaceAvailable(this.privacyDatabase, workspaceId, ["memory_entry"]);
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
    requirePrivacyWorkspaceAvailable(this.privacyDatabase, workspaceId, ["memory_entry"]);
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
    requirePrivacyWorkspaceAvailable(this.privacyDatabase, workspaceId, ["memory_entry"]);
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
    requirePrivacyWorkspaceAvailable(this.privacyDatabase, workspaceId, ["memory_entry"]);
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

  public async findBoundEvidenceRefs(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly string[]> {
    return await this.dynamicQueries.findBoundEvidenceRefs(workspaceId, evidenceObjectIds);
  }

  public async findLowActivityActiveMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      return parseRows(
        this.statements.findLowActivityActiveMemoriesStatement.all(workspaceId),
        this.memoryRowParser,
        "memory entry row"
      );
    } catch (error) {
      throw wrapMemoryEntryQueryError(
        `Failed to find low-activity active memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findTombstonedMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      return parseRows(
        this.statements.findTombstonedMemoriesStatement.all(workspaceId),
        this.memoryRowParser,
        "memory entry row"
      );
    } catch (error) {
      throw wrapMemoryEntryQueryError(
        `Failed to find tombstoned memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findDormantMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      return parseRows(
        this.statements.findDormantMemoriesStatement.all(workspaceId),
        this.memoryRowParser,
        "memory entry row"
      );
    } catch (error) {
      throw wrapMemoryEntryQueryError(
        `Failed to find dormant memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findTombstonedMemoriesWithDisposition(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      return parseRows(
        this.statements.findTombstonedWithDispositionStatement.all(workspaceId),
        this.memoryRowParser,
        "memory entry row"
      );
    } catch (error) {
      throw wrapMemoryEntryQueryError(
        `Failed to find tombstoned-with-disposition memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

}

function wrapMemoryEntryQueryError(message: string, error: unknown): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  return new StorageError("QUERY_FAILED", message, error);
}
