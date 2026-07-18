import { PathRelationSchema, type PathRelation } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import {
  parseRelationAssertionJson,
  wrapRelationAssertionStorageError
} from "../relation-assertion-repo-support.js";

type ProjectionRow = Readonly<{ readonly projection_json: string }>;

export function readActiveProjectionGeneration(
  db: StorageDatabase
): string | null {
  try {
    const row = db.connection.prepare(`
      SELECT active_projection_generation
      FROM temporal_schema_state
      WHERE state_id = 1 AND status = 'ready'
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
  try {
    const rows = db.connection.prepare(`
      SELECT projection_json
      FROM relation_path_projections
      WHERE generation = (
        SELECT active_projection_generation
        FROM temporal_schema_state
        WHERE state_id = 1 AND status = 'ready'
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
  try {
    const row = db.connection.prepare(`
      SELECT projection_json
      FROM relation_path_projections
      WHERE generation = (
        SELECT active_projection_generation
        FROM temporal_schema_state
        WHERE state_id = 1 AND status = 'ready'
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
  // Historical projections are caches: only current verified history may serve.
  const row = db.connection.prepare(`
    SELECT generation
    FROM temporal_projection_generations
    WHERE as_of = ?
      AND history_digest = (
        SELECT history_digest FROM temporal_schema_state
        WHERE state_id = 1 AND status = 'ready'
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
