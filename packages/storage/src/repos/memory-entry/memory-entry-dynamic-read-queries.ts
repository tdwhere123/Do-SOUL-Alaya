import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import type { DynamicPreparedStatementCache } from "../../sqlite/dynamic-prepared-statement-cache.js";
import { parseNonEmptyString } from "../shared/validators.js";
import {
  MEMORY_ENTRY_SELECT_COLUMNS,
  parseMemoryEntryRow,
  type MemoryEntryRow
} from "./row-mapper.js";
import {
  FIND_BY_EVIDENCE_REFS_INPUT_CAP,
  FIND_BY_EVIDENCE_REFS_ROW_LIMIT,
  type MemoryEntryRepoDiagnosticSink
} from "./types.js";

export class MemoryEntryDynamicReadQueries {
  public constructor(
    private readonly statementCache: DynamicPreparedStatementCache,
    private readonly diagnostics: MemoryEntryRepoDiagnosticSink
  ) {}

  public async findByIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const parsedObjectIds = Array.from(
      new Set(objectIds.map((objectId) => parseNonEmptyString(objectId, "object_id")))
    );

    if (parsedObjectIds.length === 0) {
      return [];
    }

    const placeholders = parsedObjectIds.map(() => "?").join(", ");
    const statement = this.statementCache.prepare(`
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

  public async findBySharedDomainTags(
    workspaceId: string,
    tags: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const uniqueTags = Array.from(
      new Set(tags.filter((tag) => typeof tag === "string" && tag.length > 0))
    );
    if (uniqueTags.length === 0) {
      return Object.freeze([]);
    }

    const placeholders = uniqueTags.map(() => "?").join(", ");
    const statement = this.statementCache.prepare(`
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
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const cappedIds = capEvidenceRefLookupIds(parsedWorkspaceId, evidenceObjectIds, this.diagnostics);
    if (cappedIds.length === 0) {
      return Object.freeze([]);
    }
    try {
      const rows = queryEvidenceRefRows(this.statementCache, parsedWorkspaceId, cappedIds);
      reportEvidenceRefRowCap(parsedWorkspaceId, cappedIds.length, rows.length, this.diagnostics);
      return Object.freeze(rows.map((row) => parseMemoryEntryRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find memory entries by evidence_refs in workspace ${parsedWorkspaceId}.`,
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

function queryEvidenceRefRows(
  statementCache: DynamicPreparedStatementCache,
  workspaceId: string,
  evidenceObjectIds: readonly string[]
): readonly MemoryEntryRow[] {
  const placeholders = evidenceObjectIds.map(() => "?").join(", ");
  return statementCache
    .prepare(
      `SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
       FROM memory_entries
       WHERE workspace_id = ?
         AND COALESCE(retention_state, '') != 'tombstoned'
         AND COALESCE(lifecycle_state, '') != 'dormant'
         AND object_id IN (
           SELECT memory_id
           FROM memory_entry_evidence_refs
           WHERE workspace_id = ?
             AND evidence_ref IN (${placeholders})
         )
       ORDER BY object_id ASC
       LIMIT ${FIND_BY_EVIDENCE_REFS_ROW_LIMIT}`
    )
    .all(workspaceId, workspaceId, ...evidenceObjectIds) as MemoryEntryRow[];
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
