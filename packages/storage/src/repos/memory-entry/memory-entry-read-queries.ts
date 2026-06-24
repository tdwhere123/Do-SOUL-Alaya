import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import {
  DEFAULT_REPO_LIST_PAGE_LIMIT,
  parseNonEmptyString,
  parsePageLimit,
  parsePageOffset
} from "../shared/validators.js";
import { MEMORY_ENTRY_SELECT_COLUMNS, parseMemoryDimension, parseMemoryEntryRow, parseScopeClass, parseStorageTier, type MemoryEntryRow } from "./row-mapper.js";
import type { MemoryEntryStatements } from "./sqlite-memory-entry-statements.js";
import {
  FIND_BY_EVIDENCE_REFS_INPUT_CAP,
  FIND_BY_EVIDENCE_REFS_ROW_LIMIT,
  type MemoryEntryListPageOptions,
  type MemoryEntryRepoDiagnosticSink
} from "./types.js";

interface CountRow {
  readonly total: number;
}

const DEFAULT_MEMORY_ENTRY_PAGE = Object.freeze({
  limit: DEFAULT_REPO_LIST_PAGE_LIMIT,
  offset: 0
});

export class MemoryEntryReadQueries {
  public constructor(
    private readonly db: StorageDatabase,
    private readonly diagnostics: MemoryEntryRepoDiagnosticSink,
    private readonly statements: MemoryEntryStatements
  ) {}

  public async findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
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
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const parsedObjectIds = Array.from(new Set(objectIds.map((objectId) => parseNonEmptyString(objectId, "object_id"))));

    if (parsedObjectIds.length === 0) {
      return [];
    }

    const placeholders = parsedObjectIds.map(() => "?").join(", ");
    const statement = this.db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ?
        AND object_id IN (${placeholders})
      ORDER BY created_at ASC, object_id ASC
    `);

    try {
      const rows = statement.all(parsedWorkspaceId, ...parsedObjectIds) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to load memory entries by ids.", error);
    }
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

  public async findBySharedDomainTags(
    workspaceId: string,
    tags: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const uniqueTags = Array.from(
      new Set(tags.filter((tag) => typeof tag === "string" && tag.length > 0))
    );
    // A new memory with no tags can never reach jaccard(domain_tags) >= the
    // rule gate, so it has no shared-tag candidates; mirror the full-scan
    // outcome (zero INCOMPATIBLE_WITH edges) by returning empty.
    if (uniqueTags.length === 0) {
      return Object.freeze([]);
    }

    // json_each expands the domain_tags JSON array per row; a row with an
    // empty array yields no json_each rows and is therefore excluded
    // (it cannot pass the >=0.35 gate). DISTINCT collapses rows that share
    // more than one tag to a single result. Tier + tombstone + ORDER BY
    // match findByWorkspaceId(hot) so the candidate set is a strict
    // superset of the full-scan candidates with identical iteration order.
    const placeholders = uniqueTags.map(() => "?").join(", ");
    const statement = this.db.connection.prepare(`
      SELECT DISTINCT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      JOIN json_each(memory_entries.domain_tags) AS tag
        ON tag.value IN (${placeholders})
      WHERE memory_entries.workspace_id = ?
        AND memory_entries.storage_tier = 'hot'
        AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
        AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
      ORDER BY memory_entries.created_at ASC, memory_entries.object_id ASC
    `);

    try {
      const rows = statement.all(...uniqueTags, workspaceId) as MemoryEntryRow[];
      return Object.freeze(rows.map((row) => parseMemoryEntryRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find memory entries by shared domain tags in workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByEvidenceRefs(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const cappedIds = capEvidenceRefLookupIds(
      workspaceId,
      evidenceObjectIds,
      this.diagnostics
    );
    if (cappedIds.length === 0) {
      return Object.freeze([]);
    }
    const evidenceFilter = buildEvidenceRefsFilter(cappedIds);
    try {
      const rows = queryEvidenceRefRows(this.db, workspaceId, evidenceFilter);
      reportEvidenceRefRowCap(workspaceId, cappedIds.length, rows.length, this.diagnostics);
      return Object.freeze(rows.map((row) => parseMemoryEntryRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find memory entries by evidence_refs in workspace ${workspaceId}.`,
        error
      );
    }
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

function capEvidenceRefLookupIds(
  workspaceId: string,
  evidenceObjectIds: readonly string[],
  diagnostics: MemoryEntryRepoDiagnosticSink
): readonly string[] {
  const unique = [...new Set(evidenceObjectIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length > FIND_BY_EVIDENCE_REFS_INPUT_CAP) {
    diagnostics("memory evidence-ref lookup input truncated", {
      workspace_id: workspaceId,
      input_count: unique.length,
      capped_count: FIND_BY_EVIDENCE_REFS_INPUT_CAP
    });
  }
  return unique.slice(0, FIND_BY_EVIDENCE_REFS_INPUT_CAP);
}

function buildEvidenceRefsFilter(
  cappedIds: readonly string[]
): Readonly<{ readonly sql: string; readonly values: readonly string[] }> {
  const clauses = cappedIds.map(() => `evidence_refs LIKE ? ESCAPE '\\'`);
  return {
    sql: clauses.join(" OR "),
    values: cappedIds.map(toEvidenceRefLikePattern)
  };
}

function toEvidenceRefLikePattern(id: string): string {
  return `%"${id.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}"%`;
}

function queryEvidenceRefRows(
  db: StorageDatabase,
  workspaceId: string,
  evidenceFilter: Readonly<{ readonly sql: string; readonly values: readonly string[] }>
): readonly MemoryEntryRow[] {
  return db.connection
    .prepare(
      `SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
       FROM memory_entries
       WHERE workspace_id = ?
         AND COALESCE(retention_state, '') != 'tombstoned'
         AND COALESCE(lifecycle_state, '') != 'dormant'
         AND (${evidenceFilter.sql})
       ORDER BY object_id ASC
       LIMIT ${FIND_BY_EVIDENCE_REFS_ROW_LIMIT}`
    )
    .all(workspaceId, ...evidenceFilter.values) as MemoryEntryRow[];
}

function reportEvidenceRefRowCap(
  workspaceId: string,
  inputCount: number,
  returnedCount: number,
  diagnostics: MemoryEntryRepoDiagnosticSink
): void {
  if (returnedCount < FIND_BY_EVIDENCE_REFS_ROW_LIMIT) {
    return;
  }
  diagnostics("memory evidence-ref lookup rows hit LIMIT", {
    workspace_id: workspaceId,
    input_count: inputCount,
    row_limit: FIND_BY_EVIDENCE_REFS_ROW_LIMIT,
    returned_count: returnedCount
  });
}

function readCount(row: CountRow | undefined): number {
  return row === undefined ? 0 : Number(row.total);
}

function parseMemoryEntryPage(page: MemoryEntryListPageOptions): Readonly<MemoryEntryListPageOptions> {
  return Object.freeze({
    limit: parsePageLimit(page.limit, "memory entry page limit"),
    offset: parsePageOffset(page.offset, "memory entry page offset")
  });
}
