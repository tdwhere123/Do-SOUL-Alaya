import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { StorageError } from "../shared/errors.js";

type SqliteConnection = InstanceType<typeof BetterSqlite3>;

export const TEMPORAL_OFFLINE_MIGRATION_VERSION = 108;

export type TemporalDatabaseMode = "runtime" | "fresh-bootstrap" | "candidate";

const TEMPORAL_ASSERTION_SCHEMA_GENERATION = "relation_assertion_v1";
const TEMPORAL_ASSERTION_EVENT_CONTRACT_GENERATION = "relation_assertion_event_v1";
const TEMPORAL_PROJECTION_SCHEMA_GENERATION = "relation_path_projection_v1";
const TEMPORAL_BOOTSTRAP_GENERATION = "temporal-bootstrap-empty-v1";
const TEMPORAL_PROJECTION_POLICY_ID = "relation-path-projection-v1";
const TEMPORAL_PROJECTION_POLICY_SHA256 = "f68603e497a8d762e5d0ed96e8cd9608475794ccef92c6c3fbc37b76daea7ee7";
const EMPTY_TEMPORAL_HISTORY_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_TEMPORAL_PROJECTION_AS_OF = "1970-01-01T00:00:00.000Z";

export function resolveTemporalDatabaseMode(
  filename: string,
  requestedMode: TemporalDatabaseMode | undefined
): TemporalDatabaseMode {
  if (requestedMode !== undefined) return requestedMode;
  // A non-existent target has no legacy truth to mutate. Existing files must
  // pass the readonly runtime gate before SQLite gains write access.
  return filename === ":memory:" || !fs.existsSync(filename) ? "fresh-bootstrap" : "runtime";
}

export function assertRuntimeTemporalDatabaseReady(
  filename: string,
  knownMaxVersion: number
): void {
  assertTemporalDatabaseReady(filename, knownMaxVersion, true);
}

/**
 * Candidate preparation and explicit selection may inspect a verified temporal
 * database before it becomes a runtime-selected projection. Runtime callers
 * must use `assertRuntimeTemporalDatabaseReady` instead.
 */
export function assertTemporalCandidateDatabaseReady(
  filename: string,
  knownMaxVersion: number
): void {
  assertTemporalDatabaseReady(filename, knownMaxVersion, false);
}

function assertTemporalDatabaseReady(
  filename: string,
  knownMaxVersion: number,
  requireSelected: boolean
): void {
  let database: SqliteConnection | undefined;
  try {
    database = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    assertCanonicalSchemaVersionTable(database);
    const versions = database.prepare("SELECT version FROM schema_version ORDER BY version ASC")
      .all() as ReadonlyArray<Readonly<{ version: unknown }>>;
    assertOrderedSafeMigrationVersions(versions.map((row) => row.version));
    const persistedMaxVersion = versions.at(-1)?.version as number | undefined;
    if (persistedMaxVersion !== undefined && persistedMaxVersion > knownMaxVersion) {
      throw new StorageError(
        "STORAGE_VERSION_AHEAD",
        `Database schema version ${persistedMaxVersion} is ahead of this binary's known max ${knownMaxVersion}. ` +
          "Upgrade Alaya or restore a database matching this version."
      );
    }
    if (!versions.some((row) => row.version === TEMPORAL_OFFLINE_MIGRATION_VERSION)) {
      throw new StorageError(
        "CONFLICT",
        "Temporal relation migration is pending. Run the offline candidate cutover; runtime will not alter this database."
      );
    }

    const state = database.prepare(
      `SELECT assertion_schema_generation, assertion_event_contract_generation,
              projection_schema_generation, active_projection_generation, active_as_of,
              projection_policy_id, projection_policy_sha256, history_digest,
              projection_count, projection_digest, status, temporal_projection_selected,
              temporal_projection_selection_required, selection_id, selected_at
         FROM temporal_schema_state
        WHERE state_id = 1`
    ).get() as Readonly<Record<string, unknown>> | undefined;
    if (state === undefined || !isVerifiedTemporalState(state) || !hasVerifiedActiveProjection(database, state)) {
      throw new StorageError(
        "CONFLICT",
        "Temporal relation schema is missing, unknown, or mixed. Runtime startup is fail-closed until a verified candidate is selected."
      );
    }
    // Fresh bootstrap has no legacy source truth to replace, so it deliberately
    // remains a compatible pre-cutover state. Only offline candidates require
    // an explicit selected receipt before a normal runtime can use them.
    if (
      requireSelected &&
      state?.temporal_projection_selection_required === 1 &&
      state.temporal_projection_selected !== 1
    ) {
      throw new StorageError(
        "CONFLICT",
        "Temporal projection candidate is prepared but not selected. Runtime startup is fail-closed until explicit selection completes."
      );
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "CONFLICT",
      "Unable to prove this database has a verified temporal relation cutover; runtime startup is fail-closed.",
      error
    );
  } finally {
    database?.close();
  }
}

export function assertCanonicalSchemaVersionTable(database: SqliteConnection): void {
  const columns = database.prepare("PRAGMA table_info(schema_version)").all() as
    ReadonlyArray<Readonly<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>>;
  const actual = columns.map(({ cid, name, type, notnull, dflt_value, pk }) => ({
    cid, name, type: type.toUpperCase(), notnull, dflt_value, pk
  }));
  const expected = [
    { cid: 0, name: "version", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
    { cid: 1, name: "applied_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 }
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("schema_version table is not canonical");
  }
}

export function assertOrderedSafeMigrationVersions(
  versions: readonly unknown[]
): asserts versions is number[] {
  let previous = 0;
  for (const version of versions) {
    if (!Number.isSafeInteger(version) || (version as number) <= 0) {
      throw new Error("schema_version ledger contains an unsafe migration version");
    }
    if ((version as number) <= previous) {
      throw new Error("schema_version ledger is not strictly ordered and unique");
    }
    previous = version as number;
  }
}

export function migrateLegacyPathRelationsToTemporalCandidate(
  database: SqliteConnection,
  options: { readonly selectionRequired: boolean }
): void {
  const migratedAt = new Date().toISOString();
  const quarantines = listLegacyPathRelationQuarantines(database);
  const insertQuarantine = database.prepare(
    `INSERT INTO relation_assertion_quarantine (
       quarantine_id, workspace_id, source_kind, source_identity, reason,
       source_json, source_digest, quarantined_at
     ) VALUES (?, ?, 'legacy_path_relation', ?, 'missing_typed_validity', ?, ?, ?)`
  );

  for (const quarantine of quarantines) {
    insertQuarantine.run(
      `quarantine_${quarantine.sourceDigest}`,
      quarantine.workspaceId,
      quarantine.sourceIdentity,
      quarantine.sourceJson,
      quarantine.sourceDigest,
      migratedAt
    );
  }

  database.prepare(
    `INSERT INTO temporal_projection_generations (
       generation, assertion_schema_generation, assertion_event_contract_generation,
       projection_schema_generation, projection_policy_id, projection_policy_sha256,
       history_digest, as_of, projection_count, projection_digest, status,
       created_at, verified_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'verified', ?, ?)`
  ).run(
    TEMPORAL_BOOTSTRAP_GENERATION,
    TEMPORAL_ASSERTION_SCHEMA_GENERATION,
    TEMPORAL_ASSERTION_EVENT_CONTRACT_GENERATION,
    TEMPORAL_PROJECTION_SCHEMA_GENERATION,
    TEMPORAL_PROJECTION_POLICY_ID,
    TEMPORAL_PROJECTION_POLICY_SHA256,
    EMPTY_TEMPORAL_HISTORY_DIGEST,
    EMPTY_TEMPORAL_PROJECTION_AS_OF,
    EMPTY_TEMPORAL_HISTORY_DIGEST,
    migratedAt,
    migratedAt
  );
  database.prepare(
    `INSERT INTO temporal_schema_state (
       state_id, assertion_schema_generation, assertion_event_contract_generation,
       projection_schema_generation, active_projection_generation, active_as_of,
       projection_policy_id, projection_policy_sha256, history_digest,
       projection_count, projection_digest, status, temporal_projection_selection_required, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ready', ?, ?)`
  ).run(
    TEMPORAL_ASSERTION_SCHEMA_GENERATION,
    TEMPORAL_ASSERTION_EVENT_CONTRACT_GENERATION,
    TEMPORAL_PROJECTION_SCHEMA_GENERATION,
    TEMPORAL_BOOTSTRAP_GENERATION,
    EMPTY_TEMPORAL_PROJECTION_AS_OF,
    TEMPORAL_PROJECTION_POLICY_ID,
    TEMPORAL_PROJECTION_POLICY_SHA256,
    EMPTY_TEMPORAL_HISTORY_DIGEST,
    EMPTY_TEMPORAL_HISTORY_DIGEST,
    options.selectionRequired ? 1 : 0,
    migratedAt
  );
}

export function resolveMigrationsDirectory(): string {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(currentDirectory, "../migrations"),
    path.join(currentDirectory, "../../src/migrations")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new StorageError("MIGRATION_NOT_FOUND", "Unable to locate SQLite migration files.");
}

export function listMigrationFiles(migrationsDirectory: string): readonly string[] {
  return fs
    .readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

export function computeKnownMaxVersion(migrationFiles: readonly string[]): number {
  let maxVersion = 0;
  for (const fileName of migrationFiles) {
    const versionMatch = /^(\d+)-.+\.sql$/.exec(fileName);
    if (versionMatch === null) continue;
    const version = Number(versionMatch[1]);
    if (Number.isFinite(version) && version > maxVersion) maxVersion = version;
  }
  return maxVersion;
}

function isVerifiedTemporalState(state: Readonly<Record<string, unknown>> | undefined): boolean {
  return state !== undefined &&
    state.assertion_schema_generation === TEMPORAL_ASSERTION_SCHEMA_GENERATION &&
    state.assertion_event_contract_generation === TEMPORAL_ASSERTION_EVENT_CONTRACT_GENERATION &&
    state.projection_schema_generation === TEMPORAL_PROJECTION_SCHEMA_GENERATION &&
    typeof state.active_projection_generation === "string" && state.active_projection_generation.length > 0 &&
    typeof state.active_as_of === "string" && state.active_as_of.length > 0 &&
    state.projection_policy_id === TEMPORAL_PROJECTION_POLICY_ID &&
    state.projection_policy_sha256 === TEMPORAL_PROJECTION_POLICY_SHA256 &&
    typeof state.history_digest === "string" && /^[0-9a-f]{64}$/u.test(state.history_digest) &&
    Number.isSafeInteger(state.projection_count) && (state.projection_count as number) >= 0 &&
    typeof state.projection_digest === "string" && /^[0-9a-f]{64}$/u.test(state.projection_digest) &&
    state.status === "ready" &&
    (state.temporal_projection_selection_required === 0 ||
      state.temporal_projection_selection_required === 1) &&
    hasCanonicalSelectionState(state);
}

function hasVerifiedActiveProjection(
  database: SqliteConnection,
  state: Readonly<Record<string, unknown>>
): boolean {
  const activeGeneration = state.active_projection_generation;
  if (typeof activeGeneration !== "string") return false;
  const generation = database.prepare(`
    SELECT generation, assertion_schema_generation, assertion_event_contract_generation,
           projection_schema_generation, projection_policy_id, projection_policy_sha256,
           history_digest, as_of, projection_count, projection_digest, status, verified_at
    FROM temporal_projection_generations
    WHERE generation = ?
  `).get(activeGeneration) as Readonly<Record<string, unknown>> | undefined;
  const projectionRows = database.prepare(`
    SELECT COUNT(*) AS count
    FROM relation_path_projections
    WHERE generation = ?
  `).get(activeGeneration) as Readonly<{ readonly count: unknown }> | undefined;
  return generation !== undefined &&
    generation.generation === activeGeneration &&
    generation.assertion_schema_generation === state.assertion_schema_generation &&
    generation.assertion_event_contract_generation === state.assertion_event_contract_generation &&
    generation.projection_schema_generation === state.projection_schema_generation &&
    generation.projection_policy_id === state.projection_policy_id &&
    generation.projection_policy_sha256 === state.projection_policy_sha256 &&
    generation.history_digest === state.history_digest &&
    generation.as_of === state.active_as_of &&
    generation.projection_count === state.projection_count &&
    generation.projection_digest === state.projection_digest &&
    generation.status === "verified" &&
    typeof generation.verified_at === "string" && generation.verified_at.length > 0 &&
    projectionRows?.count === state.projection_count;
}

function hasCanonicalSelectionState(state: Readonly<Record<string, unknown>>): boolean {
  if (state.temporal_projection_selected === 0) {
    return state.selection_id === null && state.selected_at === null;
  }
  return state.temporal_projection_selected === 1 &&
    typeof state.selection_id === "string" && state.selection_id.length > 0 &&
    typeof state.selected_at === "string" && state.selected_at.length > 0;
}

type LegacyPathRow = Readonly<{
  readonly path_id: string;
  readonly workspace_id: string;
  readonly anchors_json: string;
  readonly constitution_json: string;
  readonly effect_vector_json: string;
  readonly plasticity_state_json: string;
  readonly lifecycle_json: string;
  readonly legitimacy_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}>;

export interface LegacyPathRelationQuarantine {
  readonly workspaceId: string;
  readonly sourceIdentity: string;
  readonly sourceJson: string;
  readonly sourceDigest: string;
}

export interface LegacyPathRelationQuarantineSummary {
  readonly count: number;
  readonly digest: string;
}

export function listLegacyPathRelationQuarantines(
  database: SqliteConnection
): readonly LegacyPathRelationQuarantine[] {
  const rows = database.prepare(
    `SELECT path_id, workspace_id, anchors_json, constitution_json, effect_vector_json,
            plasticity_state_json, lifecycle_json, legitimacy_json, created_at, updated_at
       FROM path_relations
      ORDER BY workspace_id ASC, path_id ASC`
  ).all() as LegacyPathRow[];
  return Object.freeze(rows.map((row) => {
    const sourceJson = canonicalJson({
      path_id: row.path_id,
      workspace_id: row.workspace_id,
      anchors: parseLegacyJson(row.anchors_json),
      constitution: parseLegacyJson(row.constitution_json),
      effect_vector: parseLegacyJson(row.effect_vector_json),
      plasticity_state: parseLegacyJson(row.plasticity_state_json),
      lifecycle: parseLegacyJson(row.lifecycle_json),
      legitimacy: parseLegacyJson(row.legitimacy_json),
      created_at: row.created_at,
      updated_at: row.updated_at
    });
    return Object.freeze({
      workspaceId: row.workspace_id,
      sourceIdentity: row.path_id,
      sourceJson,
      sourceDigest: sha256(sourceJson)
    });
  }));
}

export function summarizeLegacyPathRelationQuarantines(
  quarantines: readonly Pick<LegacyPathRelationQuarantine,
    "workspaceId" | "sourceIdentity" | "sourceDigest">[]
): LegacyPathRelationQuarantineSummary {
  return Object.freeze({
    count: quarantines.length,
    digest: sha256(canonicalJson(quarantines.map((quarantine) => ({
      workspace_id: quarantine.workspaceId,
      source_identity: quarantine.sourceIdentity,
      source_digest: quarantine.sourceDigest
    }))))
  });
}

function parseLegacyJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { unparseable_json: value };
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
