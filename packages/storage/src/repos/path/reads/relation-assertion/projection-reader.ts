import { PathRelationSchema, type PathRelation } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../../sqlite/db.js";
import { StorageError } from "../../../../shared/errors.js";
import {
  parseRelationAssertionJson,
  wrapRelationAssertionStorageError
} from "../../relation-assertion-repo-support.js";

type ProjectionRow = Readonly<{ readonly projection_json: string }>;

type CurrentProjectionReadRow = Readonly<{
  readonly state_status: string;
  readonly projection_refresh_required: number;
  readonly active_projection_generation: string | null;
  readonly active_as_of: string | null;
  readonly assertion_schema_generation: string;
  readonly assertion_event_contract_generation: string;
  readonly projection_schema_generation: string;
  readonly projection_policy_id: string | null;
  readonly projection_policy_sha256: string | null;
  readonly history_digest: string | null;
  readonly projection_count: number;
  readonly projection_digest: string | null;
  readonly generation: string | null;
  readonly generation_assertion_schema_generation: string | null;
  readonly generation_assertion_event_contract_generation: string | null;
  readonly generation_projection_schema_generation: string | null;
  readonly generation_projection_policy_id: string | null;
  readonly generation_projection_policy_sha256: string | null;
  readonly generation_history_digest: string | null;
  readonly generation_as_of: string | null;
  readonly generation_projection_count: number | null;
  readonly generation_projection_digest: string | null;
  readonly generation_status: string | null;
  readonly generation_verified_at: string | null;
  readonly projection_rows: number;
}>;

export function assertRelationProjectionCurrent(db: StorageDatabase): void {
  if (!readCurrentProjectionStatus(db)) {
    throw new StorageError(
      "CONFLICT",
      "Temporal relation projection requires a refresh before it can be read or frozen."
    );
  }
}

export function isRelationProjectionReadable(db: StorageDatabase): boolean {
  try {
    return readCurrentProjectionStatus(db);
  } catch (error) {
    if (isMissingTableError(error)) return false;
    if (error instanceof StorageError) throw error;
    throw wrapRelationAssertionStorageError("inspect relation projection readability", error);
  }
}

function readCurrentProjectionStatus(db: StorageDatabase): boolean {
  const row = db.connection.prepare(`
    SELECT
      state.status AS state_status,
      state.projection_refresh_required,
      state.active_projection_generation,
      state.active_as_of,
      state.assertion_schema_generation,
      state.assertion_event_contract_generation,
      state.projection_schema_generation,
      state.projection_policy_id,
      state.projection_policy_sha256,
      state.history_digest,
      state.projection_count,
      state.projection_digest,
      generation.generation,
      generation.assertion_schema_generation AS generation_assertion_schema_generation,
      generation.assertion_event_contract_generation AS generation_assertion_event_contract_generation,
      generation.projection_schema_generation AS generation_projection_schema_generation,
      generation.projection_policy_id AS generation_projection_policy_id,
      generation.projection_policy_sha256 AS generation_projection_policy_sha256,
      generation.history_digest AS generation_history_digest,
      generation.as_of AS generation_as_of,
      generation.projection_count AS generation_projection_count,
      generation.projection_digest AS generation_projection_digest,
      generation.status AS generation_status,
      generation.verified_at AS generation_verified_at,
      (
        SELECT COUNT(*)
        FROM relation_path_projections AS projection
        WHERE projection.generation = state.active_projection_generation
      ) AS projection_rows
    FROM temporal_schema_state AS state
    LEFT JOIN temporal_projection_generations AS generation
      ON generation.generation = state.active_projection_generation
    WHERE state.state_id = 1
    LIMIT 1
  `).get() as CurrentProjectionReadRow | undefined;
  if (row === undefined || row.state_status !== "ready" ||
      row.projection_refresh_required !== 0) return false;
  if (!hasVerifiedCurrentProjection(row)) {
    throw new StorageError(
      "CONFLICT",
      "Temporal relation projection active generation is missing or inconsistent."
    );
  }
  return true;
}

function hasVerifiedCurrentProjection(row: CurrentProjectionReadRow): boolean {
  return typeof row.active_projection_generation === "string" &&
    row.active_projection_generation.length > 0 &&
    row.generation === row.active_projection_generation &&
    row.generation_assertion_schema_generation === row.assertion_schema_generation &&
    row.generation_assertion_event_contract_generation ===
      row.assertion_event_contract_generation &&
    row.generation_projection_schema_generation === row.projection_schema_generation &&
    row.generation_projection_policy_id === row.projection_policy_id &&
    row.generation_projection_policy_sha256 === row.projection_policy_sha256 &&
    row.generation_history_digest === row.history_digest &&
    row.generation_as_of === row.active_as_of &&
    row.generation_projection_count === row.projection_count &&
    row.generation_projection_digest === row.projection_digest &&
    row.generation_status === "verified" &&
    typeof row.generation_verified_at === "string" &&
    row.generation_verified_at.length > 0 &&
    row.projection_rows === row.projection_count;
}

export function isLegacyPathIndexUnbound(db: StorageDatabase): boolean {
  return (isRelationProjectionPopulated(db) || isRelationProjectionRefreshPending(db))
    && isPathRelationsTableEmpty(db);
}

export function readCurrentHistoryDigest(db: StorageDatabase): string | null {
  try {
    const row = db.connection.prepare(`
      SELECT history_digest
      FROM temporal_schema_state
      WHERE state_id = 1
      LIMIT 1
    `).get() as Readonly<{ readonly history_digest: string | null }> | undefined;
    return row?.history_digest ?? null;
  } catch (error) {
    throw wrapRelationAssertionStorageError("read current relation history digest", error);
  }
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
    if (error instanceof StorageError) throw error;
    throw wrapRelationAssertionStorageError("read relation projection at as-of", error);
  }
}

function findVerifiedGenerationAtAsOf(
  db: StorageDatabase,
  asOf: string
): string | null {
  // Exact as_of is the generation key; a later verified cache must not stand in.
  const rows = db.connection.prepare(`
    SELECT generation
    FROM temporal_projection_generations
    WHERE as_of = ?
      AND history_digest = (
        SELECT history_digest FROM temporal_schema_state
        WHERE state_id = 1 AND status = 'ready' AND projection_refresh_required = 0
      ) AND status = 'verified'
  `).all(asOf) as ReadonlyArray<{ readonly generation: string }>;
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new StorageError(
      "CONFLICT",
      "Duplicate verified temporal projection bind key."
    );
  }
  return rows[0]?.generation ?? null;
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
