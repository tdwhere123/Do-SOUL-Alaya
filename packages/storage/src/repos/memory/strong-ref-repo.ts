import { StrongRefSchema, type StrongRef } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";

export interface StrongRefRepo {
  create(ref: StrongRef): Promise<Readonly<StrongRef>>;
  delete(refId: string): Promise<void>;
  deleteBySource(sourceEntityType: string, sourceEntityId: string): Promise<void>;
  findByTarget(workspaceId: string, targetEntityType: string, targetEntityId: string): Promise<readonly Readonly<StrongRef>[]>;
  findByTargets(workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]): Promise<readonly Readonly<StrongRef>[]>;
  findBySource(sourceEntityId: string): Promise<readonly Readonly<StrongRef>[]>;
  isProtected(workspaceId: string, targetEntityType: string, targetEntityId: string): Promise<boolean>;
  areAllProtected(workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]): Promise<boolean>;
}

const STRONG_REF_SELECT_COLUMNS = `
      ref_id,
      source_entity_type,
      source_entity_id,
      target_entity_type,
      target_entity_id,
      workspace_id,
      reason,
      created_at
`;

interface StrongRefRow {
  readonly ref_id: string;
  readonly source_entity_type: string;
  readonly source_entity_id: string;
  readonly target_entity_type: string;
  readonly target_entity_id: string;
  readonly workspace_id: string;
  readonly reason: StrongRef["reason"];
  readonly created_at: string;
}

export class SqliteStrongRefRepo implements StrongRefRepo {
  private readonly createStatement;
  private readonly deleteStatement;
  private readonly deleteBySourceStatement;
  private readonly findByTargetStatement;
  private readonly findBySourceStatement;
  private readonly isProtectedStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO strong_refs (
        ref_id,
        source_entity_type,
        source_entity_id,
        target_entity_type,
        target_entity_id,
        workspace_id,
        reason,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteStatement = db.connection.prepare(`
      DELETE FROM strong_refs
      WHERE ref_id = ?
    `);
    this.deleteBySourceStatement = db.connection.prepare(`
      DELETE FROM strong_refs
      WHERE source_entity_type = ?
        AND source_entity_id = ?
    `);
    this.findByTargetStatement = db.connection.prepare(`
      SELECT${STRONG_REF_SELECT_COLUMNS}
      FROM strong_refs
      WHERE workspace_id = ? AND target_entity_type = ? AND target_entity_id = ?
      ORDER BY created_at ASC, ref_id ASC
    `);
    this.findBySourceStatement = db.connection.prepare(`
      SELECT${STRONG_REF_SELECT_COLUMNS}
      FROM strong_refs
      WHERE source_entity_id = ?
      ORDER BY created_at ASC, ref_id ASC
    `);
    this.isProtectedStatement = db.connection.prepare(`
      SELECT 1
      FROM strong_refs
      WHERE workspace_id = ? AND target_entity_type = ? AND target_entity_id = ?
      LIMIT 1
    `);
  }

  public async create(ref: StrongRef): Promise<Readonly<StrongRef>> {
    const parsedRef = parseStrongRef(ref);

    try {
      this.createStatement.run(
        parsedRef.ref_id,
        parsedRef.source_entity_type,
        parsedRef.source_entity_id,
        parsedRef.target_entity_type,
        parsedRef.target_entity_id,
        parsedRef.workspace_id,
        parsedRef.reason,
        parsedRef.created_at
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to insert strong ref ${parsedRef.ref_id}.`, error);
    }

    return parsedRef;
  }

  public async delete(refId: string): Promise<void> {
    const parsedRefId = parseNonEmptyString(refId, "strong ref id");

    try {
      this.deleteStatement.run(parsedRefId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to delete strong ref ${parsedRefId}.`, error);
    }
  }

  public async deleteBySource(sourceEntityType: string, sourceEntityId: string): Promise<void> {
    const parsedSourceEntityType = parseNonEmptyString(sourceEntityType, "source entity type");
    const parsedSourceEntityId = parseNonEmptyString(sourceEntityId, "source entity id");

    try {
      this.deleteBySourceStatement.run(parsedSourceEntityType, parsedSourceEntityId);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to delete strong refs for source ${parsedSourceEntityType}:${parsedSourceEntityId}.`,
        error
      );
    }
  }

  public async findByTarget(workspaceId: string, targetEntityType: string, targetEntityId: string): Promise<readonly Readonly<StrongRef>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedTargetEntityType = parseNonEmptyString(targetEntityType, "target entity type");
    const parsedTargetEntityId = parseNonEmptyString(targetEntityId, "target entity id");

    try {
      const rows = this.findByTargetStatement.all(parsedWorkspaceId, parsedTargetEntityType, parsedTargetEntityId) as StrongRefRow[];
      return rows.map((row) => parseStrongRefRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load strong refs for target ${parsedTargetEntityId}.`,
        error
      );
    }
  }

  public async findByTargets(workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]): Promise<readonly Readonly<StrongRef>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedTargetEntityType = parseNonEmptyString(targetEntityType, "target entity type");
    const parsedTargetEntityIds = normalizeDistinctTargetIds(targetEntityIds);

    if (parsedTargetEntityIds.length === 0) {
      return [];
    }

    const placeholders = parsedTargetEntityIds.map(() => "?").join(", ");
    const statement = this.db.connection.prepare(`
      SELECT${STRONG_REF_SELECT_COLUMNS}
      FROM strong_refs
      WHERE workspace_id = ? AND target_entity_type = ? AND target_entity_id IN (${placeholders})
      ORDER BY created_at ASC, ref_id ASC
    `);

    try {
      const rows = statement.all(parsedWorkspaceId, parsedTargetEntityType, ...parsedTargetEntityIds) as StrongRefRow[];
      return rows.map((row) => parseStrongRefRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", "Failed to load strong refs for target list.", error);
    }
  }

  public async findBySource(sourceEntityId: string): Promise<readonly Readonly<StrongRef>[]> {
    const parsedSourceEntityId = parseNonEmptyString(sourceEntityId, "source entity id");

    try {
      const rows = this.findBySourceStatement.all(parsedSourceEntityId) as StrongRefRow[];
      return rows.map((row) => parseStrongRefRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load strong refs for source ${parsedSourceEntityId}.`,
        error
      );
    }
  }

  public async isProtected(workspaceId: string, targetEntityType: string, targetEntityId: string): Promise<boolean> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedTargetEntityType = parseNonEmptyString(targetEntityType, "target entity type");
    const parsedTargetEntityId = parseNonEmptyString(targetEntityId, "target entity id");

    try {
      return this.isProtectedStatement.get(parsedWorkspaceId, parsedTargetEntityType, parsedTargetEntityId) !== undefined;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to check strong-ref protection for target ${parsedTargetEntityId}.`,
        error
      );
    }
  }

  public async areAllProtected(workspaceId: string, targetEntityType: string, targetEntityIds: readonly string[]): Promise<boolean> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedTargetEntityType = parseNonEmptyString(targetEntityType, "target entity type");
    const parsedTargetEntityIds = normalizeDistinctTargetIds(targetEntityIds);

    if (parsedTargetEntityIds.length === 0) {
      return true;
    }

    const placeholders = parsedTargetEntityIds.map(() => "?").join(", ");
    const statement = this.db.connection.prepare(`
      SELECT COUNT(DISTINCT target_entity_id) AS protected_count
      FROM strong_refs
      WHERE workspace_id = ? AND target_entity_type = ? AND target_entity_id IN (${placeholders})
    `);

    try {
      const row = statement.get(parsedWorkspaceId, parsedTargetEntityType, ...parsedTargetEntityIds) as { readonly protected_count: number } | undefined;
      const protectedCount = row?.protected_count ?? 0;
      return protectedCount === parsedTargetEntityIds.length;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to check strong-ref protection coverage.", error);
    }
  }
}

function normalizeDistinctTargetIds(targetEntityIds: readonly string[]): string[] {
  return [...new Set(targetEntityIds.map((targetEntityId) => parseNonEmptyString(targetEntityId, "target entity id")))];
}

function parseStrongRef(value: StrongRef): Readonly<StrongRef> {
  try {
    return deepFreeze(StrongRefSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate strong ref.", error);
  }
}

function parseStrongRefRow(row: StrongRefRow): Readonly<StrongRef> {
  return parseStrongRef({
    ref_id: parseNonEmptyString(row.ref_id, "strong ref id"),
    source_entity_type: parseNonEmptyString(row.source_entity_type, "source entity type"),
    source_entity_id: parseNonEmptyString(row.source_entity_id, "source entity id"),
    target_entity_type: parseNonEmptyString(row.target_entity_type, "target entity type"),
    target_entity_id: parseNonEmptyString(row.target_entity_id, "target entity id"),
    workspace_id: parseNonEmptyString(row.workspace_id, "workspace id"),
    reason: row.reason,
    created_at: parseTimestamp(row.created_at)
  });
}
