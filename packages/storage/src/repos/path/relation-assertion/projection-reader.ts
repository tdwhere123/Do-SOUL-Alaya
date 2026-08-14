import { PathRelationSchema, type PathRelation } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import {
  parseRelationAssertionJson,
  wrapRelationAssertionStorageError
} from "../relation-assertion-repo-support.js";

type ProjectionRow = Readonly<{ readonly projection_json: string }>;

export function assertRelationProjectionCurrent(db: StorageDatabase): void {
  const row = db.connection.prepare(`
    SELECT projection_refresh_required
    FROM temporal_schema_state
    WHERE state_id = 1 AND status = 'ready'
    LIMIT 1
  `).get() as Readonly<{ readonly projection_refresh_required: number }> | undefined;
  if (row === undefined || row.projection_refresh_required !== 0) {
    throw new StorageError(
      "CONFLICT",
      "Temporal relation projection requires a refresh before it can be read or frozen."
    );
  }
}

export function isRelationProjectionReadable(db: StorageDatabase): boolean {
  try {
    const row = db.connection.prepare(`
      SELECT projection_refresh_required
      FROM temporal_schema_state
      WHERE state_id = 1 AND status = 'ready'
      LIMIT 1
    `).get() as Readonly<{ readonly projection_refresh_required: number }> | undefined;
    return row !== undefined && row.projection_refresh_required === 0;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw wrapRelationAssertionStorageError("inspect relation projection readability", error);
  }
}

export function isLegacyPathIndexUnbound(db: StorageDatabase): boolean {
  return (isRelationProjectionPopulated(db) || isRelationProjectionRefreshPending(db))
    && isPathRelationsTableEmpty(db);
}

export function readActiveProjectionGeneration(
  db: StorageDatabase
): string | null {
  try {
    const row = db.connection.prepare(`
      SELECT active_projection_generation
      FROM temporal_schema_state
      WHERE state_id = 1 AND status = 'ready' AND projection_refresh_required = 0
      LIMIT 1
    `).get() as Readonly<{ readonly active_projection_generation: string | null }> | undefined;
    return row?.active_projection_generation ?? null;
  } catch (error) {
    throw wrapRelationAssertionStorageError("read active projection generation", error);
  }
}

export async function findActiveProjectionByWorkspace(
  db: StorageDatabase,
  workspaceId: string
): Promise<readonly Readonly<PathRelation>[]> {
  assertRelationProjectionCurrent(db);
  try {
    const rows = db.connection.prepare(`
      SELECT projection_json
      FROM relation_path_projections
      WHERE generation = (
        SELECT active_projection_generation
        FROM temporal_schema_state
        WHERE state_id = 1 AND status = 'ready' AND projection_refresh_required = 0
      ) AND workspace_id = ?
      ORDER BY path_id ASC
    `).all(workspaceId) as ProjectionRow[];
    return Object.freeze(rows.map(parseProjectionRow));
  } catch (error) {
    throw wrapRelationAssertionStorageError("read active relation projections", error);
  }
}

export async function findActiveProjectionById(
  db: StorageDatabase,
  pathId: string
): Promise<Readonly<PathRelation> | null> {
  assertRelationProjectionCurrent(db);
  try {
    const row = db.connection.prepare(`
      SELECT projection_json
      FROM relation_path_projections
      WHERE generation = (
        SELECT active_projection_generation
        FROM temporal_schema_state
        WHERE state_id = 1 AND status = 'ready' AND projection_refresh_required = 0
      ) AND path_id = ?
      LIMIT 1
    `).get(pathId) as ProjectionRow | undefined;
    return row === undefined ? null : parseProjectionRow(row);
  } catch (error) {
    throw wrapRelationAssertionStorageError("read active relation projection", error);
  }
}

export async function findProjectionByWorkspaceAtAsOf(
  db: StorageDatabase,
  workspaceId: string,
  asOf: string
): Promise<readonly Readonly<PathRelation>[] | null> {
  assertRelationProjectionCurrent(db);
  try {
    const generation = findVerifiedGenerationAtAsOf(db, asOf);
    if (generation === null) return null;
    const rows = db.connection.prepare(`
      SELECT projection_json
      FROM relation_path_projections
      WHERE generation = ? AND workspace_id = ?
      ORDER BY path_id ASC
    `).all(generation, workspaceId) as ProjectionRow[];
    return Object.freeze(rows.map(parseProjectionRow));
  } catch (error) {
    throw wrapRelationAssertionStorageError("read relation projection at as-of", error);
  }
}

function findVerifiedGenerationAtAsOf(
  db: StorageDatabase,
  asOf: string
): string | null {
  // Exact as_of is the generation key; a later verified cache must not stand in.
  const row = db.connection.prepare(`
    SELECT generation
    FROM temporal_projection_generations
    WHERE as_of = ?
      AND history_digest = (
        SELECT history_digest FROM temporal_schema_state
        WHERE state_id = 1 AND status = 'ready' AND projection_refresh_required = 0
      ) AND status = 'verified'
    LIMIT 1
  `).get(asOf) as Readonly<{ readonly generation: string }> | undefined;
  return row?.generation ?? null;
}

function parseProjectionRow(row: ProjectionRow): Readonly<PathRelation> {
  return PathRelationSchema.parse(
    parseRelationAssertionJson(row.projection_json, "relation path projection")
  );
}

function isRelationProjectionPopulated(db: StorageDatabase): boolean {
  if (!isRelationProjectionReadable(db)) return false;
  try {
    const row = db.connection.prepare(`
      SELECT projection_count
      FROM temporal_schema_state
      WHERE state_id = 1 AND status = 'ready' AND projection_refresh_required = 0
    `).get() as Readonly<{ readonly projection_count: number }> | undefined;
    return row !== undefined && row.projection_count > 0;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw wrapRelationAssertionStorageError("inspect relation projection population", error);
  }
}

function isRelationProjectionRefreshPending(db: StorageDatabase): boolean {
  try {
    const row = db.connection.prepare(`
      SELECT projection_refresh_required
      FROM temporal_schema_state
      WHERE state_id = 1 AND status = 'ready'
      LIMIT 1
    `).get() as Readonly<{ readonly projection_refresh_required: number }> | undefined;
    return row !== undefined && row.projection_refresh_required !== 0;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw wrapRelationAssertionStorageError("inspect relation projection refresh", error);
  }
}

function isPathRelationsTableEmpty(db: StorageDatabase): boolean {
  try {
    return db.connection.prepare("SELECT 1 FROM path_relations LIMIT 1").get() === undefined;
  } catch (error) {
    if (isMissingTableError(error)) return true;
    throw wrapRelationAssertionStorageError("inspect legacy path_relations vacancy", error);
  }
}

function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/iu.test(error.message);
}
