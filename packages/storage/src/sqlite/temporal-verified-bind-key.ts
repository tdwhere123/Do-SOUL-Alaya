import BetterSqlite3 from "better-sqlite3";
import { StorageError } from "../shared/errors.js";
import {
  readNonEmptyStringField,
  readNonNegativeIntField,
  readIntegerField,
  readRecord,
  type RowParser
} from "../repos/shared/parse-row.js";
import { selectRows } from "../repos/shared/select-rows.js";
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

const BindKeyGroupParser: RowParser<{ readonly as_of: string; readonly history_digest: string }> = {
  parse(value: unknown): { readonly as_of: string; readonly history_digest: string } {
    const record = readRecord(value, "verified bind-key group");
    return {
      as_of: readNonEmptyStringField(record, "as_of"),
      history_digest: readNonEmptyStringField(record, "history_digest")
    };
  }
};

const BindKeyRowParser: RowParser<BindKeyRow> = {
  parse(value: unknown): BindKeyRow {
    const record = readRecord(value, "verified bind-key row");
    return {
      rowid: readIntegerField(record, "rowid"),
      generation: readNonEmptyStringField(record, "generation"),
      projection_count: readNonNegativeIntField(record, "projection_count"),
      projection_digest: readNonEmptyStringField(record, "projection_digest"),
      assertion_schema_generation: readNonEmptyStringField(record, "assertion_schema_generation"),
      assertion_event_contract_generation: readNonEmptyStringField(
        record,
        "assertion_event_contract_generation"
      ),
      projection_schema_generation: readNonEmptyStringField(record, "projection_schema_generation"),
      projection_policy_id: readNonEmptyStringField(record, "projection_policy_id"),
      projection_policy_sha256: readNonEmptyStringField(record, "projection_policy_sha256")
    };
  }
};


export function migrateVerifiedProjectionBindKey(database: SqliteConnection): void {
  collapseCompatibleVerifiedBindKeyDuplicates(database);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${TEMPORAL_VERIFIED_BIND_KEY_INDEX}
    ON temporal_projection_generations(as_of, history_digest)
    WHERE status = 'verified'
  `);
}

function collapseCompatibleVerifiedBindKeyDuplicates(database: SqliteConnection): void {
  const groups = selectRows(
    database,
    `
    SELECT as_of, history_digest
    FROM temporal_projection_generations
    WHERE status = 'verified'
    GROUP BY as_of, history_digest
    HAVING COUNT(*) > 1
  `,
    [],
    BindKeyGroupParser,
    "verified bind-key group"
  );
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
  const rows = selectRows(
    database,
    `
    SELECT rowid, generation, projection_count, projection_digest,
           assertion_schema_generation, assertion_event_contract_generation,
           projection_schema_generation, projection_policy_id, projection_policy_sha256
    FROM temporal_projection_generations
    WHERE as_of = ? AND history_digest = ? AND status = 'verified'
    ORDER BY generation ASC, rowid ASC
  `,
    [asOf, historyDigest],
    BindKeyRowParser,
    "verified bind-key row"
  );
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
