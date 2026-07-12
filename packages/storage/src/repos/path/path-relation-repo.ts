import type { PathAnchorRef, PathRelation } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString } from "../shared/validators.js";
import {
  findActivePathRelationPage,
  findActivePathRelations,
  findAllActivePathRelations,
  findAllDormantPathRelations,
  findAllPathRelationsByWorkspace,
  findDormantPathRelationPage,
  findDormantPathRelations,
  findPathRelationById,
  findPathRelationsByAnchor,
  findPathRelationsByAnchors,
  findPathRelationsByBackingObjectId,
  findPathRelationsByBackingObjectIds,
  findPathRelationsByTargetAnchor,
  findPathRelationsByWorkspace,
  findPathRelationsByWorkspacePage,
  type PathRelationQueryContext
} from "./path-relation-read-queries.js";
import {
  PARSED_ROW_CACHE_MAX,
  comparePathRelationOrder,
  parseParsedRowCacheMax,
  parsePathRelation,
  parsePathRelationRow,
  type PathRelationRow
} from "./path-relation-rows.js";
import { findByAnchorsSql } from "./path-relation-sql.js";
import {
  preparePathRelationStatements,
  type PathRelationStatements
} from "./path-relation-statements.js";
import type { PathRelationPageOptions, PathRelationRepo } from "./path-relation-types.js";

export type { PathRelationPageOptions, PathRelationRepo } from "./path-relation-types.js";
export {
  PATH_RELATION_SOURCE_ANCHOR_KEY_SQL,
  PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL,
  PATH_RELATION_TARGET_ANCHOR_KEY_SQL,
  PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL
} from "./path-relation-sql.js";

export class SqlitePathRelationRepo implements PathRelationRepo {
  // Parsed rows keyed by path_id, validated against updated_at on every hit.
  // Recall's governance-ceiling and path-expansion stages re-read most of the
  // edge table per query; rows are immutable between mutations, so re-running
  // the deep zod parse on every read dominated recall CPU. In-process mutations
  // evict below; the daemon is the single writer-of-record for this DB.
  private readonly parsedRowCache = new Map<
    string,
    { readonly updatedAt: string; readonly relation: Readonly<PathRelation> }
  >();
  private readonly parsedRowCacheMax: number;
  private readonly statements: PathRelationStatements;

  public constructor(
    private readonly db: StorageDatabase,
    options: {
      readonly parsedRowCacheMax?: number;
    } = {}
  ) {
    this.parsedRowCacheMax = parseParsedRowCacheMax(options.parsedRowCacheMax ?? PARSED_ROW_CACHE_MAX);
    this.statements = preparePathRelationStatements(db);
  }

  public create(relation: PathRelation): Readonly<PathRelation> {
    const parsedRelation = parsePathRelation(relation);

    try {
      this.statements.createStatement.run(
        parsedRelation.path_id,
        parsedRelation.workspace_id,
        JSON.stringify(parsedRelation.anchors),
        JSON.stringify(parsedRelation.constitution),
        JSON.stringify(parsedRelation.effect_vector),
        JSON.stringify(parsedRelation.plasticity_state),
        JSON.stringify(parsedRelation.lifecycle),
        JSON.stringify(parsedRelation.legitimacy),
        parsedRelation.created_at,
        parsedRelation.updated_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to insert path relation ${parsedRelation.path_id}.`,
        error
      );
    }

    let row: PathRelationRow | undefined;
    try {
      row = this.statements.findByIdStatement.get(parsedRelation.path_id) as PathRelationRow | undefined;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load path relation ${parsedRelation.path_id}.`,
        error
      );
    }

    if (row === undefined) {
      throw new StorageError(
        "NOT_FOUND",
        `Path relation ${parsedRelation.path_id} was not found after insert.`
      );
    }

    this.parsedRowCache.delete(parsedRelation.path_id);
    return this.parseRowCached(row);
  }

  /**
   * Required by `PathPlasticityService` so that `appendManyWithMutation`
   * can wrap the EventLog row and the `path_relation` mutation in one
   * SQLite transaction, closing the race for path-relation writes.
   */
  public update(
    pathId: string,
    updates: Partial<
      Pick<
        PathRelation,
        "constitution" | "effect_vector" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at"
      >
    >
  ): Readonly<PathRelation> {
    const parsedPathId = parseNonEmptyString(pathId, "path id");
    const existing = this.loadExistingRelationForUpdate(parsedPathId);
    const nextRelation = parsePathRelation({
      ...existing,
      constitution: updates.constitution ?? existing.constitution,
      effect_vector: updates.effect_vector ?? existing.effect_vector,
      plasticity_state: updates.plasticity_state ?? existing.plasticity_state,
      lifecycle: updates.lifecycle ?? existing.lifecycle,
      legitimacy: updates.legitimacy ?? existing.legitimacy,
      updated_at: updates.updated_at ?? existing.updated_at
    });

    try {
      const changes = this.statements.updateStatement.run(
        JSON.stringify(nextRelation.constitution),
        JSON.stringify(nextRelation.effect_vector),
        JSON.stringify(nextRelation.plasticity_state),
        JSON.stringify(nextRelation.lifecycle),
        JSON.stringify(nextRelation.legitimacy),
        nextRelation.updated_at,
        parsedPathId
      ).changes;

      if (changes === 0) {
        throw new StorageError("NOT_FOUND", `Path relation ${parsedPathId} was not found.`);
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update path relation ${parsedPathId}.`,
        error
      );
    }

    return this.reloadUpdatedRelation(parsedPathId);
  }

  public async findById(pathId: string): Promise<Readonly<PathRelation> | null> {
    return await findPathRelationById(this.queryContext(), pathId);
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<PathRelation>[]> {
    return await findPathRelationsByWorkspace(this.queryContext(), workspaceId);
  }

  public async findByWorkspaceAll(workspaceId: string): Promise<readonly Readonly<PathRelation>[]> {
    return await findAllPathRelationsByWorkspace(this.queryContext(), workspaceId);
  }

  public async findByWorkspacePage(
    workspaceId: string,
    page: PathRelationPageOptions
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findPathRelationsByWorkspacePage(this.queryContext(), workspaceId, page);
  }

  public async findByAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findPathRelationsByAnchor(this.queryContext(), workspaceId, anchorRef);
  }

  public async findByTargetAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findPathRelationsByTargetAnchor(this.queryContext(), workspaceId, anchorRef);
  }

  public async findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findPathRelationsByAnchors(this.queryContext(), workspaceId, anchorRefs);
  }

  public async findByBackingObjectId(
    workspaceId: string,
    objectId: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findPathRelationsByBackingObjectId(this.queryContext(), workspaceId, objectId);
  }

  public async findByBackingObjectIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findPathRelationsByBackingObjectIds(this.queryContext(), workspaceId, objectIds);
  }

  /**
   * Default active-path list for bounded surfaces. Topology/graph repair flows
   * must use `findActiveAll`.
   */
  public async findActive(workspaceId: string): Promise<readonly Readonly<PathRelation>[]> {
    return await findActivePathRelations(this.queryContext(), workspaceId);
  }

  public async findActiveAll(workspaceId: string): Promise<readonly Readonly<PathRelation>[]> {
    return await findAllActivePathRelations(this.queryContext(), workspaceId);
  }

  public async findActivePage(
    workspaceId: string,
    page: PathRelationPageOptions
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findActivePathRelationPage(this.queryContext(), workspaceId, page);
  }

  /**
   * Default dormant-path list for bounded surfaces. Consolidation planning must
   * use `findDormantAll`.
   */
  public async findDormant(
    workspaceId: string,
    olderThanIso: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findDormantPathRelations(this.queryContext(), workspaceId, olderThanIso);
  }

  public async findDormantAll(
    workspaceId: string,
    olderThanIso: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findAllDormantPathRelations(this.queryContext(), workspaceId, olderThanIso);
  }

  public async findDormantPage(
    workspaceId: string,
    olderThanIso: string,
    page: PathRelationPageOptions
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await findDormantPathRelationPage(this.queryContext(), workspaceId, olderThanIso, page);
  }

  public async delete(pathId: string): Promise<void> {
    const parsedPathId = parseNonEmptyString(pathId, "path id");

    try {
      this.statements.deleteStatement.run(parsedPathId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to delete path relation ${parsedPathId}.`, error);
    }

    this.parsedRowCache.delete(parsedPathId);
  }

  public __anchorLookupSqlForTest(): Readonly<{
    readonly findBySourceAnchor: string;
    readonly findByTargetAnchor: string;
    readonly findByAnchors: (keyCount: number) => string;
    readonly findByBackingObjectId: string;
  }> {
    return Object.freeze({
      findBySourceAnchor: this.statements.findBySourceAnchorStatement.source,
      findByTargetAnchor: this.statements.findByTargetAnchorStatement.source,
      findByAnchors: (keyCount: number) => findByAnchorsSql(keyCount),
      findByBackingObjectId: this.statements.findByBackingObjectIdStatement.source
    });
  }

  private loadExistingRelationForUpdate(parsedPathId: string): Readonly<PathRelation> {
    let existingRow: PathRelationRow | undefined;
    try {
      existingRow = this.statements.findByIdStatement.get(parsedPathId) as PathRelationRow | undefined;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load path relation ${parsedPathId}.`, error);
    }

    if (existingRow === undefined) {
      throw new StorageError("NOT_FOUND", `Path relation ${parsedPathId} was not found.`);
    }

    return this.parseRowCached(existingRow);
  }

  private reloadUpdatedRelation(parsedPathId: string): Readonly<PathRelation> {
    let updatedRow: PathRelationRow | undefined;
    try {
      updatedRow = this.statements.findByIdStatement.get(parsedPathId) as PathRelationRow | undefined;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to reload path relation ${parsedPathId} after update.`,
        error
      );
    }

    if (updatedRow === undefined) {
      throw new StorageError(
        "NOT_FOUND",
        `Path relation ${parsedPathId} was not found after update.`
      );
    }

    // Evict before re-parsing: callers may update fields without bumping
    // updated_at, which the cache key alone would mistake for an unchanged row.
    this.parsedRowCache.delete(parsedPathId);
    return this.parseRowCached(updatedRow);
  }

  private queryContext(): PathRelationQueryContext {
    return {
      db: this.db,
      statements: this.statements,
      parseRow: (row) => this.parseRowCached(row),
      parseRows: (rows, options) => this.parseRowsCached(rows, options)
    };
  }

  private parseRowCached(row: PathRelationRow): Readonly<PathRelation> {
    const cached = this.parsedRowCache.get(row.path_id);
    if (cached !== undefined && cached.updatedAt === row.updated_at) {
      this.parsedRowCache.delete(row.path_id);
      this.parsedRowCache.set(row.path_id, cached);
      return cached.relation;
    }
    const relation = parsePathRelationRow(row);
    if (this.parsedRowCache.has(row.path_id)) {
      this.parsedRowCache.delete(row.path_id);
    }
    if (this.parsedRowCache.size >= this.parsedRowCacheMax) {
      const oldestKey = this.parsedRowCache.keys().next().value;
      if (typeof oldestKey === "string") {
        this.parsedRowCache.delete(oldestKey);
      }
    }
    this.parsedRowCache.set(row.path_id, { updatedAt: row.updated_at, relation });
    return relation;
  }

  private parseRowsCached(
    rows: readonly PathRelationRow[],
    options: {
      readonly dedupe?: boolean;
    } = {}
  ): readonly Readonly<PathRelation>[] {
    const relations = rows.map((row) => this.parseRowCached(row));

    if (!options.dedupe) {
      return deepFreeze(relations);
    }

    const deduped = new Map<string, Readonly<PathRelation>>();
    for (const relation of relations) {
      deduped.set(relation.path_id, relation);
    }

    return deepFreeze(
      [...deduped.values()].sort((left, right) => comparePathRelationOrder(left, right))
    );
  }
}
