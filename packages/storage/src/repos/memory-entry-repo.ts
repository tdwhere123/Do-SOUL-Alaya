import {
  StorageTier,
  type MemoryDimension,
  type MemoryEntry,
  type MemoryEntryRepoUpdateFields as ProtocolMemoryEntryRepoUpdateFields,
  type ScopeClass
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import {
  buildObjectIdFilterSql,
  countQueryCodepoints,
  createShortKeywordMatcher,
  mergeKeywordSearchRows,
  normalizeKeywordSearchObjectIds,
  tokenizeFtsQuery,
  type ExactKeywordCandidateRow,
  type ExactKeywordSearchRow,
  type FtsKeywordSearchRow
} from "./memory-entry-keyword-search.js";
import {
  MEMORY_ENTRY_SELECT_COLUMNS,
  parseDynamicsUpdateFields,
  parseLifecycleState,
  parseMemoryDimension,
  parseMemoryEntry,
  parseMemoryEntryRow,
  parseScopeClass,
  parseStorageTier,
  parseUpdatedAt,
  parseUpdateFields,
  type MemoryEntryRow
} from "./memory-entry-row-mapper.js";
import { parseNonEmptyString } from "./shared/validators.js";

export type MemoryEntryRepoUpdateFields = ProtocolMemoryEntryRepoUpdateFields & {
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
};
export interface MemoryEntryRepoDynamicsUpdateFields {
  readonly activation_score: number;
  readonly retention_score: number;
  readonly manifestation_state: MemoryEntry["manifestation_state"];
  readonly retention_state?: MemoryEntry["retention_state"];
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
  readonly reinforcement_count?: number;
  readonly contradiction_count?: number;
  readonly superseded_by?: string;
}

export interface MemoryEntryRepoTierUpdateInput {
  readonly objectId: string;
  readonly workspaceId: string;
  readonly fromTier: StorageTier;
  readonly toTier: StorageTier;
  readonly updatedAt: string;
  readonly expectedUpdatedAt: string;
  readonly activationBump?: number;
  readonly lastUsedAt?: string;
  readonly lastHitAt?: string;
}

export interface MemoryEntryKeywordSearchResult {
  readonly object_id: string;
  readonly normalized_rank: number;
}

export interface MemoryEntryRepo {
  create(entry: MemoryEntry): Promise<Readonly<MemoryEntry>>;
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]>;
  findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByRunId(runId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimension(
    workspaceId: string,
    dimension: MemoryDimension
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly MemoryEntryKeywordSearchResult[]>;
  searchByKeywordWithinObjectIds?(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly MemoryEntryKeywordSearchResult[]>;
  // see also: 005-evidence-capsules.sql + 068-evidence-capsule-fts.sql
  // Returns memory entries whose evidence_refs JSON array references any of
  // the given evidence_capsule.object_id values, scoped to workspace.
  findByEvidenceRefs?(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findLowActivityActiveMemories(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  findTombstonedMemories(workspaceId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  update(objectId: string, fields: MemoryEntryRepoUpdateFields): Promise<Readonly<MemoryEntry>>;
  updateScoped(objectId: string, workspaceId: string, fields: MemoryEntryRepoUpdateFields): Promise<Readonly<MemoryEntry>>;
  updateTier(input: MemoryEntryRepoTierUpdateInput): Readonly<MemoryEntry> | null;
  updateDynamics(
    objectId: string,
    fields: MemoryEntryRepoDynamicsUpdateFields,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>>;
  transitionLifecycle(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>>;
  archive(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry>>;
  hardDeleteTombstoned(objectId: string): Promise<void>;
}

export class SqliteMemoryEntryRepo implements MemoryEntryRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceHotStatement;
  private readonly findByWorkspaceTierStatement;
  private readonly findByRunIdStatement;
  private readonly findByDimensionHotStatement;
  private readonly findByScopeClassHotStatement;
  private readonly updateStatement;
  private readonly updateScopedStatement;
  // updateDynamics uses a dynamic SQL builder to support nullable field clearing.
  private readonly searchByKeywordStatement;
  private readonly findLowActivityActiveMemoriesStatement;
  private readonly findTombstonedMemoriesStatement;
  private readonly transitionLifecycleStatement;
  private readonly archiveStatement;
  private readonly hardDeleteTombstonedStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO memory_entries (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        dimension,
        source_kind,
        formation_kind,
        scope_class,
        content,
        domain_tags,
        evidence_refs,
        workspace_id,
        run_id,
        surface_id,
        storage_tier,
        activation_score,
        retention_score,
        manifestation_state,
        retention_state,
        decay_profile,
        confidence,
        last_used_at,
        last_hit_at,
        reinforcement_count,
        contradiction_count,
        superseded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.findByIdStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE object_id = ?
      LIMIT 1
    `);
    this.findByWorkspaceHotStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = 'hot' AND COALESCE(retention_state, '') != 'tombstoned'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findByWorkspaceTierStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = ? AND COALESCE(retention_state, '') != 'tombstoned'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findByRunIdStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE run_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findByDimensionHotStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND dimension = ? AND storage_tier = 'hot' AND COALESCE(retention_state, '') != 'tombstoned'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findByScopeClassHotStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND scope_class = ? AND storage_tier = 'hot' AND COALESCE(retention_state, '') != 'tombstoned'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.updateStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET
        content = COALESCE(?, content),
        domain_tags = COALESCE(?, domain_tags),
        evidence_refs = COALESCE(?, evidence_refs),
        storage_tier = COALESCE(?, storage_tier),
        confidence = COALESCE(?, confidence),
        retention_state = COALESCE(?, retention_state),
        last_used_at = COALESCE(?, last_used_at),
        last_hit_at = COALESCE(?, last_hit_at),
        updated_at = ?
      WHERE object_id = ?
    `);
    this.updateScopedStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET
        content = COALESCE(?, content),
        domain_tags = COALESCE(?, domain_tags),
        evidence_refs = COALESCE(?, evidence_refs),
        storage_tier = COALESCE(?, storage_tier),
        confidence = COALESCE(?, confidence),
        retention_state = COALESCE(?, retention_state),
        last_used_at = COALESCE(?, last_used_at),
        last_hit_at = COALESCE(?, last_hit_at),
        updated_at = ?
      WHERE object_id = ? AND workspace_id = ?
    `);
    this.searchByKeywordStatement = db.connection.prepare(`
      SELECT
        memory_content_fts.object_id,
        bm25(memory_content_fts) AS raw_rank
      FROM memory_content_fts
      JOIN memory_entries ON memory_entries.object_id = memory_content_fts.object_id
      WHERE
        memory_content_fts.workspace_id = ?
        AND memory_content_fts MATCH ?
        AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
      ORDER BY raw_rank ASC, memory_content_fts.object_id ASC
      LIMIT ?
    `);
    this.findLowActivityActiveMemoriesStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE
        workspace_id = ?
        AND lifecycle_state = 'active'
        AND storage_tier = 'hot'
        AND COALESCE(activation_score, 0.0) <= 0.3
        AND COALESCE(last_hit_at, last_used_at, updated_at, created_at)
          <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
      ORDER BY
        COALESCE(last_hit_at, last_used_at, updated_at, created_at) ASC,
        COALESCE(activation_score, 0.0) ASC,
        object_id ASC
    `);
    this.findTombstonedMemoriesStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE
        workspace_id = ?
        AND retention_state = 'tombstoned'
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      ORDER BY updated_at ASC, object_id ASC
    `);
    this.transitionLifecycleStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET lifecycle_state = ?, updated_at = ?
      WHERE object_id = ?
    `);
    this.archiveStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET lifecycle_state = 'archived', updated_at = ?
      WHERE object_id = ?
    `);
    this.hardDeleteTombstonedStatement = db.connection.prepare(`
      DELETE FROM memory_entries
      WHERE object_id = ?
        AND retention_state = 'tombstoned'
        AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    `);
  }

  public async create(entry: MemoryEntry): Promise<Readonly<MemoryEntry>> {
    const parsedEntry = parseMemoryEntry(entry);

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
        parsedEntry.superseded_by
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create memory entry ${parsedEntry.object_id}.`,
        error
      );
    }

    return parsedEntry;
  }

  public async findById(objectId: string): Promise<Readonly<MemoryEntry> | null> {
    try {
      const row = this.findByIdStatement.get(objectId) as MemoryEntryRow | undefined;
      return row === undefined ? null : parseMemoryEntryRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load memory entry ${objectId}.`, error);
    }
  }

  public async findByIds(objectIds: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedObjectIds = Array.from(new Set(objectIds.map((objectId) => parseNonEmptyString(objectId, "object_id"))));

    if (parsedObjectIds.length === 0) {
      return [];
    }

    const placeholders = parsedObjectIds.map(() => "?").join(", ");
    const statement = this.db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE object_id IN (${placeholders})
      ORDER BY created_at ASC, object_id ASC
    `);

    try {
      const rows = statement.all(...parsedObjectIds) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to load memory entries by ids.", error);
    }
  }

  public async findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const parsedTier = tier === undefined ? undefined : parseStorageTier(tier);
      const rows =
        parsedTier === undefined || parsedTier === StorageTier.HOT
          ? (this.findByWorkspaceHotStatement.all(workspaceId) as MemoryEntryRow[])
          : (this.findByWorkspaceTierStatement.all(workspaceId, parsedTier) as MemoryEntryRow[]);
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  // Run-scoped reads intentionally include both hot and cold tiers.
  public async findByRunId(runId: string): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.findByRunIdStatement.all(runId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list memory entries for run ${runId}.`, error);
    }
  }

  public async findByDimension(
    workspaceId: string,
    dimension: MemoryDimension
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedDimension = parseMemoryDimension(dimension);

    try {
      const rows = this.findByDimensionHotStatement.all(workspaceId, parsedDimension) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory entries for workspace ${workspaceId} and dimension ${parsedDimension}.`,
        error
      );
    }
  }

  public async findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const parsedScopeClass = parseScopeClass(scopeClass);

    try {
      const rows = this.findByScopeClassHotStatement.all(workspaceId, parsedScopeClass) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory entries for workspace ${workspaceId} and scope class ${parsedScopeClass}.`,
        error
      );
    }
  }

  public async findByEvidenceRefs(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const unique = [...new Set(evidenceObjectIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (unique.length === 0) {
      return Object.freeze([]);
    }
    const cappedIds = unique.slice(0, 256);
    const likePatterns = cappedIds.map(() => `evidence_refs LIKE ?`);
    const likeValues = cappedIds.map((id) => `%${id.replace(/[%_]/g, "")}%`);
    try {
      const rows = this.db.connection
        .prepare(
          `SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
           FROM memory_entries
           WHERE workspace_id = ?
             AND COALESCE(retention_state, '') != 'tombstoned'
             AND (${likePatterns.join(" OR ")})
           ORDER BY object_id ASC
           LIMIT 512`
        )
        .all(workspaceId, ...likeValues) as MemoryEntryRow[];
      return Object.freeze(rows.map((row) => parseMemoryEntryRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find memory entries by evidence_refs in workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly MemoryEntryKeywordSearchResult[]> {
    try {
      return this.searchKeywordRows({ workspaceId, queryText, limit });
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to search memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async searchByKeywordWithinObjectIds(
    workspaceId: string,
    queryText: string,
    limit: number,
    objectIds: readonly string[]
  ): Promise<readonly MemoryEntryKeywordSearchResult[]> {
    const candidateObjectIds = normalizeKeywordSearchObjectIds(objectIds);

    if (candidateObjectIds.length === 0) {
      return Object.freeze([]);
    }

    try {
      return this.searchKeywordRows({
        workspaceId,
        queryText,
        limit,
        candidateObjectIds
      });
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to search filtered memory entries for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findLowActivityActiveMemories(
    workspaceId: string
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = this.findLowActivityActiveMemoriesStatement.all(workspaceId) as MemoryEntryRow[];
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
      const rows = this.findTombstonedMemoriesStatement.all(workspaceId) as MemoryEntryRow[];
      return rows.map((row) => parseMemoryEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find tombstoned memories for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async update(
    objectId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>> {
    const parsedFields = parseUpdateFields(fields);

    try {
      const result = this.updateStatement.run(
        parsedFields.content ?? null,
        parsedFields.domain_tags === undefined ? null : JSON.stringify(parsedFields.domain_tags),
        parsedFields.evidence_refs === undefined ? null : JSON.stringify(parsedFields.evidence_refs),
        parsedFields.storage_tier ?? null,
        parsedFields.confidence ?? null,
        parsedFields.retention_state ?? null,
        parsedFields.last_used_at ?? null,
        parsedFields.last_hit_at ?? null,
        parsedFields.updated_at,
        objectId
      );

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update memory entry ${objectId}.`, error);
    }
  }

  public async updateScoped(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    const parsedFields = parseUpdateFields(fields);

    try {
      const result = this.updateScopedStatement.run(
        parsedFields.content ?? null,
        parsedFields.domain_tags === undefined ? null : JSON.stringify(parsedFields.domain_tags),
        parsedFields.evidence_refs === undefined ? null : JSON.stringify(parsedFields.evidence_refs),
        parsedFields.storage_tier ?? null,
        parsedFields.confidence ?? null,
        parsedFields.retention_state ?? null,
        parsedFields.last_used_at ?? null,
        parsedFields.last_hit_at ?? null,
        parsedFields.updated_at,
        objectId,
        parsedWorkspaceId
      );

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null || updated.workspace_id !== parsedWorkspaceId) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update memory entry ${objectId}.`, error);
    }
  }

  public updateTier(input: MemoryEntryRepoTierUpdateInput): Readonly<MemoryEntry> | null {
    const objectId = parseNonEmptyString(input.objectId, "object_id");
    const workspaceId = parseNonEmptyString(input.workspaceId, "workspace_id");
    const fromTier = parseStorageTier(input.fromTier);
    const toTier = parseStorageTier(input.toTier);
    const updatedAt = parseUpdatedAt(input.updatedAt);
    const expectedUpdatedAt = parseUpdatedAt(input.expectedUpdatedAt);
    const lastUsedAt = input.lastUsedAt === undefined ? undefined : parseUpdatedAt(input.lastUsedAt);
    const lastHitAt = input.lastHitAt === undefined ? undefined : parseUpdatedAt(input.lastHitAt);
    const activationBump = input.activationBump ?? 0;
    if (!Number.isFinite(activationBump) || activationBump < 0 || activationBump > 1) {
      throw new StorageError("VALIDATION_FAILED", "Failed to validate activation tier bump.");
    }

    try {
      const result = this.db.connection
        .prepare(
          `UPDATE memory_entries
           SET storage_tier = ?,
               activation_score = min(1.0, COALESCE(activation_score, 0.0) + ?),
               last_used_at = COALESCE(?, last_used_at),
               last_hit_at = COALESCE(?, last_hit_at),
               updated_at = ?
           WHERE object_id = ?
             AND workspace_id = ?
             AND storage_tier = ?
             AND updated_at = ?`
        )
        .run(
          toTier,
          activationBump,
          lastUsedAt ?? null,
          lastHitAt ?? null,
          updatedAt,
          objectId,
          workspaceId,
          fromTier,
          expectedUpdatedAt
        );

      if (result.changes === 0) {
        return null;
      }

      const row = this.findByIdStatement.get(objectId) as MemoryEntryRow | undefined;
      if (row === undefined) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after tier update.`);
      }
      return parseMemoryEntryRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update memory entry tier for ${objectId}.`, error);
    }
  }

  public async archive(objectId: string, updatedAt: string): Promise<Readonly<MemoryEntry>> {
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    try {
      const result = this.archiveStatement.run(parsedUpdatedAt, objectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const archived = await this.findById(objectId);

      if (archived === null) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after archive.`);
      }

      return archived;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to archive memory entry ${objectId}.`, error);
    }
  }

  public async updateDynamics(
    objectId: string,
    fields: MemoryEntryRepoDynamicsUpdateFields,
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>> {
    const parsedFields = parseDynamicsUpdateFields(fields);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    // Build the SET clause dynamically so that:
    // - undefined fields are omitted (keep existing DB value)
    // - null fields are SET to NULL (explicit clear)
    // - value fields are SET to the provided value
    // The fixed COALESCE pattern could not distinguish undefined from null, so
    // callers could not clear a nullable field back to null via this method.
    const setClauses: string[] = [
      "activation_score = ?",
      "retention_score = ?",
      "manifestation_state = ?"
    ];
    const params: Array<string | number | null> = [
      parsedFields.activation_score,
      parsedFields.retention_score,
      parsedFields.manifestation_state as string
    ];

    const optionalFields: Array<readonly [string, string | number | null | undefined]> = [
      ["retention_state", parsedFields.retention_state as string | null | undefined],
      ["last_used_at", parsedFields.last_used_at],
      ["last_hit_at", parsedFields.last_hit_at],
      ["reinforcement_count", parsedFields.reinforcement_count],
      ["contradiction_count", parsedFields.contradiction_count],
      ["superseded_by", parsedFields.superseded_by]
    ];

    for (const [column, value] of optionalFields) {
      if (value !== undefined) {
        setClauses.push(`${column} = ?`);
        params.push(value ?? null);
      }
    }

    setClauses.push("updated_at = ?");
    params.push(parsedUpdatedAt);
    params.push(objectId);

    try {
      const result = this.db.connection
        .prepare(`UPDATE memory_entries SET ${setClauses.join(", ")} WHERE object_id = ?`)
        .run(...params);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update dynamics for memory entry ${objectId}.`,
        error
      );
    }
  }

  public async transitionLifecycle(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string
  ): Promise<Readonly<MemoryEntry>> {
    const parsedLifecycleState = parseLifecycleState(lifecycleState);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    try {
      const result = this.transitionLifecycleStatement.run(parsedLifecycleState, parsedUpdatedAt, objectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found.`);
      }

      const updated = await this.findById(objectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Memory entry ${objectId} was not found after lifecycle update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to transition lifecycle for memory entry ${objectId}.`,
        error
      );
    }
  }

  public async hardDeleteTombstoned(objectId: string): Promise<void> {
    try {
      const result = this.hardDeleteTombstonedStatement.run(objectId);

      if (result.changes === 0) {
        throw new StorageError(
          "NOT_FOUND",
          `Tombstoned memory entry ${objectId} was not found or is not eligible for deletion.`
        );
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to hard-delete tombstoned memory entry ${objectId}.`,
        error
      );
    }
  }

  private searchKeywordRows(params: Readonly<{
    readonly workspaceId: string;
    readonly queryText: string;
    readonly limit: number;
    readonly candidateObjectIds?: readonly string[];
  }>): readonly MemoryEntryKeywordSearchResult[] {
    const tokens = tokenizeFtsQuery(params.queryText);

    if (tokens.length === 0 || !Number.isInteger(params.limit) || params.limit <= 0) {
      return Object.freeze([]);
    }

    const shortTokens = tokens.filter((token) => countQueryCodepoints(token) < 3);
    const trigramTokens = tokens.filter((token) => countQueryCodepoints(token) >= 3);
    const exactRows = this.searchExactKeywordRows(
      params.workspaceId,
      shortTokens,
      params.limit,
      params.candidateObjectIds
    );
    const trigramRows = this.searchTrigramKeywordRows(
      params.workspaceId,
      trigramTokens,
      params.limit,
      params.candidateObjectIds
    );
    const mergedRows = mergeKeywordSearchRows(exactRows, trigramRows, params.limit);

    return Object.freeze(
      mergedRows.map((row) =>
        Object.freeze({
          object_id: row.object_id,
          normalized_rank: row.normalized_rank
        })
      )
    );
  }

  private searchExactKeywordRows(
    workspaceId: string,
    tokens: readonly string[],
    limit: number,
    candidateObjectIds?: readonly string[]
  ): readonly ExactKeywordSearchRow[] {
    if (tokens.length === 0) {
      return [];
    }

    const tokenMatchers = tokens.map((token) => createShortKeywordMatcher(token));
    const objectIdFilter = buildObjectIdFilterSql(candidateObjectIds);
    const rows = this.db.connection.prepare(`
      SELECT
        object_id,
        content
      FROM memory_entries
      WHERE workspace_id = ?
      AND COALESCE(retention_state, '') != 'tombstoned'
      ${objectIdFilter.sql}
      ORDER BY object_id ASC
    `).all(workspaceId, ...objectIdFilter.params) as readonly ExactKeywordCandidateRow[];

    return rows
      .map((row) =>
        Object.freeze({
          object_id: row.object_id,
          matched_token_count: tokenMatchers.reduce(
            (count, matcher) => count + (matcher(row.content) ? 1 : 0),
            0
          )
        })
      )
      .filter((row) => row.matched_token_count > 0)
      .sort((left, right) => {
        const matchDelta = right.matched_token_count - left.matched_token_count;
        if (matchDelta !== 0) {
          return matchDelta;
        }

        return left.object_id.localeCompare(right.object_id);
      })
      .slice(0, limit);
  }

  private searchTrigramKeywordRowsWithinObjectIds(
    workspaceId: string,
    tokens: readonly string[],
    limit: number,
    candidateObjectIds: readonly string[]
  ): readonly FtsKeywordSearchRow[] {
    const objectIdFilter = buildObjectIdFilterSql(candidateObjectIds, "memory_content_fts.object_id");

    return this.db.connection.prepare(`
      SELECT
        memory_content_fts.object_id,
        bm25(memory_content_fts) AS raw_rank
      FROM memory_content_fts
      JOIN memory_entries ON memory_entries.object_id = memory_content_fts.object_id
      WHERE
        memory_content_fts.workspace_id = ?
        AND memory_content_fts MATCH ?
        AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
      ${objectIdFilter.sql}
      ORDER BY raw_rank ASC, memory_content_fts.object_id ASC
      LIMIT ?
    `).all(
      workspaceId,
      tokens.map((token) => `"${token}"`).join(" OR "),
      ...objectIdFilter.params,
      limit
    ) as readonly FtsKeywordSearchRow[];
  }

  private searchTrigramKeywordRows(
    workspaceId: string,
    tokens: readonly string[],
    limit: number,
    candidateObjectIds?: readonly string[]
  ): readonly FtsKeywordSearchRow[] {
    if (tokens.length === 0) {
      return [];
    }

    if (candidateObjectIds !== undefined) {
      return this.searchTrigramKeywordRowsWithinObjectIds(
        workspaceId,
        tokens,
        limit,
        candidateObjectIds
      );
    }

    return this.searchByKeywordStatement.all(
      workspaceId,
      tokens.map((token) => `"${token}"`).join(" OR "),
      limit
    ) as readonly FtsKeywordSearchRow[];
  }
}
