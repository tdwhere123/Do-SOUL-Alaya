import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { initDatabase, readSchemaMigrationLedger } from "./db.js";
import {
  TEMPORAL_OFFLINE_MIGRATION_VERSION,
  assertTemporalCandidateDatabaseReady,
  computeKnownMaxVersion,
  listLegacyPathRelationQuarantines,
  listMigrationFiles,
  resolveMigrationsDirectory,
  summarizeLegacyPathRelationQuarantines,
  type LegacyPathRelationQuarantine,
  type LegacyPathRelationQuarantineSummary
} from "./temporal-cutover-gate.js";
import { StorageError } from "../shared/errors.js";

export interface TemporalCandidateFileDigest {
  readonly role: "database" | "journal" | "wal";
  readonly bytes: number;
  readonly sha256: string;
}

export interface TemporalCandidatePreparation {
  readonly selected: false;
  readonly receiptFilename: string;
  readonly source: {
    readonly filename: string;
    readonly schemaVersions: readonly number[];
    readonly fileSet: readonly TemporalCandidateFileDigest[];
  };
  readonly candidate: {
    readonly filename: string;
    readonly schemaVersions: readonly number[];
    readonly sha256: string;
  };
  readonly quarantine: {
    readonly convertedCount: 0;
    readonly quarantinedCount: number;
    readonly digest: string;
  };
}

interface NormalizedPaths {
  readonly sourceFilename: string;
  readonly candidateFilename: string;
  readonly receiptFilename: string;
}

/**
 * Builds, verifies, and receipts an offline temporal candidate. It never
 * changes the source path and deliberately does not select the candidate.
 */
export async function prepareTemporalCandidate(input: {
  readonly sourceFilename: string;
  readonly candidateFilename: string;
  readonly receiptFilename: string;
}): Promise<TemporalCandidatePreparation> {
  const paths = normalizePaths(input);
  assertCandidateOutputsAreNew(paths);

  const sourceBefore = readFileSet(paths.sourceFilename);
  const sourceSchemaVersions = readSchemaMigrationLedger(paths.sourceFilename);
  assertLegacySourceSchema(sourceSchemaVersions);
  const sourceQuarantines = readSourceQuarantines(paths.sourceFilename);
  const sourceSummary = summarizeLegacyPathRelationQuarantines(sourceQuarantines);
  const copyStagingFilename = stagingFilename(paths.candidateFilename, "copy");
  const sealedStagingFilename = stagingFilename(paths.candidateFilename, "sealed");
  let candidatePublished = false;

  try {
    await copyDatabaseSnapshot(paths.sourceFilename, copyStagingFilename);
    assertUnchangedSource(paths.sourceFilename, sourceBefore);

    const candidate = initDatabase({ filename: copyStagingFilename, temporalMode: "candidate" });
    candidate.close();
    await copyDatabaseSnapshot(copyStagingFilename, sealedStagingFilename);

    const knownMaxVersion = currentKnownMigrationVersion();
    assertTemporalCandidateDatabaseReady(sealedStagingFilename, knownMaxVersion);
    const candidateSchemaVersions = readSchemaMigrationLedger(sealedStagingFilename);
    assertCandidateSchema(sourceSchemaVersions, candidateSchemaVersions);
    const candidateQuarantines = readCandidateQuarantines(sealedStagingFilename);
    assertQuarantineReconciliation(sourceQuarantines, sourceSummary, candidateQuarantines);
    assertUnchangedSource(paths.sourceFilename, sourceBefore);

    fs.renameSync(sealedStagingFilename, paths.candidateFilename);
    candidatePublished = true;
    assertTemporalCandidateDatabaseReady(paths.candidateFilename, knownMaxVersion);

    const result: TemporalCandidatePreparation = Object.freeze({
      selected: false,
      receiptFilename: paths.receiptFilename,
      source: Object.freeze({
        filename: paths.sourceFilename,
        schemaVersions: sourceSchemaVersions,
        fileSet: sourceBefore
      }),
      candidate: Object.freeze({
        filename: paths.candidateFilename,
        schemaVersions: candidateSchemaVersions,
        sha256: fileSha256(paths.candidateFilename)
      }),
      quarantine: Object.freeze({
        convertedCount: 0,
        quarantinedCount: sourceSummary.count,
        digest: sourceSummary.digest
      })
    });
    writeReceiptAtomically(paths.receiptFilename, preparedReceipt(result));
    return result;
  } catch (error) {
    if (candidatePublished) removeDatabaseFileSet(paths.candidateFilename);
    writeFailureReceiptIfPossible(paths.receiptFilename, failureReceipt({
      sourceFilename: paths.sourceFilename,
      sourceSchemaVersions,
      sourceFileSet: sourceBefore,
      sourceSummary,
      error
    }));
    throw error;
  } finally {
    removeDatabaseFileSet(copyStagingFilename);
    removeDatabaseFileSet(sealedStagingFilename);
  }
}

function normalizePaths(input: {
  readonly sourceFilename: string;
  readonly candidateFilename: string;
  readonly receiptFilename: string;
}): NormalizedPaths {
  if (input.sourceFilename === ":memory:") {
    throw new StorageError("CONFLICT", "An in-memory database cannot be an offline temporal source.");
  }
  const sourceFilename = path.resolve(input.sourceFilename);
  const candidateFilename = path.resolve(input.candidateFilename);
  const receiptFilename = path.resolve(input.receiptFilename);
  const protectedSourcePaths = new Set(databaseFileSetPaths(sourceFilename));
  if (protectedSourcePaths.has(candidateFilename) || protectedSourcePaths.has(receiptFilename)) {
    throw new StorageError("CONFLICT", "Temporal candidate and receipt paths must be distinct from the source database.");
  }
  if (candidateFilename === receiptFilename) {
    throw new StorageError("CONFLICT", "Temporal candidate and receipt paths must be distinct.");
  }
  if (!fs.existsSync(sourceFilename)) {
    throw new StorageError("NOT_FOUND", `Temporal source database was not found: ${sourceFilename}`);
  }
  return { sourceFilename, candidateFilename, receiptFilename };
}

function assertCandidateOutputsAreNew(paths: NormalizedPaths): void {
  const existingCandidatePart = databaseFileSetPaths(paths.candidateFilename)
    .find((filename) => fs.existsSync(filename));
  if (existingCandidatePart !== undefined) {
    throw new StorageError("CONFLICT", `Temporal candidate output already exists: ${existingCandidatePart}`);
  }
  if (fs.existsSync(paths.receiptFilename)) {
    throw new StorageError("CONFLICT", `Temporal candidate receipt already exists: ${paths.receiptFilename}`);
  }
  fs.mkdirSync(path.dirname(paths.candidateFilename), { recursive: true });
  fs.mkdirSync(path.dirname(paths.receiptFilename), { recursive: true });
}

function assertLegacySourceSchema(schemaVersions: readonly number[]): void {
  const maxVersion = schemaVersions.at(-1);
  if (maxVersion !== TEMPORAL_OFFLINE_MIGRATION_VERSION - 1) {
    throw new StorageError(
      "CONFLICT",
      `Temporal offline candidate expects a legacy schema ending at ${TEMPORAL_OFFLINE_MIGRATION_VERSION - 1}, got ${maxVersion ?? "none"}.`
    );
  }
}

async function copyDatabaseSnapshot(sourceFilename: string, destinationFilename: string): Promise<void> {
  const source = new BetterSqlite3(sourceFilename, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destinationFilename);
  } finally {
    source.close();
  }
}

function readSourceQuarantines(filename: string): readonly LegacyPathRelationQuarantine[] {
  const database = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
  try {
    return listLegacyPathRelationQuarantines(database);
  } finally {
    database.close();
  }
}

function readCandidateQuarantines(filename: string): readonly LegacyPathRelationQuarantine[] {
  const database = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
  try {
    const rows = database.prepare(
      `SELECT workspace_id, source_identity, source_json, source_digest
         FROM relation_assertion_quarantine
        WHERE source_kind = 'legacy_path_relation'
          AND reason = 'missing_typed_validity'
        ORDER BY workspace_id ASC, source_identity ASC`
    ).all() as ReadonlyArray<Readonly<{
      workspace_id: string;
      source_identity: string;
      source_json: string;
      source_digest: string;
    }>>;
    return Object.freeze(rows.map((row) => {
      if (fileTextSha256(row.source_json) !== row.source_digest) {
        throw new StorageError("CONFLICT", "Temporal candidate quarantine source digest is invalid.");
      }
      return Object.freeze({
        workspaceId: row.workspace_id,
        sourceIdentity: row.source_identity,
        sourceJson: row.source_json,
        sourceDigest: row.source_digest
      });
    }));
  } finally {
    database.close();
  }
}

function assertCandidateSchema(
  sourceSchemaVersions: readonly number[],
  candidateSchemaVersions: readonly number[]
): void {
  const expected = [...sourceSchemaVersions, TEMPORAL_OFFLINE_MIGRATION_VERSION];
  if (JSON.stringify(candidateSchemaVersions) !== JSON.stringify(expected)) {
    throw new StorageError("CONFLICT", "Temporal candidate schema ledger does not exactly extend the legacy source.");
  }
}

function assertQuarantineReconciliation(
  source: readonly LegacyPathRelationQuarantine[],
  sourceSummary: LegacyPathRelationQuarantineSummary,
  candidate: readonly LegacyPathRelationQuarantine[]
): void {
  const candidateSummary = summarizeLegacyPathRelationQuarantines(candidate);
  const sourceIdentity = source.map(quarantineIdentity);
  const candidateIdentity = candidate.map(quarantineIdentity);
  if (sourceSummary.count !== candidateSummary.count ||
      sourceSummary.digest !== candidateSummary.digest ||
      JSON.stringify(sourceIdentity) !== JSON.stringify(candidateIdentity)) {
    throw new StorageError("CONFLICT", "Temporal candidate quarantine does not reconcile with legacy path relations.");
  }
}

function quarantineIdentity(quarantine: LegacyPathRelationQuarantine): Readonly<Record<string, string>> {
  return {
    workspace_id: quarantine.workspaceId,
    source_identity: quarantine.sourceIdentity,
    source_digest: quarantine.sourceDigest
  };
}

function currentKnownMigrationVersion(): number {
  return computeKnownMaxVersion(listMigrationFiles(resolveMigrationsDirectory()));
}

function readFileSet(filename: string): readonly TemporalCandidateFileDigest[] {
  const roles: readonly TemporalCandidateFileDigest["role"][] = ["database", "journal", "wal"];
  return Object.freeze(roles.flatMap((role) => {
    const partFilename = databaseFileSetPath(filename, role);
    if (!fs.existsSync(partFilename)) return [];
    const bytes = fs.readFileSync(partFilename);
    return [Object.freeze({ role, bytes: bytes.byteLength, sha256: fileBytesSha256(bytes) })];
  }));
}

function assertUnchangedSource(
  sourceFilename: string,
  expected: readonly TemporalCandidateFileDigest[]
): void {
  const actual = readFileSet(sourceFilename);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new StorageError("CONFLICT", "Temporal source changed during offline candidate preparation.");
  }
}

function databaseFileSetPaths(filename: string): readonly string[] {
  return [filename, `${filename}-journal`, `${filename}-wal`, `${filename}-shm`];
}

function databaseFileSetPath(filename: string, role: TemporalCandidateFileDigest["role"]): string {
  if (role === "database") return filename;
  return `${filename}-${role}`;
}

function stagingFilename(candidateFilename: string, phase: "copy" | "sealed"): string {
  return path.join(
    path.dirname(candidateFilename),
    `.${path.basename(candidateFilename)}.temporal-${phase}-${randomUUID()}.sqlite`
  );
}

function removeDatabaseFileSet(filename: string): void {
  for (const candidate of databaseFileSetPaths(filename)) {
    fs.rmSync(candidate, { force: true });
  }
}

function preparedReceipt(result: TemporalCandidatePreparation): Record<string, unknown> {
  return {
    receipt_version: 1,
    kind: "temporal_offline_candidate",
    status: "prepared",
    selected: false,
    generated_at: new Date().toISOString(),
    source: {
      filename: result.source.filename,
      schema_versions: result.source.schemaVersions,
      file_set: result.source.fileSet
    },
    candidate: {
      filename: result.candidate.filename,
      schema_versions: result.candidate.schemaVersions,
      sha256: result.candidate.sha256
    },
    quarantine: {
      converted_count: 0,
      quarantined_count: result.quarantine.quarantinedCount,
      digest: result.quarantine.digest
    }
  };
}

function failureReceipt(input: {
  readonly sourceFilename: string;
  readonly sourceSchemaVersions: readonly number[];
  readonly sourceFileSet: readonly TemporalCandidateFileDigest[];
  readonly sourceSummary: LegacyPathRelationQuarantineSummary;
  readonly error: unknown;
}): Record<string, unknown> {
  return {
    receipt_version: 1,
    kind: "temporal_offline_candidate",
    status: "failed",
    selected: false,
    generated_at: new Date().toISOString(),
    source: {
      filename: input.sourceFilename,
      schema_versions: input.sourceSchemaVersions,
      file_set: input.sourceFileSet
    },
    quarantine: {
      converted_count: 0,
      quarantined_count: input.sourceSummary.count,
      digest: input.sourceSummary.digest
    },
    error: input.error instanceof Error ? input.error.message : String(input.error)
  };
}

function writeFailureReceiptIfPossible(filename: string, receipt: Record<string, unknown>): void {
  if (fs.existsSync(filename)) return;
  try {
    writeReceiptAtomically(filename, receipt);
  } catch {
    // The original migration failure remains the actionable error.
  }
}

function writeReceiptAtomically(filename: string, receipt: Record<string, unknown>): void {
  const temporaryFilename = `${filename}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporaryFilename, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryFilename, filename);
  } finally {
    fs.rmSync(temporaryFilename, { force: true });
  }
}

function fileSha256(filename: string): string {
  return fileBytesSha256(fs.readFileSync(filename));
}

function fileTextSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fileBytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
