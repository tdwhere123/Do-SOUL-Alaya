import {
  type MemoryDimension,
  type MemoryEntry,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import {
  parseMemoryDimension,
  parseMemoryEntryRow,
  parseScopeClass,
  type MemoryEntryRow
} from "./row-mapper.js";
import type { MemoryEntryStatements } from "./sqlite-memory-entry-statements.js";
import { DEFAULT_MEMORY_ENTRY_PAGE, parseMemoryEntryPage } from "./memory-entry-read-page.js";
import type { MemoryEntryListPageOptions } from "./types.js";

export class MemoryEntryConflictReadQueries {
  public constructor(private readonly statements: () => MemoryEntryStatements) {}

  public async findByWorkspaceIdWithConflict(
    workspaceId: string,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedPage = parseMemoryEntryPage(page ?? DEFAULT_MEMORY_ENTRY_PAGE);
    try {
      const rows = this.statements().findByWorkspaceHotConflictPagedStatement.all(
        workspaceId,
        parsedPage.limit,
        parsedPage.offset
      ) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list conflict memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async countByWorkspaceIdWithConflict(workspaceId: string): Promise<number> {
    try {
      const row = this.statements().countByWorkspaceHotConflictStatement.get(workspaceId) as
        | { readonly total: number }
        | undefined;
      return row?.total ?? 0;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count conflict memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedDimension = parseMemoryDimension(dimension);
    const parsedPage = parseMemoryEntryPage(page ?? DEFAULT_MEMORY_ENTRY_PAGE);
    try {
      const rows = this.statements().findByDimensionHotConflictPagedStatement.all(
        workspaceId,
        parsedDimension,
        parsedPage.limit,
        parsedPage.offset
      ) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list conflict memory entries for workspace ${workspaceId} and dimension ${parsedDimension}.`,
        error
      );
    }
  }

  public async countByDimensionWithConflict(
    workspaceId: string,
    dimension: MemoryDimension
  ): Promise<number> {
    const parsedDimension = parseMemoryDimension(dimension);
    try {
      const row = this.statements().countByDimensionHotConflictStatement.get(
        workspaceId,
        parsedDimension
      ) as { readonly total: number } | undefined;
      return row?.total ?? 0;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count conflict memory entries for workspace ${workspaceId} and dimension ${parsedDimension}.`,
        error
      );
    }
  }

  public async findByScopeClassWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedScopeClass = parseScopeClass(scopeClass);
    const parsedPage = parseMemoryEntryPage(page ?? DEFAULT_MEMORY_ENTRY_PAGE);
    try {
      const rows = this.statements().findByScopeClassHotConflictPagedStatement.all(
        workspaceId,
        parsedScopeClass,
        parsedPage.limit,
        parsedPage.offset
      ) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list conflict memory entries for workspace ${workspaceId} and scope class ${parsedScopeClass}.`,
        error
      );
    }
  }

  public async countByScopeClassWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<number> {
    const parsedScopeClass = parseScopeClass(scopeClass);
    try {
      const row = this.statements().countByScopeClassHotConflictStatement.get(
        workspaceId,
        parsedScopeClass
      ) as { readonly total: number } | undefined;
      return row?.total ?? 0;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count conflict memory entries for workspace ${workspaceId} and scope class ${parsedScopeClass}.`,
        error
      );
    }
  }

  public async findByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryDimension,
    page?: MemoryEntryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedScopeClass = parseScopeClass(scopeClass);
    const parsedDimension = parseMemoryDimension(dimension);
    const parsedPage = parseMemoryEntryPage(page ?? DEFAULT_MEMORY_ENTRY_PAGE);
    try {
      const rows = this.statements().findByScopeClassAndDimensionHotConflictPagedStatement.all(
        workspaceId,
        parsedScopeClass,
        parsedDimension,
        parsedPage.limit,
        parsedPage.offset
      ) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list conflict memory entries for workspace ${workspaceId}, scope ${parsedScopeClass}, dimension ${parsedDimension}.`,
        error
      );
    }
  }

  public async countByScopeClassAndDimensionWithConflict(
    workspaceId: string,
    scopeClass: ScopeClass,
    dimension: MemoryDimension
  ): Promise<number> {
    const parsedScopeClass = parseScopeClass(scopeClass);
    const parsedDimension = parseMemoryDimension(dimension);
    try {
      const row = this.statements().countByScopeClassAndDimensionHotConflictStatement.get(
        workspaceId,
        parsedScopeClass,
        parsedDimension
      ) as { readonly total: number } | undefined;
      return row?.total ?? 0;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count conflict memory entries for workspace ${workspaceId}, scope ${parsedScopeClass}, dimension ${parsedDimension}.`,
        error
      );
    }
  }
}
