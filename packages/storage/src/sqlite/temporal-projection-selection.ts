import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SqliteConnection, StorageDatabase } from "./db.js";
import {
  assertTemporalCandidateDatabaseReady,
  computeKnownMaxVersion,
  listLegacyPathRelationQuarantines,
  listMigrationFiles,
  resolveMigrationsDirectory,
  summarizeLegacyPathRelationQuarantines
} from "./temporal-cutover-gate.js";
import {
  appendSelectionAudit,
  emptyLegacySelectionState,
  hasTemporalSelectionSchema,
  readTemporalSelectionState,
  type TemporalProjectionSelectionState
} from "./temporal-projection-selection-state.js";
import { StorageError } from "../shared/errors.js";

const LEGACY_PATH_RELATION_WRITE_BLOCK_MESSAGE =
  "Legacy path relation writes are disabled after temporal projection selection.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LEGACY_PATH_RELATION_READ_BLOCK_MESSAGE =
  "Legacy path relation reads are disabled after temporal projection selection.";

interface ReceiptFileDigest {
  readonly role: "database" | "journal" | "wal";
  readonly bytes: number;
  readonly sha256: string;
}

interface PreparedTemporalCandidateReceipt {
  readonly sourceFilename: string;
  readonly sourceFileSet: readonly ReceiptFileDigest[];
  readonly candidateFilename: string;
  readonly candidateSha256: string;
  readonly quarantineCount: number;
  readonly quarantineDigest: string;
}

export type {
  TemporalProjectionSelectionAuditEntry,
  TemporalProjectionSelectionState
} from "./temporal-projection-selection-state.js";

export interface SelectTemporalProjectionInput {
  readonly receiptFilename: string;
  readonly reason: string;
  readonly selectedAt?: string;
  /** A cutover may precommit this UUID before selection so recovery can prove ownership. */
  readonly selectionId?: string;
}

export interface RollbackTemporalProjectionInput {
  readonly receiptFilename: string;
  readonly expectedSelectionId: string;
  readonly reason: string;
  readonly rolledBackAt?: string;
}

/**
 * Reads the persisted selection state from the supplied open database. Legacy
 * databases are intentionally reported as unselected so their behavior stays unchanged.
 */
export function inspectTemporalProjectionSelection(
  database: StorageDatabase
): TemporalProjectionSelectionState {
  assertOpenDatabase(database);
  if (!hasTemporalSelectionSchema(database.connection)) {
    return emptyLegacySelectionState();
  }
  return readTemporalSelectionState(database.connection);
}

export function isTemporalProjectionSelected(database: StorageDatabase): boolean {
  return inspectTemporalProjectionSelection(database).selected;
}

/**
 * Selects a prepared candidate only after its source witness, candidate seal,
 * runtime gate, and quarantine inventory all still agree.
 */
export function selectTemporalProjection(
  database: StorageDatabase,
  input: SelectTemporalProjectionInput
): TemporalProjectionSelectionState {
  const receipt = readPreparedTemporalCandidateReceipt(input.receiptFilename);
  const candidateFilename = assertCandidateDatabase(database, receipt);
  assertTemporalCandidateDatabaseReady(candidateFilename, knownMigrationVersion());
  const reason = parseRequiredText(input.reason, "selection reason");
  const selectedAt = parseIsoTimestamp(input.selectedAt ?? new Date().toISOString(), "selected at");
  const sourceFileSetDigest = digestFileSet(receipt.sourceFileSet);

  const transaction = database.connection.transaction(() => {
    const state = readTemporalSelectionState(database.connection);
    if (state.selected) {
      throw new StorageError("CONFLICT", "Temporal projection is already selected; inspect or roll back it first.");
    }
    assertCandidateSeal(candidateFilename, receipt);
    assertSourceUnchanged(receipt);
    assertCandidateQuarantineReconciles(database.connection, receipt);

    const selectionId = resolveSelectionId(input.selectionId);
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET temporal_projection_selected = 1,
          selection_id = ?,
          selected_at = ?,
          updated_at = ?
      WHERE state_id = 1 AND temporal_projection_selected = 0
    `).run(selectionId, selectedAt, selectedAt);
    appendSelectionAudit(database.connection, {
      selectionId,
      transitionKind: "selected",
      previousSelected: false,
      nextSelected: true,
      candidateSha256: receipt.candidateSha256,
      sourceFileSetDigest,
      projectionGeneration: requiredProjectionGeneration(state),
      occurredAt: selectedAt,
      reason
    });
    assertSourceUnchanged(receipt);
    return readTemporalSelectionState(database.connection);
  });

  const selected = transaction.immediate();
  database.markRuntimeTemporalMode();
  return selected;
}

/**
 * Explicitly clears the selected bit while preserving an immutable audit trail.
 * Callers must supply the observed selection id to avoid a stale rollback.
 */
export function rollbackTemporalProjection(
  database: StorageDatabase,
  input: RollbackTemporalProjectionInput
): TemporalProjectionSelectionState {
  const receipt = readPreparedTemporalCandidateReceipt(input.receiptFilename);
  const candidateFilename = assertCandidateDatabase(database, receipt);
  assertTemporalCandidateDatabaseReady(candidateFilename, knownMigrationVersion());
  const expectedSelectionId = parseRequiredText(input.expectedSelectionId, "expected selection id");
  const reason = parseRequiredText(input.reason, "rollback reason");
  const rolledBackAt = parseIsoTimestamp(input.rolledBackAt ?? new Date().toISOString(), "rolled back at");
  const sourceFileSetDigest = digestFileSet(receipt.sourceFileSet);

  const transaction = database.connection.transaction(() => {
    const state = readTemporalSelectionState(database.connection);
    if (!state.selected || state.selectionId !== expectedSelectionId) {
      throw new StorageError("CONFLICT", "Temporal projection selection no longer matches the requested rollback.");
    }
    assertSourceUnchanged(receipt);
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET temporal_projection_selected = 0,
          selection_id = NULL,
          selected_at = NULL,
          updated_at = ?
      WHERE state_id = 1 AND temporal_projection_selected = 1 AND selection_id = ?
    `).run(rolledBackAt, expectedSelectionId);
    appendSelectionAudit(database.connection, {
      selectionId: expectedSelectionId,
      transitionKind: "rolled_back",
      previousSelected: true,
      nextSelected: false,
      candidateSha256: fileSha256(candidateFilename),
      sourceFileSetDigest,
      projectionGeneration: requiredProjectionGeneration(state),
      occurredAt: rolledBackAt,
      reason
    });
    assertSourceUnchanged(receipt);
    return readTemporalSelectionState(database.connection);
  });

  return transaction.immediate();
}

/** Database-side callers use this early guard; triggers cover direct SQL too. */
export function assertLegacyPathRelationWriteAllowed(database: SqliteConnection): void {
  if (!hasTemporalSelectionSchema(database)) return;
  const state = readTemporalSelectionState(database);
  if (!state.selected) return;
  throw new StorageError("CONFLICT", LEGACY_PATH_RELATION_WRITE_BLOCK_MESSAGE);
}

/** Selected runtimes must use the rebuildable assertion projection, never quarantined legacy rows. */
export function assertLegacyPathRelationReadAllowed(database: SqliteConnection): void {
  if (!hasTemporalSelectionSchema(database)) return;
  const state = readTemporalSelectionState(database);
  if (!state.selected) return;
  throw new StorageError("CONFLICT", LEGACY_PATH_RELATION_READ_BLOCK_MESSAGE);
}

function assertOpenDatabase(database: StorageDatabase): void {
  if (database.isClosed()) {
    throw new StorageError("CONFLICT", "Temporal projection selection requires an open storage database.");
  }
}

function resolveSelectionId(requested: string | undefined): string {
  if (requested === undefined) return randomUUID();
  if (!UUID_PATTERN.test(requested)) {
    throw new StorageError("VALIDATION_FAILED", "Temporal projection selection id must be a UUID.");
  }
  return requested.toLowerCase();
}

function assertCandidateDatabase(
  database: StorageDatabase,
  receipt: PreparedTemporalCandidateReceipt
): string {
  assertOpenDatabase(database);
  if (database.filename === ":memory:") {
    throw new StorageError("CONFLICT", "An in-memory database cannot be selected as a temporal candidate.");
  }
  const candidateFilename = path.resolve(database.filename);
  if (candidateFilename !== receipt.candidateFilename || candidateFilename === receipt.sourceFilename) {
    throw new StorageError("CONFLICT", "Temporal selection database does not match the prepared candidate receipt.");
  }
  return candidateFilename;
}

function assertCandidateSeal(
  candidateFilename: string,
  receipt: PreparedTemporalCandidateReceipt
): void {
  if (fileSha256(candidateFilename) !== receipt.candidateSha256) {
    throw new StorageError("CONFLICT", "Temporal candidate no longer matches its prepared receipt seal.");
  }
}

function assertSourceUnchanged(receipt: PreparedTemporalCandidateReceipt): void {
  const actual = readFileSet(receipt.sourceFilename);
  if (JSON.stringify(actual) !== JSON.stringify(receipt.sourceFileSet)) {
    throw new StorageError("CONFLICT", "Temporal source no longer matches its prepared receipt witness.");
  }
}

function assertCandidateQuarantineReconciles(
  database: SqliteConnection,
  receipt: PreparedTemporalCandidateReceipt
): void {
  const legacy = listLegacyPathRelationQuarantines(database);
  const legacySummary = summarizeLegacyPathRelationQuarantines(legacy);
  if (legacySummary.count !== receipt.quarantineCount || legacySummary.digest !== receipt.quarantineDigest) {
    throw new StorageError("CONFLICT", "Temporal candidate legacy path inventory does not reconcile with its receipt.");
  }
  const rows = database.prepare(`
    SELECT workspace_id, source_identity, source_digest
    FROM relation_assertion_quarantine
    WHERE source_kind = 'legacy_path_relation' AND reason = 'missing_typed_validity'
    ORDER BY workspace_id ASC, source_identity ASC
  `).all() as readonly Readonly<{
    readonly workspace_id: string;
    readonly source_identity: string;
    readonly source_digest: string;
  }>[];
  const quarantined = rows.map((row) => ({
    workspaceId: row.workspace_id,
    sourceIdentity: row.source_identity,
    sourceDigest: row.source_digest
  }));
  const quarantineSummary = summarizeLegacyPathRelationQuarantines(quarantined);
  if (
    quarantineSummary.count !== legacySummary.count ||
    quarantineSummary.digest !== legacySummary.digest ||
    JSON.stringify(quarantined) !== JSON.stringify(legacy.map(quarantineIdentity))
  ) {
    throw new StorageError("CONFLICT", "Temporal candidate quarantine does not reconcile with legacy path relations.");
  }
}

function quarantineIdentity(input: {
  readonly workspaceId: string;
  readonly sourceIdentity: string;
  readonly sourceDigest: string;
}): Readonly<{ readonly workspaceId: string; readonly sourceIdentity: string; readonly sourceDigest: string }> {
  return Object.freeze({
    workspaceId: input.workspaceId,
    sourceIdentity: input.sourceIdentity,
    sourceDigest: input.sourceDigest
  });
}

function readPreparedTemporalCandidateReceipt(filename: string): PreparedTemporalCandidateReceipt {
  const receiptFilename = path.resolve(parseRequiredText(filename, "receipt filename"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(receiptFilename, "utf8"));
  } catch (error) {
    throw new StorageError("CONFLICT", "Unable to read the temporal candidate receipt.", error);
  }
  if (!isRecord(parsed) || parsed.receipt_version !== 1 || parsed.kind !== "temporal_offline_candidate" ||
      parsed.status !== "prepared" || parsed.selected !== false) {
    throw new StorageError("CONFLICT", "Temporal candidate receipt is not an unselected prepared receipt.");
  }
  const source = requireRecord(parsed.source, "receipt source");
  const candidate = requireRecord(parsed.candidate, "receipt candidate");
  const quarantine = requireRecord(parsed.quarantine, "receipt quarantine");
  const sourceFilename = path.resolve(parseRequiredText(source.filename, "receipt source filename"));
  const candidateFilename = path.resolve(parseRequiredText(candidate.filename, "receipt candidate filename"));
  if (sourceFilename === candidateFilename) {
    throw new StorageError("CONFLICT", "Temporal candidate receipt points source and candidate at the same file.");
  }
  return Object.freeze({
    sourceFilename,
    sourceFileSet: parseReceiptFileSet(source.file_set),
    candidateFilename,
    candidateSha256: parseSha256(candidate.sha256, "receipt candidate sha256"),
    quarantineCount: parseNonNegativeInteger(quarantine.quarantined_count, "receipt quarantine count"),
    quarantineDigest: parseSha256(quarantine.digest, "receipt quarantine digest")
  });
}

function parseReceiptFileSet(value: unknown): readonly ReceiptFileDigest[] {
  if (!Array.isArray(value)) {
    throw new StorageError("CONFLICT", "Temporal candidate receipt has an invalid source file set.");
  }
  const seenRoles = new Set<string>();
  const parsed = value.map((entry) => {
    const record = requireRecord(entry, "receipt source file");
    const role = record.role;
    if (role !== "database" && role !== "journal" && role !== "wal" || seenRoles.has(role)) {
      throw new StorageError("CONFLICT", "Temporal candidate receipt has an invalid source file role.");
    }
    seenRoles.add(role);
    return Object.freeze({
      role,
      bytes: parseNonNegativeInteger(record.bytes, "receipt source file bytes"),
      sha256: parseSha256(record.sha256, "receipt source file sha256")
    });
  }).sort((left, right) => left.role.localeCompare(right.role));
  if (!seenRoles.has("database")) {
    throw new StorageError("CONFLICT", "Temporal candidate receipt is missing its source database witness.");
  }
  return Object.freeze(parsed);
}

function readFileSet(filename: string): readonly ReceiptFileDigest[] {
  const parts: readonly ReceiptFileDigest["role"][] = ["database", "journal", "wal"];
  return Object.freeze(parts.flatMap((role) => {
    const partFilename = role === "database" ? filename : `${filename}-${role}`;
    if (!fs.existsSync(partFilename)) return [];
    const bytes = fs.readFileSync(partFilename);
    return [Object.freeze({ role, bytes: bytes.byteLength, sha256: sha256(bytes) })];
  }));
}

function digestFileSet(fileSet: readonly ReceiptFileDigest[]): string {
  return sha256(Buffer.from(JSON.stringify(fileSet), "utf8"));
}

function knownMigrationVersion(): number {
  return computeKnownMaxVersion(listMigrationFiles(resolveMigrationsDirectory()));
}

function requiredProjectionGeneration(state: TemporalProjectionSelectionState): string {
  if (state.activeProjectionGeneration === null) {
    throw new StorageError("CONFLICT", "Temporal projection selection requires an active verified projection generation.");
  }
  return state.activeProjectionGeneration;
}

function parseRequiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 1_000) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${label}.`);
  }
  return value.trim();
}

function parseIsoTimestamp(value: unknown, label: string): string {
  const parsed = parseRequiredText(value, label);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${label}.`);
  }
  return parsed;
}

function parseSha256(value: unknown, label: string): string {
  const parsed = parseRequiredText(value, label);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${label}.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${label}.`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new StorageError("CONFLICT", `Invalid ${label}.`);
  }
  return value;
}

function fileSha256(filename: string): string {
  return sha256(fs.readFileSync(filename));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
