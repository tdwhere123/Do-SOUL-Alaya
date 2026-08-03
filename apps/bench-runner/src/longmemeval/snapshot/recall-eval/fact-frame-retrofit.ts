import { createHash } from "node:crypto";
import {
  AssociativeFactFrameSchema,
  BoundedJsonObjectSchema,
  buildAssociativeFactKeyProjections,
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash,
  groundAssociativeFactFrame,
  type CandidateMemorySignal,
  type EvidenceSearchProjection
} from "@do-soul/alaya-protocol";
import {
  RecallQualifiedEvidenceReader,
  SqliteSignalRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { z } from "zod";
import { readRegularFileNoFollow, sha256Buffer } from "../bound-file.js";

const FACT_FRAME_RETROFIT_SCHEMA_VERSION = 1;
const MAX_LEDGER_BYTES = 256 * 1024 * 1024;
const RETROFIT_BATCH_SIZE = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

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
}

export interface FactFrameRetrofitLedger {
  readonly sha256: string;
  readonly records: readonly FactFrameRetrofitLedgerRecord[];
}

type FactFrameRetrofitLedgerRecord = z.infer<
  typeof FactFrameRetrofitLedgerRecordSchema
>;

interface AssertionOwnerRow {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly created_by: string;
  readonly lifecycle_state: string;
  readonly evidence_kind: string;
  readonly evidence_health_state: string;
  readonly gist: string;
  readonly excerpt: string | null;
  readonly source_hash: string | null;
}

interface RetrofitPlan {
  readonly record: FactFrameRetrofitLedgerRecord;
  readonly signal: Readonly<CandidateMemorySignal>;
  readonly owner: AssertionOwnerRow & { readonly source_hash: string };
  readonly rawPayload: Readonly<Record<string, unknown>>;
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
  if (persisted.count !== expectedProjectionCount) {
    throw new Error("fact-frame retrofit persisted projection count mismatch");
  }
  return Object.freeze({
    schema_version: FACT_FRAME_RETROFIT_SCHEMA_VERSION,
    ledger_sha256: ledger.sha256,
    ledger_record_count: ledger.records.length,
    rebuilt_owner_count: ledger.records.length,
    rejected_record_count: 0,
    projection_count: persisted.count,
    projection_content_sha256: persisted.sha256
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
  const signal = signalRepo.getByIdInCurrentTransaction(record.signal_id);
  if (signal === null) throw recordError(record, "signal missing");
  const assertion = assertSignalAuthority(signal, record);
  const owner = readAssertionOwner(db, record.signal_id);
  assertOwnerAuthority(owner, signal, assertion, record);
  const frame = groundAssociativeFactFrame(record.fact_frame, assertion);
  if (frame === null) throw recordError(record, "fact_frame is not source-exact");
  const rawPayload = BoundedJsonObjectSchema.parse({
    ...signal.raw_payload,
    fact_frame: frame
  });
  return Object.freeze({
    record,
    signal,
    owner: owner as AssertionOwnerRow & { readonly source_hash: string },
    rawPayload,
    projections: buildAssociativeFactKeyProjections(frame)
  });
}

function assertSignalAuthority(
  signal: Readonly<CandidateMemorySignal>,
  record: FactFrameRetrofitLedgerRecord
): string {
  if (signal.source !== "garden_compile" || signal.signal_state !== "materialized") {
    throw recordError(record, "signal is not a materialized garden assertion");
  }
  const assertion = readNonEmptyString(signal.raw_payload.source_assertion);
  if (assertion === null || assertion !== assertion.trim()) {
    throw recordError(record, "source_assertion missing or non-canonical");
  }
  if (digestText(assertion) !== record.source_assertion_sha256) {
    throw recordError(record, "source_assertion_sha256 mismatch");
  }
  const grounding = readObject(signal.raw_payload.source_grounding);
  if (grounding?.status !== "grounded" ||
      grounding.content_basis !== "source_assertion" ||
      grounding.source_assertion !== assertion) {
    throw recordError(record, "source_grounding authority mismatch");
  }
  return assertion;
}

function assertOwnerAuthority(
  owner: AssertionOwnerRow,
  signal: Readonly<CandidateMemorySignal>,
  assertion: string,
  record: FactFrameRetrofitLedgerRecord
): void {
  if (owner.created_by !== "garden_compile" || owner.lifecycle_state !== "active" ||
      owner.evidence_kind !== "conversation_excerpt" ||
      owner.evidence_health_state !== "verified") {
    throw recordError(record, "evidence owner is not active verified Garden evidence");
  }
  if (owner.workspace_id !== signal.workspace_id || owner.run_id !== signal.run_id ||
      owner.surface_id !== signal.surface_id || owner.excerpt !== assertion) {
    throw recordError(record, "evidence owner envelope mismatch");
  }
  if (readNonEmptyString(signal.raw_payload.full_turn_content) !== owner.gist) {
    throw recordError(record, "source corpus mismatch");
  }
  if (owner.source_hash !== expectedSourceHash(owner, assertion)) {
    throw recordError(record, "verified assertion receipt mismatch");
  }
}

function expectedSourceHash(owner: AssertionOwnerRow, assertion: string): string {
  return formatVerifiedUserAssertionSourceHash(digestText(
    buildVerifiedUserAssertionReceiptPreimage({
      workspace_id: owner.workspace_id,
      run_id: owner.run_id,
      surface_id: owner.surface_id,
      source_assertion: assertion,
      source_corpus: owner.gist
    })
  ));
}

function readAssertionOwner(db: StorageDatabase, signalId: string): AssertionOwnerRow {
  const rows = db.connection.prepare(ASSERTION_OWNER_SQL).all(signalId) as AssertionOwnerRow[];
  if (rows.length !== 1) {
    throw new Error(
      `fact-frame retrofit ${signalId}: expected one verified assertion owner, found ${rows.length}`
    );
  }
  return rows[0]!;
}

function initializeRetrofitOwnerLedger(db: StorageDatabase): void {
  db.connection.exec(`
    CREATE TEMP TABLE p170_fact_frame_retrofit_owners (
      evidence_object_id TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
}

function assertRuntimeQualifiedOwners(
  db: StorageDatabase,
  plans: readonly RetrofitPlan[]
): void {
  const reader = new RecallQualifiedEvidenceReader(db);
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
  const updateSignal = db.connection.prepare(
    "UPDATE signals SET raw_payload_json = ? WHERE signal_id = ?"
  );
  const recordOwner = db.connection.prepare(
    "INSERT OR IGNORE INTO p170_fact_frame_retrofit_owners (evidence_object_id) VALUES (?)"
  );
  const remove = db.connection.prepare(`
    DELETE FROM evidence_search_projections
     WHERE evidence_object_id = ? AND projection_kind = 'fact_key'
  `);
  const insert = db.connection.prepare(INSERT_PROJECTION_SQL);
  let projectionCount = 0;
  for (const plan of plans) {
    if (recordOwner.run(plan.owner.object_id).changes !== 1) {
      throw recordError(plan.record, "multiple signals resolve to one evidence owner");
    }
    const updated = updateSignal.run(JSON.stringify(plan.rawPayload), plan.signal.signal_id);
    if (updated.changes !== 1) throw recordError(plan.record, "signal update failed");
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

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function recordError(record: FactFrameRetrofitLedgerRecord, reason: string): Error {
  return new Error(`fact-frame retrofit ${record.signal_id}: ${reason}`);
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const ASSERTION_OWNER_SQL = `
  SELECT capsule.object_id, capsule.workspace_id, capsule.run_id,
         capsule.surface_id, capsule.created_by, capsule.lifecycle_state,
         capsule.evidence_kind, capsule.evidence_health_state, capsule.gist,
         capsule.excerpt, capsule.source_hash
    FROM recall_routing_key_owners AS owner
    JOIN evidence_capsules AS capsule
      ON capsule.workspace_id = owner.workspace_id
     AND capsule.object_id = owner.owner_id
   WHERE owner.owner_kind = 'evidence_capsule'
     AND owner.signal_id = ?
     AND capsule.source_hash LIKE 'sha256:garden-verified-user-assertion-v1:%'
   ORDER BY capsule.object_id ASC
`;

const INSERT_PROJECTION_SQL = `
  INSERT INTO evidence_search_projections (
    evidence_object_id, projection_id, projection_kind,
    workspace_id, source_hash, content
  ) VALUES (?, ?, ?, ?, ?, ?)
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
