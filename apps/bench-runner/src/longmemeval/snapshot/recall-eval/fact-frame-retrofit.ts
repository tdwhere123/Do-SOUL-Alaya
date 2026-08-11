import { createHash } from "node:crypto";
import {
  AssociativeFactFrameSchema,
  type EvidenceFactFrameFormationCapture,
  type EvidenceSearchProjection
} from "@do-soul/alaya-protocol";
import { materializeEvidenceFactFrameFormation } from "@do-soul/alaya-core";
import { verifyOfficialApiSourceLocatorBinding } from "@do-soul/alaya-soul";
import type BetterSqlite3 from "better-sqlite3";
import {
  RecallQualifiedEvidenceReader,
  SqliteSignalRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { z } from "zod";
import { readRegularFileNoFollow, sha256Buffer } from "../bound-file.js";
import {
  resolveVerifiedAssertionAuthority,
  type VerifiedAssertionOwnerRow
} from "./fact-frame-formation/verified-assertion-authority.js";

const FACT_FRAME_RETROFIT_SCHEMA_VERSION = 1;
const MAX_LEDGER_BYTES = 256 * 1024 * 1024;
const RETROFIT_BATCH_SIZE = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RETROFIT_FACT_FRAME_PRODUCER_OPERATOR_ID =
  "sealed_fact_frame_retrofit_ledger_v1";

const FactFrameRetrofitLedgerRecordSchema = z.object({
  schema_version: z.literal(FACT_FRAME_RETROFIT_SCHEMA_VERSION),
  signal_id: z.string().trim().min(1).max(512),
  source_assertion_sha256: z.string().regex(SHA256_PATTERN),
  fact_frame: AssociativeFactFrameSchema
}).strict().readonly();

export interface FactFrameRetrofitReport {
  readonly schema_version: typeof FACT_FRAME_RETROFIT_SCHEMA_VERSION;
  readonly ledger_sha256: string;
  readonly ledger_record_count: number;
  readonly rebuilt_owner_count: number;
  readonly rejected_record_count: 0;
  readonly projection_count: number;
  readonly projection_content_sha256: string;
  readonly formation_operator_id?: string;
  readonly formation_capture_count?: number;
  readonly formation_capture_sha256?: string;
}

export interface FactFrameRetrofitLedger {
  readonly sha256: string;
  readonly records: readonly FactFrameRetrofitLedgerRecord[];
}

type FactFrameRetrofitLedgerRecord = z.infer<
  typeof FactFrameRetrofitLedgerRecordSchema
>;

interface RetrofitPlan {
  readonly record: FactFrameRetrofitLedgerRecord;
  readonly owner: VerifiedAssertionOwnerRow & { readonly source_hash: string };
  readonly capture: Readonly<EvidenceFactFrameFormationCapture>;
  readonly projections: readonly Readonly<EvidenceSearchProjection>[];
}

interface CanonicalProjectionRow {
  readonly evidence_object_id: string;
  readonly projection_id: number;
  readonly projection_kind: string;
  readonly workspace_id: string;
  readonly source_hash: string;
  readonly content: string;
}

export function readFactFrameRetrofitLedger(
  ledgerPath: string
): FactFrameRetrofitLedger {
  const bytes = readRegularFileNoFollow(ledgerPath, MAX_LEDGER_BYTES);
  const text = decodeLedger(bytes);
  const records = parseLedgerRecords(text);
  return Object.freeze({
    sha256: sha256Buffer(bytes),
    records: Object.freeze(records)
  });
}

export function applyFactFrameRetrofit(
  db: StorageDatabase,
  ledger: FactFrameRetrofitLedger
): FactFrameRetrofitReport {
  const signalRepo = new SqliteSignalRepo(db);
  initializeRetrofitOwnerLedger(db);
  let expectedProjectionCount = 0;
  for (let offset = 0; offset < ledger.records.length; offset += RETROFIT_BATCH_SIZE) {
    const plans = ledger.records
      .slice(offset, offset + RETROFIT_BATCH_SIZE)
      .map((record) => planRecord(db, signalRepo, record));
    assertRuntimeQualifiedOwners(db, plans);
    expectedProjectionCount += applyPlans(db, plans);
  }
  const persisted = summarizePersistedProjectionRows(db);
  const formations = summarizePersistedFormationRows(db);
  if (persisted.count !== expectedProjectionCount) {
    throw new Error("fact-frame retrofit persisted projection count mismatch");
  }
  if (formations.count !== ledger.records.length) {
    throw new Error("fact-frame retrofit persisted formation count mismatch");
  }
  return Object.freeze({
    schema_version: FACT_FRAME_RETROFIT_SCHEMA_VERSION,
    ledger_sha256: ledger.sha256,
    ledger_record_count: ledger.records.length,
    rebuilt_owner_count: ledger.records.length,
    rejected_record_count: 0,
    projection_count: persisted.count,
    projection_content_sha256: persisted.sha256,
    formation_operator_id: RETROFIT_FACT_FRAME_PRODUCER_OPERATOR_ID,
    formation_capture_count: formations.count,
    formation_capture_sha256: formations.sha256
  });
}

function decodeLedger(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("fact-frame retrofit ledger is not valid UTF-8");
  }
  if (text.length === 0 || !text.endsWith("\n")) {
    throw new Error("fact-frame retrofit ledger must be non-empty NDJSON ending in newline");
  }
  return text;
}

function parseLedgerRecords(text: string): FactFrameRetrofitLedgerRecord[] {
  const lines = text.slice(0, -1).split("\n");
  const records: FactFrameRetrofitLedgerRecord[] = [];
  let previousSignalId: string | undefined;
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) throw ledgerLineError(index, "empty line");
    const record = parseLedgerRecord(line, index);
    if (previousSignalId !== undefined && record.signal_id <= previousSignalId) {
      throw ledgerLineError(index, "signal_id order must be strictly ascending");
    }
    records.push(record);
    previousSignalId = record.signal_id;
  }
  return records;
}

function parseLedgerRecord(
  line: string,
  index: number
): FactFrameRetrofitLedgerRecord {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw ledgerLineError(index, "invalid JSON");
  }
  const parsed = FactFrameRetrofitLedgerRecordSchema.safeParse(value);
  if (!parsed.success) throw ledgerLineError(index, "schema validation failed");
  return parsed.data;
}

function ledgerLineError(index: number, reason: string): Error {
  return new Error(`fact-frame retrofit ledger line ${index + 1}: ${reason}`);
}

function planRecord(
  db: StorageDatabase,
  signalRepo: SqliteSignalRepo,
  record: FactFrameRetrofitLedgerRecord
): RetrofitPlan {
  const authority = resolveVerifiedAssertionAuthority(db, signalRepo, record.signal_id);
  const assertion = authority.sourceAssertion;
  if (digestText(assertion) !== record.source_assertion_sha256) {
    throw recordError(record, "source_assertion_sha256 mismatch");
  }
  const formation = materializeEvidenceFactFrameFormation({
    sourceAssertion: assertion,
    sourceHash: authority.sourceHash,
    proposal: {
      schema_version: 1,
      producer_operator_id: RETROFIT_FACT_FRAME_PRODUCER_OPERATOR_ID,
      source_assertion: assertion,
      fact_frame: record.fact_frame
    }
  });
  if (formation.capture.status !== "formed") {
    throw recordError(record, "canonical fact-frame formation rejected the proposal");
  }
  return Object.freeze({
    record,
    owner: authority.owner,
    capture: formation.capture,
    projections: formation.searchProjections
  });
}

function initializeRetrofitOwnerLedger(db: StorageDatabase): void {
  db.connection.exec(`
    DROP TABLE IF EXISTS temp.p170_fact_frame_retrofit_owners;
    CREATE TEMP TABLE p170_fact_frame_retrofit_owners (
      evidence_object_id TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
}

function assertRuntimeQualifiedOwners(
  db: StorageDatabase,
  plans: readonly RetrofitPlan[]
): void {
  const reader = new RecallQualifiedEvidenceReader(
    db,
    verifyOfficialApiSourceLocatorBinding
  );
  const byWorkspace = new Map<string, RetrofitPlan[]>();
  for (const plan of plans) {
    const current = byWorkspace.get(plan.owner.workspace_id) ?? [];
    current.push(plan);
    byWorkspace.set(plan.owner.workspace_id, current);
  }
  for (const [workspaceId, workspacePlans] of byWorkspace) {
    const requested = workspacePlans.map((plan) => plan.owner.object_id);
    const qualified = new Set(reader.findReceiptQualifiedOwnerIds(workspaceId, requested));
    const rejected = workspacePlans.find((plan) => !qualified.has(plan.owner.object_id));
    if (rejected !== undefined) {
      throw recordError(rejected.record, "runtime qualification failed");
    }
  }
}

function applyPlans(db: StorageDatabase, plans: readonly RetrofitPlan[]): number {
  const recordOwner = db.connection.prepare(
    "INSERT OR IGNORE INTO p170_fact_frame_retrofit_owners (evidence_object_id) VALUES (?)"
  );
  const remove = db.connection.prepare(`
    DELETE FROM evidence_search_projections
     WHERE evidence_object_id = ? AND projection_kind = 'fact_key'
  `);
  const insert = db.connection.prepare(INSERT_PROJECTION_SQL);
  const insertFormation = db.connection.prepare(INSERT_FORMATION_SQL);
  const readFormation = db.connection.prepare(
    "SELECT capture_digest FROM evidence_fact_frame_formations WHERE evidence_object_id = ?"
  );
  let projectionCount = 0;
  for (const plan of plans) {
    if (recordOwner.run(plan.owner.object_id).changes !== 1) {
      throw recordError(plan.record, "multiple signals resolve to one evidence owner");
    }
    persistFormation(insertFormation, readFormation, plan);
    remove.run(plan.owner.object_id);
    for (const projection of plan.projections) {
      insert.run(
        plan.owner.object_id,
        projection.projection_id,
        projection.projection_kind,
        plan.owner.workspace_id,
        plan.owner.source_hash,
        projection.content
      );
      projectionCount += 1;
    }
  }
  return projectionCount;
}

function persistFormation(
  insert: BetterSqlite3.Statement,
  read: BetterSqlite3.Statement,
  plan: RetrofitPlan
): void {
  const capture = plan.capture;
  const result = insert.run(
    plan.owner.object_id,
    plan.owner.workspace_id,
    capture.schema_version,
    capture.operator_id,
    capture.status,
    capture.producer_operator_id,
    capture.source_hash,
    capture.fact_frame === null ? null : JSON.stringify(capture.fact_frame),
    capture.capture_digest
  );
  if (result.changes === 1) return;
  const existing = read.get(plan.owner.object_id) as
    { readonly capture_digest: string } | undefined;
  if (existing?.capture_digest !== capture.capture_digest) {
    throw recordError(plan.record, "existing fact-frame formation capture conflicts");
  }
}

function summarizePersistedProjectionRows(
  db: StorageDatabase
): Readonly<{ count: number; sha256: string }> {
  const digest = createHash("sha256");
  digest.update("[", "utf8");
  let count = 0;
  const rows = db.connection.prepare(READ_PROJECTION_SQL)
    .iterate() as Iterable<CanonicalProjectionRow>;
  for (const row of rows) {
    if (count > 0) digest.update(",", "utf8");
    digest.update(JSON.stringify(row), "utf8");
    count += 1;
  }
  digest.update("]", "utf8");
  return Object.freeze({ count, sha256: digest.digest("hex") });
}

function summarizePersistedFormationRows(
  db: StorageDatabase
): Readonly<{ count: number; sha256: string }> {
  const rows = db.connection.prepare(READ_FORMATION_SQL).all() as ReadonlyArray<Readonly<{
    evidence_object_id: string;
    capture_digest: string;
  }>>;
  return Object.freeze({
    count: rows.length,
    sha256: digestText(JSON.stringify(rows))
  });
}

function recordError(record: FactFrameRetrofitLedgerRecord, reason: string): Error {
  return new Error(`fact-frame retrofit ${record.signal_id}: ${reason}`);
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const INSERT_PROJECTION_SQL = `
  INSERT INTO evidence_search_projections (
    evidence_object_id, projection_id, projection_kind,
    workspace_id, source_hash, content
  ) VALUES (?, ?, ?, ?, ?, ?)
`;

const INSERT_FORMATION_SQL = `
  INSERT INTO evidence_fact_frame_formations (
    evidence_object_id, workspace_id, schema_version, operator_id, status,
    producer_operator_id, source_hash, fact_frame_json, capture_digest
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(evidence_object_id) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    schema_version = excluded.schema_version,
    operator_id = excluded.operator_id,
    status = excluded.status,
    producer_operator_id = excluded.producer_operator_id,
    source_hash = excluded.source_hash,
    fact_frame_json = excluded.fact_frame_json,
    capture_digest = excluded.capture_digest
  WHERE evidence_fact_frame_formations.status != 'formed'
`;

const READ_PROJECTION_SQL = `
  SELECT projection.evidence_object_id, projection.projection_id,
         projection.projection_kind, projection.workspace_id,
         projection.source_hash, projection.content
    FROM p170_fact_frame_retrofit_owners AS owner
    JOIN evidence_search_projections AS projection
      ON projection.evidence_object_id = owner.evidence_object_id
   WHERE projection.projection_kind = 'fact_key'
   ORDER BY projection.evidence_object_id ASC, projection.projection_id ASC
`;

const READ_FORMATION_SQL = `
  SELECT formation.evidence_object_id, formation.capture_digest
  FROM p170_fact_frame_retrofit_owners AS owner
  JOIN evidence_fact_frame_formations AS formation
    ON formation.evidence_object_id = owner.evidence_object_id
  ORDER BY formation.evidence_object_id ASC
`;
