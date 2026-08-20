import BetterSqlite3 from "better-sqlite3";
import { StorageError } from "../shared/errors.js";
import {
  isCompatibleProjectionIdentity,
  type ProjectionIdentity
} from "./projection-identity.js";

type SqliteConnection = InstanceType<typeof BetterSqlite3>;

export const TEMPORAL_VERIFIED_BIND_KEY_MIGRATION_VERSION = 8;
export const TEMPORAL_VERIFIED_BIND_KEY_INDEX =
  "idx_temporal_projection_generations_verified_bind_key";

const BOOTSTRAP_GENERATION = "temporal-bootstrap-empty-v1";

type BindKeyRow = ProjectionIdentity & Readonly<{
  readonly generation: string;
  readonly rowid: number;
}>;

export function migrateVerifiedProjectionBindKey(database: SqliteConnection): void {
  collapseCompatibleVerifiedBindKeyDuplicates(database);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${TEMPORAL_VERIFIED_BIND_KEY_INDEX}
    ON temporal_projection_generations(as_of, history_digest)
    WHERE status = 'verified'
  `);
}

function collapseCompatibleVerifiedBindKeyDuplicates(database: SqliteConnection): void {
  const groups = database.prepare(`
    SELECT as_of, history_digest
    FROM temporal_projection_generations
    WHERE status = 'verified'
    GROUP BY as_of, history_digest
    HAVING COUNT(*) > 1
  `).all() as ReadonlyArray<{ readonly as_of: string; readonly history_digest: string }>;
  if (groups.length === 0) return;

  const active = readActiveProjectionGeneration(database);
  for (const group of groups) {
    collapseVerifiedBindKeyGroup(database, group.as_of, group.history_digest, active);
  }
}

function collapseVerifiedBindKeyGroup(
  database: SqliteConnection,
  asOf: string,
  historyDigest: string,
  activeGeneration: string | null
): void {
  const rows = database.prepare(`
    SELECT rowid, generation, projection_count, projection_digest,
           assertion_schema_generation, assertion_event_contract_generation,
           projection_schema_generation, projection_policy_id, projection_policy_sha256
    FROM temporal_projection_generations
    WHERE as_of = ? AND history_digest = ? AND status = 'verified'
    ORDER BY generation ASC, rowid ASC
  `).all(asOf, historyDigest) as BindKeyRow[];
  const winner = selectCompatibleWinner(rows, activeGeneration);
  deleteLosingVerifiedGenerations(database, rows, winner.generation);
}

function selectCompatibleWinner(
  rows: readonly BindKeyRow[],
  activeGeneration: string | null
): BindKeyRow {
  const [first, ...rest] = rows;
  if (first === undefined) {
    throw new StorageError("CONFLICT", "Verified bind-key collapse found an empty group.");
  }
  for (const row of rest) {
    if (!isCompatibleProjectionIdentity(first, row)) {
      throw new StorageError(
        "CONFLICT",
        "Incompatible verified temporal projection bind-key duplicates cannot be collapsed."
      );
    }
  }
  return [...rows].sort((left, right) =>
    compareBindKeyPreference(left, right, activeGeneration)
  )[0] ?? first;
}

function compareBindKeyPreference(
  left: BindKeyRow,
  right: BindKeyRow,
  activeGeneration: string | null
): number {
  const byActive = Number(right.generation === activeGeneration) -
    Number(left.generation === activeGeneration);
  if (byActive !== 0) return byActive;
  const byBootstrap = Number(right.generation === BOOTSTRAP_GENERATION) -
    Number(left.generation === BOOTSTRAP_GENERATION);
  if (byBootstrap !== 0) return byBootstrap;
  const byId = left.generation.localeCompare(right.generation);
  if (byId !== 0) return byId;
  return left.rowid - right.rowid;
}

function deleteLosingVerifiedGenerations(
  database: SqliteConnection,
  rows: readonly BindKeyRow[],
  winnerGeneration: string
): void {
  const deleteProjections = database.prepare(
    "DELETE FROM relation_path_projections WHERE generation = ?"
  );
  const deleteGeneration = database.prepare(
    "DELETE FROM temporal_projection_generations WHERE generation = ?"
  );
  for (const row of rows) {
    if (row.generation === winnerGeneration) continue;
    deleteProjections.run(row.generation);
    deleteGeneration.run(row.generation);
  }
}

function readActiveProjectionGeneration(database: SqliteConnection): string | null {
  const row = database.prepare(`
    SELECT active_projection_generation
    FROM temporal_schema_state
    WHERE state_id = 1
  `).get() as Readonly<{ readonly active_projection_generation: string | null }> | undefined;
  return row?.active_projection_generation ?? null;
}
